# Animaxia Cloud — CI/CD (`.github/`)

GitHub Actions pipelines for the Animaxia Cloud microservices platform
(10 services + gateway, Bun runtime, Docker, Helm/Kubernetes).

| Workflow | File | Trigger | Purpose |
|---|---|---|---|
| CI | `workflows/ci.yml` | pull request (non-doc-only), push to `main` | lint + syntax-verify + test + build all 10 Docker images (no push) |
| CD | `workflows/cd-deploy.yml` | push tag `v*`, manual `workflow_dispatch` | build & push images to ghcr.io, Helm deploy, smoke test, auto-rollback |
| Rollback | `workflows/rollback.yml` | manual `workflow_dispatch`, `repository_dispatch` (`rollback`) | roll the Helm release back to a chosen revision |

## Branch & tag flow

```
 +------------------------------- GitHub Actions -------------------------------+

   pull request (any change
   except *.md-only)  --------->  ci.yml
   push to main       -------->  ci.yml
                                     lint ----> verify ----> test ----> docker-build x10
                                     (images tagged ci-<sha>, NOT pushed to a registry)

   push tag v*        --------->  cd-deploy.yml          (also manual dispatch)
   manual dispatch    --------->  cd-deploy.yml
                                     ci-gate (lint + verify)
                                       |
                                       v
                                     build-push x10
                                     (ghcr.io/<owner>/<service>:<version> + :latest)
                                       |
                                       v
                                     helm-deploy
                                     (helm upgrade --install animaxia-cloud --atomic)
                                       |
                                       v
                                     smoke-test
                                     (in-cluster curl gateway-service:8080/api/health)
                                       |
                        success <------+------> failure
                          |                          |
                          v                          v
                  $GITHUB_STEP_SUMMARY         auto-rollback
                  (deployment info)           (helm rollback  ||
                                               kubectl rollout undo)
                                                             |
                                                             v
                                                   failure summary + Slack
                                                   notification (SLACKWEBHOOK)

   manual / incident bot ----->  rollback.yml
                                 (helm rollback to revision N; 0 = previous)

 +------------------------------------------------------------------------------+
```

## How releases work

1. A PR or push to `main` runs **CI**: ESLint (flat config at the repo root),
   `scripts/verify-syntax.mjs` (bun `--no-bundle` syntax check of every
   `.js`/`.mjs` in `common/`, `domain/`, `services/`), `bun test`, and a
   build-only Docker matrix over the 10 services. Nothing is published.
2. To cut a release, push a tag: `git tag v3.0.1 && git push origin v3.0.1`.
3. **CD** picks it up (`cd-deploy.yml`):
   - `ci-gate` re-runs lint + verify (deploys are blocked on a red gate),
   - `build-push` builds all 10 images from the repo root context
     (`services/<name>/Dockerfile`) and pushes them with two tags:
     the release version (`v3.0.1` -> `3.0.1`) and `:latest`,
   - `helm-deploy` runs
     `helm upgrade --install animaxia-cloud deploy/helm/animaxia-cloud
     --namespace animaxia --create-namespace --values values-production.yaml
     --set image.tag=<version> --set global.imageTag=<version> --atomic
     --timeout 10m --wait`, then waits for `deploy/gateway-service` to roll
     out (`kubectl rollout status`, 300s),
   - `smoke-test` launches a one-shot `curlimages/curl:8.10.1` pod inside the
     namespace and requires `http://gateway-service:8080/api/health` to answer
     with a payload containing `"status"`,
   - if anything after a successful deploy fails, **auto-rollback** restores
     the previous Helm revision (`helm rollback ... || kubectl rollout undo`),
     writes a failure summary into `$GITHUB_STEP_SUMMARY` and posts to the
     optional Slack webhook. (If `helm-deploy` itself fails, `--atomic` has
     already rolled back and the job only notifies.)
4. Manual re-deploys: run `cd-deploy.yml` via **workflow_dispatch**; the
   optional `imageTag` input overrides the version (useful for re-releasing an
   existing image), otherwise the git tag or `sha-<short>` is used.

## Image naming

| Stage | Image reference | Pushed |
|---|---|---|
| CI (ci.yml) | `ghcr.io/animaxia/<service>:ci-<full-sha>` | no (build-only gate) |
| CD (cd-deploy.yml) | `ghcr.io/<owner-lowercase>/<service>:<version>` | yes |
| CD (cd-deploy.yml) | `ghcr.io/<owner-lowercase>/<service>:latest` | yes |

- `<service>` is one of: `gateway-service`, `auth-service`, `content-service`,
  `ai-service`, `analytics-service`, `search-service`, `premium-service`,
  `social-service`, `mobile-service`, `queue-service`.
- `<owner-lowercase>` = `github.repository_owner` lowercased (ghcr.io requires
  lowercase repository paths).
- `<version>` = `imageTag` input, else the git tag without its leading `v`
  (`refs/tags/v3.0.1` -> `3.0.1`), else `sha-<short>` for branch dispatches.
- Note: the first push creates the ghcr.io packages as **private** by default —
  flip them to public (or configure an imagePullSecret in the cluster) if the
  target cluster cannot pull them.

## Required repo secrets

| Secret | Required | Used by | Description |
|---|---|---|---|
| `KUBE_CONFIG` | yes (CD + rollback) | `cd-deploy.yml`, `rollback.yml` | **base64-encoded** kubeconfig YAML for the target cluster: `base64 -w0 kubeconfig.yaml` -> paste. Written to `~/.kube/config` (decoded). Must point at a context with permissions to create the `animaxia` namespace, install the release and roll it back. A secret stored as plain (non-base64) YAML is tolerated, but base64 is the documented format. |
| `SLACKWEBHOOK` | no | `cd-deploy.yml` (auto-rollback notify) | Slack incoming-webhook URL; when set, deploy failures + rollbacks are posted to Slack. House env style: no underscore. |
| `GITHUB_TOKEN` | automatic | `cd-deploy.yml` (ghcr.io push) | Provided by GitHub Actions itself — no setup. The workflow grants it `packages: write` via its `permissions:` block. |

## Manual & emergency rollback

**From the UI:** Actions -> *Rollback* -> *Run workflow* -> pick
`revision` (default `0` = previous revision; `N` = that Helm revision number —
see `helm history animaxia-cloud -n animaxia`) and `namespace`
(default `animaxia`).

**From the CLI/API (workflow_dispatch):**

```bash
gh workflow run rollback.yml -f revision=0 -f namespace=animaxia
```

**From an external system (repository_dispatch)** — e.g. an incident bot or a
monitoring hook:

```bash
curl -X POST \
  -H "Authorization: token <PAT-with-repo-scope>" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/<owner>/<repo>/dispatches \
  -d '{"event_type":"rollback","client_payload":{"revision":"5","namespace":"animaxia"}}'
```

The rollback job lists the release history, rolls back
(`helm rollback animaxia-cloud [revision] -n animaxia --wait --timeout 10m`),
verifies `deploy/gateway-service` rolls out, and appends the post-rollback
history to the run summary.

## Assumptions & conventions

- Action versions are pinned to major tags: `actions/checkout@v4`,
  `oven-sh/setup-bun@v2` (bun `latest`), `docker/setup-buildx-action@v3`,
  `docker/build-push-action@v6`, `docker/login-action@v3`,
  `azure/setup-helm@v4`.
- The Helm chart lives at `deploy/helm/animaxia-cloud` and its per-service
  images honor `.Values.image.tag` (default `latest`); the deploy passes BOTH
  `--set image.tag=<version>` and `--set global.imageTag=<version>` so the
  release is pinned regardless of which key the chart consumes.
- `deploy/helm/animaxia-cloud/values-production.yaml` must exist (production
  overrides for the `helm upgrade --values` call).
- Every service Dockerfile builds from the **repo root** context
  (`services/<name>/Dockerfile`, BLUEPRINT section 8) and expects
  `package.json` + `bun.lock` at the root — commit `bun.lock` so
  `bun install --frozen-lockfile` (CI/CD) and the Docker builds stay
  reproducible.
- ESLint uses the flat config committed at the repo root
  (`eslint.config.mjs`); deleting it makes the lint jobs fail by design.
- `scripts/verify-syntax.mjs` (task 2-l) is the syntax gate for all
  application code; it runs under `node` and shells out to `bun build
  --no-bundle`.
- Deploys are serialized per environment via the concurrency group
  `deploy-<environment>` (`cancel-in-progress: false`) — an in-flight deploy is
  never cancelled, the next one queues behind it.
