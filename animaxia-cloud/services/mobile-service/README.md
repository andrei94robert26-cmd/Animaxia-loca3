# mobile-service — Animaxia Cloud mobile BFF (:4008)

Backend-for-frontend for the Animaxia mobile client: compact, bandwidth-friendly
payloads assembled by the domain router `@animaxia/domain/mobile/mobile.js`
(mounted verbatim, same as the monolith's `app.use('/api/mobile', mobileRouter)`).
The router queries the **shared PostgreSQL** directly (content, viewevents,
watchhistory, watchlist, users) — the same database every Animaxia service uses —
so there is no in-process dependency on content-service.

Owns the gateway prefix `/api/mobile` (BLUEPRINT §3).

## Run

```bash
# from the repo root (loads the root .env)
bun services/mobile-service/server.js

# or via the workspace script
bun run mobile
```

Requires `DATABASEURL` (PostgreSQL/Neon). Without it the service boots on the
local JSON fallback store; the mobile SQL rows (viewevents/watchhistory joins)
require the platform schema, which `ensurePlatformSchema` creates at boot.

## Environment variables

| Var | Default | Meaning |
|---|---|---|
| `MOBILEPORT` / `PORT` | `4008` | listen port |
| `DATABASEURL` | — | PostgreSQL URL (shared database) |
| `PGSSL`, `PGPOOLMAX` | `false`, `10` | pg pool options |
| `LOCALDATADIR` | `./data` | local fallback store directory |
| `ADVANCEDCACHEMAX`, `ADVANCEDCACHETTLMS` | `1000`, `300000` | advanced cache LRU bounds (the /home entry uses its own 60s TTL) |
| `RATELIMITWINDOW_MS`, `RATELIMITMAX` | `60000`, `120` | per-IP fixed window |
| `PLAYERALLOWMP4/M3U8/IFRAME/YOUTUBE`, `YOUTUBEAPIKEY` | `true`, — | player source policy (player resolution inside `/player/:id`) |
| `AUTHSECRET` | sha256 fallback | JWT secret derivation (attachUser / requireAuth) |

## Endpoints

### Mobile BFF (domain router, mounted at `/api/mobile`)

| Method + path | What |
|---|---|
| `GET /api/mobile/home` | home screen → `{ hero, rows: [{ key, title, items }], config }`. **Public**; authenticated callers additionally get the leading `continue` row. Compact items: `{ id, title, type, thumbnail, rating, year }`. Trending = most-viewed (7d `viewevents`) with newest-content cold-start fallback; hero = first trending item (+overview/backdrop) |
| `GET /api/mobile/player/:id` | compact player payload → `{ content, mode, allowedTypes, sources, primary, nextUp }`; 400 `Invalid content id` · 404 `Content not found`; `nextUp` = next trending item; never cached (resolvePlayer may call YouTube for the trailer fallback) |
| `GET /api/mobile/profile` | **requireAuth** → `{ user, plan, limits, watchlistCount, recentHistory }` (recent 5 with `watchedat`/`progress`) |
| `GET /api/mobile/config` | client bootstrap → `{ versions: { min, latest }, features, endpoints }` — public |

### Service infra (createService)

| Method + path | What |
|---|---|
| `GET /health` | `{ status: 'ok'\|'degraded', service, version, env, uptimeSec, timestamp, checks: { db, content: { total } }, worker, rateLimit }` |
| `GET /metrics` | Prometheus (`animaxia_http_requests_total`, cache hit/miss, worker heartbeats, …) |
| `GET /` | service info + db driver snapshot |

`router.js` is a thin composition layer over the domain router (BLUEPRINT §7
template) — no service-specific routes yet.

## Caching — honest posture

- Mobile responses are **user-dependent** → the global HTTP `cacheMiddleware`
  is never applied to `/api/mobile` (mounting it would leak one user's
  Continue-watching row to everyone).
- The **anonymous** `/home` payload is cached inside the domain router via the
  advancedCache: key `mobile:home`, **60s TTL**, tagged `content` →
  auto-invalidated on `content:changed` events. Authenticated `/home` calls
  are always built fresh.
- **This service cannot actively pre-warm that cache**: the builder
  (`buildHome`) is module-private in `@animaxia/domain/mobile/mobile.js` —
  not exported — so neither the main process (no function to call) nor the
  worker thread (separate isolate, separate cache instance) can warm the
  main process's advancedCache. The payload warms **lazily** on the first
  anonymous `/home` request after boot or TTL expiry — a ≤60s cold window at
  worst. The worker thread's 5-minute content count is the refresh signal
  operators watch (content arriving → the next `/home` request rebuilds the
  rows).

## Worker thread (5 min)

- Runs `SELECT COUNT(*) FROM content` (via `countContent`, with local-fallback
  support) on its own short-lived lazy pg pool (open → query → close, the
  same pattern as `domain/workers/tasks/mine.mjs`), then posts
  `{ type: 'task', ok, detail: { content: n, driver } }` — surfaced in
  `/health` → `worker.lastTask` and the `animaxia_worker_*` metrics.
- Catch-all errors post `{ ok: false, error }`; the thread never crashes the
  service and answers parent `{ type: 'run' }` messages with an immediate run.

## Auth posture (identical to the monolith)

`attachUser` is on, so `req.user` is populated from the forwarded Bearer
token; the domain router branches on it for `/home` and enforces
`requireAuth` on `/profile` internally. No router-level guards are added at
the service boundary — the monolith mounted `/api/mobile` without any, and
the gateway's edge ACL handles generic protection upstream.

## Docker

```bash
# from the repo root
docker build -f services/mobile-service/Dockerfile -t ghcr.io/animaxia/mobile-service:local .
docker run --rm -p 4008:4008 --env-file .env ghcr.io/animaxia/mobile-service:local
```

Multi-stage bun:1.2-alpine, non-root uid 10001, curl-based `HEALTHCHECK` on
`/health` (BLUEPRINT §8).
