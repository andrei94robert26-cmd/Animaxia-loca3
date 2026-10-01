# Animaxia — Dashboards (FAZA 9 — Ops & Observability)

Grafana dashboards covering the observability surfaces of the platform:

| File | Grafana title | UID | Covers |
|---|---|---|---|
| `ai-cloud.json` | Animaxia — AI Cloud | `animaxia-ai-cloud` | LLM call rate & provider mix, latency p50/p95 vs the 1500 ms SLO, errors/degraded fallbacks, token usage, AI quota 402s, vector backend (pgvector), Neon health |
| `edge-gateway.json` | Animaxia — Edge Gateway | `animaxia-edge-gateway` | WAF blocks by rule, rate-limit hits, cache hit ratio + events by state, requests by module, HLS traffic, p95 latency (top 10), errors by module |
| `user-experience.json` | Animaxia — User Experience | `animaxia-ux` | Login success rate, auth failures by status, AI quota 402s by route, player errors (5xx highlighted), the two 99.5% availability SLOs, web/mobile/desktop note |
| `db-shards.json` | Animaxia — DB Shards | `animaxia-db-shards` | FAZA 13 sharding: pool usage per shard (total/idle/waiting), per-shard error rate + connected/healthy stats, search & vector cluster node latency per shard, search cluster health (nodes healthy/total, query + single-flight coalesced rates), vector cluster health (nodes, query/upsert rates) |

Every PromQL expression references the **canonical metric contract**:
[`animaxia-ops/metrics/METRICS.md`](../metrics/METRICS.md). If a metric name or
label changes, change the contract first, then update the producers
(monolith `modules/ops/metrics.js`, edge `shared/metrics.ts`) and these
dashboards together.

## How to use

### Option (a) — import via the Grafana UI

1. Grafana → **Dashboards → New → Import**.
2. Either paste the file contents into the *Import via dashboard JSON model*
   box, or **Upload JSON file** (`ai-cloud.json` / `edge-gateway.json` /
   `user-experience.json` / `db-shards.json`).
3. On the import screen pick the Prometheus datasource. The JSON ships with the
   provisioned datasource uid `animaxia-prom` pre-wired (same convention as
   `animaxia-cloud/observability/grafana/dashboards/animaxia-overview.json`);
   if your datasource has a different uid, select it from the dropdown — every
   panel uses the same one.

### Option (b) — copy into the provisioned dashboards dir

The observability stack already ships Grafana provisioning that scans
`animaxia-cloud/observability/grafana/dashboards/`:

```bash
cp animaxia-ops/dashboards/*.json animaxia-cloud/observability/grafana/dashboards/
```

The datasource reference (uid `animaxia-prom`, provisioned with the
observability stack) resolves automatically — no manual datasource picking.
Grafana picks the dashboards up on the next provisioning tick (~10s); delete
the files to uninstall.

## Prometheus scrape additions

Only **one new scrape job** is needed — the monolith. The cloud microservice
jobs (`animaxia-gateway`, `animaxia-auth`, `animaxia-content`, `animaxia-ai`,
`animaxia-analytics`, `animaxia-search`, `animaxia-premium`, `animaxia-social`,
`animaxia-mobile`, `animaxia-queue`, `otel-collector`) already exist in
`animaxia-cloud/observability/prometheus/prometheus.yml`. Add:

```yaml
- job_name: animaxia-monolith
  metrics_path: /api/metrics
  static_configs: [{ targets: ["monolith:4000"] }]
```

Notes:

- The target hostname is the Docker compose service name. When the monolith
  runs directly on the host instead, use `host.docker.internal:4000` — the
  same host-dev pattern as the commented jobs at the bottom of
  `prometheus.yml`.
- The job name deliberately keeps the `animaxia-` prefix: the
  `AnimaxiaServiceDown` alert (`up{job=~"animaxia-.*"} == 0`,
  `alerts/alerts.yaml`) picks the new target up for free.
- If a cloud microservice ever emits `route` label values identical to the
  monolith's, scope the affected queries with `job="animaxia-monolith"` to
  keep the SLO ratios monolith-only (today the cloud routes do not collide —
  see METRICS.md §3).

## §edge — where do the `animaxia_edge_*` series come from?

Cloudflare Workers **cannot be scraped directly by Prometheus**: there is no
persistent endpoint reachable from the Docker network, and the per-isolate
counters reset on eviction. Two supported options:

### Option 1 — authenticated scrape via a tiny external exporter

Every worker already exposes its metrics — module workers serve `GET /metrics`
and the gateway serves `GET /edge/metrics`, both behind `requireInternalAuth`
(`Authorization: Bearer ${EDGE_INTERNAL_TOKEN}`, or `EDGE_ADMIN_JWT`). Run a
small exporter (a Docker container or a cron) that:

1. fetches `https://<gateway-worker>/edge/metrics` plus each module worker's
   `/metrics` with the internal bearer token,
2. re-exposes the merged series on its own `/metrics`, stamping a `worker`
   label so per-isolate resets are visible,

and scrape that with Prometheus:

```yaml
- job_name: animaxia-edge
  static_configs: [{ targets: ["edge-exporter:9101"] }]
```

This path preserves the full label detail the dashboards use (`rule`, `route`,
`state`, `module`).

### Option 2 — Cloudflare GraphQL Analytics API (recommended for global aggregates)

For fleet-wide aggregates — WAF blocks, rate-limit hits, cache hit ratio
across all colos — query the Cloudflare GraphQL Analytics API instead, either
with the **Grafana Cloudflare plugin** or a small curl-based exporter on a
cron (`firewallEventsAdaptive` for WAF, `httpRequestsAdaptiveGroups` for
requests/cache status, `rateLimitAnalytics` for 429s). GraphQL aggregates are
immune to isolate resets, which matters for the WAF-spike and cache-hit-ratio
alerts — see [`alerts/README.md`](../alerts/README.md) §Cloudflare for the
alert-side equivalent and the alert policy names.

### Sandbox status

In the current sandbox no edge traffic flows through Cloudflare — the
`animaxia_edge_*` series are fully exercised **hermetically** by the
animaxia-edge test suite (smoke suite 13), so the dashboards can be validated
against a local Prometheus fed from those test runs.
