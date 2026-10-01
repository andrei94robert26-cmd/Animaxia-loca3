# Animaxia Ops — Incident Runbooks

Operational incident playbooks for the Animaxia platform (FAZA 9 — Ops & Observability).
Every procedure here was **executed and verified in this environment** — the commands are
copy-pasteable as-is. Command-first: when an incident fires, open the runbook, run the
Diagnosis block, then the Recovery/Mitigation block, then the Verification block.

## Runbook index

| Runbook | Triggering alert / signal | Typical MTTR |
|---|---|---|
| [neon-outage.md](neon-outage.md) | `animaxia_db_connected 0`; homepage "SQL layer unavailable" + TMDB 401 cards; `/api/health` `driver:"local-fallback"`, `totalItems:3` | **< 2 min** — `./restore-env.sh` one-command recovery (observed Neon reconnect ~10 s) |
| [ai-provider-degraded.md](ai-provider-degraded.md) | `animaxia_ai_degraded_total` increasing; `/api/health` `ai.provider.available:false` + `lastError`; admin stats errorRate climbing | **~5 min** — `.env` AI var edit + safe kill/setsid restart + verify |
| [edge-waf-misconfig.md](edge-waf-misconfig.md) | WAF block-event spike; legit clients getting 403 `waf_blocked` + `x-edge-waf` header; edge smoke suite benign-guard failures | **10–15 min** full fix (test → lint → deploy); **seconds** to mitigate via KV override |
| [shard-down.md](shard-down.md) | `AnimaxiaShardDown` — `animaxia_db_shard_connected{shard="…"} == 0` for 2m; `/api/shards/health` shows `status:"down"` on a shard | **5–10 min** — fix `SHARD{N}URL` (physical) or follow neon-outage.md (logical/main pool); empty-URL fallback to logical mode is instant |
| [search-cluster-node-down.md](search-cluster-node-down.md) | `AnimaxiaSearchClusterNodeDown` — `animaxia_search_cluster_nodes_healthy < animaxia_search_cluster_nodes_total` for 5m; `cluster.nodes[]` error entries on `/api/search/advanced` | **< 5 min** — the nodes are the shard pools: fix the underlying pool (shard-down.md); nodes re-check on the next scrape |

## The golden rule

**`public/animaxia-cloud.zip` is the source of truth.** The backend `.env` (149+ vars, 305
lines — `DATABASEURL`, `TMDBAPIKEY`, `AUTHSECRET`, `AI_PROVIDER`, `VECTOR_BACKEND`, …) lives at
the **zip root**, and it is the only authoritative copy: sandbox/session resets have repeatedly
wiped `mini-services/animaxia-backend/.env` (2026-09-17, 2026-09-18 ×2). ZIP updates must be
**additive — never rewrite existing prefixes** (per-prefix file counts must stay byte-identical
for everything already packaged). And watch the env naming trap: most backend var names have NO
underscores (`DATABASEURL`, `TMDBAPIKEY`, `AUTHSECRET`); the AI ones do (`AI_PROVIDER`,
`AI_API_KEY`, `VECTOR_BACKEND`).

## First three commands for any incident

```bash
curl -s http://localhost:4000/api/health     # db / cache / rateLimit / provider circuits / player / ai / quota
curl -s http://localhost:4000/api/metrics    # Prometheus text — animaxia_db_*, animaxia_ai_*, animaxia_provider_circuit_state, …
cd animaxia-ops && bun run ops:synthetics    # 29 synthetic checks, exits non-zero on hard failure
```

- **Synthetics:** `bun run ops:synthetics` from `animaxia-ops/` (also works from the repo root).
  `--json` for machine-readable output, `--only web|api|auth|ai|player|edge` for a single suite.
  CI gates on the exit code.
- **Metrics contract:** every exported series is documented in [../metrics/METRICS.md](../metrics/METRICS.md).

## Platform map

Animaxia is a streaming platform with a Next.js web app on :3000 that gets all its data from an
Express monolith on :4000 (backed by Neon PostgreSQL, with an automatic local-fallback JSON
driver when Neon credentials are missing/rejected — the platform degrades, it never crashes).
A packaged cloud tier (microservices :4001-4009 + gateway :8080, in `animaxia-cloud/`) and the
Cloudflare Workers edge layer (`animaxia-edge/` — one gateway worker with WAF/rate-limit/cache
fronting five sub-workers + a cron worker) complete the picture; the edge is fully tested
hermetically (`cd animaxia-edge && bun run test` — typecheck + 159 smoke + 35 e2e checks) and
deployed with `deploy/deploy-all.sh` (sub-workers first, gateway last).

| Port / plane | Component | Notes |
|---|---|---|
| :3000 | Web app (Next.js) | needs no provider keys — all data flows through :4000; never kill it during backend recovery |
| :4000 | Monolith backend (Express + Neon PostgreSQL) | `cd mini-services/animaxia-backend && bun run dev`; auto local-fallback JSON driver without Neon; `.env` restored from the ZIP by `./restore-env.sh` |
| :4001-4009 | Cloud microservices | packaged in `animaxia-cloud.zip`, not running in this sandbox |
| :8080 | Cloud gateway | packaged in `animaxia-cloud.zip`, not running in this sandbox |
| :8787 | Edge gateway — local dev only | `bunx wrangler dev --config worker/wrangler.toml` |
| Cloudflare Workers | Edge layer: gateway + search/ai/auth/player/analytics + cron (`animaxia-edge/`) | deployed with `deploy/deploy-all.sh`; runtime config via `EDGE_CONFIG` KV key `"config"` |

## Related ops tooling

- `animaxia-ops/synthetics/` — the 29-check synthetic suite (`bun run ops:synthetics`).
- `animaxia-ops/metrics/` — metrics contract (`METRICS.md`) + the `/api/metrics` implementation.
- `mini-services/animaxia-backend/restore-env.sh` — one-command env/backend recovery after a
  session reset (see [neon-outage.md](neon-outage.md)).

## FAZA 10 (additive)

[social-realtime-degraded.md](social-realtime-degraded.md) — the realtime service `:4010`
(socket.io watch parties, live activity ticker) or its monolith webhook is degraded:
ticker frozen but `/api/social/feed/v2` still 200, party chat in "offline mode", sockets
not connecting. Typical MTTR **< 2 min** — detached `setsid` restart; the common trap is a
`REALTIMETOKEN` divergence between the two `.env` files (fix = same token in both +
restart **both** services). Also note the port table addition: **:4010 realtime service**
(`cd mini-services/animaxia-realtime && bun run dev`; owns nothing durably — rooms re-seed
from the monolith, Neon stays the source of truth).
