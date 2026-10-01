# Animaxia Cloud — Docker Local Stack

Full local development stack: **10 microservices** (gateway + 9 domain services)
built from per-service Dockerfiles with bun, wired together on a private bridge
network, fronted by the API gateway on **http://localhost:8080**.

| File | Purpose |
|------|---------|
| `docker-compose.yml` | The full local stack (this README explains how to run it) |
| `Dockerfile.template` | Canonical per-service Dockerfile (BLUEPRINT §8). Each service keeps a substituted copy at `services/<name>/Dockerfile` — the service agents own those |
| `docker-compose.observability.yml` | Observability overlay (Prometheus, Grafana, Loki + promtail, OTel Collector, Tempo) — **owned by agent 2-j**, same folder |
| `docker-compose.debug.yml` *(optional, yours to create)* | Debug overlay exposing service ports on the host — see [Debug profile](#debug-profile-exposing-service-ports) |

## Prerequisites

- **Docker Engine 24+** with the Compose v2 plugin — check with:
  ```bash
  docker compose version
  ```
- **bun** (optional) — only needed for non-Docker local dev (`bun run dev`) or
  to regenerate `bun.lock`. The containers themselves use `oven/bun:1.2-alpine`,
  so no local bun install is required to run the stack.
- **A reachable PostgreSQL** (e.g. Neon) — the services share one external
  database via `DATABASEURL`.
- **Repo root `.env`** — compose injects it into every container and **fails
  fast if it is missing**:
  ```bash
  cd /path/to/animaxia-cloud
  cp .env.example .env    # then fill in DATABASEURL, AUTHSECRET, TMDBAPIKEY, ...
  ```

## Build & run

From this directory (`deploy/docker/`):

```bash
docker compose up -d --build
```

First build compiles 10 images (bun workspace install per service) — a few
minutes. Subsequent starts are instant. The gateway waits (via
`depends_on: service_healthy`) until all nine microservices pass their
`/health` checks.

Watch the stack come up:

```bash
docker compose ps          # STATE should reach "running (healthy)"
```

## The gateway

- **API entry point:** http://localhost:8080
- **Smoke test** (aggregated health — the gateway fans out to every service):
  ```bash
  curl http://localhost:8080/api/health
  ```
- The gateway's own liveness endpoint: `curl http://localhost:8080/health`
- Route table & breaker states: `curl http://localhost:8080/api/gateway/routes`

Only the gateway is exposed to the host by default; the microservices
(4001–4009) talk to each other inside the `animaxia` bridge network via Docker
DNS (`http://auth-service:4001`, `http://content-service:4002`, …).

## Service & image reference

| Service | Port | Image (built by compose) | Gateway prefix |
|---------|------|--------------------------|----------------|
| gateway-service | 8080 | `ghcr.io/animaxia/gateway-service:local` | — (is the gateway) |
| auth-service | 4001 | `ghcr.io/animaxia/auth-service:local` | `/api/auth`, `/api/users`, `/api/security` |
| content-service | 4002 | `ghcr.io/animaxia/content-service:local` | `/api/all`, `/api/content`, `/api/miner`, `/api/admin`, `/api/anime`, `/api/movies`, `/api/tv`, `/api/sports`, `/api/news`, `/api/cache` |
| ai-service | 4003 | `ghcr.io/animaxia/ai-service:local` | `/api/ai` |
| analytics-service | 4004 | `ghcr.io/animaxia/analytics-service:local` | `/api/analytics` |
| search-service | 4005 | `ghcr.io/animaxia/search-service:local` | `/api/search` |
| premium-service | 4006 | `ghcr.io/animaxia/premium-service:local` | `/api/premium` |
| social-service | 4007 | `ghcr.io/animaxia/social-service:local` | `/api/social` |
| mobile-service | 4008 | `ghcr.io/animaxia/mobile-service:local` | `/api/mobile` |
| queue-service | 4009 | `ghcr.io/animaxia/queue-service:local` | `/api/queue`, `/api/workers` |

Compose tags the local builds `:local`. CI builds and pushes the same images as
`ghcr.io/animaxia/<service>:<git-sha>` and `:latest` (see
`.github/workflows/`).

### Building a single image manually (BLUEPRINT §8)

Build context is **always the repo root** — from `animaxia-cloud/`:

```bash
docker build -f services/auth-service/Dockerfile -t ghcr.io/animaxia/auth-service:local .
```

## Logs

```bash
docker compose logs -f                          # everything, follow
docker compose logs -f gateway-service          # one service
docker compose logs --tail=100 content-service  # last 100 lines
docker logs animaxia-queue-service              # by fixed container name
```

Logs are single-line JSON (Loki-friendly): `docker compose logs -f | jq .` if
you want them pretty.

## Scaling a service

The gateway proxies by service name (e.g. `http://content-service:4002`), and
Docker's embedded DNS resolves a service name to **all its replicas
round-robin** — so extra replicas share the load automatically, with zero
gateway reconfiguration:

```bash
docker compose up -d --scale content-service=3
docker compose ps          # 3 × animaxia-content-service containers
curl http://localhost:8080/api/content   # hits a different replica each time
docker compose up -d --scale content-service=1   # scale back down
```

**One caveat:** `docker-compose.yml` pins each service with `container_name`
(`animaxia-content-service`, …), and a pinned name allows only one container.
Before scaling a service, comment out its `container_name:` line (compose then
auto-names the replicas `animaxia-cloud-<service>-1/2/3…`). The shared
`animaxia-data` volume is mounted into every replica — fine for the
read-mostly thumbnail store; treat the local fallback store as a cache, not a
source of truth (Postgres is).

## Rebuilding one service

```bash
docker compose up -d --build content-service   # rebuild + recreate just this one
# or, explicitly:
docker compose build search-service && docker compose up -d search-service
```

Handy after you edit files under `services/<name>/`, `common/` or `domain/` —
the build context is the whole repo root, so shared-workspace changes rebuild
whichever service you name.

## Observability stack

Metrics, logs, traces and dashboards live in
`docker-compose.observability.yml` (same folder, owned by agent 2-j). Merge it
on top of the base stack:

```bash
docker compose -f docker-compose.yml -f docker-compose.observability.yml up -d
```

Every service already points `OTELSENDPOINT` at the OTel Collector
(`http://otel-collector:4318/v1/traces`), so traces flow as soon as the
collector is up — and because the exporter is fire-and-forget, services are
unaffected when the observability overlay is not running. Plain
`GET /metrics` (Prometheus text) is available on every service, e.g. through
the debug profile below.

## Debug profile (exposing service ports)

To hit a microservice directly from the host — its `/metrics`, `/health` or a
raw API — either uncomment the `ports:` hint on that service in
`docker-compose.yml`, or create `docker-compose.debug.yml`:

```yaml
# deploy/docker/docker-compose.debug.yml
services:
  auth-service:
    profiles: [debug]          # only starts with --profile debug
    ports: ["4001:4001"]
  content-service:
    profiles: [debug]
    ports: ["4002:4002"]
  # ... ai-service 4003, analytics-service 4004, search-service 4005,
  #     premium-service 4006, social-service 4007, mobile-service 4008,
  #     queue-service 4009
```

```bash
docker compose -f docker-compose.yml -f docker-compose.debug.yml --profile debug up -d
curl http://localhost:4002/metrics
```

Note the profile semantics: a service tagged `profiles: [debug]` is **skipped**
by plain `docker compose up` and only runs when the profile is enabled — which
is why the exposure belongs in an overlay, not on the always-on stanzas.

## Cleanup

```bash
docker compose down                     # stop + remove containers (keeps volumes + images)
docker compose down -v                  # ... also drops the animaxia-data volume
docker compose down --rmi local         # ... also removes the locally built images
docker compose down -v --remove-orphans # full nuke incl. overlay leftovers
```

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `env file .../.env not found` | `cp .env.example .env` at the repo root, fill in `DATABASEURL` |
| Services build but stay `unhealthy` | Check `docker compose logs auth-service` — usually `DATABASEURL` unreachable or missing `?sslmode=require` |
| Permission denied writing `/app/data` | The image must create `/app/data` owned by uid 10001 (`animaxia`) before the named volume mounts — see `Dockerfile.template` notes in the service's Dockerfile |
| `port is already allocated` (8080) | Another gateway/web server on the host — stop it or remap the left-hand side of `8080:8080` |
| `cannot scale service ... container name already in use` | Comment out that service's `container_name:` before `--scale` (see [Scaling](#scaling-a-service)) |
