# Animaxia Cloud — Helm Chart

Installs the complete Animaxia Cloud platform: 10 microservices (gateway 8080,
auth 4001, content 4002, ai 4003, analytics 4004, search 4005, premium 4006,
social 4007, mobile 4008, queue 4009), a shared ConfigMap + Secret wiring,
ClusterIP Services, HPAs, PDBs, an optional nginx Ingress, the shared data PVC
and the queue CronJobs.

The raw-manifest twin lives in [`../../k8s/`](../../k8s/) — use **either**,
not both, per namespace.

## Install

```bash
# 1) create the secrets out-of-band (preferred over env.secret):
kubectl create namespace animaxia
kubectl -n animaxia create secret generic animaxia-secrets \
  --from-literal=DATABASEURL='postgresql://user:pass@host/db?sslmode=require' \
  --from-literal=AUTHSECRET="$(openssl rand -hex 32)" \
  --from-literal=TMDBAPIKEY='<tmdb-key>' \
  --from-literal=STRIPESECRETKEY='sk_test_...' \
  --from-literal=FOOTBALLDATAAPI_KEY='<football-data-key>' \
  --from-literal=ADMINEMAILS='admin@animaxia.local' \
  --from-literal=OTELSENDPOINT='http://otel-collector.observability.svc.cluster.local:4318/v1/traces'

# 2) install
helm upgrade --install animaxia deploy/helm/animaxia-cloud \
  --namespace animaxia \
  -f deploy/helm/animaxia-cloud/values.yaml

# production overrides (pinned tag, TLS ingress, bigger HPAs, RWM storage…):
helm upgrade --install animaxia deploy/helm/animaxia-cloud \
  --namespace animaxia \
  -f deploy/helm/animaxia-cloud/values-production.yaml
```

Dev-friendly (chart renders its own placeholder Secret — NOT for production):

```bash
helm upgrade --install animaxia deploy/helm/animaxia-cloud \
  --namespace animaxia --create-namespace \
  --set existingSecret= \
  --set env.secret.DATABASEURL='postgresql://...' \
  --set env.secret.AUTHSECRET="$(openssl rand -hex 32)"
```

## Upgrade / rollback

```bash
helm upgrade animaxia deploy/helm/animaxia-cloud --namespace animaxia --reuse-values \
  --set image.tag=3.0.1                      # rolling deploy (config checksums restart pods)

helm history animaxia -n animaxia
helm rollback animaxia 1 -n animaxia

# scale out a service without editing values:
helm upgrade animaxia deploy/helm/animaxia-cloud -n animaxia --reuse-values \
  --set services.content.maxReplicas=12
```

## Uninstall

```bash
helm uninstall animaxia -n animaxia
# PVC "animaxia-data" and the manually-created Secret survive; remove with:
kubectl -n animaxia delete pvc -l app.kubernetes.io/instance=animaxia
kubectl -n animaxia delete secret animaxia-secrets
```

## Values Highlights

| Key | Default | Notes |
|-----|---------|-------|
| `global.imageRegistry` | `ghcr.io` | prefixed onto every service image |
| `image.repository` / `image.tag` | `animaxia` / `3.0.0` | final image `ghcr.io/animaxia/<key>-service:<tag>` |
| `services.<key>.enabled` | `true` | skip a service entirely |
| `services.<key>.replicas` | per service | used verbatim when `autoscaling.enabled=false` |
| `services.<key>.minReplicas` / `maxReplicas` | per service | HPA bounds (gateway 2–10, content 2–8, ai 1–6, search 2–6, others 2–4, queue 1–3) |
| `services.<key>.resources` | 100m/128Mi → 500m/512Mi | gateway limits are tighter (256Mi) |
| `env.config` | full set | non-secret ConfigMap (house-style env names — see root `.env.example`) |
| `env.secret` | REPLACE_ME | only rendered when `existingSecret` is "" |
| `existingSecret` | `animaxia-secrets` | preferred way to supply secrets |
| `serviceAccount.create` | `true` | single shared SA, automount disabled |
| `ingress.enabled` / `host` | `true` / `animaxia.local` | nginx class, `tls.enabled=false` by default |
| `autoscaling.enabled` / `defaultTargetCPU` | `true` / `70` | PDBs auto-created for multi-replica services |
| `queue.cronJobs.enabled` / `schedules` | `true` | 6 schedules mirroring BLUEPRINT §11 (tmdb/jikan refresh, cleanups, reindex) |
| `queue.retentionDays` | `7` | `QUEUERETENTIONDAYS` (30 in production values) |
| `observability.otelEndpoint` | `""` | injected as `OTELSENDPOINT` into every Deployment when set |
| `persistence.*` | 10Gi RWO | shared PVC mounted by content + queue at `/app/data` |
| `workerJob.enabled` / `jobType` | `false` / `indexing.batch` | on-demand enqueue Job (analytics.batch / providers.refresh variants via `--set`) |

See `values.yaml` for the complete, commented reference and
`values-production.yaml` for a hardened production profile.

## Rendering / debugging

```bash
helm template animaxia deploy/helm/animaxia-cloud -n animaxia | less   # render locally
helm lint deploy/helm/animaxia-cloud                                    # lint
helm get manifest animaxia -n animaxia                                  # what's live
kubectl -n animaxia get pods,svc,hpa,pdb,pvc,cronjobs                   # cluster state
```

## Notes

- **Service names are fixed** (`gateway-service`, `auth-service`, …) because
  the `env.config` `*SERVICEURL` entries reference them as in-cluster DNS.
  Overriding `services.<key>.name` requires updating those URLs.
- **PDBs** are rendered only for services with `minReplicas > 1` — a
  single-replica PDB would block node drains (queue-service by design).
- **Pod restarts on config change**: deployments carry
  `checksum/config`+`checksum/secret` annotations computed from the rendered
  ConfigMap/Secret — `helm upgrade` rolls pods automatically.
- **CronJobs vs internal scheduler**: queue-service runs its own scheduler
  (`QUEUESCHEDULERENABLED=true`); the CronJobs are belt & braces and the queue
  dedupes double ticks. Disable either side without data-loss risk.
