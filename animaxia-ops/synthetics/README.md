# Animaxia Ops — Synthetic Checks

`bun run ops:synthetics` (from `animaxia-ops/`) exercises the live platform
the way a user would. Zero dependencies; exits non-zero on any hard failure —
CI (`ops-ci.yml`) gates the daily run on it.

## Suites (46 checks)

| Suite | What it proves |
|---|---|
| `web` | Next.js :3000 answers 200 with Animaxia branding under 3s; `/api/edge-status` (the edge console probe) responds |
| `api` | Monolith `/api/health`: Neon connected, ≥50 catalog items, all provider circuits closed, FAZA 9 `ai` section present; `/api/metrics` serves Prometheus text + JSON snapshot |
| `auth` | Real register → login → `GET /api/auth/me` round-trip with a fresh throwaway account (Neon write + JWT session) |
| `ai` | `/api/ai/cloud/status` reports the LLM provider + vector backend; authenticated `GET /api/ai/personal/home` returns AI content (402 = quota exhausted → **soft**, never fails the run) |
| `player` | `/api/mobile/player/3` resolves sources; a real `.m3u8` manifest is fetched live (`#EXTM3U` verified); the offline fallback clips shipped for mobile + desktop exist (>300 KB) |
| `miner` | FAZA 12 ingest service: `/api/miner/status` identity, five registered job types, pool concurrency, job queue stats with bounded failures |
| `edge` | The web console's edge probe reports the upstream origin healthy |
| `shards` | FAZA 13 sharding: `/api/shards/health` → `ok:true` with every shard `status:"healthy"`; composite `/api/shards` reports `shardcount ≥ 1` + the shardid schema columns on content/searchdocs/vectorembeddings; every pool entry connected (**soft** when a configured branch URL is down — physical mode is config-dependent); search + vector cluster enabled & healthy (**soft** when disabled by config) |

## Usage

```bash
cd animaxia-ops
bun run ops:synthetics            # human report
bun run ops:synthetics:json       # machine-readable (CI)
bun run ops:synthetics --only ai  # single suite: web|api|auth|ai|player|edge|miner|shards
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
