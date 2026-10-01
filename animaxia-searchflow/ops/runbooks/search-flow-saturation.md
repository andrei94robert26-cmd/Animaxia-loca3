# Runbook — Search flow saturation (FAZA 15 queue + priority + windowing)

**Service:** monolith backend `mini-services/animaxia-backend/` — search flow
control `modules/search/flow.js` (admission layer between
`/api/search/advanced` + `/api/search/autocomplete` and Neon) on **:4000**.
**Alerts (group `animaxia-searchflow-alerts` in
[`../alerts/alerts.yaml`](../alerts/alerts.yaml)):**

| Alert | Severity | `for` | Meaning |
|---|---|---|---|
| `AnimaxiaSearchFlowDroppedRequests` | critical | 0m | `increase(animaxia_search_dropped_requests[5m]) > 0` — queue overflow, users saw `503 SEARCH_QUEUE_FULL` |
| `AnimaxiaSearchFlowQueueSaturation` | warning | 5m | `animaxia_search_queue_length > animaxia_search_queue_capacity * 0.8` — sustained load above drain rate |
| `AnimaxiaSearchFlowInflightSaturated` | warning | 10m | `animaxia_search_inflight >= animaxia_search_max_concurrent` — every execution slot busy |

**Architecture recap (FAZA 15):** every search request is admitted to a
**shard-aware priority queue** (high = admin/ops/QA, normal = logged-in, low =
anonymous, anti-starvation aging: low→normal after `lowPromoteMs`, normal→high
after `normalPromoteMs`). Dispatch happens **only on window ticks** — at most
`batchSize` executions every `intervalMs`, bounded by `maxConcurrent`. The FTS
queries are byte-identical to FAZA 14 (results 100% real); the queue only
controls the flow, so Neon observes a controlled stream instead of a spike.
Overflow past `queueCap` answers an explicit `503 SEARCH_QUEUE_FULL` (counter
`dropped`, **target 0** — never a silent discard); waiting past the request
budget (`REQUESTTIMEOUTMS` − 2.5s execution margin) answers an explicit
`504 SEARCH_QUEUE_TIMEOUT` (counter `timedOut`) before the FAZA 17 resilience
middleware would.

## Symptoms

```text
alert: AnimaxiaSearchFlowDroppedRequests
expr:  increase(animaxia_search_dropped_requests[5m]) > 0
```

- Users see `503 { error: 'Search queue is full — try again shortly', code: 'SEARCH_QUEUE_FULL' }`.
- `animaxia_search_queue_high_water ≈ animaxia_search_queue_capacity`.
- Common trigger: a burst larger than `queueCap` (default 10 000 waiting) or a
  Neon slowdown shrinking the drain rate while arrivals continue.

```text
alert: AnimaxiaSearchFlowQueueSaturation
expr:  animaxia_search_queue_length > animaxia_search_queue_capacity * 0.8  (for 5m)
```

- Searches still succeed but `flow.queuedMs` on responses climbs (visible in
  the UI as a longer loader) and `animaxia_search_wait_ms_p95` rises.

```text
alert: AnimaxiaSearchFlowInflightSaturated
expr:  animaxia_search_inflight >= animaxia_search_max_concurrent  (for 10m)
```

- The queue drains at exactly execution speed; per-request latency inflates
  (convoy) when the pg pool (`PGPOOLMAX`) is the real ceiling.

## Diagnosis

```bash
# Live gauges + queue wait percentiles + per-priority attribution
curl -s http://localhost:4000/api/search/status | python3 -m json.tool | sed -n '/flowControl/,/windowing/p'

# Full console: config, rolling history (queue/inflight/rate), per-shard table
curl -s http://localhost:4000/api/search/flow | python3 -m json.tool | head -60

# Prometheus series
curl -s http://localhost:4000/api/metrics | grep -E '^animaxia_search_'

# Is the pg pool the real ceiling?
curl -s http://localhost:4000/api/metrics | grep -E '^animaxia_db_pool_'
#   animaxia_db_pool_total 40        <- at PGPOOLMAX?
#   animaxia_db_pool_waiting 250     <- executions stacked on pool slots
```

Interpretation:

| Observation | Meaning |
|---|---|
| `queue_by_priority{priority="low"}` dominates | anonymous flood — check the per-IP rate limiter (`rateLimitStats` in `/api/health`) and edge WAF |
| `inflight = max_concurrent` AND `db_pool_waiting > 0` | execution-bound: the pool is the ceiling — raise `PGPOOLMAX` or accept smoothing |
| `dropped > 0` with `queue_length ≈ queue_capacity` | arrival burst beyond capacity — raise `queueCap` (short-term) + rebalance the window |
| `timed_out > 0` with wait p95 near `REQUESTTIMEOUTMS` | the request budget is the binding constraint — faster execution (pool) or smaller bursts |
| `window_interval`/`window_batch_size` far from defaults (80/80) | someone reconfigured at runtime — check the audit log (`action: searchflow.settings`) |

## Remediation

**Rebalance the window at runtime (admin token required):**

```bash
TOKEN=<admin-access-token>
# Faster admission: shorter interval and/or larger batch (clamped server-side:
# intervalMs 10..2000, batchSize 1..1000, maxConcurrent 1..2000, queueCap
# 100..500000, maxWaitMs 1000..300000)
curl -s -X POST http://localhost:4000/api/search/flow/settings \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"intervalMs": 60, "batchSize": 100}'
```

The same knobs are editable in the **`#/admin/search-flow`** console
(Admin panel → Search Flow → Setări), which also shows the live queue chart,
priorities and per-shard attribution.

**When the pg pool is the ceiling:** raise `PGPOOLMAX` (default 40) — Neon
serverless absorbs modest increases; remember that `.env` changes require a
**full process restart** (`dotenv` does not override env vars already loaded
natively by Bun at process start, so `bun --watch` restarts are not enough).
Keep `maxConcurrent` near the pool's sustainable concurrency — inflating it
beyond the pool only adds convoy latency.

**When the burst is abusive:** the per-IP rate limiter (`RATELIMITMAX`,
default 120/min) already bounds single sources; a distributed flood is better
shed at the edge (gateway WAF) than absorbed by the queue.

**Emergency bypass (NOT recommended — restores uncontrolled FAZA 14 flow):**

```bash
curl -s -X POST http://localhost:4000/api/search/flow/settings \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"enabled": false}'
# → the queue drains immediately and every search executes directly; the
#   searchflow metrics freeze (flow_enabled 0). Re-enable as soon as the
#   burst passes.
```

## Verification

```bash
# 1. Queue healthy: length drains back to ~0, drops stop increasing
curl -s http://localhost:4000/api/metrics | grep -E '^animaxia_search_(queue_length|dropped_requests|inflight)'

# 2. Searches still 100% real (engine + flow attribution on every response)
curl -s 'http://localhost:4000/api/search/advanced?q=dune&limit=1' | python3 -c \
  "import json,sys; d=json.load(sys.stdin); print(d['engine'], d['flow'])"

# 3. Full FAZA 15 smoke (61 checks: 10/100/500 bursts, priorities, shards,
#    semantic equivalence vs FAZA 14, 0 dropped / 0 timedOut)
cd mini-services/animaxia-backend && bun tests/smoke-searchflow.mjs
```
