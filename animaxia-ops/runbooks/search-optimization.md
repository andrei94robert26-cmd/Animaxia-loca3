# Runbook — Search Optimization Layer (FAZA 17)

**Scope:** `AnimaxiaSearchOptCacheRatioLow` · `AnimaxiaSearchOptDisabled`
**Layer:** `modules/search/opt.js` (monolith :4000) — the dedup + batching +
micro-cache layer sitting INSIDE the FAZA 15 flow queue (after the window
dispatch, before the real Neon FTS).
**Console:** `#/admin/search-opt` · **API:** `GET /api/search/opt`,
`POST /api/search/opt/settings` (admin) · **Dashboard:**
`dashboards/search-opt.json` (*Animaxia — Search Optimization*)
**Canonical metrics:** `animaxia-ops/metrics/METRICS.md` §10

---

## What the layer does (30 seconds)

FAZA 17 decides **whether Neon actually sees a query** — nothing more:

| Stage | Rule | Effect on Neon |
|---|---|---|
| Dedup / Batching | an identical execution is in flight → attach to its promise (`batchMap[queryHash]`) | Neon sees NOTHING for the attached request |
| Cache | the exact query was executed ≤ `cacheTtlMs` (3000 ms) ago → serve the stored result (`searchCache[queryHash]`) | Neon sees NOTHING |
| Real FTS | no batch, no cache entry → create a batch, run the 100% real query, cache the result on success | ONE real query (shared by every future attach/hit) |

Invariants:

- **Every served result is 100% real** — the cache/batch serving returns the
  EXACT object a real Neon execution produced (nothing fabricated, nothing
  merged). The additive `opt: { source, queryHash }` response block documents
  the provenance: `'neon'` | `'batch'` | `'cache'` | `'bypass'`.
- **Nothing stale beyond the pinned TTL** — entries live 1000–5000 ms
  (default 3000); `content:changed` (index resync) flushes the whole cache
  immediately.
- **Failures are never cached** — a failed execution propagates the honest
  error to every attached request; the next arrival retries a fresh real
  query.
- **Clean counter invariant** — `animaxia_search_cache_misses` ≈
  `animaxia_search_fts_queries_total` while under the batch cap: every miss
  corresponds to exactly one real Neon query.
- **QA-pinned behavior** — 100 / 1000 / 5000 identical simultaneous requests
  → **1 real Neon query each** (fan-out 5000 measured), all requests answered
  with real results, zero losses (`search_dropped_requests` stays 0).

The pinned 10-stage pipeline (`/api/search/status` → `pipeline`):
`antiSpam → rateLimit → cooldown → queue → priority → windowing → dedup →
batching → cache → fts`.

## Knobs (all runtime-adjustable, admin-gated)

| Knob | Env | Default | Clamp | Meaning |
|---|---|---|---|---|
| `enabled` | `SEARCHOPTENABLED` | `true` | — | master switch (false = byte-identical FAZA 16 behavior) |
| `cacheTtlMs` | `SEARCHOPTCACHETTLMS` | `3000` | 1000–5000 | pinned freshness window |
| `cacheMax` | `SEARCHOPTCACHEMAX` | `5000` | 100–100000 | entry cap (insertion-order eviction) |
| `batchMax` | `SEARCHOPTBATCHMAX` | `10000` | 100–50000 | max DISTINCT concurrent batches (protective cap — beyond it requests execute directly, source `'bypass'`) |

```bash
# read current config + counters
curl -s localhost:4000/api/search/opt | jq '.config, .counters'

# runtime reconfigure (admin Bearer)
curl -X POST localhost:4000/api/search/opt/settings \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"cacheTtlMs": 5000}'
```

## AnimaxiaSearchOptCacheRatioLow (hit ratio < 5% after > 1000 served)

**First: this is often NOT an incident.** With the FAZA 16 per-user pacing
(500 ms per user per kind), repeat traffic is mostly DISTINCT users searching
DISTINCT queries — a long-tail catalog naturally has a low cache ratio, and
**batching still collapses concurrent identical requests** (`batch_hits`).
Check in this order:

1. **Is `animaxia_search_batch_hits` > 0 and growing?** The layer is doing
   its job on the concurrent axis; the cache ratio only covers the time axis.
   Trending-query spikes („Naruto”, „Spider-Man” premieres) show up as huge
   `batch_hits` with a modest cache ratio — healthy.
2. **Is TTL at the floor?** `animaxia_search_cache_ttl_ms` = 1000 means an
   admin (or env) forced the minimum — popular queries need 3000–5000 ms of
   overlap to hit. Raise via the settings endpoint if freshness allows.
3. **Is the traffic really identical?** Compare
   `rate(animaxia_search_opt_served_total)` vs
   `rate(animaxia_search_fts_queries_total)` on the dashboard — if they track
   1:1, the queries are genuinely all different (search-driven exploration).
   No action; the layer costs O(1) per request in this mode.
4. **Memory pressure?** `animaxia_search_cache_evictions` growing fast means
   `cacheMax` is too small for the working set — raise `SEARCHOPTCACHEMAX`
   (each entry is one result object; 5000 entries ≈ a few MB).

## AnimaxiaSearchOptDisabled (layer bypassed)

The layer was disabled at runtime (`POST /api/search/opt/settings
{ enabled: false }` or `SEARCHOPTENABLED=false`). Searches stay 100% real
and the FAZA 15 queue still bounds Neon load, but identical simultaneous
requests are no longer collapsed — a 1000-user identical burst becomes 1000
real queries bounded only by windowing (80 × 80 ms).

- **Intentional?** The documented use case is isolating index-freshness
  suspicions (cache off = every request reflects the newest `searchdocs`).
  Confirm with the change audit log (`searchopt.settings` action) and leave
  it — the alert is `info` severity for exactly this reason.
- **Re-enable:**

```bash
curl -X POST localhost:4000/api/search/opt/settings \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"enabled": true}'
```

or the `#/admin/search-opt` console → *Setări runtime* → switch **Activ** →
*Salvează*.

## Escalation paths

- **Neon saturated despite the layer** (`animaxia_db_pool_waiting` > 0):
  the traffic is dominated by DISTINCT queries — the layer cannot collapse
  them. Capacity path is the FAZA 15 one: windowing throughput
  (`/api/search/flow/settings`) or horizontal replicas (`SHARD{n}URL`).
  See `search-flow-saturation.md`.
- **Suspicious results freshness** (user reports stale titles after an
  ingest): check `GET /api/search/status` → `cache.ttlMs` and the last
  `content:changed` flush in the `[search-opt] CACHE FLUSH` log lines; a
  forced `POST /api/search/index` (admin) rebuilds the index and flushes the
  cache as a side effect.
- **`animaxia_search_fts_errors_total` growing**: the REAL queries are
  failing (never cached — good). Follow the Neon outage runbook
  (`neon-outage.md`); the layer transparently degrades to per-request
  execution for retries.
