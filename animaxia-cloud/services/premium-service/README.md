# @animaxia/premium-service — :4006

The Animaxia Cloud **monetization plane**: plan catalog + entitlement checks
(`premium/plans.js`) and Stripe checkout/confirm/cancel (`premium/stripe.js`),
mounted together on one `/api/premium` surface exactly like the monolith, plus
an hourly worker that expires lapsed paid plans back to `free`.

- **Port**: `4006` (env `PREMIUMPORT`, then `PORT`)
- **Base URL override** (other services): `PREMIUMSERVICEURL` (default `http://localhost:4006`)
- **Boot**: `bun services/premium-service/server.js` (or `bun run premium` from the repo root)
- **Docker** (from repo root): `docker build -f services/premium-service/Dockerfile -t ghcr.io/animaxia/premium-service:local .`

## Route table

Gateway proxies `/api/premium` here (BLUEPRINT §3). Mount mirrors the monolith:
`app.use('/api/premium', plansRouter, stripeRouter)`.

| Method | Path | Auth | Body | Response |
|---|---|---|---|---|
| GET | `/api/premium/plans` | public | — | `{ data: [free, plus, pro] }` |
| GET | `/api/premium/me` | Bearer | — | `{ plan, limits, subscription, usage }` |
| GET | `/api/premium/verify` | Bearer | — | `{ plan, active, limits }` |
| POST | `/api/premium/checkout` | Bearer (+ gateway edge token check) | `{ plan: 'plus'\|'pro' }` | `{ ok, sessionId, url, mode }` |
| POST | `/api/premium/confirm` | Bearer | `{ sessionId }` | `{ ok, user, subscription }` (402 until paid in live mode) |
| POST | `/api/premium/cancel` | Bearer | — | `{ ok, subscription }` |
| GET | `/health` · `/metrics` · `/` | public | — | health / Prometheus / service info |

**Stripe modes** (identical to the monolith):
- *Sandbox* (default, no `STRIPESECRETKEY`): fully simulated checkout —
  `cs_sandbox_<hex>` session ids held in memory and mirrored into the
  `subscriptions` table (provider `stripe-sandbox`), so `/confirm` still works
  after a restart. `url` returned is the SPA route `/premium?session=…`.
- *Live* (`STRIPESECRETKEY` starting with `sk_`): real Stripe Checkout Sessions
  via the REST API (no SDK); any Stripe failure → `502 { error: 'Stripe error: …' }`.

Side effects on confirm/cancel: `users.plan`/`users.planexpiresat` updates,
`auditLog('premium.subscribe'|'premium.cancel')`, `emitPlatform('plan:changed')`
(in-process event bus → advanced-cache invalidation).

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PREMIUMPORT` / `PORT` | `4006` | listen port |
| `SERVICENAME` | `premium-service` | overrides the service name in logs/metrics |
| `DATABASEURL` | — | shared PostgreSQL connection string (**required**; without it the service boots on the local fallback store and platform routes answer 503) |
| `PGSSL` / `PGPOOLMAX` | `false` / `10` | pg pool options |
| `STRIPESECRETKEY` | — | `sk_…` → live Stripe mode; anything else/empty → sandbox mode |
| `CORS_ORIGIN`, `NODE_ENV`, `METRICSENABLED`, `OTELSENDPOINT`, `OTELSAMPLERATE` | — | standard cloud knobs (common/service.js) |

## Worker thread (`worker.thread.js`, every hour)

Plan-expiry sweep on the shared `users` table:

```sql
UPDATE users
   SET plan = 'free', planexpiresat = NULL
 WHERE planexpiresat IS NOT NULL
   AND planexpiresat < NOW()
   AND plan <> 'free'
RETURNING id;
```

Posts `{ type:'task', ok:true, detail:{ expired, expiredUserIds (≤100),
expiredTruncated, paidRemaining } }` to the main process (visible in `/health`
→ `worker.lastTask` and the `animaxia_worker_*` metrics); server.js logs each
non-zero sweep. **Honest limitation:** worker isolates have separate module
state from the main process, so the thread cannot emit `plan:changed` into the
platform event bus — entitlement enforcement doesn't need it anyway, because
every authenticated request re-reads the fresh `users` row
(`attachUserFromToken` / domain `requireAuth`).

## curl examples

```bash
TOKEN=$(curl -sX POST http://localhost:4001/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"admin@animaxia.dev","password":"supersecret1"}' | jq -r .accessToken)

# plan catalog (public)
curl -s http://localhost:4006/api/premium/plans | jq '.data[].key'

# current plan + usage
curl -s http://localhost:4006/api/premium/me -H "authorization: Bearer $TOKEN"

# sandbox checkout → confirm
SESSION=$(curl -sX POST http://localhost:4006/api/premium/checkout \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"plan":"plus"}' | jq -r .sessionId)
curl -sX POST http://localhost:4006/api/premium/confirm \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"sessionId\":\"$SESSION\"}" | jq '{ok, user: .user.plan}'

# cancel → back to free
curl -sX POST http://localhost:4006/api/premium/cancel -H "authorization: Bearer $TOKEN"

# health
curl -s http://localhost:4006/health | jq
```
