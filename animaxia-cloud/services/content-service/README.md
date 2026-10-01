# content-service — Animaxia Cloud content core (:4002)

The cloud extraction of the monolith's content surface. Every handler in
`router.js` is a **verbatim port** of `mini-services/animaxia-backend/server.js`
(core routes, lines ~89–249) plus the six provider mounts — same validation,
same status codes, same JSON shapes, same mount order. The frontend depends on
these exact contracts.

Owns these gateway prefixes (BLUEPRINT §3): `/api/all`, `/api/content`,
`/api/miner`, `/api/admin`, `/api/anime`, `/api/movies`, `/api/tv`,
`/api/sports`, `/api/news`, `/api/cache`.

```
gateway :8080 ──▶ content-service :4002 ──▶ PostgreSQL (content + platform tables)
                        │                    (local JSON fallback when PG is down)
                        ├──▶ Jikan / TMDB / TVmaze / football-data / Ergast / RSS
                        └──▶ worker thread (5 min): provider probe + thumbnails check
```

## Run

```bash
# from the repo root (loads the root .env)
bun services/content-service/server.js

# or via the workspace script
bun run content
```

Requires `DATABASEURL` (PostgreSQL/Neon). Without it the service boots on the
local JSON fallback store (`LOCALDATADIR/content.json`, default `./data`) and
`GET /api/all` responses carry a `warning` field — same behaviour as the
monolith.

## Environment variables

| Var | Default | Meaning |
|---|---|---|
| `CONTENTPORT` / `PORT` | `4002` | listen port |
| `DATABASEURL` | — | PostgreSQL URL; missing/rejected → local fallback store |
| `PGSSL`, `PGPOOLMAX` | `false`, `10` | pg pool options |
| `LOCALDATADIR` | `./data` | local fallback + `thumbnails/` directory (k8s/docker: `/app/data` on the `animaxia-data` volume) |
| `CACHETTLMS` | `60000` | HTTP response cache TTL (`X-Cache: HIT/MISS`) |
| `PROVIDERCACHETTL_MS` | `120000` | provider response cache TTL (shared common cache) |
| `PROVIDERFAILURETHRESHOLD`, `PROVIDERCIRCUITOPEN_MS` | `3`, `60000` | provider circuit breaker |
| `ADVANCEDCACHEMAX`, `ADVANCEDCACHETTLMS` | `1000`, `300000` | advanced cache LRU bounds |
| `RATELIMITWINDOW_MS`, `RATELIMITMAX` | `60000`, `120` | per-IP fixed window |
| `TMDBAPIKEY`, `TMDBBASEURL` | —, `https://api.themoviedb.org/3` | TMDB |
| `JIKANBASEURL` | `https://api.jikan.moe/v4` | Jikan (MyAnimeList) |
| `TVMAZEBASEURL` | `https://api.tvmaze.com` | TVmaze |
| `FOOTBALLDATAAPI_KEY`, `FOOTBALLDATABASE_URL` | —, `https://api.football-data.org/v4` | football-data.org |
| `ERGASTBASEURL` | `https://api.jolpi.ca/ergast/f1` | Ergast F1 mirror |
| `BBCRSSURL`, `CNNRSSURL`, `NHKRSSURL`, `ALJAZEERARSSURL` | public feeds | RSS news sources |
| `YOUTUBEAPIKEY`, `PLAYERALLOW*` | —, `true` | player trailer fallback + source policy |
| `MINERTIMEOUTMS`, `MINERMAXHTML_BYTES`, `MINERALLOWPRIVATE_NETWORK` | `15000`, `5000000`, `false` | miner SSRF/size guards |
| `AUTHSECRET` | sha256 fallback | JWT secret derivation (attachUser) |

## Endpoints

### Provider mounts (all behind `cacheMiddleware()` → `X-Cache: HIT/MISS`, plus the provider layer's retries/backoff/circuit breaker)

| Method + path | Upstream | Notes |
|---|---|---|
| `GET /api/anime/top?page=` | Jikan | top anime, 24/page |
| `GET /api/anime/search?q=&limit=` | Jikan | 400 when `q` missing; limit 1–50 (default 20) |
| `GET /api/anime/season` | Jikan | current season |
| `GET /api/anime/random` | Jikan | 3 attempts × 1500ms; 502 `Jikan unavailable: …` on final failure |
| `GET /api/anime/:id` | Jikan | 400 invalid id · 404 not found · full detail (+status/episodes/studios) |
| `GET /api/movies/trending?window=day\|week&page=` | TMDB | trending movies |
| `GET /api/movies/popular?page=` · `/top?page=` · `/upcoming?page=` | TMDB | lists |
| `GET /api/movies/search?q=&page=` | TMDB | multi-search (movie+tv), 400 when `q` missing |
| `GET /api/movies/:id` | TMDB | detail + cast + trailer key · 400/404 |
| `GET /api/tv/schedule` | TVmaze | today's schedule (first 30 with images) — **registered before the TMDB tv router so the paths coexist** |
| `GET /api/tv/trending?window=&page=` · `/popular?page=` · `/top?page=` | TMDB | tv lists |
| `GET /api/tv/search?q=&page=` | TMDB | 400 when `q` missing |
| `GET /api/tv/:id` | TMDB | tv detail (+episodes/seasons/trailer) · 400/404 |
| `GET /api/sports/football/competitions` | football-data | curated list, static fallback on upstream failure |
| `GET /api/sports/football/standings?competition=PL` | football-data | 403 plan-limited · 404 unknown competition |
| `GET /api/sports/football/matches?competition=&status=&limit=` | football-data | fixtures |
| `GET /api/sports/f1/standings` | Ergast | current-season driver standings |
| `GET /api/sports/f1/schedule` | Ergast | current-season race calendar |
| `GET /api/news?source=all\|bbc\|cnn\|nhk\|aljazeera&limit=` | RSS | merged + deduped + pubDate-sorted; 400 unknown source; 502 when every feed fails |

### Advanced cache (domain router, mount 7)

| Method + path | What |
|---|---|
| `GET /api/cache/stats` | `{ lru: {...}, global: {...} }` (advanced LRU + common HTTP/provider cache snapshot) — public |
| `POST /api/cache/invalidate` | body `{ tags?: string[], prefix?: string }` → `{ ok, cleared }` — **requireAuth + requireAdmin** (enforced inside the domain router) + audit `cache.invalidate` |

### Core content routes (verbatim monolith port)

| Method + path | What |
|---|---|
| `GET /api/all?page=&limit=&type=&search=&sort=createdat\|title` | paginated listing (`limit` clamped 1–100, default 20) → `{ data, total, page, limit, totalPages, warning? }` — cached |
| `GET /api/content/external/:externalid` | lookup by external id (URL-decode safe) → row or 404 — cached |
| `GET /api/content/:id` | integer id validation (400 `Invalid content id`), row or 404 — cached |
| `POST /api/content` | body `{ externalid, type?, title, thumbnail?, metadata? }`; 400 when `externalid`/`title` missing; upsert → `{ ok, record, created }` + cache invalidation + audit `content.create`/`content.update` |
| `DELETE /api/content/:id` | 400 invalid id · 404 not found · `{ ok, deleted }` + invalidation + audit `content.delete` |
| `GET /api/content/:id/player` | `getContentById` → `resolvePlayer` → `{ content, mode: 'direct'\|'trailer'\|'none', allowedTypes, sources, primary?, note? }` — cached |
| `GET /api/miner?url=&type=&externalId=` · `POST /api/miner` (body `{ url, type?, externalId? }`) | SSRF-safe URL miner; **explicitly uncached — every call re-mines and re-upserts**; 400 `Missing url`; upstream failures → `err.status \|\| 502` → `{ error }`; success → `{ ok, extraction, record }` + invalidation + audit `miner.run` |
| `POST /api/admin/seed` | demo items + TMDB trending movie/tv + top anime (Jikan, TMDB fallback) → `{ ok, added: { movie, tv, anime, demo }, totalItems, animeSource }` + invalidation + audit `admin.seed` |

### Service infra (createService)

| Method + path | What |
|---|---|
| `GET /health` | `{ status: 'ok'\|'degraded', service, version, env, uptimeSec, timestamp, checks: { db, content: { total, byType } }, worker, rateLimit }` |
| `GET /metrics` | Prometheus (`animaxia_http_requests_total`, cache hit/miss, worker heartbeats, …) |
| `GET /` | service info + db driver snapshot |

The monolith's `GET /api/health` is **not** ported: in the cloud the gateway
owns `/api/health` (aggregated fan-out) and this service's own `/health`
carries the db + content-counts summary.

## Auth posture (identical to the monolith)

`attachUser` is on, so `req.user` is populated from the forwarded Bearer token.
The core mutation routes (`POST/DELETE /api/content`, `/api/miner`,
`POST /api/admin/seed`) are **open at the service boundary** — exactly like
the monolith, which audits them with `req.user?.id ?? null`. In the cloud the
gateway's edge ACL admin-gates `/api/admin/*` before requests reach this
service, and `POST /api/cache/invalidate` enforces requireAuth + requireAdmin
inside the domain router.

## Caching & invalidation

`invalidateHttpCache()` (router.js) runs at **every mutation point** exactly
like the monolith — `POST /api/content`, `DELETE /api/content/:id`, miner
success, `POST /api/admin/seed` — and clears `http:*` keys from the shared
common cache singleton, then emits `content:changed` on the platform event bus
(`emitPlatform`, the never-throws wrapper around the monolith's
`events.emit`), which tag-invalidates the advanced cache. Provider responses
live under non-`http:` keys and stay warm across content mutations.
Boot-time seeding additionally invalidates once after seeding an empty
database (the monolith seeds before `listen()` so it needs no equivalent —
documented deviation, safe: clearing a cold per-process cache).

## Seeding & multi-replica note

On boot (createService `seedIfEmpty`) the service replicates the monolith
logic: count the content table; when empty, run `seed()` and log the exact
monolith boot line
(`Seeded demo:N movie:N tv:N anime:N (animeSource=…, totalItems=…)`).
With multiple replicas racing on an empty database, more than one may seed —
this is **acceptable**: `seed()` only performs idempotent upserts keyed on
`externalid`, so replicas converge to identical rows (worst case duplicated
work, never duplicate rows).

## Worker thread (5 min)

- **Provider probe** — plain `fetch` (5s timeout) against the TMDB and Jikan
  base URLs; any HTTP response = reachable (TMDB answers 401 without a key —
  liveness, not API correctness). Results land in `/health` → `worker.lastTask`.
- **Thumbnails check** — file count in `<LOCALDATADIR>/thumbnails`.
- Honest scope note: the worker runs in its own isolate, so it **cannot warm
  the main process's provider cache or breakers** — real traffic does that
  (provider cache TTL `PROVIDERCACHETTL_MS`). The probe is the early-warning
  signal, mirroring the gateway's upstream prober. The worker is deliberately
  DB-free; the DB ping lives in `/health`.

## Docker

```bash
# from the repo root
docker build -f services/content-service/Dockerfile -t ghcr.io/animaxia/content-service:local .
docker run --rm -p 4002:4002 --env-file .env ghcr.io/animaxia/content-service:local
```

Multi-stage bun:1.2-alpine, non-root uid 10001, curl-based `HEALTHCHECK` on
`/health` (BLUEPRINT §8). Mount `animaxia-data` at `/app/data`
(`LOCALDATADIR=/app/data`) to persist the local fallback store + thumbnails.
