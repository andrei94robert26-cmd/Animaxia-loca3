# Animaxia Cloud — Raw Kubernetes Manifests

kubectl-apply-ready manifests for the 10 Animaxia microservices (gateway 8080,
auth 4001, content 4002, ai 4003, analytics 4004, search 4005, premium 4006,
social 4007, mobile 4008, queue 4009) in namespace `animaxia`.

The Helm chart in [`../helm/animaxia-cloud/`](../helm/animaxia-cloud/) renders
an equivalent (more configurable) set — use **either** the raw manifests (small
clusters, learning, kubectl-only ops) **or** the Helm chart (repeatable
environments). Don't apply both for the same namespace.

## Files / apply order

| # | File | Contents |
|---|------|----------|
| 00 | `00-namespace.yaml` | Namespace `animaxia` + labels |
| 01 | `01-configmap.yaml` | ConfigMap `animaxia-config` — ALL non-secret env (house style, see root `.env.example`) incl. in-cluster `*SERVICEURL` DNS entries |
| 02 | `02-secret.yaml` | Secret `animaxia-secrets` — **template with REPLACE_ME placeholders** (see below) |
| 03 | `03-ingress.yaml` | Ingress `animaxia-gateway` (class nginx, host `animaxia.local` → gateway-service:8080) |
| 04 | `04-pvc.yaml` | PVC `animaxia-data` (10Gi, ReadWriteOnce) — mounted by content + queue at `/app/data` |
| 10 | `10-gateway-service.yaml` | gateway Deployment (2 replicas) + Service + HPA 2–10 |
| 11–19 | `11-auth-service.yaml` … `19-queue-service.yaml` | per-service Deployment + Service + HPA (auth 2–4, content 2–8, ai 1–6, analytics 2–4, search 2–6, premium 2–4, social 2–4, mobile 2–4, queue 1–3) |
| 90 | `90-cronjobs.yaml` | 6 CronJobs ticking the queue-service scheduler (tmdb/jikan refresh, cleanup-logs/audit/sessions, reindex) |
| 91 | `91-workerjob.yaml` | on-demand worker Job (enqueue `indexing.batch`) + commented variants |

## Quickstart

```bash
# 1) namespace + config first
kubectl apply -f 00-namespace.yaml
kubectl apply -f 01-configmap.yaml

# 2) create the REAL secret (preferred — do not commit real values):
kubectl -n animaxia create secret generic animaxia-secrets \
  --from-literal=DATABASEURL='postgresql://user:pass@host/db?sslmode=require' \
  --from-literal=AUTHSECRET="$(openssl rand -hex 32)" \
  --from-literal=TMDBAPIKEY='<tmdb-key>' \
  --from-literal=STRIPESECRETKEY='sk_test_...' \
  --from-literal=FOOTBALLDATAAPI_KEY='<football-data-key>' \
  --from-literal=ADMINEMAILS='admin@animaxia.local' \
  --from-literal=OTELSENDPOINT='http://otel-collector.observability.svc.cluster.local:4318/v1/traces'
# (02-secret.yaml is a TEMPLATE only — applying it as-is gives REPLACE_ME values)

# 3) ingress + storage + all services (files 03, 04, 10..19)
kubectl apply -f 03-ingress.yaml -f 04-pvc.yaml
kubectl apply -f 10-gateway-service.yaml -f 11-auth-service.yaml \
  -f 12-content-service.yaml -f 13-ai-service.yaml  -f 14-analytics-service.yaml \
  -f 15-search-service.yaml  -f 16-premium-service.yaml \
  -f 17-social-service.yaml -f 18-mobile-service.yaml -f 19-queue-service.yaml
# or simply: kubectl apply -f . -l app.kubernetes.io/part-of=animaxia-cloud
#            (after creating the secret out-of-band)

# 4) schedulers + on-demand job template (optional)
kubectl apply -f 90-cronjobs.yaml      # belt & braces on top of the internal scheduler
kubectl apply -f 91-workerjob.yaml     # runs an indexing.batch enqueue ONCE (see header)

# 5) watch it come up
kubectl -n animaxia get pods,svc,hpa,pvc -w
```

### Access from your machine

```bash
# port-forward the gateway (simplest):
kubectl -n animaxia port-forward svc/gateway-service 8080:8080
curl http://localhost:8080/api/health   # aggregated health of all services

# or via the ingress (add `127.0.0.1 animaxia.local` to /etc/hosts and point
# the ingress controller's service at 80):
curl http://animaxia.local/api/health
```

Per-service debugging: `kubectl -n animaxia port-forward svc/auth-service 4001:4001`
then `curl http://localhost:4001/health` — every service exposes `/health`,
`/metrics` (Prometheus) and `/` (service info).

## Secrets — the env contract

Non-secret env (tuning, provider base URLs, queue/gateway knobs, in-cluster
service URLs) lives in `animaxia-config`. Secret env lives in
`animaxia-secrets`:

| Key | Notes |
|-----|-------|
| `DATABASEURL` | Neon/Postgres connection string (`PGSSL=true` expected) |
| `AUTHSECRET` | JWT HS256 secret — 32+ random bytes |
| `TMDBAPIKEY` | TMDB v3 key |
| `STRIPESECRETKEY` | `sk_test_…` / `sk_live_…` |
| `FOOTBALLDATAAPI_KEY` | football-data.org X-Auth-Token |
| `ADMINEMAILS` | comma-separated bootstrap admin emails |
| `OTELSENDPOINT` | OTLP/HTTP traces endpoint (in-cluster otel-collector) |

Rotating: `kubectl -n animaxia create secret generic animaxia-secrets
--from-literal=… --dry-run=client -o yaml | kubectl apply -f -` then roll the
deployments (`kubectl -n animaxia rollout restart deploy`).

## Scaling & HPAs

Every service ships an HPA (autoscaling/v2, CPU target 70%; gateway also
memory 80%). Bounds:

| Service | min–max | Notes |
|---------|---------|-------|
| gateway | 2–10 | CPU 70% + memory 80% |
| content | 2–8 | provider-heavy |
| ai | 1–6 | can idle at 1 |
| search | 2–6 | |
| auth, analytics, premium, social, mobile | 2–4 | |
| queue | 1–3 | keep small — workers contend on SKIP LOCKED rows |

Manual override (HPA will fight you unless you pause it):

```bash
kubectl -n animaxia scale deploy/content-service --replicas=4        # one-off burst
kubectl -n animaxia patch hpa content-service -p '{"spec":{"maxReplicas":12}}'
kubectl -n animaxia autoscale deploy/ai-service --min=2 --max=8 --cpu-percent=60  # replace HPA
```

HPAs require metrics-server (`kubectl -n kube-system get deploy metrics-server`);
on minikube: `minikube addons enable metrics-server`.

## Notes

- **Storage**: `animaxia-data` is ReadWriteOnce (single-node). For multi-AZ
  switch to ReadWriteMany or split per-service PVCs (see `04-pvc.yaml` header).
- **Scheduling redundancy**: queue-service runs its own internal scheduler
  (`QUEUESCHEDULERENABLED=true` in the ConfigMap). The CronJobs in
  `90-cronjobs.yaml` are belt & braces; duplicate ticks are deduped.
- **Images**: `ghcr.io/animaxia/<service>:latest` with `imagePullPolicy:
  Always` — pin tags for reproducible deploys (the Helm chart pins `3.0.0`).
- **Probes**: `/health` on each service returns 200 while the process is
  alive (liveness) and includes a `checks.db` readiness detail.

## Removing

```bash
kubectl delete namespace animaxia          # removes everything, incl. the PVC
# or selectively:
kubectl delete -f 90-cronjobs.yaml -f 91-workerjob.yaml
kubectl delete -f 10-gateway-service.yaml -f 11-auth-service.yaml \
  -f 12-content-service.yaml -f 13-ai-service.yaml -f 14-analytics-service.yaml \
  -f 15-search-service.yaml -f 16-premium-service.yaml -f 17-social-service.yaml \
  -f 18-mobile-service.yaml -f 19-queue-service.yaml
kubectl delete -f 03-ingress.yaml -f 04-pvc.yaml -f 01-configmap.yaml
kubectl -n animaxia delete secret animaxia-secrets   # NEVER just apply 02-secret.yaml over a real one
kubectl delete -f 00-namespace.yaml
```
