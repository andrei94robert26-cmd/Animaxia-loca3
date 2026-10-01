# Animaxia — Metric Contract (FAZA 9, canonical)

Every dashboard, alert and synthetic check in `animaxia-ops/` references the
metric names below. If a name changes, change it here first, then update the
producers (monolith `modules/ops/metrics.js`, edge `shared/metrics.ts`) and
consumers together.

Producers:

| Layer | Endpoint | Format | Implementation |
|---|---|---|---|
| Monolith (:4000) | `GET /api/metrics` · `?format=json` | Prometheus text / JSON | `mini-services/animaxia-backend/modules/ops/metrics.js` (canonical copy: `animaxia-ops/metrics/monolith-metrics.js`) |
| Edge module workers | `GET /metrics` · `?format=json` | Prometheus text / JSON | `animaxia-edge/shared/metrics.ts` (`withMetrics` wrapper) |
| Edge gateway | `GET /edge/metrics` (requireInternalAuth) | Prometheus text / JSON | `animaxia-edge/worker/src/index.ts` |
| Cloud microservices (:4001-4009, gateway :8080) | `GET /metrics` per service | Prometheus text | `animaxia-cloud/common/metrics.js` (Phase 3, unchanged) |

---

## 1. Monolith (:4000) — `animaxia_http_*` + pull collectors

Scrape config needed (see `dashboards/README.md`):

```yaml
- job_name: animaxia-monolith
  metrics_path: /api/metrics
  static_configs: [{ targets: ["monolith:4000"] }]
```

| Metric | Type | Labels | Notes |
|---|---|---|---|
| `animaxia_http_requests_total` | counter | `method, route, status` | route normalized (numeric ids → `:id`, ≤4 segments) |
| `animaxia_http_request_latency_ms_bucket/_sum/_count` | histogram | `method, route` | buckets 10/25/50/100/250/500/1000/2500/5000 ms |
| `animaxia_http_server_errors_total` | counter | `method, route` | 5xx only |
| `animaxia_quota_responses_total` | counter | `route` | 402 on `/api/ai*` (AI quota) |
| `animaxia_db_connected` | gauge | — | 1 = PostgreSQL (Neon) driver active |
| `animaxia_db_pool_total` / `_idle` / `_waiting` | gauge | — | pg pool gauges |
| `animaxia_db_driver_info` | gauge | `driver` | `postgres` \| `local-fallback` (=1) |
| `animaxia_cache_hits_total` / `animaxia_cache_misses_total` | counter | — | monolith HTTP cache |
| `animaxia_cache_hit_ratio` / `animaxia_cache_keys` | gauge | — | |
| `animaxia_provider_circuit_state` | gauge | `provider` | 0 closed / 1 half-open / 2 open — providers: tmdb, jikan, tvmaze, youtube, football-data, ergast, rss |
| `animaxia_ai_calls_total` / `_today` | gauge | — | from the llm-core usage ring |
| `animaxia_ai_errors_total` / `animaxia_ai_degraded_total` | gauge | — | degraded = provider fallback fired |
| `animaxia_ai_tokens_total` | gauge | `direction` | `prompt` \| `completion` |
| `animaxia_ai_latency_p50_ms` / `animaxia_ai_latency_p95_ms` | gauge | — | ring-window percentiles |
| `animaxia_ai_calls_by_provider` | gauge | `provider` | z-ai / openai / mock |
| `animaxia_vector_backend_info` | gauge | `backend` | pgvector / mock / qdrant / pinecone (=1 active) |
| `animaxia_vector_documents` | gauge | `kind` | indexed docs (`content`, …) |
| `animaxia_uptime_seconds` / `animaxia_process_memory_rss_bytes` | gauge | — | |

JSON snapshot (`?format=json`) additionally exposes `http.routes[route]` with
`requests / errors5xx / avgMs` and the raw `collectors` namespaces
(`db, cache, providers, ai, vector`).

`GET /api/health` (public, unchanged shape + additive `ai` section):
`status, db{driver, connected, totalItems}, cache, rateLimit, providers[],
player, ai{provider{provider, model, available, lastError, fallback}, quota{plan, used, limit}}`.

## 2. Edge (Cloudflare Workers) — `animaxia_edge_*`

Per-worker isolate counters. In production each worker serves its own
`/metrics` (gateway: `/edge/metrics`, behind `EDGE_INTERNAL_TOKEN` /
`EDGE_ADMIN_JWT`); scrape them with an authenticated Prometheus exporter or
read aggregates via the Cloudflare GraphQL Analytics API
(see `dashboards/README.md` §edge for both options).

| Metric | Type | Labels | Notes |
|---|---|---|---|
| `animaxia_edge_requests_total` | counter | `module, route, status` | module = gateway \| search \| ai \| auth \| player \| analytics \| cron |
| `animaxia_edge_request_latency_ms_bucket/_sum/_count` | histogram | `module, route` | same bucket ladder as the monolith |
| `animaxia_edge_errors_total` | counter | `module` | 5xx + handler throws |
| `animaxia_edge_cache_events_total` | counter | `module, state` | from the `x-edge-cache` tag: `hit, miss, stale, stale-error, bypass, disabled` |
| `animaxia_edge_waf_blocks_total` | counter | `rule` | gateway WAF: `bot, sqli, xss, traversal, null-byte, query-size` |
| `animaxia_edge_cron_runs_total` | counter | `cron` | cron worker, per trigger expression |
| `animaxia_edge_cron_jobs_total` | counter | `job, ok` | per-job outcome (`ok` = `true` \| `false`) |

Rate-limit hits = `animaxia_edge_requests_total{module="gateway",status="429"}`
(route label distinguishes the tier path). HLS traffic =
`animaxia_edge_requests_total{module="player",route="/hls"}` plus
`animaxia_edge_cache_events_total{module="player"}`.

## 3. Cloud microservices (Phase 3, `animaxia-cloud/common/metrics.js`)

Prometheus jobs (already in `animaxia-cloud/observability/prometheus/prometheus.yml`):
`animaxia-gateway` (:8080), `animaxia-auth` (:4001), `animaxia-content` (:4002),
`animaxia-ai` (:4003), `animaxia-analytics` (:4004), `animaxia-search` (:4005),
`animaxia-premium` (:4006), `animaxia-social` (:4007), `animaxia-mobile` (:4008),
`animaxia-queue` (:4009), `otel-collector` (:8889).

| Metric | Type | Labels |
|---|---|---|
| `animaxia_http_requests_total` | counter | `service, method, route, status` (see common/metrics.js for exact label set) |
| `animaxia_http_request_duration_seconds` | histogram | `service, …` |
| `animaxia_uptime_seconds`, `animaxia_memory_rss_bytes`, `animaxia_memory_heap_used_bytes`, `animaxia_event_loop_lag_seconds` | gauge | — |
| `animaxia_cache_hits_total` / `animaxia_cache_misses_total` | counter | `service` |
| `animaxia_rate_limited_total` | counter | `service` |

> Note: the monolith latency unit is **milliseconds** (metric name says `_ms`);
> the cloud services histogram is **seconds** (`_seconds`, standard Prometheus
> convention). Dashboards must use `* 1000` when mixing the two.

## 4. SLO targets (FAZA 9 mandate)

| SLO | Target | Query basis |
|---|---|---|
| Availability `/api/mobile/home` | ≥ 99.5% (28d) | monolith `animaxia_http_requests_total{route="/api/mobile/home"}` — success = non-5xx |
| Availability `/api/ai/personal/home` | ≥ 99.5% (28d) | monolith `animaxia_http_requests_total{route="/api/ai/personal/home"}` |
| Availability edge gateway | ≥ 99.5% (28d) | `animaxia_edge_requests_total{module="gateway"}` |
| AI endpoint latency | p95 < 1500 ms | monolith `animaxia_http_request_latency_ms` on `/api/ai/*` routes |
| Error budget alert | error rate > 2% for 10m | any SLO route (see `alerts/alerts.yaml`) |

Recording rules and alert expressions live in `alerts/slo.yaml` +
`alerts/alerts.yaml`; they reference only the metric names in this contract.

---

## 5. FAZA 10 — Social & Realtime metrics (additive)

### Realtime service (:4010) — `animaxia_realtime_*`

Producer: `mini-services/animaxia-realtime/index.js` (`renderMetrics()`), exposed at
`GET http://localhost:4010/metrics` (Prometheus text, no auth). Counters are per-process
(reset on restart — the service owns nothing durable, rooms re-seed from the monolith).

Suggested scrape job:

```yaml
- job_name: animaxia-realtime
  metrics_path: /metrics
  static_configs: [{ targets: ["localhost:4010"] }]
```

| Metric | Type | Labels | Help text (verbatim) |
|---|---|---|---|
| `animaxia_realtime_sockets_connected` | gauge | — | Currently connected sockets. |
| `animaxia_realtime_party_rooms` | gauge | — | Watch-party rooms with live state. |
| `animaxia_realtime_party_joins_total` | counter | — | Party room joins since boot. |
| `animaxia_realtime_control_events_total` | counter | — | Host control events relayed since boot. |
| `animaxia_realtime_chat_messages_total` | counter | `persisted` | Party chat messages relayed (persisted flag). |
| `animaxia_realtime_activity_broadcasts_total` | counter | — | Live activity events broadcast since boot. |
| `animaxia_realtime_persist_errors_total` | counter | — | Monolith persistence failures since boot. |
| `animaxia_realtime_http_requests_total` | counter | `route` | HTTP requests by route (`info`, `health`, `metrics`, `internal-activity`). |
| `animaxia_realtime_uptime_seconds` | gauge | — | Uptime in seconds. |

Operational reading (see `../runbooks/social-realtime-degraded.md`):
`animaxia_realtime_persist_errors_total` climbing = the realtime service cannot reach the
monolith (degraded chat persistence); `internal-activity` requests counting while
`activity_broadcasts_total` stays flat = webhook token mismatch (401s, silent on the
monolith side by design).

### Monolith coverage of the social routes — automatic

The FAZA-9 middleware (`modules/ops/metrics.js`, `GET /api/metrics`) needs **no changes**
for FAZA 10: every new `/api/social/*` and `/api/ai/social/*` route is counted automatically
in `animaxia_http_requests_total` / `animaxia_http_request_latency_ms_*` /
`animaxia_http_server_errors_total`, with the usual route normalization (numeric ids →
`:id`, ≤ 4 segments). Verified live, e.g.:

```text
animaxia_http_requests_total{method="POST",route="/api/social/reviews",status="201"}
animaxia_http_requests_total{method="GET",route="/api/social/party/:id",status="200"}
animaxia_http_requests_total{method="POST",route="/api/ai/social/review-digest",status="200"}
```

---

## 6. FAZA 13 — Sharding metrics (additive)

Producer: the same monolith endpoint `GET /api/metrics`
(`mini-services/animaxia-backend/modules/ops/metrics.js`, canonical mirror
`animaxia-ops/metrics/monolith-metrics.js`) — a new `registerShardingCollectors()`
wiring (called in `server.js` right after `registerStandardCollectors`) attaches
the **`shards` pull collector**. Every FAZA 9 name/label above is unchanged; the
unlabeled `animaxia_db_pool_*` legacy lines remain and the shard-labeled gauges
are emitted **alongside** them. Each sub-call (pools / search / searchHealth /
vector / vectorHealth) is individually try/caught — a failing cluster degrades
to `{error:'collector_failed'}` for that part only and the rest of the scrape
survives.

`GET /api/metrics?format=json` exposes the same data under
`collectors.shards` (`pools`, `search`, `searchHealth`, `vector`,
`vectorHealth`); `GET /api/shards` and `GET /api/shards/health` (Task 13-3)
serve the composite status/synthetics view.

### Per-shard DB pools (registry: `db.js listShardPools()`, one entry per shard)

| Metric | Type | Labels | Notes |
|---|---|---|---|
| `animaxia_db_shard_pool_total` / `_idle` / `_waiting` | gauge | `shard, branch, mode` | pg pool gauges per shard; `mode` = `main` (logical — shared main Neon pool) \| `branch` (physical — dedicated `SHARD{N}URL` Neon branch pool) |
| `animaxia_db_shard_connected` | gauge | `shard, branch` | 1 = pool connected (main mode mirrors the main pool driver; branch mode = last query succeeded) |
| `animaxia_db_shard_healthy` | gauge | `shard, branch` | 1 = pool healthy; main-mode entries mirror `connected` (the registry tracks no separate flag there) |
| `animaxia_db_shard_queries_total` | counter | `shard` | queries routed through `queryOnShard(shard, …)` since boot (real in logical AND physical mode) |
| `animaxia_db_shard_errors_total` | counter | `shard` | failed first attempts on that shard (branch mode: each fallback to main counts one error) |

### Search cluster (`services/search-cluster/index.js`, FTS fan-out per shard)

| Metric | Type | Labels | Notes |
|---|---|---|---|
| `animaxia_search_cluster_enabled` | gauge | — | 1 = `SEARCHCLUSTENABLED=true` (0 → `/api/search/advanced` serves the legacy single-node path) |
| `animaxia_search_cluster_queries_total` | counter | — | fan-out queries served by the cluster since boot |
| `animaxia_search_cluster_errors_total` | counter | — | node failures (a query only 503s when ALL nodes fail) |
| `animaxia_search_cluster_coalesced_total` | counter | — | identical concurrent queries collapsed by the FAZA 17-style single-flight |
| `animaxia_search_cluster_nodes_healthy` / `_nodes_total` | gauge | — | live from the shard pool registry |
| `animaxia_search_cluster_latency_p50_ms` / `_latency_p95_ms` | gauge | — | rolling 50-query window percentiles |
| `animaxia_search_cluster_node_healthy` | gauge | `shard` | 1 = node health ping (SELECT 1) + doc count passed |
| `animaxia_search_cluster_node_docs` | gauge | `shard` | `COUNT(*) WHERE shardid = n` on searchdocs |
| `animaxia_search_cluster_node_latency_ms` | gauge | `shard` | node health round-trip in ms |

### Vector cluster (`services/vector-cluster/index.js`, pgvector fan-out with tenant/hint affinity)

| Metric | Type | Labels | Notes |
|---|---|---|---|
| `animaxia_vector_cluster_enabled` | gauge | — | 1 = `VECTORCLUSTENABLED=true` (0 → legacy single-pool pgvector path) |
| `animaxia_vector_cluster_queries_total` | counter | — | similarity queries served by the cluster since boot |
| `animaxia_vector_cluster_errors_total` | counter | — | node failures (fallback to the backend search never fails a user query) |
| `animaxia_vector_cluster_upserts_total` | counter | — | upserts routed per the vectorref shard rule |
| `animaxia_vector_cluster_nodes_healthy` / `_nodes_total` | gauge | — | live from the shard pool registry |
| `animaxia_vector_cluster_latency_p50_ms` / `_latency_p95_ms` | gauge | — | rolling 50-query window percentiles |
| `animaxia_vector_cluster_node_healthy` | gauge | `shard` | per-node health ping result |
| `animaxia_vector_cluster_node_docs` | gauge | `shard` | `COUNT(*) WHERE shardid = n` on vectorembeddings |
| `animaxia_vector_cluster_node_latency_ms` | gauge | `shard` | node health round-trip in ms |

Consumers: dashboard `animaxia-ops/dashboards/db-shards.json` (*Animaxia — DB
Shards*), alerts `AnimaxiaShardDown` / `AnimaxiaSearchClusterNodeDown`
(`alerts/alerts.yaml`, group `animaxia-sharding-alerts`), synthetics suite
`shards` (`synthetics/run.mjs`), runbooks
[`../runbooks/shard-down.md`](../runbooks/shard-down.md) +
[`../runbooks/search-cluster-node-down.md`](../runbooks/search-cluster-node-down.md).
