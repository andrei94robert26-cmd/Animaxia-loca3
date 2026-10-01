# @animaxia/auth-service — :4001

The Animaxia Cloud **identity plane**: accounts, sessions, profiles and the
admin security console, plus the frozen `/internal/verify-admin` contract the
API gateway's edge ACL depends on.

- **Port**: `4001` (env `AUTHPORT`, then `PORT` — same precedence as every service)
- **Base URL override** (other services): `AUTHSERVICEURL` (default `http://localhost:4001`)
- **Boot**: `bun services/auth-service/server.js` (or `bun run auth` from the repo root)
- **Docker** (from repo root): `docker build -f services/auth-service/Dockerfile -t ghcr.io/animaxia/auth-service:local .`

## Route table

Gateway proxies `/api/auth`, `/api/users`, `/api/security` here (BLUEPRINT §3).
Routes are the domain modules mounted exactly like the monolith:

| Method | Path | Auth | Body / Query | Response |
|---|---|---|---|---|
| POST | `/api/auth/register` | public (30/min/IP) | `{ email, username, password }` | `201 { ok, user, accessToken, refreshToken, expiresIn }` |
| POST | `/api/auth/login` | public (30/min/IP + brute-force lock) | `{ email, password }` | `{ ok, user, accessToken, refreshToken, expiresIn }` |
| POST | `/api/auth/refresh` | public (rotating token) | `{ refreshToken }` | `{ ok, accessToken, refreshToken, expiresIn }` |
| POST | `/api/auth/logout` | public | `{ refreshToken }` | `{ ok, revoked }` |
| GET | `/api/auth/me` | Bearer | — | `{ user, stats: { watchlist, history, comments } }` |
| GET | `/api/users/me` | Bearer (mount-level `requireAuth`) | — | `{ user, stats }` |
| PATCH | `/api/users/me` | Bearer | `{ username?, avatar?, preferences? }` | `{ user }` |
| POST | `/api/users/me/avatar` | Bearer | `{ image: dataURL ≤512KB }` | `{ user }` |
| GET | `/api/users/me/watchlist` | Bearer | — | `{ data: [{ content, addedat }] }` |
| POST | `/api/users/me/watchlist` | Bearer | `{ contentId }` | `{ ok, added }` (402 on plan limit) |
| DELETE | `/api/users/me/watchlist/:contentId` | Bearer | — | `{ ok, removed }` |
| GET | `/api/users/me/history` | Bearer | `?limit=` | `{ data: [{ content, watchedat, progress }] }` |
| POST | `/api/users/me/history` | Bearer | `{ contentId, progress }` | `{ ok }` |
| GET | `/api/users/me/preferences` | Bearer | — | `{ preferences }` |
| PUT | `/api/users/me/preferences` | Bearer | `{ types?, genres?, franchises? }` | `{ preferences }` |
| GET | `/api/security/status` | Bearer + admin | — | `{ bruteForce, buckets, auditTotal }` |
| GET | `/api/security/audit` | Bearer + admin | `?limit=&offset=&action=` | `{ data, total, limit, offset }` |
| POST | `/internal/verify-admin` | internal (gateway only) | `{ sub }` | see below |
| GET | `/health` · `/metrics` · `/` | public | — | health / Prometheus / service info |

### `/internal/verify-admin` (FROZEN — consumed by gateway-service)

```jsonc
POST /internal/verify-admin        body { "sub": 1 }        // number or numeric string
→ 200 { "ok": true, "admin": true, "user": { …publicUser… } }   // admin = (role === 'admin')
→ 404 { "ok": false, "admin": false, "error": "User not found" } // unknown sub
→ 400 { "ok": false, "error": "Missing sub" }                   // missing/invalid sub
```

The gateway calls this once per admin-gated request and caches the answer
(true **and** false) for **60 s** per `sub`; `404` → "not an admin", anything
else → the gateway fails closed with `503`. Internal volume is therefore tiny
and rides behind the service's blanket limiter (120/min/IP). Keep `/internal`
off the public internet — network policy should expose it to the gateway only.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `AUTHPORT` / `PORT` | `4001` | listen port |
| `SERVICENAME` | `auth-service` | overrides the service name in logs/metrics |
| `DATABASEURL` | — | shared PostgreSQL (Neon) connection string (**required** for the platform tables; without it the service boots on the local fallback store and platform routes answer 503) |
| `PGSSL` / `PGPOOLMAX` | `false` / `10` | pg pool options |
| `AUTHSECRET` | derived | HS256 secret (else sha256(`animaxia-auth:<DATABASEURL>`)) — must match the gateway |
| `ADMINEMAILS` | — | comma list of emails registered as admin (bootstrap rule: first account is always admin) |
| `CORS_ORIGIN`, `NODE_ENV`, `METRICSENABLED`, `OTELSENDPOINT`, `OTELSAMPLERATE` | — | standard cloud knobs (common/service.js) |

## Worker thread (`worker.thread.js`, every 5 min)

Refresh-token housekeeping on the shared `refreshtokens` table:

```sql
DELETE FROM refreshtokens
 WHERE expiresat < NOW()
    OR (revoked = TRUE AND createdat < NOW() - INTERVAL '7 days')
RETURNING id;
```

Posts `{ type:'task', ok:true, detail:{ deleted, remaining, policy } }` to the
main process (visible in `/health` → `worker.lastTask` and the
`animaxia_worker_*` metrics). Note: the schema has **no `revokedat` column**
(common/migrations.js), so revoked tokens are retained for 7 days from their
*creation* — they are useless the moment they are rotated out; the window
exists for debugging only.

## curl examples

```bash
# register (first account becomes admin)
curl -sX POST http://localhost:4001/api/auth/register \
  -H 'content-type: application/json' \
  -d '{"email":"admin@animaxia.dev","username":"admin","password":"supersecret1"}'

# login → copy accessToken
TOKEN=$(curl -sX POST http://localhost:4001/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"admin@animaxia.dev","password":"supersecret1"}' | jq -r .accessToken)

# profile snapshot
curl -s http://localhost:4001/api/users/me -H "authorization: Bearer $TOKEN"

# admin check (what the gateway does internally)
curl -sX POST http://localhost:4001/internal/verify-admin \
  -H 'content-type: application/json' -d '{"sub":1}'

# admin security console
curl -s http://localhost:4001/api/security/status -H "authorization: Bearer $TOKEN"

# health
curl -s http://localhost:4001/health | jq
```
