# Runbook — Search Rate Protection (FAZA 16)

**Scope:** `AnimaxiaSearchRateSpamFlood` · `AnimaxiaSearchRateBurstSustained` ·
`AnimaxiaSearchRateDisabled`
**Layer:** `modules/search/rate.js` (monolith :4000) — the per-user pacing
layer in front of the FAZA 15 search flow queue.
**Console:** `#/admin/search-rate` · **API:** `GET /api/search/rate`,
`POST /api/search/rate/settings` (admin) · **Dashboard:**
`dashboards/search-rate.json` (*Animaxia — Search Rate*)
**Canonical metrics:** `animaxia-ops/metrics/METRICS.md` §9

---

## What the layer does (30 seconds)

FAZA 16 decides **who may search how often** — nothing more:

| Protection | Rule | Answer |
|---|---|---|
| Rate limit | 1 admitted search / user / kind every `perUserMs` (500 ms) | `429 rate_limited` + `retryInMs` |
| Cooldown | after an `/advanced` **result** is received, the next `/advanced` waits `cooldownMs` (1200 ms) | `429 cooldown_active` + `retryInMs` |
| Anti-spam | ≥ `spamThreshold` (3) arrivals within `spamWindowMs` (200 ms) → auto-block `spamBlockMs` (1000 ms) | `429 spam_blocked` + `retryInMs` |
| Burst detect | ≥ `burstThreshold` (1000) global arrivals within `burstWindowMs` (1000 ms) → **event only** (nothing blocked) | observability |

Invariants:

- **Admitted searches stay 100% real** — they flow unchanged into the FAZA 15
  queue; the FTS executions are byte-identical to FAZA 14.
- **Every rejection is explicit** — a 429 with `retryInMs` and a
  `Retry-After` header. Nothing is dropped silently; the UI shows
  „Așteaptă un moment…” and auto-retries.
- `/advanced` and `/autocomplete` pace in **separate lanes** — typing never
  blocks ENTER and vice-versa; the anti-spam window counts both together.
- 1000 **distinct** users searching simultaneously are ALL admitted (the
  limits are per user) — the burst is absorbed by the FAZA 15 queue +
  windowing; only the flood of ONE identity is blocked.

## AnimaxiaSearchRateSpamFlood (> 100 blocks / 5 min)

The auto-block is doing its job; the volume is the signal.

1. **Identify the source.** `#/admin/search-rate` → per-shard table
   (`animaxia_search_rate_blocked_by_shard`) and the monolith log lines
   `[search-rate] SPAM BLOCKED — advanced from ip:x.y.z.w` (or `u:{id}`).
   A single identity dominating = abusive client or a broken integration
   retrying in a tight loop (check its `Retry-After` handling).
2. **Block upstream if abusive.** The edge WAF can drop the identity before
   it costs anything — the monolith never sees the requests.
3. **If it is MANY identities at once** (coordinated flood), verify the FAZA 15
   queue stayed healthy: `animaxia_search_dropped_requests` and
   `animaxia_search_timedout_requests` must not move (both target 0) and
   `animaxia_search_queue_length` should return to 0 after the flood.
4. **Legitimate synchronized traffic** (launches, bots with consent): raise
   `burstThreshold` so the burst alert stops firing — the per-user limits
   stay active regardless.

## AnimaxiaSearchRateBurstSustained (burst_active == 1 for 10m)

A burst that doesn't end — capacity planning attention, not an outage.

1. **Check absorption health:** `AnimaxiaSearchFlowQueueSaturation` /
   `AnimaxiaSearchFlowDroppedRequests` quiet, `animaxia_db_pool_waiting` 0,
   `animaxia_search_wait_ms_p95` well under `maxWaitMs`. If all green, the
   platform is simply serving a sustained peak — no action required.
2. **If the queue is filling:** raise FAZA 15 window throughput
   (`POST /api/search/flow/settings` — e.g. `batchSize: 100`), or add
   replicas behind the shard URLs (`SHARD{n}URL`) — windowing scales
   horizontally by design.
3. **If arrivals are dominated by repeats of the same users**, tighten the
   rhythm instead: `POST /api/search/rate/settings { perUserMs: 800 }` —
   the queue drain rate is reserved for distinct users.

## AnimaxiaSearchRateDisabled (rate_enabled == 0)

The documented emergency bypass — the FAZA 15 queue still bounds Neon, but
per-user pacing, cooldown and anti-spam are OFF.

1. Confirm intent with whoever ran
   `POST /api/search/rate/settings { enabled: false }` (audit log action
   `searchrate.settings`).
2. Re-enable when the investigation ends:
   `POST /api/search/rate/settings { enabled: true }` (admin Bearer) or the
   `#/admin/search-rate` console. Pacing state rebuilds within seconds.

## Runtime knobs (all clamped server-side)

```bash
# read the live console
curl -s localhost:4000/api/search/rate | jq '.config, .counters'

# tighten the rhythm (admin token required)
curl -X POST localhost:4000/api/search/rate/settings \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"perUserMs": 800, "cooldownMs": 1500, "spamThreshold": 3, "spamBlockMs": 1500, "burstThreshold": 800}'
```

| Knob | Default | Range | Effect |
|---|---|---|---|
| `perUserMs` | 500 | 100–5000 | min interval between admitted searches (per user, per kind) |
| `cooldownMs` | 1200 | 250–10000 | post-result `/advanced` cooldown |
| `spamWindowMs` | 200 | 50–2000 | flood window |
| `spamThreshold` | 3 | 2–10 | arrivals within the window = flood |
| `spamBlockMs` | 1000 | 100–10000 | auto-block duration after a flood |
| `burstWindowMs` | 1000 | 250–5000 | burst detection window |
| `burstThreshold` | 1000 | 10–100000 | arrivals/window = burst event |

Env equivalents at boot: `SEARCHRATEENABLED`, `SEARCHRATEPERUSERMS`,
`SEARCHRATECOOLDOWNMS`, `SEARCHRATESPAMWINDOWMS`, `SEARCHRATESPAMTHRESHOLD`,
`SEARCHRATESPAMBLOCKMS`, `SEARCHRATEBURSTWINDOWMS`, `SEARCHRATEBURSTTHRESHOLD`.

## QA evidence (pinned)

`tests/smoke-searchrate.mjs` (monolith): rate-limit (2 în <500 ms), cooldown
(post-result block + recovery), anti-spam (10 ENTER în <200 ms → 1 admitted +
rest 429 spam_blocked, auto-block, recovery), autocomplete lane independence,
burst 1000 utilizatori distincți simultan — **toate 1000 răspunsuri 200 reale,
0 pierdute**, windowing discipline intact (FAZA 15), Neon healthy.
