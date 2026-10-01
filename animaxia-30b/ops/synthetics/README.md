# Animaxia Ops — Synthetic Checks

`bun run ops:synthetics` (from `animaxia-ops/`) exercises the live platform
the way a user would. Zero dependencies; exits non-zero on any hard failure —
CI (`ops-ci.yml`) gates the daily run on it.

## Suites (139 checks)

| Suite | What it proves |
|---|---|
| `web` | Next.js :3000 answers 200 with Animaxia branding under 3s; `/api/edge-status` (the edge console probe) responds |
| `api` | Monolith `/api/health`: Neon connected, ≥50 catalog items, all provider circuits closed, FAZA 9 `ai` section present; `/api/metrics` serves Prometheus text + JSON snapshot |
| `auth` | Real register → login → `GET /api/auth/me` round-trip with a fresh throwaway account (Neon write + JWT session) |
| `ai` | `/api/ai/cloud/status` reports the LLM provider + vector backend; authenticated `GET /api/ai/personal/home` returns AI content (402 = quota exhausted → **soft**, never fails the run) |
| `player` | `/api/mobile/player/3` resolves sources; a real `.m3u8` manifest is fetched live (`#EXTM3U` verified); the offline fallback clips shipped for mobile + desktop exist (>300 KB) |
| `miner` | FAZA 12 ingest service: `/api/miner/status` identity, five registered job types, pool concurrency, job queue stats with bounded failures |
| `edge` | The web console's edge probe reports the upstream origin healthy |
| `global30b` | FAZA 14 definitive spec: `/api/platform/feed/global` → `animaxia-global-30b` with the 30.000.000.000 logical address space (30 shards × 1B), items flagged virtual XOR real, per-shard real coverage, an **O(1) deep page at 29.999.999.980** (< 2s, ends the space on shard 29), `?shard=29` range filtering, the universal external player (YouTube → embed, `contentFree`, private-network SSRF block) and the logical 30B reporting on `/api/search/status` |
| `searchflow` | FAZA 15 Search Flow Control: `/api/search/status` exposes the pinned `flowControl` (queueEnabled, maxConcurrent, priorities) + `windowing` (intervalMs, batchSize) contract; `/api/search/flow` serves config + rolling history + the 30-row perShard table; a live 16-request burst (distinct simulated users via unique `X-Forwarded-For`, unique `q` so single-flight coalescing stays out of the way) → every request 200 with `engine: animaxia-neon-fts` + the additive `flow { priority, shardid, queuedMs }`, `dropped`/`timedOut` deltas 0, `maxInflightSeen ≤ maxConcurrent`; `X-Animaxia-Priority: high` honored on the response; the `animaxia_search_*` series present in `/api/metrics` |
| `searchrate` | FAZA 16 Search Rate Management: `/api/search/status` exposes the pinned `rateLimit` (perUserMs, enforced) + `burstControl` (active, maxBurstPerWindow) contract; `/api/search/rate` serves config + counters + history + the 30-row perShard table; an admitted search stays 100% real (animaxia-neon-fts) and carries `rate { perUserMs, cooldownMs }`; 2 simultaneous searches from ONE user → 200 + explicit 429 `rate_limited` with retryInMs + Retry-After; a search right after a result → 429 `cooldown_active` (exact pinned shape); 10 ENTER presses in <200ms → exactly 1 admitted + 9 explicit 429s (`spam_blocked` auto-block); autocomplete paces in its own lane (admitted during the advanced cooldown); per-user isolation (a distinct user searches 200 while others are blocked); counters move on the console; the `animaxia_search_rate_*` series present in `/api/metrics`; `POST /rate/settings` anonymous → 401 |
| `searchopt` | FAZA 17 Search Optimization Layer: `/api/search/status` exposes the pinned `batching` (enabled, activeBatches) + `cache` (ttlMs 1000–5000, hits, misses) + `dedup` (active, deduplicatedRequests) contracts and the exact 10-stage `pipeline` array; `/api/search/opt` serves config + counters + active batch list + history + the 30-row perShard table; 50 identical concurrent requests from 50 distinct users on a fresh query → all 200, all 100% real (animaxia-neon-fts) with the additive `opt` provenance block and **exactly 1 real Neon query** (49 deduplicated); a repeat within the TTL → `opt.source = "cache"` with real data; distinct queries → own real executions + distinct hashes (no false dedup); autocomplete carries the opt block; the four spec-pinned series (`animaxia_search_batch_hits` / `_cache_hits` / `_cache_misses` / `animaxia_search_dedup_count`) present in `/api/metrics`; `POST /opt/settings` anonymous → 401 |
| `shards` | FAZA 13 sharding + FAZA 14 topology: 30 shards × 1B ids, logical address space 30.000.000.000, coalesced-logical cluster execution in logical mode (**soft** when the cluster is disabled by config); `/api/shards/health` → `ok:true` with every shard `status:"healthy"`; composite `/api/shards` reports `shardcount ≥ 1` + the shardid schema columns on content/searchdocs/vectorembeddings; every pool entry connected (**soft** when a configured branch URL is down — physical mode is config-dependent); search + vector cluster enabled & healthy (**soft** when disabled by config) |

## Usage

```bash
cd animaxia-ops
bun run ops:synthetics            # human report
bun run ops:synthetics:json       # machine-readable (CI)
bun run ops:synthetics --only ai  # single suite: web|api|auth|ai|player|edge|miner|shards|global30b|searchflow|searchrate|searchopt
```

From the repo root (convenience delegation added to the web app's
package.json):

```bash
bun run ops:synthetics
```

## Configuration

| Env | Default | Meaning |
|---|---|---|
| `WEB_ORIGIN` | `http://localhost:3000` | Next.js web app |
| `API_ORIGIN` | `http://localhost:4000` | Animaxia monolith |

## Soft vs hard failures

- **Soft** (reported, exit 0): AI quota exhaustion (402) — by design the free
  plan caps daily AI calls, mirroring the FAZA 8 e2e quota policy. FAZA 13
  `shards` suite: a branch-mode shard pool with a configured URL that is down
  (physical mode is config-dependent — the resilient branch→main fallback
  keeps reads working), and the search/vector clusters when disabled via
  `SEARCHCLUSTENABLED` / `VECTORCLUSTENABLED` (the legacy single-node path is a
  valid steady state).
- **Hard** (exit 1): anything else — web down, Neon disconnected, provider
  circuit open, metrics endpoint broken, auth flow broken, player/HLS chain
  broken, missing offline assets.

The full edge pipeline (gateway/search/ai/auth/player/analytics/cron against
the real cloud + Neon) is covered by `animaxia-edge` `bun run test`
(smoke 159 checks hermetic + e2e 35 checks live) which runs in the same CI
workflow — see `.github/workflows/ops-ci.yml`.

## FAZA 10 candidate checks (not yet wired into run.mjs)

The 29 checks above predate the social layer. These social & realtime probes
are **candidates only** — `run.mjs` does not execute them yet, so nobody
should assume they gate CI:

| Candidate | Probe | Why |
|---|---|---|
| realtime health | `GET http://localhost:4010/api/health` → `status:"ok"` | catches the realtime service being down (live ticker / watch parties silently degraded — see `../runbooks/social-realtime-degraded.md`) |
| public social feed | `GET /api/social/feed/v2/public` → 200 | proves the FAZA-10 REST layer + `activityevents` table answer anonymously |
| parties list | `GET /api/social/parties` → 200 | proves the watch-party listing + lazy-expiry query path |

Wiring them would need a `social` suite entry in `run.mjs` (and the suite
count / README table updated accordingly). Until then, the runbook's
Diagnosis block is the manual equivalent.
| `searchfull` | 13 | FAZA 18 — full integration + stress verdict contracts: pipelineIntegrated + the exact 10-stage array + the stressTest pinned shape on /status, the stress console composition (sections sum 11000 ≥ headline 10000) + budget lane + lastRun verdict + the 10M projection, POST /stress admin-gated (401 anonymous), the 5 FAZA 18 series + the 11 spec monitoring series (FAZA 15–17) in Prometheus, collectors.searchstress in JSON |
