# @animaxia/social-service — :4007

The Animaxia Cloud **community plane**: 2-level threaded comments, comment
votes and content likes (`social/comments.js`) plus global and personalized
activity feeds (`social/feed.js`), mounted together on one `/api/social`
surface exactly like the monolith — plus the feed-snapshot maintenance
(described honestly below).

- **Port**: `4007` (env `SOCIALPORT`, then `PORT`)
- **Base URL override** (other services): `SOCIALSERVICEURL` (default `http://localhost:4007`)
- **Boot**: `bun services/social-service/server.js` (or `bun run social` from the repo root)
- **Docker** (from repo root): `docker build -f services/social-service/Dockerfile -t ghcr.io/animaxia/social-service:local .`

## Route table

Gateway proxies `/api/social` here (BLUEPRINT §3). Mount mirrors the monolith:
`app.use('/api/social', commentsRouter, feedRouter)`.

| Method | Path | Auth | Body / Query | Response |
|---|---|---|---|---|
| GET | `/api/social/content/:id/comments` | public (Bearer adds `myVote`) | — | `{ data: [threads] }` (top 50 + replies) |
| POST | `/api/social/content/:id/comments` | Bearer (20/min/user) | `{ body, parentid? }` | `201 { ok, comment }` |
| DELETE | `/api/social/comments/:id` | Bearer (owner or admin) | — | `{ ok }` |
| POST | `/api/social/comments/:id/vote` | Bearer | `{ value: 1\|-1\|0 }` | `{ ok, likes, dislikes, myVote }` |
| POST | `/api/social/content/:id/like` | Bearer | `{ value: 1\|-1\|0 }` | `{ ok, likes, dislikes, myVote }` |
| GET | `/api/social/content/:id/likes` | public (Bearer adds `myVote`) | — | `{ likes, dislikes, myVote }` |
| GET | `/api/social/feed/global` | public | `?cursor=&limit=` (≤20) | `{ data: [activity], nextCursor }` |
| GET | `/api/social/feed/personal` | Bearer | `?cursor=&limit=` (≤20) | `{ data, nextCursor, basedOn }` |
| GET | `/health` · `/metrics` · `/` | public | — | health / Prometheus / service info |

Thread shape (frozen): `{ id, body, createdat, user: { id, username, avatar },
likes, dislikes, myVote, replies: [...] }` — replies to replies re-root on the
top-level parent. Activity shape: `{ id, type: 'comment'|'like'|'content'|
'user', createdat, user?, content?, preview?, value? }`.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `SOCIALPORT` / `PORT` | `4007` | listen port |
| `SERVICENAME` | `social-service` | overrides the service name in logs/metrics |
| `DATABASEURL` | — | shared PostgreSQL connection string (**required**; without it the service boots on the local fallback store and platform routes answer 503) |
| `PGSSL` / `PGPOOLMAX` | `false` / `10` | pg pool options |
| `ADVANCEDCACHEMAX` / `ADVANCEDCACHETTLMS` | `1000` / `300000` | advancedCache capacity / default TTL (the snapshot overrides with its own TTL) |
| `CORS_ORIGIN`, `NODE_ENV`, `METRICSENABLED`, `OTELSENDPOINT`, `OTELSAMPLERATE` | — | standard cloud knobs (common/service.js) |

## Feed-snapshot maintenance — the honest dual approach

Worker threads have **separate module state** from the main process, so a
cache warmed inside the thread is invisible to the request handlers. The
maintenance is therefore split:

1. **Worker thread (`worker.thread.js`, every 5 min)** — DB-light COUNT checks
   over the four activity sources (comments, comments last 24h, likes,
   content, users) and posts
   `{ type:'task', ok:true, detail:{ note, comments, commentsLast24h, likes,
   content, users } }` — the independent health/early-warning signal, visible
   in `/health` → `worker.lastTask` and the `animaxia_worker_*` metrics.
2. **Main process (`server.js`, every 5 min)** — recomputes the global-feed
   snapshot: a faithful replication of `fetchActivities(40)` from
   `domain/social/feed.js` (the module-private heaviest query behind
   GET /feed/global) and stores it via
   `advancedCache.set('feed:global:snapshot', …, { tags: ['social', 'feed'] })`.
   The snapshot is auto-invalidated on every `comment:added` platform event
   (comments are created in this process) and re-warmed on the next tick.
   Freshness is surfaced in `/health` → `checks.snapshot.computedAt`.

**Scope, stated plainly:** the domain feed routes compute per-request
(user-dependent `myVote` / personalization) and do **not** read the snapshot —
it keeps the four source queries hot in the PostgreSQL buffers, provides a
precomputed global page for diagnostics and future fast paths, and doubles as
a canary that the feed query itself stays healthy. Neither the worker thread
nor the refresher is on any request's critical path; both are fail-soft.

## curl examples

```bash
TOKEN=$(curl -sX POST http://localhost:4001/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"admin@animaxia.dev","password":"supersecret1"}' | jq -r .accessToken)

# global activity feed (public)
curl -s 'http://localhost:4007/api/social/feed/global?limit=5' | jq '.data[].type'

# comment on content 1, then read the thread
curl -sX POST http://localhost:4007/api/social/content/1/comments \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"body":"First!"}' | jq '.comment.id'
curl -s http://localhost:4007/api/social/content/1/comments | jq '.data[0]'

# like content 1 (+1) and check tallies
curl -sX POST http://localhost:4007/api/social/content/1/like \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"value":1}' | jq
curl -s http://localhost:4007/api/social/content/1/likes -H "authorization: Bearer $TOKEN" | jq

# personalized feed
curl -s http://localhost:4007/api/social/feed/personal -H "authorization: Bearer $TOKEN" | jq '.basedOn'

# health (db + social counters + snapshot freshness + worker stats)
curl -s http://localhost:4007/health | jq
```
