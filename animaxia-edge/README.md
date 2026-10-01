# Animaxia Edge — Cloudflare Workers layer (FAZA 8)

The edge layer of the Animaxia platform: one **gateway worker** fronting the
cloud (monolith `:4000` → Neon PostgreSQL) plus five specialized sub-workers
(search, AI, auth, player, analytics) and a **cron worker** — all wired
through service bindings, KV, R2, a Durable Object and a Queue, with a shared
zero-dependency TypeScript layer.

```
                        ┌──────────────────────────────────────────────┐
 clients (web / mobile ─▶  animaxia-edge-gateway (worker/)             │
 / desktop / bots)      │  WAF → rate limits → smart routing → cache   │
                        └─────┬───────────┬───────────┬───────────┬────┘
              service bindings ▼           ▼           ▼           ▼
        ┌─────────────┐ ┌──────────┐ ┌──────────┐ ┌────────────┐ ┌──────────────┐
        │ edge-search │ │ edge-ai  │ │ edge-auth│ │ edge-player│ │edge-analytics│
        │ KV catalog  │ │ KV cache │ │ KV replay│ │ R2 segments│ │ KV + Queue   │
        └──────┬──────┘ └────┬─────┘ └────┬─────┘ └─────┬──────┘ └──────┬───────┘
               │  fallbacks  │            │ passthrough │  batches    │ flush
               └─────────────┴─────┬──────┴─────────────┴──────────────┘
                                    ▼
                     cloud gateway (monolith :4000) ──▶ Neon PostgreSQL
                                     ▲
   /media/* ─▶ R2 MEDIA_BUCKET      │  /ws/* ─▶ WS proxy (assistant live)
   rate tier 1 ─▶ RATE_LIMITER DO  │  cron worker ─▶ scheduled jobs + flush
```

## Modules

| Worker | Purpose | Key routes | Bindings |
|---|---|---|---|
| `worker/` — **gateway** | WAF, per-IP/per-user/heavy rate limits, smart routing, response cache (60s + SWR + SIE), R2 media, WebSocket proxy | `/edge/*`, `/api/*`, `/ai/*`, `/vector/*`, `/mobile/*`, `/search`, `/autocomplete`, `/auth/*`, `/player/*`, `/hls`, `/analytics/*`, `/beacon`, `/media/*`, `/ws/*` | EDGE_CONFIG, EDGE_CACHE, EDGE_RATELIMIT (KV), MEDIA_BUCKET (R2), RATE_LIMITER (DO), SVC_* (5 services) |
| `search/` | fuzzy search + autocomplete over a KV catalog snapshot built from `/api/all` (paged), cloud fallback | `GET /search`, `GET /autocomplete`, `POST /search/refresh` (admin), `GET /search/health` | EDGE_CONFIG, SEARCH_CACHE |
| `ai/` | RAG edge acceleration — L1 answer cache + L2 retrieval pre-warm (`/api/vector/search`), SSE passthrough | `POST /ai/assistant`, `POST /ai/rag/{chat,recommend,summarize,explain}`, `POST /ai/embeddings`, `GET /ai/cloud/status`, `GET /ai/tools` | EDGE_CONFIG, EMBEDDINGS_CACHE, EDGE_CACHE |
| `auth/` | HS256 verify at the edge, jti anti-replay registry, device-bound wrapper tokens, refresh replay guard, passthroughs | `GET /auth/verify`, `POST /auth/refresh`, `POST /auth/{login,register,logout,…}`, `GET /auth/me`, `POST /auth/revoke`, `POST /auth/device/token`, `GET /auth/health` | EDGE_CONFIG, EDGE_CACHE, EDGE_REPLAY |
| `player/` | HLS manifest rewrite (segments → `/hls?u=…`, variants → `variant?src=…`), host allowlist, L1 segment cache + R2 write-through + stale-if-error | `GET /player/manifest/:id`, `GET /player/manifest/variant`, `GET /hls`, `GET /player/sources/:id`, `GET /player/media/*` | EDGE_CONFIG, EDGE_CACHE, MEDIA_BUCKET, HLS_CACHE |
| `analytics/` | view/play/complete tracking → Queue (or KV ring), hourly trending buckets, flush to cloud in batches | `POST /analytics/view`, `POST /analytics/event`, `POST /beacon`, `GET /analytics/trending`, `POST /analytics/flush` (admin) + `queue()` consumer | EDGE_CONFIG, ANALYTICS_TREND, ANALYTICS_QUEUE |
| `cron/` | scheduled jobs + manual triggers, every run logged | `GET|POST /cron/run/:job`, `GET /cron/jobs`, `GET /cron/health` + `scheduled()` | EDGE_CONFIG, EDGE_CACHE, EDGE_RATELIMIT, EDGE_REPLAY, SVC_ANALYTICS |
| `shared/` | the contract layer: types, KV config, JWT (WebCrypto HS256), WAF rules, 3-tier rate limiting, SWR/SIE cache, fuzzy matching, HTTP helpers, upstream fetch/rewrites | — | — |

## Quickstart

```bash
cd animaxia-edge
bun install                 # typescript + @cloudflare/workers-types only

bun run typecheck           # tsc --noEmit (strict) over every worker + harness
bun run lint                # guard lint (hygiene + wrangler contracts)
bun run test:smoke          # 146-check hermetic suite — REAL worker code,
                            # in-memory KV/R2/Queue/DO stubs, stubbed cloud
bun run test:e2e            # edge → cloud (:4000) → Neon chain (34 checks)
bun run test                # all of the above in order
```

The **local harness** (`tests/local-harness.ts`) is the trick that makes the
tests credential-free: it implements `KvLike` / `R2Like` / `QueueLike` /
`DoNamespaceLike` / the Cache API in memory, wires every `SVC_*` service
binding to the real sub-worker module in-process, and can stub `globalThis.fetch`
per host. The same worker code that runs under bun runs on Cloudflare.

**E2E prerequisites** (`bun run test:e2e`): the cloud monolith running at
`http://127.0.0.1:4000` with Neon connected and its `.env` present (the suite
reads `DATABASEURL` from `mini-services/animaxia-backend/.env` to derive the
identical HS256 secret as the cloud — no shared secret needs to be copied).

```bash
# from the repository root, if the backend is down:
unzip -o public/animaxia-cloud.zip .env -d mini-services/animaxia-backend/
cd mini-services/animaxia-backend && (setsid bun run dev > log 2>&1 < /dev/null &)
```

## Local development (wrangler dev)

```bash
cp .dev.vars.example .dev.vars       # fill JWT_SECRET or AUTHSECRET+DATABASEURL
bunx wrangler dev --config worker/wrangler.toml   # gateway on :8787
```

Service bindings are **optional at runtime** — without the sub-workers the
gateway degrades to direct cloud routing for that prefix (e.g. `/search` →
`/api/search/advanced` passthrough, `/auth/login` → `/api/auth/login`), so a
single gateway in `wrangler dev` is already useful. Run each sub-worker with
`bunx wrangler dev --config <module>/wrangler.toml` for full behavior.

## Production deploy

1. **One-time resources** — the exact commands are in the header of
   `deploy/deploy-all.sh`: 7 KV namespaces, the `animaxia-media` R2 bucket
   (+ `offline-test.mp4` upload), the `animaxia-edge-analytics` queue.
2. **Fill the KV ids** in each `wrangler.toml` (they ship as
   `REPLACE_WITH_KV_ID` — the deploy script refuses to run until they are
   real, `--allow-placeholder` overrides).
3. **Secrets** — `wrangler secret put <NAME> --config <module>/wrangler.toml`
   per the matrix in each wrangler.toml header (JWT_SECRET or
   AUTHSECRET+DATABASEURL for token parity, EDGE_ADMIN_JWT,
   EDGE_INTERNAL_TOKEN).
4. **Origins** — every `[vars] CLOUD_ORIGIN` defaults to
   `http://127.0.0.1:4000` for local dev; override for production
   (`--var CLOUD_ORIGIN:https://api.animaxia.com` or the dashboard), plus the
   optional AI/VECTOR/MOBILE/WS origin overrides.
5. **Deploy in order** — sub-workers first, gateway last:

```bash
./deploy/deploy-all.sh          # or: bun run deploy:all
```

CI/CD: `.github/workflows/edge-deploy.yml` — verify (typecheck + lint +
hermetic smoke) → deploy (needs `CLOUDFLARE_API_TOKEN` +
`CLOUDFLARE_ACCOUNT_ID` secrets) → optional remote smoke sketch.

## Routing table (gateway)

| Prefix | Target | Cached |
|---|---|---|
| `/api/*` | cloud gateway | public GETs: 60s fresh + SWR + SIE |
| `/ai/*` | SVC_AI → ai origin (`/api/ai/*`) | inside the AI worker (answer + retrieval) |
| `/vector/*` | vector origin (`/api/vector/*`) | no (heavy tier rate-limited) |
| `/mobile/*` | mobile origin (`/api/mobile/*`) | public GETs (`/mobile/home`, `/mobile/config`) |
| `/search`, `/autocomplete` | SVC_SEARCH → `/api/search/*` | fuzzy results are in-memory |
| `/auth/*` | SVC_AUTH → `/api/auth/*` | never (bypass list) |
| `/player/*`, `/hls` | SVC_PLAYER → `/api/mobile/player/*` | manifest 30s, segments 1h |
| `/analytics/*`, `/beacon` | SVC_ANALYTICS → `/api/analytics/*` | never (writes + aggregation) |
| `/media/*` | R2 MEDIA_BUCKET | immutable-ish (max-age=86400) |
| `/ws/*` | WebSocket proxy → WS_ORIGIN | n/a |

## Caching semantics (`shared/cache.ts`)

| Tag | Meaning |
|---|---|
| `MISS` | fresh fetch, response stored (L1 Cache API + L2 KV) |
| `HIT` | served within the fresh window (config `edge.cacheTtlSec`, default 60s) |
| `STALE` | past fresh, inside `edge.swrSec` (600s) — stale served immediately, revalidation runs in the background |
| `STALE-ERROR` | origin erroring/unreachable, stale copy served from inside `edge.staleIfErrorSec` (24h) |
| `BYPASS` | authorized request, mutation, non-2xx or uncacheable upstream |
| `DISABLED` | `cacheTtlSec: 0` via KV config |

Authorized requests are never cached; `X-Edge-Age` reports the copy age.

## Rate limiting (`shared/rate-limit.ts`)

Three tiers, strongest first: **Durable Object** (`RATE_LIMITER`, fixed
window, SQLite + alarm sweep) → **KV** (`EDGE_RATELIMIT`) → **per-isolate
memory**. Limits (KV-configurable): `ipPerMin` 600, `userPerMin` 180,
`heavyPerMin` 30 — the heavy tier applies to `/ai/*` and `/vector/*` for
authenticated *and* anonymous callers. Every response carries
`X-RateLimit-Limit/-Remaining/-Reset`; 429s add `Retry-After`.

## WAF (`shared/waf.ts`)

Bot UA blocklist (curl/wget/scrapers/SEO crawlers/attack tools), SQLi
fingerprints (attack-shaped context only — "O'Reilly" and "one or two" pass),
XSS payloads, path traversal (incl. `%2e%2e%2f`), encoded null bytes,
oversized queries (>8 KB). Blocks are 403 `waf_blocked` with the matched rule
and are logged to `EDGE_CACHE waf:{ts}:{id}` — read them via
`GET /edge/waf/events` (admin). All rules can be toggled via KV config.

## Auth model (`shared/jwt.ts` + `auth/`)

- **Secret parity**: `JWT_SECRET` → `AUTHSECRET` → derived
  `sha256hex("animaxia-auth:<DATABASEURL>")` — identical derivation to the
  cloud, so real cloud tokens verify at the edge with zero secret copying.
- **`GET /auth/verify`**: signature → expiry → **jti anti-replay**
  (`EDGE_REPLAY` registry, single-use) → **device binding** (`dvp` claim ↔
  `x-animaxia-device` header; modes off/soft/strict).
- **`POST /auth/device/token`**: mints a wrapper access token carrying a fresh
  `jti` + `dvp = sha256(deviceId)` — the FAZA 8 anti-replay/device-bound token.
- **`POST /auth/refresh`**: passthrough + replay guard — the presented refresh
  token hash is registered on first use (`rth:<sha256>`, 30d); a second
  presentation is rejected `refresh_replay` (the cloud also rotates server-side).

## Search catalog lifecycle

`loadCatalog`: in-memory snapshot → `SEARCH_CACHE` KV (`catalog:v1`, TTL
`search.catalogTtlSec` = 600s) → rebuild from cloud `/api/all?limit=100&page=N`
(paged, so the full Neon catalog lands at the edge). Fuzzy semantics mirror the
cloud search service (edit distance ≤ 2, max 3 variants per term). Missing
catalog (cloud + KV down) → transparent `/api/search/advanced` passthrough.

## AI cache levels

L1 **answer cache** — `ans:rag:<sha256(path+body)>` per exact request
(`ai.ragAnswerTtlSec` = 300s); L2 **retrieval pre-warm** —
`emb:vec:<sha256(query)>` storing the `/api/vector/search` result
(`ai.embeddingsTtlSec` = 24h) reusable across endpoints. Authorized requests
bypass both (answers embed the caller's profile). SSE responses stream through
untouched. Responses are tagged `x-edge-ai: hit|miss|stream|bypass-auth|passthrough`.

## Player pipeline

`/player/manifest/:id` → cloud `/api/mobile/player/:id` → first HLS source →
manifest text (host **allowlist**, config `player.allowHosts`) → rewrite:
segments → `/hls?u=<abs>`, variant playlists → `/player/manifest/variant?src=<abs>`
(covers `#EXT-X-KEY/MAP/MEDIA/I-FRAME` URIs too). Segments: L1 Cache API +
optional R2 `HLS_CACHE` write-through (`hls/<sha256>.<ext>`) with
**stale-if-error** served from R2 when the origin fails. No HLS source → the
cloud payload passes through tagged `x-edge-player: no-hls` (mp4/youtube fallback).

## Analytics pipeline

Events (`view|play|complete`) → trending counters
(`ANALYTICS_TREND trend:<hourBucket>:<contentId>`, LWW races documented) →
delivery via **Cloudflare Queues** (`ANALYTICS_QUEUE`, consumer batches 25/30s
→ cloud `/api/analytics/views`) or, without the queue, a KV ring buffer
drained by `POST /analytics/flush` (cron `*/5 * * * *`). Trending
`score = views + 2×plays + 3×completes` over 15m/1h/6h/24h/7d windows.

## Cron jobs

| Schedule | Job | Action |
|---|---|---|
| `0 5 * * *` | daily-picks | GET `/api/all` (cache warm + picks refresh) |
| `0 6 * * 1` | weekly-recap | GET `/api/analytics/trending?window=7d&limit=20` |
| `0 */6 * * *` | tmdb-refresh | POST `/api/workers/refresh` (admin JWT; fallback GET `/api/movies?limit=1`) |
| `30 */6 * * *` | jikan-refresh | POST `/api/workers/refresh` (fallback GET `/api/anime?limit=1`) |
| `0 3 * * *` | cleanup-logs | edge-only: purge `waf:*` + `cron:log:*` keys |
| `0 4 * * *` | cleanup-sessions | edge-only: purge `rl:*` + `replay:*` keys |
| `*/5 * * * *` | analytics flush | `SVC_ANALYTICS` → `POST /analytics/flush` |

Every run is recorded to `EDGE_CACHE cron:log:<ts>:<job>` (7-day TTL) and
visible via `GET /cron/jobs`; `GET|POST /cron/run/:job` triggers manually
(admin). Endpoints and schedules are KV-configurable at runtime
(`config.cron.jobs`) — no redeploy needed.

## Testing

- `bun run test:smoke` — 146 hermetic checks in 12 suites: gateway pipeline,
  WAF (blocks + benign passes), all three rate-limit tiers, cache
  MISS→HIT→STALE→STALE-ERROR, R2 Range/ETag, fuzzy search, auth
  (verify/replay/device/refresh-replay), AI two-level cache + SSE passthrough,
  player rewrite chain, analytics queue/buffer/flush, cron manual runs +
  cleanups, WebSocket graceful paths.
- `bun run test:e2e` — 34 checks of the real chain: cloud+Neon health,
  register via edge (Neon write) → edge verify of a real cloud token (derived
  secret) → cached proxying → edge search over the Neon catalog → vector
  retrieval + cache hits → analytics flush → Neon → edge trending counters →
  real HLS manifest rewrite + live segment proxy → WAF on the live gateway →
  runtime KV config override.

## Troubleshooting

- **`REPLACE_WITH_KV_ID`** — create the namespaces (deploy script header) and
  paste the ids; local `wrangler dev` works with placeholders.
- **KV TTL minimum 60s** — real KV enforces it; the harness mirrors it.
- **bun vs workerd** — `WebSocketPair` exists only on Workers: the gateway
  returns an explicit 501 under bun (asserted in the smoke suite); deploy on
  Cloudflare for assistant live.
- **429 during tests** — rate-limit state is per-process; the harness exposes
  `rateLimiter().reset()` and `resetConfigCache()` between scenarios.
- **Quota 402 on `/ai/rag/*`** — the cloud enforces an anonymous AI quota
  (5/day/IP); the edge passes 402s through uncached. The e2e treats it as a
  soft warning.

## FAZA 8 requirements checklist

1. **Edge Gateway** — `worker/`: smart routing (`/api`, `/ai`, `/vector`,
   `/mobile` + module prefixes), 60s edge cache + stale-while-revalidate +
   stale-if-error, per-IP + per-user (+heavy) rate limiting, WAF (bots/SQLi/
   XSS/traversal), KV config, R2 media, WebSocket support → **done**
2. **Edge Search** — `search/`: fuzzy + autocomplete, edge caching, cloud
   fallback → **done**
3. **Edge AI** — `ai/`: edge-accelerated RAG (answer + retrieval caches),
   embeddings cache, cloud fallback, streaming passthrough → **done**
4. **Edge Auth** — `auth/`: JWT verify at the edge, refresh passthrough,
   anti-replay (jti registry + refresh guard), device-bound tokens → **done**
5. **Edge Player** — `player/`: HLS manifest rewrite, segment caching (+R2),
   cloud fallback, R2 media hosting → **done**
6. **Edge Analytics** — `analytics/`: view tracking, trending aggregation,
   batching (Queue consumer) + cron flush → **done**
7. **Cron Jobs** — `cron/`: daily picks, weekly recap, TMDB/Jikan refresh,
   cleanup logs, cleanup sessions (+ analytics flush) → **done**
8. **Deploy** — wrangler.toml per worker with full bindings, GitHub Actions
   CI/CD (`edge-deploy.yml`), smoke suite, E2E edge → cloud → Neon → **done**
9. **ZIP** — `animaxia-edge/` added to `animaxia-cloud.zip` additively
   (nothing pre-existing rewritten) → **done**
