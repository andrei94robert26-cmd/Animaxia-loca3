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

## 7. FAZA 14 — 30×1B topology & coalesced-logical execution (additive)

The definitive FAZA 14 spec pins `SHARDCOUNT=30` (30 logical shards × 1
billion ids = the **30B logical address space** — volume simulated logically,
real rows stay real in Neon). **No metric names/labels changed**; the notes
below document how the existing FAZA 13 families behave at 30 shards:

| Aspect | Behavior at 30 shards |
|---|---|
| `animaxia_db_shard_pool_*{shard,branch,mode}` | 30 series (s0…s29); logical mode still routes every shard to the main pool — `mode="main"`, `animaxia_db_shard_connected/healthy` mirror the main driver state per shard |
| `animaxia_search_cluster_*` / `animaxia_vector_cluster_*` | unchanged names; in logical mode the clusters now execute **coalesced-logical** — ONE merged query + ONE `GROUP BY shardid` count instead of 2×30 fan-out probes per call, so every `/api/metrics` scrape stays 2 queries per cluster regardless of shard count |
| `*_cluster_node_docs{shard}` / `*_node_latency_ms{shard}` | per-shard docs from the coalesced `GROUP BY shardid`; latency is the single merged probe round-trip reported per covered shard |
| `*_cluster_node_healthy` / `_nodes_healthy` / `_nodes_total` | 30 nodes; `healthy` follows the coalesced ping (all-or-nothing per pool in logical mode) |
| by-shard query counters (`ops.byShard` via `?format=json`) | in coalesced-logical mode each cluster query counts on EVERY covered shard (documented semantics: "cluster queries covering this shard") |

New additive fields (not Prometheus metrics): `/api/shards` and
`/api/search/status` expose `logical: { addressSpace: 30000000000, shardcount,
shardSpan: 1000000000, mode }`; cluster responses expose
`cluster.execution: 'coalesced-logical' | 'fanout'` and health reports
`execution` as well. Consumers: synthetics suites `shards` (topology 30×1B +
logical space + coalesced execution) and `global30b` (the global 30B feed +
universal external player conformance), dashboard
`dashboards/db-shards.json` (unchanged — dynamic per-shard series), and the
`AnimaxiaShardDown` / `AnimaxiaSearchClusterNodeDown` alerts (unchanged —
label-driven, no shard-count math).

## 8. FAZA 15 — Search Flow Control (additive)

The FAZA 15 admission layer (`mini-services/animaxia-backend/modules/search/flow.js`)
sits between the search routes (`/api/search/advanced`, `/api/search/autocomplete`)
and Neon: a **shard-aware priority queue** (high = admin/ops/QA via
`X-Animaxia-Priority`, normal = authenticated, low = anonymous, with
anti-starvation aging: low→normal after `lowPromoteMs`, normal→high after
`normalPromoteMs`) + **windowed dispatch** (at most `batchSize` executions
released every `intervalMs`, bounded by `maxConcurrent`). The FTS queries
themselves are byte-identical to FAZA 14 — **results stay 100% real**; only
admission is controlled. Config: `SEARCHFLOW*` env (see `.env.example`) or
runtime via `POST /api/search/flow/settings` (admin).

All series come from the `'searchflow'` pull collector on the monolith (:4000),
fed by `searchFlowMetricsSnapshot()` (flat shape; `?format=json` exposes it as
`collectors.searchflow`).

| Metric | Type | Labels | Notes |
|---|---|---|---|
| `animaxia_search_flow_enabled` | gauge | — | 1 = queue active (`SEARCHFLOWENABLED≠false`); 0 = FAZA 14 direct execution |
| `animaxia_search_queue_length` | gauge | — | requests currently waiting in the flow queue |
| `animaxia_search_queue_by_priority` | gauge | `priority` | queue length per lane (`high`/`normal`/`low`) |
| `animaxia_search_queue_by_shard` | gauge | `shard` | queue length per shard (sparse — only shards with activity emit series) |
| `animaxia_search_inflight` | gauge | — | executions currently running against Neon (≤ `maxConcurrent`) |
| `animaxia_search_inflight_by_shard` | gauge | `shard` | in-flight executions per shard (sparse) |
| `animaxia_search_window_interval` | gauge | — | configured window interval in ms |
| `animaxia_search_window_batch_size` | gauge | — | configured max dispatches per window |
| `animaxia_search_dropped_requests` | counter | — | queueCap overflows → explicit `503 SEARCH_QUEUE_FULL` (**target 0**; the client always gets a definitive answer, nothing is discarded silently) |
| `animaxia_search_timedout_requests` | counter | — | request-budget expiries → explicit `504 SEARCH_QUEUE_TIMEOUT` (arrival + `REQUESTTIMEOUTMS` − 2.5s execution margin; fires **before** the FAZA 17 resilience 504) |
| `animaxia_search_processed_total` | counter | — | executions completed (success + query errors — Neon saw them) |
| `animaxia_search_processed_by_priority` | counter | `priority` | completions per lane |
| `animaxia_search_wait_ms_p50` / `_wait_ms_p95` | gauge | — | queue wait percentiles over the last 200 completions |
| `animaxia_search_processing_rate` | gauge | — | completions per second over the last 10s |
| `animaxia_search_queue_high_water` | gauge | — | max queue length observed since boot |
| `animaxia_search_queue_capacity` | gauge | — | configured `queueCap` (overflow bound for the saturation alert) |
| `animaxia_search_max_concurrent` | gauge | — | configured `maxConcurrent` (scheduler-level bound; the pg pool `PGPOOLMAX` stays the physical connection ceiling beneath it) |

Non-Prometheus surfaces (same data): `GET /api/search/status` → additive
`flowControl` (pinned contract: `queueEnabled`, `maxConcurrent`, `priorities`
+ live gauges) and `windowing` (`intervalMs`, `batchSize`, `windowsFired`,
`windowDispatches`, `avgBatchSize`); `GET /api/search/flow` → full console
(config + rolling history 180×1s of `queueLength`/`inflight`/`rate`/`dropped`
+ 30-row perShard attribution table); every `/advanced` + `/autocomplete`
response carries `flow: { priority, shardid, queuedMs }`.

Consumers: dashboard `dashboards/search-flow.json` (*Animaxia — Search Flow*),
alerts `AnimaxiaSearchFlowDroppedRequests` / `AnimaxiaSearchFlowQueueSaturation`
/ `AnimaxiaSearchFlowInflightSaturated` (`alerts/alerts.yaml`, group
`animaxia-searchflow-alerts`), synthetics suite `searchflow`
(`synthetics/run.mjs`), runbook
[`../runbooks/search-flow-saturation.md`](../runbooks/search-flow-saturation.md),
admin console `#/admin/search-flow` (queue chart + live gauges + per-shard
table + runtime settings).

## 9. FAZA 16 — Search Rate Management (additive)

The FAZA 16 pacing layer (`mini-services/animaxia-backend/modules/search/rate.js`)
sits in front of the FAZA 15 flow queue and decides **who may search how
often**: a per-user rate limit (one admitted search per user per kind every
`perUserMs`), a post-result cooldown (`cooldownMs` after an `/advanced`
result is received), anti-spam flood protection (≥ `spamThreshold` arrivals
within `spamWindowMs` → auto-block `spamBlockMs`) and passive global burst
detection (`burstThreshold` arrivals per `burstWindowMs` → event only).
Admitted searches flow unchanged into the FAZA 15 queue — **the FTS stays
byte-identical, results 100% real**; every rejection is an explicit
`429 { error, code, retryInMs }` (`rate_limited` / `cooldown_active` /
`spam_blocked`), never a silent drop. `/advanced` and `/autocomplete` pace in
separate lanes (typing never blocks ENTER). Config: `SEARCHRATE*` env (see
`.env.example`) or runtime via `POST /api/search/rate/settings` (admin).

All series come from the `'searchrate'` pull collector on the monolith
(:4000), fed by `searchRateMetricsSnapshot()` (`?format=json` exposes it as
`collectors.searchrate`).

| Metric | Type | Labels | Notes |
|---|---|---|---|
| `animaxia_search_rate_enabled` | gauge | — | 1 = pacing active (`SEARCHRATEENABLED≠false`); 0 = bypass (FAZA 15 queue alone) |
| `animaxia_search_rate_per_user_ms` | gauge | — | configured per-user, per-kind min interval (default 500 ms) |
| `animaxia_search_rate_cooldown_ms` | gauge | — | configured post-result `/advanced` cooldown (default 1200 ms) |
| `animaxia_search_rate_limit_hits` | counter | — | requests answered `429 rate_limited` (faster than `perUserMs`) |
| `animaxia_search_cooldown_active` | counter | — | requests answered `429 cooldown_active` (inside the post-result cooldown) |
| `animaxia_search_spam_blocked` | counter | — | requests answered `429 spam_blocked` (flood auto-block; arrivals counted whether admitted or rejected) |
| `animaxia_search_burst_events` | counter | — | global micro-spikes that crossed `burstThreshold` within `burstWindowMs` (hysteresis: closes at half; detection is passive — nothing is blocked by it) |
| `animaxia_search_burst_active` | gauge | — | 1 = a burst is being observed right now |
| `animaxia_search_burst_window_ms` | gauge | — | configured burst detection window (default 1000 ms) |
| `animaxia_search_burst_max_per_window` | gauge | — | configured burst threshold (default 1000 arrivals/window) |
| `animaxia_search_burst_arrivals_per_s` | gauge | — | live arrivals per second inside the sliding burst window (100 ms buckets — O(1) at any scale) |
| `animaxia_search_rate_admitted_total` | counter | — | requests that passed the gate (advanced + autocomplete) |
| `animaxia_search_rate_completed_total` | counter | — | `/advanced` executions that delivered a real result (cooldown hook) |
| `animaxia_search_rate_tracked_users` | gauge | — | identities with live pacing state (`u:{id}` / `ip:{ip}`; 5 min idle sweep, 100k hard cap) |
| `animaxia_search_rate_admitted_by_shard` | counter | `shard` | admissions attributed to the request's shard (sparse — only shards with activity) |
| `animaxia_search_rate_blocked_by_shard` | counter | `shard` | rejections (rate + cooldown + spam) per shard (sparse) |

Non-Prometheus surfaces (same data): `GET /api/search/status` → additive
`rateLimit` (pinned contract: `perUserMs`, `enforced` + cooldown/spam state)
and `burstControl` (pinned: `active`, `maxBurstPerWindow` + live detection);
`GET /api/search/rate` → full console (config + counters + rolling history
180×1s of `arrivals`/`admitted`/`blocked` + 30-row perShard table); every
admitted `/advanced` response carries `rate: { perUserMs, cooldownMs }`; every
rejection carries `Retry-After` + `{ error, code, retryInMs }`.

Consumers: dashboard `dashboards/search-rate.json` (*Animaxia — Search
Rate*), alerts `AnimaxiaSearchRateSpamFlood` / `AnimaxiaSearchRateBurstSustained`
/ `AnimaxiaSearchRateDisabled` (`alerts/alerts.yaml`, group
`animaxia-searchrate-alerts`), synthetics suite `searchrate`
(`synthetics/run.mjs`), runbook
[`../runbooks/search-rate-protection.md`](../runbooks/search-rate-protection.md),
admin console `#/admin/search-rate` (pacing gauges + arrivals/blocked chart +
per-shard table + runtime settings), user-facing affordances in `#/search`
(disabled ENTER + „Așteaptă un moment…” countdown + auto-retry).

## 10. FAZA 17 — Search Optimization Layer (additive)

The FAZA 17 optimization layer (`mini-services/animaxia-backend/modules/search/opt.js`)
sits INSIDE the FAZA 15 flow queue (after the window dispatch, before the
FTS) and decides **whether Neon actually sees a query**: identical concurrent
requests share ONE real execution (batching — `batchMap[queryHash]`), repeats
within `cacheTtlMs` (pinned 1000–5000 ms, default 3000) are served from the
micro-cache (`searchCache[queryHash]`), and the dedup umbrella counts every
request that did NOT trigger a Neon query. The served object is always the
EXACT output of a real Neon execution — nothing fabricated, nothing stale
beyond the TTL (`content:changed` flushes the cache on index resync). The
deterministic pipeline is pinned in `/api/search/status` as `pipeline`:
`antiSpam → rateLimit → cooldown → queue → priority → windowing → dedup →
batching → cache → fts`. 1000 identical simultaneous requests → **1 real
Neon query** (reduction 1000×; QA bursts measured 100/1000/5000 → 1 each).
Config: `SEARCHOPT*` env or runtime via `POST /api/search/opt/settings`
(admin); disabling degrades to the byte-identical FAZA 16 behavior.

All series come from the `'searchopt'` pull collector on the monolith
(:4000), fed by `searchOptMetricsSnapshot()` (`?format=json` exposes it as
`collectors.searchopt`).

| Metric | Type | Labels | Notes |
|---|---|---|---|
| `animaxia_search_batch_hits` | counter | — | **spec-pinned** — requests attached to an in-flight identical execution (Neon untouched for them) |
| `animaxia_search_cache_hits` | counter | — | **spec-pinned** — requests served the stored REAL result within `cacheTtlMs` (Neon untouched) |
| `animaxia_search_cache_misses` | counter | — | **spec-pinned** — cache lookups that had to start a real query (clean invariant: `cache_misses` ≈ `fts_queries_total` while under the batch cap) |
| `animaxia_search_dedup_count` | counter | — | **spec-pinned** — deduplicated requests (`batch_hits` + `cache_hits`) |
| `animaxia_search_opt_enabled` | gauge | — | 1 = layer active; 0 = bypass (every request runs its own FTS) |
| `animaxia_search_cache_ttl_ms` | gauge | — | configured TTL (default 3000 ms; clamped 1000–5000) |
| `animaxia_search_cache_entries` | gauge | — | live cache entries (expired swept every 1 s; `content:changed` flushes all) |
| `animaxia_search_cache_hit_ratio` | gauge | — | `hits / (hits + misses)` over the process lifetime |
| `animaxia_search_cache_evictions` | counter | — | entries evicted by the `cacheMax` bound (LRU-ish, insertion order) |
| `animaxia_search_active_batches` | gauge | — | distinct in-flight batches right now (one real execution each) |
| `animaxia_search_batches_created` | counter | — | distinct batches since boot (== distinct real executions started by the layer) |
| `animaxia_search_batches_completed` | counter | — | batches that settled successfully (result cached) |
| `animaxia_search_batch_max_fanout` | gauge | — | largest fan-out ever observed (requests sharing 1 query — QA measured 5000) |
| `animaxia_search_fts_queries_total` | counter | — | the Neon-side truth: REAL FTS executions started by the layer |
| `animaxia_search_fts_errors_total` | counter | — | executions that failed (never cached; error propagates honestly to every attached request) |
| `animaxia_search_opt_served_total` | counter | — | requests that entered the layer (any disposition) |
| `animaxia_search_opt_bypassed_total` | counter | — | served with the layer disabled / above the `batchMax` cap (direct execution, honest) |
| `animaxia_search_opt_served_by_shard` | counter | `shard` | requests attributed to the request's shard (sparse — only shards with activity) |
| `animaxia_search_cache_hits_by_shard` | counter | `shard` | cache servings per shard (sparse) |
| `animaxia_search_batch_hits_by_shard` | counter | `shard` | batch attachments per shard (sparse) |
| `animaxia_search_fts_queries_by_shard` | counter | `shard` | real executions attributed to the batch leader's shard (sparse) |

Non-Prometheus surfaces (same data): `GET /api/search/status` → additive
`batching` (pinned: `enabled`, `activeBatches`), `cache` (pinned: `ttlMs`,
`hits`, `misses`), `dedup` (pinned: `active`, `deduplicatedRequests`) and
`pipeline` (the exact 10-stage array); `GET /api/search/opt` → full console
(config + counters incl. `reductionFactor` + live in-flight batch list top-50
by fan-out + rolling history 180×1s of `requests`/`fts`/`cacheHits`/
`batchHits` + 30-row perShard table); every `/advanced` + `/autocomplete`
response carries the additive `opt: { source, queryHash, cached, batched }`
provenance block (`'neon'` | `'batch'` | `'cache'` | `'bypass'`).

Consumers: dashboard `dashboards/search-opt.json` (*Animaxia — Search
Optimization*), alerts `AnimaxiaSearchOptCacheRatioLow` /
`AnimaxiaSearchOptDisabled` (`alerts/alerts.yaml`, group
`animaxia-searchopt-alerts`), synthetics suite `searchopt`
(`synthetics/run.mjs`), runbook
[`../runbooks/search-optimization.md`](../runbooks/search-optimization.md),
admin console `#/admin/search-opt` (reduction gauges + requests-vs-Neon chart
+ 10-stage pipeline strip + active batch table + per-shard reduction table +
runtime settings).

## 11. FAZA 18 — Full Integration + Stress Test (additive)

FAZA 18 integrates every search component (FAZA 15 flow control, FAZA 16
rate management, FAZA 17 optimization) into ONE deterministic 10-stage
pipeline and proves it with a **10,000+ simultaneous-search stress engine**
(`mini-services/animaxia-backend/modules/search/stress.js`): every simulated
request traverses the REAL pipeline (`searchRateGate → searchFlowExecute →
searchOptExecute → searchCluster.queryFTS`) with a unique simulated user
identity. The pinned composition — 1000 identical + 1000 different + 5000
mixed (2500 hot + 1500 typeahead + 1000 long-tail) + 2000 spam ENTER + 1000
cooldown + 1000 rate-limit — sums to **11,000 simultaneous requests**
(transparency note: the six spec line items sum above the 10,000 headline —
both are reported: `concurrency: 10000` pinned, `burstTotal/simultaneous:
11000` actual). The last run verdict is pinned in `/api/search/status` as
`stressTest: { concurrent: 10000, passed: true }` and persisted to
`data/search-stress-last.json` (survives restarts). The stress lane uses an
explicit per-entry queue budget (`budgetMs`, additive in flow.js — default
request budgets are UNTOUCHED for normal traffic) so the burst drains at the
platform's honest execution capacity with **zero losses** (0 errors, 0
dropped, 0 timedOut). The 10M-user projection (10M × 1–3 searches over 24h,
structural caps, real 500-concurrent sample) ships inside every run report.

All series come from the `'searchstress'` pull collector on the monolith
(:4000), fed by `searchStressMetricsSnapshot()` (`?format=json` exposes it
as `collectors.searchstress`).

| Metric | Type | Labels | Notes |
|---|---|---|---|
| `animaxia_search_pipeline_integrated` | gauge | — | **spec-pinned** — 1 = every one of the 10 pinned stages is structurally mounted (the stress engine received the real FTS entry points from the search router) |
| `animaxia_search_pipeline_stages` | gauge | — | **spec-pinned** — the integrated stage count (10: antiSpam → … → cache → fts) |
| `animaxia_search_stress_running` | gauge | — | 1 = a stress run is executing right now (POST returns 409 while set) |
| `animaxia_search_stress_executed` | gauge | — | 1 = at least one run recorded (persisted across restarts) |
| `animaxia_search_stress_passed` | gauge | — | **spec-pinned** — the last run verdict (all 22 assertions green) |
| `animaxia_search_stress_concurrency` | gauge | — | the pinned headline (10000) |
| `animaxia_search_stress_wall_ms` | gauge | — | the last run wall time (the honest drain at real execution capacity — ~35 s on the 2-core sandbox) |
| `animaxia_search_stress_requests_total` | gauge | — | simultaneous requests created in one synchronous turn (11000) |
| `animaxia_search_stress_requests_answered` | gauge | — | explicit dispositions (results + honest 429s) — equal to `requests_total` (none lost) |
| `animaxia_search_stress_requests_ok` | gauge | — | requests served a 100% real result (200) |
| `animaxia_search_stress_requests_blocked` | gauge | — | honest 429s (spam_blocked + cooldown_active + rate_limited) |
| `animaxia_search_stress_requests_errors` | gauge | — | unexpected errors (target 0) |
| `animaxia_search_stress_fts_queries` | gauge | — | REAL Neon FTS executions in the last run (incl. pre-warms + the 10M sample) |
| `animaxia_search_stress_reduction_factor` | gauge | — | answered per real query (QA measured 5.31× overall; the identical section alone is 1000×) |
| `animaxia_search_stress_runs_total` | counter | — | runs recorded this process (history capped at 20) |

Non-Prometheus surfaces (same data): `GET /api/search/status` → additive
`pipelineIntegrated`, `pipelineStages` (the exact 10-stage array) and
`stressTest` (pinned `{ concurrent: 10000, passed: true }` + the last-run
summary); `GET /api/search/stress` → full console (composition, budgetMs,
the complete last-run report with all 22 assertions + per-section outcomes +
the 10M projection + the 7 verdicts, and the runs history);
`POST /api/search/stress` (admin, 202 + poll, 409 while running) starts a
run. The spec's 11 monitoring series from FAZA 15–17
(`search_queue_length`, `search_inflight`, `search_window_interval`,
`search_batch_hits`, `search_cache_hits`, `search_cache_misses`,
`search_dedup_count`, `search_rate_limit_hits`, `search_cooldown_active`,
`search_spam_blocked`, `search_burst_events`) remain the live pipeline
gauges — FAZA 18 adds the integration + stress verdict on top of them.

Consumers: dashboard `dashboards/search-full.json` (*Animaxia — Search Full
Integration*), alert `AnimaxiaSearchPipelineDegraded` (`alerts/alerts.yaml`,
group `animaxia-searchstress-alerts`), synthetics suite `searchfull`
(`synthetics/run.mjs`), runbook
[`../runbooks/search-full-stress.md`](../runbooks/search-full-stress.md),
admin console `#/admin/search-full` (run verdict gauges + the 10-stage
integrated pipeline strip + the six pinned sections table + the 22
assertions with evidence + the 10M projection card + the runs history + the
four live FAZA 15/16/17 charts + the admin run trigger).
