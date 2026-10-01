# Animaxia Cloud

<!-- FAZA 9 (ops): status badges — workflows ship inside the packages
     (animaxia-ops/.github/workflows/ops-ci.yml, animaxia-edge/…/edge-deploy.yml,
     animaxia-desktop/…/desktop-ci.yml); copy them to the repo root
     .github/workflows/ on the real Git host and adjust the org/repo prefix. -->
![Ops CI](https://github.com/animaxia/animaxia/actions/workflows/ops-ci.yml/badge.svg)
![Edge Deploy](https://github.com/animaxia/animaxia/actions/workflows/edge-deploy.yml/badge.svg)
![desktop-ci](https://github.com/animaxia/animaxia/actions/workflows/desktop-ci.yml/badge.svg)

**Phase 3 of the Animaxia platform** — the monolith extracted into a cloud-native
microservices platform: an API gateway, nine domain services, a durable
Postgres-backed job queue, full observability (metrics / logs / traces),
Docker + Kubernetes + Helm orchestration, CI/CD with auto-rollback, a
Cloudflare edge, and a disaster-recovery program.

**Phase 4 addendum — Animaxia AI Cloud**: the full AI layer (LLM core,
vector search, RAG, tools + agent, personal AI, admin AI) now also runs in
ai-service behind `/api/ai` + `/api/vector` — see
[Phase 4 — AI Cloud](#phase-4--ai-cloud) below.

```
                        ┌──────────────────────────────┐
                        │  CLOUDFLARE EDGE (cdn/)      │
                        │  WAF · rate limit · cache    │
                        │  KV config · R2 media        │
                        └──────────────┬───────────────┘
                                       ▼
                        ┌──────────────────────────────┐
   user ──────────────► │  gateway-service      :8080  │  routing · global auth (JWT)
                        │  (API Gateway)               │  edge cache · circuit breakers
                        └──┬────┬────┬────┬────┬────┬──┘  stale-while-error fallback
        ┌──────────────────┘    │    │    │    │    └─────────────────┐
        ▼                       ▼    ▼    ▼    ▼                      ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│ auth-service │ │content-service│ │ ai-service   │ │analytics-svc │ │search-service│
│    :4001     │ │    :4002      │ │   :4003      │ │   :4004      │ │   :4005      │
│ users/JWT    │ │ /api/all      │ │ recommend-   │ │ views/trend- │ │ advanced/    │
│ profile      │ │ content/player│ │ ations/chat/ │ │ ing/overview│ │ fuzzy/auto-  │
│ security     │ │ miner/anime/  │ │ summarize    │ │ + rollups   │ │ complete     │
│ verify-admin │ │ movies/tv/    │ │ (z-ai SDK)   │ │             │ │ index        │
│              │ │ sports/news/  │ │              │ │             │ │              │
│              │ │ cache/admin   │ │              │ │             │ │              │
└──────┬───────┘ └──────┬───────┘ └──────┬───────┘ └──────┬───────┘ └──────┬───────┘
       │                │                │                │                │
       │         ┌──────┴───────┐ ┌──────┴───────┐ ┌──────┴───────┐ ┌──────┴──────┐
       │         │premium-service│ │social-service│ │mobile-service│ │queue-service│
       │         │   :4006       │ │   :4007      │ │   :4008      │ │   :4009     │
       │         │ plans/Stripe  │ │ comments/    │ │ /mobile/home │ │ PG queue ·  │
       │         │ subscriptions │ │ votes/likes  │ │ player/prof. │ │ cron · 11   │
       │         │ free/plus/pro │ │ global feed  │ │ (API for the │ │ job types · │
       │         │               │ │              │ │  mobile app) │ │ /workers    │
       │         └──────┬───────┘ └──────┬───────┘ └──────┬───────┘ └──────┬──────┘
       └────────────────┴────────────────┴────────────────┴────────────────┘
                                        ▼
                      ┌───────────────────────────────────┐
                      │  NEON POSTGRESQL (shared, pooled) │
                      │  content · users · social · jobs  │
                      └───────────────────────────────────┘
   observability/     Prometheus :9090 · Grafana :3001 · Loki :3100 · Tempo :3200
   (compose overlay)  OTel Collector :4317/:4318 · Promtail (docker_sd)

   .github/           GitHub Actions: CI (lint+verify+test+docker build) →
                      CD (build+push GHCR → helm deploy → smoke → AUTO ROLLBACK)
```

## Repository layout

| Folder | Purpose | Docs |
|---|---|---|
| `BLUEPRINT.md` | Frozen architecture contract (routes, ports, env, imports) | — |
| `common/` | `@animaxia/common` — shared infra: db, cache, rate limit, JWT, metrics, tracing, queue, `createService` factory | [BLUEPRINT §5](BLUEPRINT.md) |
| `domain/` | `@animaxia/domain` — extracted business modules (users, providers, player, miner, ai, analytics, search, cache, premium, social, mobile) | [BLUEPRINT §4](BLUEPRINT.md) |
| `services/` | The 10 microservices (each: own server, router, health, rate limit, cache, worker thread, Dockerfile) | each has a README |
| `deploy/docker/` | Dockerfile template + `docker-compose.yml` + observability overlay | [deploy/docker/README.md](deploy/docker/README.md) |
| `deploy/k8s/` | Raw Kubernetes manifests (Deployment/Service/Ingress/HPA/ConfigMap/Secret/CronJob/Job) | [deploy/k8s/README.md](deploy/k8s/README.md) |
| `deploy/helm/animaxia-cloud/` | Complete Helm chart (+ production values) | [deploy/helm/animaxia-cloud/README.md](deploy/helm/animaxia-cloud/README.md) |
| `.github/` | CI/CD: `ci.yml`, `cd-deploy.yml` (auto-rollback), `rollback.yml` | [.github/README.md](.github/README.md) |
| `observability/` | Prometheus + rules, Grafana + 2 dashboards, Loki, Promtail, OTel Collector, Tempo | [observability/README.md](observability/README.md) |
| `cdn/cloudflare/` | Edge worker (cache/KV/R2/failover), WAF + rate-limit + cache rules, Terraform | [cdn/cloudflare/README.md](cdn/cloudflare/README.md) |
| `disaster-recovery/` | DR plan + backup/restore/failover/cold-archive scripts | [disaster-recovery/PLAN.md](disaster-recovery/PLAN.md) |
| `scripts/` | `dev-up.sh`, `dev-down.sh`, `smoke-test.sh`, `verify-syntax.mjs` | headers in each script |

## Quickstart (local dev)

Prereqs: **bun ≥ 1.2**, a reachable **Neon PostgreSQL** connection string.
Optional: docker (for the compose stacks), a TMDB API key (content enrichment).

```bash
cp .env.example .env     # then fill DATABASEURL (postgresql://… — no psql prefix!)
bun install              # workspaces: common + domain + 10 services
bun run dev              # boots ALL 10 services (scripts/dev-up.sh)
bun run smoke            # end-to-end smoke test (scripts/smoke-test.sh)
```

Gateway: **http://localhost:8080** (`/api/health` aggregated, `/api/gateway/routes`).
Stop everything: `bun run dev:down`. Tail one service: `tail -f logs/gateway-service.log`.

### Service registry

| Service | Port | Env override | Owns (gateway prefix) |
|---|---|---|---|
| gateway-service | 8080 | `GATEWAYPORT` | `/api/health` (aggregated), `/api/gateway/*` |
| auth-service | 4001 | `AUTHPORT` | `/api/auth`, `/api/users`, `/api/security`, `/internal/verify-admin` |
| content-service | 4002 | `CONTENTPORT` | `/api/all`, `/api/content*`, `/api/miner`, `/api/admin`, `/api/anime`, `/api/movies`, `/api/tv`, `/api/sports`, `/api/news`, `/api/cache` |
| ai-service | 4003 | `AIPORT` | `/api/ai`, `/api/vector` |
| analytics-service | 4004 | `ANALYTICSPORT` | `/api/analytics` |
| search-service | 4005 | `SEARCHPORT` | `/api/search` |
| premium-service | 4006 | `PREMIUMPORT` | `/api/premium` |
| social-service | 4007 | `SOCIALPORT` | `/api/social` |
| mobile-service | 4008 | `MOBILEPORT` | `/api/mobile` |
| queue-service | 4009 | `QUEUEPORT` | `/api/queue`, `/api/workers` |

Every service also serves `GET /health`, `GET /metrics` (Prometheus) and `GET /`
(service info) on its own port.

### Docker

```bash
cd deploy/docker
docker compose up -d --build                        # all 10 services + gateway
docker compose -f docker-compose.yml -f docker-compose.observability.yml up -d
curl http://localhost:8080/api/health               # smoke
```

### Kubernetes

```bash
kubectl apply -f deploy/k8s/00-namespace.yaml      # then secrets (see k8s README)
kubectl apply -R -f deploy/k8s/
# or with Helm:
helm upgrade --install animaxia-cloud deploy/helm/animaxia-cloud -n animaxia --create-namespace
```

### CI/CD

Tag `vX.Y.Z` → GitHub Actions builds all 10 images → pushes to GHCR →
`helm upgrade --install` → smoke test → **automatic rollback on failure**.
Manual/emergency rollback: `rollback.yml` workflow. See [.github/README.md](.github/README.md).

## Phase 4 — AI Cloud

The Phase-4 AI layer (`domain/aicloud/`, BLUEPRINT §11) is mounted in
**ai-service** right after the Phase-3 AI router (Express falls through on
no-match, so the Phase-3 surface is untouched):

- **llm-core** — provider abstraction `z-ai | openai | mock` with an
  auto-degradation chain, mode-aware prompts, token-budgeted context,
  per-user + per-plan quotas and full usage tracking (`aiusagelogs`).
- **vector** — pluggable vector backends (pgvector / mock / Qdrant /
  Pinecone, `VECTOR_BACKEND=auto` degrades gracefully) over 256-dim
  embeddings of content, user taste, feed activity and agent memories.
- **RAG** — retrieve → hybrid rank → prompt → LLM for recommendations,
  summaries, explanations and spoiler-safe chat-with-content, with
  deterministic fallback composers.
- **tools + agent** — six whitelisted tools (the cloud `enqueueQueueJob`
  POSTs to queue-service over HTTP) + animaxiaAssistant: JSON tool-calling,
  long-term memory and safety guardrails.
- **personal** — per-user AI home, taste-ranked feed, player companion and
  weekly recap.
- **admin** — AI usage dashboard (tokens, cost, error rate, latency,
  top prompts).

New endpoints: `/api/ai/cloud/status`, `/api/ai/rag/*`,
`/api/ai/assistant(+history)`, `/api/ai/personal/*`, `/api/ai/tools(+run)`,
`/api/ai/admin/*`, and `/api/vector/status|search|index-content|index-user`.
New env: `AI_PROVIDER`, `AI_API_KEY`, `AI_MODEL`, `AI_TIMEOUTMS`,
`VECTOR_BACKEND`, `QDRANTURL`, `QDRANTAPIKEY`, `PINECONEURL`,
`PINECONEAPIKEY` (Phase-4 block in [`.env.example`](.env.example)).

```bash
curl -s http://localhost:8080/api/ai/cloud/status
curl -s -X POST http://localhost:8080/api/vector/search \
  -H 'content-type: application/json' -d '{"query":"mecha anime","topK":3}'
```

## Environment variables

See [`.env.example`](.env.example) — the complete, commented reference. Names
follow the Animaxia house style: **no underscores** (`DATABASEURL`, `TMDBAPIKEY`,
`CACHETTLMS`, `AUTHPORT`…) with a few frozen legacy exceptions
(`RATELIMITWINDOW_MS`, `PROVIDERCACHETTL_MS`, `MINERMAXHTML_BYTES`, …).
Never invent new underscore names.

## The frontend

The Next.js frontend ships separately in the `animaxia-platform` ZIP; it targets
the Phase-1/2 monolith API (port 4000, reached through the sandbox gateway via
`?XTransformPort=4000`). Animaxia Cloud serves the **same route surface** from
the gateway on `:8080` (route allocation table in [BLUEPRINT §3](BLUEPRINT.md)),
so pointing a deployment's `BACKEND_PORT`/proxy at `http://localhost:8080`
switches the platform to microservices with zero frontend changes.

## Phase 5 — Animaxia Mobile App

`animaxia-mobile/` — the Android + iOS client (React Native, Expo SDK 52,
expo-router, TypeScript strict), shipped inside this ZIP. It talks to ONE
origin — the gateway `:8080` (or the monolith `:4000` in dev) — with a single
config knob: `EXPO_PUBLIC_API_URL` (`.env` / EAS build profiles).

- **Auth** — JWT access (15 min) + rotating refresh (30 d) in SecureStore;
  the HTTP core auto-refreshes on 401 (single-flight) and retries once.
- **Home / Player** — mobile BFF payloads (`/api/mobile/home`,
  `/api/mobile/player/:id`); expo-av native playback (mp4/HLS) with
  view/play/complete analytics + throttled progress saves; offline
  stale-while-error cache on AsyncStorage.
- **AI Cloud on mobile** — personal daily picks, because-you-watched, weekly
  recap, RAG explain / more-like-this / chat-with-content and the
  animaxiaAssistant chat with tool traces — quota-aware per plan
  (free 10 / plus 100 / pro 500 AI calls a day, live meter in the UI).
- **Social / Watchlist / Premium** — cursor-paginated feeds, optimistic
  watchlist, plan catalog + sandbox/Stripe checkout confirm flow.

```bash
cd animaxia-mobile && npm install && cp .env.example .env
# point EXPO_PUBLIC_API_URL at the gateway, then:
npx expo start            # Expo Go / emulator / simulator
eas build -p android --profile production   # release builds (see README.md)
```

Architecture, endpoint map and full Android/iOS build steps:
[`animaxia-mobile/README.md`](animaxia-mobile/README.md) ·
[BLUEPRINT §15](BLUEPRINT.md).

## Platform packages in this ZIP (platform map)

Beyond the Animaxia Cloud core at the ZIP root (`services/`, `domain/`,
`common/`, `deploy/`, `observability/`, `cdn/`, `disaster-recovery/`), the
archive carries the additive platform packages, one prefix per delivery phase:

| Prefix | Phase | Contents |
|---|---|---|
| `animaxia-mobile/` | Phase 5 | React Native / Expo client (Android + iOS). |
| `animaxia-desktop/` | Phase 6–7 | Electron desktop app (mini-player, tray, offline). |
| `animaxia-edge/` | FAZA 8–11 | Cloudflare Workers: gateway (WAF/rate/cache), search, ai, auth, player, analytics, cron + `tests/` (smoke/e2e/tenant) + `shared/` (cache, tenant, **shard**, jwt, waf…). |
| `animaxia-ops/` | FAZA 9 + | Ops kit: metrics doc, dashboards (**db-shards** incl.), alerts (**ShardDown**, **SearchClusterNodeDown** incl.), runbooks, synthetics (46 checks incl. the `shards` suite). |
| `animaxia-social/` | FAZA 10 | Realtime service (:4010, socket.io) + social monolith modules mirror + smoke suite. |
| `animaxia-tenant/` | FAZA 11 | Multi-tenant monolith modules mirror (registry, quotas, billing) + tenant smoke suite. |
| `animaxia-miner/` | FAZA 12 | Ingest + indexing service mirror (job queue, TMDB/Jikan providers) + smoke/e2e. |
| `animaxia-sharding/` | FAZA 13 | **Sharding & Multi-Node**: shard model + migrations + `/api/shards` routes (monolith-modules mirror), search + vector cluster services, frontend Shard Console (`#/admin/shards`), ops mirror and the 31-check live sharding smoke suite. |

Quicklinks: [`animaxia-sharding/README.md`](animaxia-sharding/README.md) ·
[`animaxia-miner/README.md`](animaxia-miner/README.md) ·
[`animaxia-tenant/README.md`](animaxia-tenant/README.md) ·
[`animaxia-social/README.md`](animaxia-social/README.md) ·
[`animaxia-ops/README.md`](animaxia-ops/README.md) ·
[`animaxia-edge/README.md`](animaxia-edge/README.md).

The monolith itself (mini-services/animaxia-backend, port 4000) stays outside
the ZIP by design (only its `.env` ships at the root as the credential
reference); every phase mirrors its new monolith modules under its own prefix.

## License

MIT (placeholder — adjust before public release).
