# @animaxia/analytics-service

Animaxia Cloud **analytics service** (:4004) — viewing analytics for the
platform: raw view-event ingestion, trending content, per-user activity
reports and the admin platform overview. Mounted route family:
**`/api/analytics`** (gateway proxies this prefix here, BLUEPRINT §3).

Business logic lives in `@animaxia/domain/analytics/analytics.js` (mounted
verbatim — this service adds only boot wiring, rate policy, worker and
health).

## Endpoints (from domain/analytics/analytics.js — mounted at `/api/analytics`)

| Method | Path | Auth | Notes |
|---|---|---|---|
| `POST` | `/api/analytics/views` `{ contentId, event }` | public (Bearer attaches `userid`) | Record a `'view'` \| `'play'` \| `'complete'` event → `{ ok: true }`; 404 unknown content; 120/min per IP (router-level limiter); inserts into `viewevents` |
| `GET` | `/api/analytics/trending?window=24h\|7d\|30d&limit=10` | public | Most-watched content scored `plays*2 + views` → `{ data: [{ content, views, plays, score }], fallback }`; limit clamped 1–50; cached 60 s per window; on an empty window falls back to newest content with zeroed metrics (`fallback: true`) |
| `GET` | `/api/analytics/user/:id?days=14` | **required** (401), self or admin (403) | Personal report `{ totals: { views, plays, completed }, viewsByDay, topTypes }`; `days` clamped 1–90; totals are all-time |
| `GET` | `/api/analytics/overview` | **required + admin** | Platform snapshot `{ totals, viewsByDay (14d zero-filled), topContent (top 5), planDistribution, activeUsers7d, recentSignups }`; cached 30 s |

Service-level (createService): `GET /` (info), `GET /health` (readiness), `GET /metrics` (Prometheus).

## Worker thread (`worker.thread.js`, every 15 min)

Daily rollup of raw `viewevents` into **`dailyviewrollups`** — a table the
worker itself ensures (idempotent `CREATE TABLE IF NOT EXISTS`; house-style
lowercase/no-underscore columns):

```sql
-- recomputed for the trailing window (yesterday + today), idempotently:
INSERT INTO dailyviewrollups (contentid, day, views, plays, completed, uniqueviewers, updatedat)
SELECT contentid, date_trunc('day', createdat)::date,
       COUNT(*) FILTER (WHERE event='view'), COUNT(*) FILTER (WHERE event='play'),
       COUNT(*) FILTER (WHERE event='complete'), COUNT(DISTINCT userid), NOW()
FROM viewevents
WHERE createdat >= date_trunc('day', NOW()) - interval '1 day'
GROUP BY 1, 2
ON CONFLICT (contentid, day) DO UPDATE SET views=EXCLUDED.views, …;
```

- **Idempotent**: today's partial aggregates are refreshed every run;
  late-arriving events for yesterday are folded in; older days are immutable.
- Posts `{ type:'task', ok:true, detail: { inserted, windowFrom, lookback } }`
  (`inserted` = upsert rowCount) — visible in `GET /health` → `worker.lastTask`;
  responds to a `{ type:'run' }` parent message with an immediate run.
- The live `/api/analytics` endpoints keep querying `viewevents` directly —
  `dailyviewrollups` is a pre-aggregation for dashboards/BI and a guard
  against unbounded raw-event scans.

## Env vars

| Var | Default | Purpose |
|---|---|---|
| `ANALYTICSPORT` / `PORT` | `4004` | listen port (`PORT` wins, then `ANALYTICSPORT`) |
| `DATABASEURL` | — | Postgres (required: viewevents/users/content tables; local fallback store has no SQL layer) |
| `PGSSL`, `PGPOOLMAX` | `false`, `10` | pg pool tuning |
| `AUTHSECRET` | derived | JWT secret for Bearer verification (must match auth-service) |
| `RATELIMITWINDOW_MS`, `RATELIMITMAX` | `60000`, `240` | outer per-IP limiter (generous — analytics writes are hot; the router adds its own 120/min on `/views`) |
| `ADVANCEDCACHETTLMS`, `ADVANCEDCACHEMAX` | `300000`, `1000` | advancedCache tuning (trending/overview caching) |
| `CORS_ORIGIN`, `TRACINGENABLED`, `OTELSENDPOINT`, `OTELSAMPLERATE`, `METRICSENABLED` | — | standard common/ knobs |

`SERVICENAME` defaults to `analytics-service`; `NODE_ENV` standard.

## Run

```bash
# from repo root (bun workspaces)
bun run analytics                  # or: bun services/analytics-service/server.js
ANALYTICSPORT=4300 bun services/analytics-service/server.js   # custom port

# docker (repo root context)
docker build -f services/analytics-service/Dockerfile -t ghcr.io/animaxia/analytics-service:local .
docker run --rm -p 4004:4004 --env-file .env ghcr.io/animaxia/analytics-service:local
```

## Try it (through the gateway on :8080)

```bash
# record a view event (public)
curl -s -X POST http://localhost:8080/api/analytics/views \
  -H 'content-type: application/json' -d '{"contentId":1,"event":"view"}'

curl -s 'http://localhost:8080/api/analytics/trending?window=24h&limit=5'

# personal report (self) and admin overview need tokens from auth-service
curl -s http://localhost:8080/api/analytics/user/1 -H 'authorization: Bearer <token>'
curl -s http://localhost:8080/api/analytics/overview -H 'authorization: Bearer <admin-token>'

# direct (bypassing the gateway)
curl -s http://localhost:4004/health
```
