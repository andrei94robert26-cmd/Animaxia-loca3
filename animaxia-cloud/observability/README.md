# Animaxia Cloud — Observability Stack

Metrics (Prometheus), logs (Loki + Promtail), traces (Tempo via the OpenTelemetry
Collector) and dashboards (Grafana) for all 10 Animaxia microservices.

## Architecture

```
                          ┌────────────────────────────────────────────────┐
                          │              every microservice                │
   gateway :8080  ──┐     │  • GET /metrics   (Prometheus text, zero-dep   │
   auth     :4001   │     │    exporter in common/metrics.js)              │
   content  :4002   │     │  • stdout logs    (single-line JSON —          │
   ai       :4003   ├──┐  │    common/logger.js, Loki-friendly)            │
   analytics:4004   │  │  │  • OTLP spans     (W3C traceparent, fire-and-  │
   search   :4005   │  │  │    forget → common/telemetry.js)               │
   premium  :4006   │  │  └────────────────────────────────────────────────┘
   social   :4007   │  │
   mobile   :4008   │  │
   queue    :4009 ──┘  │
        │              │
        │  scrape /metrics (docker DNS)
        ▼              ▼
 ┌──────────────┐  ┌───────────────┐   ┌──────────────────────┐
 │  PROMETHEUS  │  │    PROMTAIL   │   │  OTEL-COLLECTOR      │
 │  :9090       │  │  (docker.sock │   │  :4317 gRPC :4318 http│
 │  + rules/    │  │   animaxia-*  │   │  batch → tempo        │
 └──────┬───────┘  │   containers) │   └──────────┬───────────┘
        │          └──────┬────────┘              │
        │                 ▼                       ▼
        │           ┌──────────┐           ┌──────────┐
        └──────────►│  GRAFANA │◄──────────│  TEMPO   │
            :3001   │  :3000   │  traces   │  :3200   │
                    └──────────┘           └──────────┘
```

## Run it

The stack is a compose overlay on top of the main service stack:

```bash
cd deploy/docker
docker compose -f docker-compose.yml -f docker-compose.observability.yml up -d
```

The overlay attaches to the same `animaxia` network, so Prometheus scrapes the
services by Docker DNS names and the services' `OTELSENDPOINT`
(`http://otel-collector:4318/v1/traces`) resolves automatically.

**Host-dev profile** — services running with `bun run dev` on the host instead
of Docker: uncomment `extra_hosts: ["host.docker.internal:host-gateway"]` on the
prometheus service and switch the scrape jobs to the `-host` profile documented
in [`prometheus/prometheus.yml`](prometheus/prometheus.yml).

## URLs

| Service | URL | Notes |
|---|---|---|
| Grafana | http://localhost:3001 | admin / admin (host port 3001 — the Next.js frontend owns 3000) |
| Prometheus | http://localhost:9090 | UI at `/`, alerts at `/alerts` |
| Loki | http://localhost:3100 | `/ready`, `/loki/api/v1/...` |
| Tempo | http://localhost:3200 | trace store + API |
| OTLP ingest | http://localhost:4318 (HTTP) · :4317 (gRPC) | collector receivers |
| Collector metrics | otel-collector:8889 (internal) | OTLP→Prometheus exporter, not published |

## Dashboards (auto-provisioned)

### Animaxia Cloud — Overview (`animaxia-overview`)
Fleet health (per-service up/down stats), request rate / 5xx error ratio /
p50-p95-p99 latency / cache hit ratio by service, RSS memory + event-loop lag,
circuit-breaker states, rate-limited totals, top-10 slowest routes, and a live
log tail of all services.

### Animaxia Cloud — Queue & Workers (`animaxia-queue`)
Pending / running / done / dead stats, queue depth by job type, job duration
p95 by type, worker task runs (ok/fail) and heartbeat age, dead-letter table.

Datasources are provisioned too: `animaxia-prom` (Prometheus),
`animaxia-loki` (Loki), `animaxia-tempo` (Tempo, with traces→logs linking by
the `service` tag).

## Alerts (`prometheus/rules/animaxia-alerts.yml`)

| Alert | Severity | Meaning | First response |
|---|---|---|---|
| `AnimaxiaServiceDown` | critical | `up{job=~"animaxia-.*"} == 0` for 1m | check service logs / restart deployment |
| `AnimaxiaGatewayUpstreamDown` | warning | gateway probe: an upstream missed `/health` 2m | `kubectl rollout status` / docker logs |
| `AnimaxiaHighErrorRate` | critical | 5xx ratio > 5% over 5m | check error logs for the service label |
| `AnimaxiaCircuitOpen` | warning | a circuit breaker is open 1m | inspect `GET /api/gateway/routes` breaker states |
| `AnimaxiaHighLatency` | warning | p95 latency > 1s for 5m | slowest-routes panel, DB probe |
| `AnimaxiaEventLoopLag` | warning | event loop lag > 0.5s for 5m | CPU saturation / hot loop |
| `AnimaxiaMemoryPressure` | warning | RSS > 450MB for 10m | check HPA / raise limits |
| `AnimaxiaQueueBacklog` | warning | pending jobs > 100 for 10m | `GET /api/queue/stats`, worker health |
| `AnimaxiaDeadLetters` | warning | new dead letters in the last hour | inspect job `lasterror`, retry or fix |
| `AnimaxiaWorkerStalled` | critical | worker heartbeat older than 300s | restart the service pod |

No Alertmanager is bundled yet — firing alerts surface in the Prometheus UI
(`/alerts`) and the alert panels in Grafana; wiring Alertmanager with
notification channels is future work.

## Metrics reference (per-service families)

`animaxia_http_requests_total{service,method,route,status}` ·
`animaxia_http_request_duration_seconds{service,method,route}` (buckets
.005…10s) · `animaxia_uptime_seconds` · `animaxia_memory_rss_bytes` ·
`animaxia_memory_heap_used_bytes` · `animaxia_event_loop_lag_seconds` ·
`animaxia_cache_hits_total` / `animaxia_cache_misses_total` ·
`animaxia_rate_limited_total` · `animaxia_circuit_state{service,breaker}`
(0 closed / 1 half-open / 2 open) · `animaxia_gateway_upstream_up{service}` ·
`animaxia_queue_depth{type,status}` · `animaxia_queue_job_duration_seconds{type}` ·
`animaxia_worker_last_heartbeat_seconds` / `animaxia_worker_task_runs_total{ok}`.

Recording rules (`animaxia-recordings` group): `animaxia:http_request_rate:5m`,
`animaxia:http_error_ratio:5m`, `animaxia:cache_hit_ratio:5m`.

## Distributed tracing

Every service middleware chain includes `traceMiddleware` (W3C `traceparent`):
the gateway injects a trace id per request and propagates it to upstreams via
`serviceFetch` (CLIENT spans); each service records its SERVER span and ships
spans as OTLP/HTTP JSON to the collector (sampled by `OTELSAMPLERATE`, disabled
by `TRACINGENABLED=false`). The gateway also returns the trace id in the
`x-trace-id` response header — paste it into **Grafana → Explore → Tempo**
(TraceQL: `<trace-id>`) to see the full cross-service waterfall. Tempo's
traces→logs linking (by `service` tag) jumps straight to the correlated Loki
lines.

## Kubernetes notes

This compose stack is for local docker. On Kubernetes the Deployments in
[`deploy/k8s/`](../deploy/k8s/) already carry the canonical scrape annotations
(`prometheus.io/scrape`, `prometheus.io/port`, `prometheus.io/path`) — run a
Prometheus Operator `ServiceMonitor`/`PodMonitor` against them, or reuse these
rule files verbatim in an Alertmanager-enabled Prometheus. Bundling
kube-prometheus into the repo is future work.
