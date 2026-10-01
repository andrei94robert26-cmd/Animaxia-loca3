# gateway-service — Animaxia Cloud API Gateway (:8080)

The single entry point in front of every Animaxia Cloud microservice. All
client traffic hits the gateway; it routes by prefix to the right upstream,
enforces an edge auth ACL, caches cacheable GETs at the edge (with
stale-while-error), guards every upstream with a circuit breaker, propagates
W3C `traceparent` for end-to-end distributed tracing and rate-limits the
whole surface.

```
client ──▶ :8080 gateway ──▶ :4001 auth      :4005 search    :4008 mobile
                          ──▶ :4002 content  :4006 premium   :4009 queue
                          ──▶ :4003 ai       :4007 social
                          ──▶ :4004 analytics
```

## Run

```bash
# from the repo root (loads the root .env)
bun services/gateway-service/server.js

# or via the workspace script
bun run gateway
```

Requires no database (the gateway is stateless; DB-backed services attach
users themselves from the forwarded `Authorization` header).

## Environment variables

| Var | Default | Meaning |
|---|---|---|
| `GATEWAYPORT` / `PORT` | `8080` | listen port |
| `GATEWAYRATELIMITWINDOW_MS` | `60000` | global limiter fixed window (per client IP) |
| `GATEWAYRATELIMITMAX` | `300` | max requests per window per client |
| `GATEWAYUPSTREAMTIMEOUTMS` | `15000` | upstream call timeout (504 on exceed) |
| `GATEWAYEDGEDEFAULTTTLMS` | `30000` | edge-cache entry TTL |
| `GATEWAYEDGECACHEENTRIES` | `5000` | edge-cache LRU bound |
| `GATEWAYPURGETOKEN` | *(unset)* | when set, `DELETE /api/gateway/cache` requires `x-purge-token` matching it; when unset the endpoint requires an edge-verified admin |
| `AUTHSERVICEURL` … `QUEUESERVICEURL` | `http://localhost:<port>` | upstream base URLs (docker/k8s overrides) |
| `AUTHSECRET` / `DATABASEURL` | — | JWT secret derivation (same rule as auth-service, see `@animaxia/common/jwt.js`) |

## Routing table (longest prefix wins)

| Prefix | Upstream (default) |
|---|---|
| `/api/auth`, `/api/users`, `/api/security` | auth-service `:4001` |
| `/api/all`, `/api/content`, `/api/miner`, `/api/admin`, `/api/anime`, `/api/movies`, `/api/tv`, `/api/sports`, `/api/news`, `/api/cache` | content-service `:4002` |
| `/api/ai` | ai-service `:4003` |
| `/api/analytics` | analytics-service `:4004` |
| `/api/search` | search-service `:4005` |
| `/api/premium` | premium-service `:4006` |
| `/api/social` | social-service `:4007` |
| `/api/mobile` | mobile-service `:4008` |
| `/api/queue`, `/api/workers` | queue-service `:4009` |
| `/api/health` | gateway itself (aggregated fan-out) |
| `/api/gateway/*` | gateway itself (management API) |
| any other `/api/*` | `404 { error: 'No upstream route', path }` |

The table is imported from `GATEWAY_ROUTES` (`@animaxia/common/services.js`) —
a single source of truth. Live view: `GET /api/gateway/routes`.

## Endpoints on the gateway itself

| Method + path | What |
|---|---|
| `GET /health` | self health (readiness `{ gateway: true }`, worker status) |
| `GET /api/health` | **aggregated** fan-out health of all 9 upstreams (3s timeout each) → `{ status: 'ok'\|'degraded', service: 'gateway', version, timestamp, uptimeSec, upstreams: { auth: { status, service, … }, … }, breakers: [...] }`. Always HTTP 200. |
| `GET /api/health/live` | trivial liveness `{ status: 'ok' }` |
| `GET /api/gateway/routes` | route table + upstream base URLs (credentials masked) + breaker snapshots |
| `GET /api/gateway/cache` | edge-cache stats (keys, hits, misses, hitRate, TTL, prefixes, purges) |
| `DELETE /api/gateway/cache` · `POST /api/gateway/purge` | purge the whole edge cache → `{ ok: true, purged }` — `x-purge-token` when `GATEWAYPURGETOKEN` is set, else edge admin |
| `GET /api/gateway/stats` | limiter stats + breaker snapshots + tracing stats + uptime + edge-auth/edge-cache stats |
| `GET /metrics` | Prometheus (includes `animaxia_gateway_upstream_up{service}`) |
| any `/api/*` not listed above | proxied (see below) |

## How the proxy works (`proxy.js`)

1. **Match** — longest-prefix match against the route table. Unknown `/api/*`
   → `404 { error: 'No upstream route', path }`. `/api/gateway` and
   `/api/health` are never proxied (mounted before the catch-all and skipped
   as a safety net).
2. **Invalidate** — any `POST/PUT/PATCH/DELETE` to `/api/*` purges the
   `/api/all`, `/api/content` and `/api/mobile` edge-cache prefixes first
   (best-effort smart invalidation; services still own their own caches).
3. **Edge cache** — cacheable GET (`/api/all`, `/api/content`, `/api/anime`,
   `/api/movies`, `/api/tv`, `/api/sports`, `/api/news`, `/api/search`,
   `/api/mobile/home`, `/api/analytics/trending`) served on HIT with
   `X-Cache: HIT` + `Age` (no upstream call). Key: `<service>:<originalUrl>`.
4. **Circuit breaker** — one `CircuitBreaker` per upstream (threshold 3
   failures → open 30s → half-open). Rejected call → stale fallback, else
   `503 { error, service, retryAfterSec, degraded: true }` (+`Retry-After`).
5. **Forward** — method, query string, JSON body (re-serialised) and the safe
   header subset `authorization, content-type, accept, user-agent,
   x-request-id` (the gateway-generated request id is added when the client
   sent none). `host`/`connection` are never forwarded. The call goes through
   `serviceFetch` so a `traceparent` header is injected — one trace from the
   browser through the gateway into every service.
6. **Respond** — upstream status + content-type + body passed through
   verbatim, plus `X-Upstream-Service: <name>` and `X-Upstream-Latency-Ms`.
   Fresh cacheable 200s are stored in the edge cache (`X-Cache: MISS`;
   `X-Cache: BYPASS` for non-cacheable).
7. **Failures** — network error → `502`, timeout → `504`
   (`{ error, service, degraded: true, detail }`); upstream 5xx → breaker
   failure + stale fallback, otherwise passed through verbatim with
   `X-Gateway-Degraded: true`. **Upstream 4xx are never masked.**
   Stale-while-error: on network/timeout/5xx, the last stored copy (up to
   10×TTL old — kept in a shadow stale store, see below) is served as `200` +
   `X-Cache: STALE` instead of the error.

## Edge auth (`auth.js`) — verify-only + route ACL

Every `/api/*` request passes the edge-auth middleware first:

- Bearer token verified **locally** (HS256, `@animaxia/common/jwt.js` — same
  secret derivation as auth-service). Valid → `req.edgeUser = { sub, email,
  plan, typ, iat, exp }` (the JWT has **no role claim**); missing/invalid →
  `req.edgeUser = null`. Anonymous requests are never rejected just for
  lacking a token. The original `Authorization` header is **always** forwarded
  upstream — services run their own `attachUser` and make final decisions.
- ACL rejected at the edge (before the hop):

| Path | Rule |
|---|---|
| `/api/users/*` | valid token required (all methods) |
| `/api/social/*` | valid token required on POST/PUT/DELETE (GET feeds are public) |
| `/api/premium/checkout` | valid token required on POST |
| `/api/admin/*`, `/api/security/*`, `/api/cache/admin/*`, `/api/queue/admin/*` | valid token **and** admin |

- `401 { error: 'Authentication required' }` when a token is required but
  absent/invalid; `403 { error: 'Admin access required' }` for non-admins;
  `503` when the admin verification itself is unavailable.

### Admin check contract (auth-service, agent 3-b)

```
POST ${AUTHSERVICEURL}/internal/verify-admin
content-type: application/json          (+ traceparent injected)
{ "sub": "<user id>" }

→ 200 { "ok": true, "admin": true|false, "user": { … } }   ← gate on body.admin === true
→ 404                                                     ← unknown user → admin: false
→ 5xx / network error                                     ← gateway fails CLOSED (503)
```

Results (true **and** false) are cached per `sub` for **60 s** on the gateway
(`gateway-admin-check` cache) — a promotion to admin lags ≤ 60 s at the edge.
`null` (unavailable) is never cached, so recovery is immediate. The same
check backs `requireEdgeAdmin` for `DELETE /api/gateway/cache`.

## Rate limiting (`rateLimit.js`)

One fixed-window limiter for **all** `/api/*` traffic (per client IP):
`GATEWAYRATELIMITMAX` per `GATEWAYRATELIMITWINDOW_MS` (default 300/min). The
limiter instance is owned by this service (mounted in the global router
chain) so `GET /api/gateway/stats` can report live numbers; the gateway's own
`/health`, `/metrics` and `/` are intentionally unthrottled so probes and
scrapes never see a 429.

## Worker thread (`worker.thread.js`)

Every 30 s probes `GET <upstream>/health` (3 s timeout) for all 9 upstreams,
tracks consecutive failures and downtime-since timestamps, and posts
`{ type: 'task', ok: true, detail: { up, downSince, failures } }`. It is
dependency-free (node: builtins only) so it runs identically in bun worker
threads, and it answers `{ type: 'run' }` with an immediate probe. server.js
polls the last task result every 15 s and sets
`animaxia_gateway_upstream_up{service}` (1 up / 0 down) on `/metrics`.

## Implementation notes / deviations

- **Worker path is absolute**: `common/worker.js` resolves a relative `file`
  against `common/` itself, so server.js passes
  `fileURLToPath(new URL('./worker.thread.js', import.meta.url))`.
- **Limiter ownership**: `rateLimit: null` is passed to `createService` and
  the global limiter is mounted manually (see above) so its stats are
  reportable.
- **JSON-only bodies**: request bodies are parsed by `express.json` and
  re-serialised upstream — the Animaxia API is 100% JSON; multipart/raw-text
  uploads are not proxied.
- **Stale shadow store**: `common/cache.js`'s `get()` deletes expired entries
  on lookup and `peek()` rejects anything past `expiresAt`, so the spec's
  `instance.peek(key, { maxAgeMs: 10 × TTL })` alone cannot ever return a
  stale (expired) copy. `edgeCache.js` therefore keeps a shadow Map with the
  SAME entry objects (bodies are not duplicated) for the stale-while-error
  window; both stores are purged together (purgeAll / purgePrefix /
  invalidation).
- **Aggregated health is unaggregated-cached**: every `GET /api/health` does
  a fresh fan-out (max 3 s) — dashboards get live data at the cost of 9
  internal calls.

## Files

```
services/gateway-service/
├── package.json     # @animaxia/gateway-service (express, cors, dotenv, @animaxia/common)
├── server.js        # createService() wiring — global chain, routers, worker, gauge
├── router.js        # /api/gateway/* management endpoints
├── proxy.js         # routing/proxy core (breakers, serviceFetch, pass-through)
├── auth.js          # edge auth (verify-only JWT + ACL + admin check)
├── edgeCache.js     # edge caching policy + stale-while-error + invalidation
├── health.js        # aggregated upstream health fan-out (+ /live)
├── rateLimit.js     # global limiter config + owned instance
├── cache.js         # edge-cache instance (createCache)
├── worker.thread.js # upstream health prober thread (node: builtins only)
├── Dockerfile       # bun:1.2-alpine multi-stage (build context = repo root)
└── README.md        # this file
```
