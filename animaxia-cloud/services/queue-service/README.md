# queue-service (:4009)

The async backbone of Animaxia Cloud: a **durable PostgreSQL-backed job queue**
(no Redis), an in-process **consumer pool** running all eleven house job types,
a **cron scheduler**, and the **monolith-compatible `/api/workers` API**. The
gateway proxies `/api/queue` and `/api/workers` here (BLUEPRINT §3/§10).

```
bun services/queue-service/server.js        # or: bun run queue (repo root)
```

## Architecture

```
                    ┌────────────────────────────────────────────────────┐
  gateway :8080 ───▶│ queue-service :4009                                │
  /api/queue/*      │                                                    │
  /api/workers/*    │  Express (createService)                           │
                    │   ├── router.js        /api/queue  (REST surface)   │
                    │   ├── workersCompat.js /api/workers (monolith API)  │
                    │   ├── consumers.js     HANDLERS + poll loop ────────┼──▶ jobs table (PG)
                    │   ├── cron.js          scheduler + tick route ──────┼──▶ schedules table (PG)
                    │   └── worker.thread.js every 30s: requeueStale +    │
                    │                        purgeFinished (own pg pool)  │
                    └────────────────────────────────────────────────────┘
```

**Queue mechanics** (implemented in `@animaxia/common/queue.js`):

- **Claiming** — `UPDATE jobs … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)`:
  multiple consumers (and multiple replicas — k8s scales this service) claim
  disjoint job sets without contention; priority `DESC`, then `runat`, then id.
- **Leases** — a claim sets `lockedby = queue-<pid>` and
  `leaseexpiresat = NOW() + QUEUEWORKERTTLSEC` (default 180s). A crashed or
  stuck consumer loses its claim: the maintenance worker thread reclaims
  lease-expired `running` jobs back to `pending` every 30s (`requeueStale`).
- **Retries + backoff** — handler failures call `failJob`: the job returns to
  `pending` with **quadratic backoff** (`attempts² · 5s`) until `maxattempts`
  (default 3), after which it is dead-lettered (`status = 'dead'`, surfaced in
  `/api/queue/stats` as `deadLetters`). Admins can requeue via
  `POST /api/queue/jobs/:id/retry`.
- **Retention** — `purgeFinished` deletes `done|failed|dead` jobs older than
  `QUEUERETENTIONDAYS` (default 7 days). The daily `maintenance.cleanup-logs`
  cron is a stricter pass (finished jobs older than 1 day).
- **Statuses** — `pending → running → done` with `failed` (retryable) and
  `dead` (terminal, awaiting manual retry/delete).

**Consumer pool** — `consumers.js` polls every `QUEUEPOLLMS` (default 2000ms)
and runs up to `QUEUECONCURRENCY` (default 4) handlers in-process. Handlers
import the same `@animaxia/domain` modules as the rest of the fleet, so
side effects work exactly like the monolith worker pool: player prefetch warms
`advancedCache`, mine/refresh invalidate the `http:` response cache and emit
`content:changed`, thumbnails write `data/thumbnails/*.svg`. Unknown job types
are failed immediately (`failJob('Unknown job type: …')`).

**Cron scheduler** — `cron.js` owns a minimal 5-field cron matcher
(`*`, `*/n`, `a,b`, `a-b`; dow 0 and 7 both Sunday) and evaluates the six
frozen schedules every 30s. Fire-once-per-minute is guaranteed by (1) the
`schedules` persistence table (`name` PK, `lastrunat`) with a 55s dedupe
window and (2) skipping when a `pending`/`running` job of that type already
exists. `POST /api/queue/cron/tick` runs the same evaluation, so the K8s
CronJobs (`deploy/k8s/90-cronjobs.yaml`) are belt & braces with the internal
interval. `QUEUESCHEDULERENABLED=false` disables the internal interval (the
tick route keeps working).

## REST API

### `/api/queue` (router.js)

| Method | Path                | Auth         | Description |
|--------|---------------------|--------------|-------------|
| POST   | `/jobs`             | Bearer (any user) | `{type, payload?, priority?, runAt?, maxAttempts?}` → `201 {ok, job}`. Type validated against the live handler registry. |
| GET    | `/jobs?status=&type=&limit=&offset=` | public | `{ok, data, total}` (total via SQL count; status ∈ pending/running/done/failed/dead) |
| GET    | `/jobs/:id`         | public       | Full job row (incl. payload/result) or 404 |
| POST   | `/jobs/:id/retry`   | Admin        | Re-queue a `failed`/`dead` job (attempts reset) → `{ok, job}` or 404 |
| DELETE | `/jobs/:id`         | Admin        | Delete a job → `{ok}` or 404 |
| GET    | `/stats`            | public       | `{ok, byStatus, byType, oldestPendingAgeSec, deadLetters, leaseSec, retentionDays, consumers, handlers}` |
| POST   | `/cron/tick`        | public       | K8s CronJob target. Body `{job, payload}` → enqueue directly (validated) → `{ok, jobId}`; empty body → evaluate schedules → `{ok, enqueued: [...]}` |
| GET    | `/cron/schedules`   | public       | `{ok, schedules: [{schedule, type, payload, lastrunat}]}` |

### `/api/workers` (workersCompat.js — monolith-compatible)

| Method | Path              | Auth         | Description |
|--------|-------------------|--------------|-------------|
| POST   | `/mine`           | Bearer (any user) | `{url, type?, externalId?}` → enqueue `miner.mine` → `{ok, jobId}` |
| POST   | `/prefetch`       | Bearer (any user) | `{contentId}` (404 when content missing) → enqueue `miner.prefetch` → `{ok, jobId}` |
| POST   | `/thumbnails`     | Admin        | `{contentId?}` or `{missing: true}` → enqueue `thumbnails.generate` → `{ok, jobId}` |
| POST   | `/refresh`        | Admin        | `{source: 'tmdb'\|'jikan'}` → enqueue `providers.refresh` → `{ok, jobId}` |
| GET    | `/jobs`           | public       | Latest 20 jobs, payload stripped → `{data}` |
| GET    | `/jobs/:id`       | public       | Full job row or 404 |
| GET    | `/status`         | public       | `{pool: {model: 'postgres-queue', concurrency, inflight}, jobs: byStatus, schedules: lastrunat map}` |
| GET    | `/thumbnails/:file` | public     | Generated SVG poster. Sanitised: `path.basename` + `^[a-z0-9-]+\.svg$`, 404 otherwise; `image/svg+xml`, `Cache-Control: public, max-age=3600` |

## Job types

| Type | Payload | Handler result | Notes |
|------|---------|----------------|-------|
| `miner.mine` | `{url, type?, externalId?}` | `{ok, contentId, title}` | `mineUrl` → clears `http:` caches → emits `content:changed` |
| `miner.prefetch` | `{contentId}` | `{ok, contentId, mode, sources}` | 404→fail; `resolvePlayer` cached 120s (`advancedCache.set(..., {ttlMs: 120000, tags: ['content']})`) |
| `ai.batch` | `{limit?}` (default 5, max 20) | `{ok, processed, updated}` | Rows with `metadata.aisummary IS NULL`; z-ai chat completion (2-3 sentence English summary) with heuristic first-sentence fallback; `upsertContent` metadata merge |
| `analytics.batch` | `{}` | `{ok, upserted}` | Idempotent `viewevents` → `dailyviewrollups` INSERT…SELECT…ON CONFLICT over yesterday+today (same statement the analytics-service worker runs — converges on the identical table) |
| `indexing.batch` | `{limit?}` | `{ok, docs, latestContentAt, note}` | **Honesty note:** search-service's index is in-process memory this service cannot warm. The job re-validates content freshness (COUNT + MAX(createdat)) and reports it; see "Search index freshness" below |
| `providers.refresh` | `{source: 'tmdb'\|'jikan'}` | `{ok, source, upserted}` | tmdb: trending movies+TV (top 20 each) via `tmdbFetch` + genre map (seed.js pattern); jikan: top anime (20) via `fetchProviderJson` 4-attempt loop; then `http:` cache clear + `content:changed` |
| `thumbnails.generate` | `{contentId?}` or `{missing: true}` | `{ok, generated: [files], updated}` | Monolith SVG poster generator (FNV-1a title hash → deterministic gradient); writes `data/thumbnails/<slug>-<id>.svg`, links rows via `upsertContent`; `missing:true` covers up to 20 artwork-less rows |
| `maintenance.cleanup-logs` | `{}` | `{ok, purged}` | Finished queue jobs are the logs: `purgeFinished({olderThanDays: 1})` |
| `maintenance.cleanup-audit` | `{}` | `{ok, deleted}` | `DELETE FROM auditlogs WHERE createdat < NOW() - INTERVAL '90 days'` |
| `maintenance.cleanup-sessions` | `{}` | `{ok, deleted}` | `DELETE FROM refreshtokens WHERE expiresat < NOW() OR revoked = TRUE` |
| `maintenance.reindex` | `{}` | `{ok, docs, latestContentAt, note}` | Same freshness probe as `indexing.batch` (fleet-wide daily intent) |

### Search index freshness (documented limitation)

The monolith rebuilt its search index in-process. In the cloud the index lives
in **search-service's memory** — a queue job cannot reach another service's
heap. The queue therefore does what is honest and useful: `indexing.batch` /
`maintenance.reindex` re-validate content freshness and report
`docs`/`latestContentAt`, while search-service keeps its own index fresh via
(1) `content:changed` events from its own process, (2) its worker-thread
watermark probe (COUNT + MAX(createdat) every 10 min, main thread emits
`content:changed` on drift) and (3) the manual admin `POST /api/search/index`.
This job does **not** call that endpoint (cross-service auth complexity);
trigger it manually when you need a synchronous rebuild.

## Cron schedules

| Expression | Job | Meaning |
|------------|-----|---------|
| `0 */6 * * *` | `providers.refresh {source:'tmdb'}` | TMDB trending every 6h |
| `30 */6 * * *` | `providers.refresh {source:'jikan'}` | Jikan top anime every 6h (offset) |
| `0 3 * * *` | `maintenance.cleanup-logs` | Daily 03:00 — purge finished jobs >1d |
| `15 3 * * *` | `maintenance.cleanup-audit` | Daily 03:15 — audit logs >90d |
| `0 * * * *` | `maintenance.cleanup-sessions` | Hourly — expired/revoked refresh tokens |
| `0 4 * * *` | `maintenance.reindex` | Daily 04:00 — content freshness probe |

K8s CronJobs POST these to `/api/queue/cron/tick` as belt & braces; whichever
fires first records `lastrunat`, the other dedupes.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `QUEUEPORT` / `PORT` | `4009` | Listen port (`QUEUEPORT` wins per house precedence) |
| `DATABASEURL` | — | PostgreSQL connection string (queue, content, platform tables) |
| `QUEUEPOLLMS` | `2000` | Consumer claim interval |
| `QUEUECONCURRENCY` | `4` | Max simultaneously-running jobs (claim batch ≤10) |
| `QUEUEWORKERTTLSEC` | `180` | Job lease length before stale reclaim |
| `QUEUESCHEDULERENABLED` | `true` | `false` disables the internal cron interval (tick route stays live) |
| `QUEUERETENTIONDAYS` | `7` | purgeFinished retention (worker thread) |
| `LOCALDATADIR` | `./data` | Thumbnails dir base (`<dir>/thumbnails`, mounted at `/app/data` in docker/k8s) |
| `TMDBAPIKEY`, `TMDBBASEURL` | — | providers.refresh (tmdb) |
| `JIKANBASEURL` | `https://api.jikan.moe/v4` | providers.refresh (jikan) |
| `RATELIMITWINDOW_MS` / `RATELIMITMAX` | `60000` / `120` | Outer rate limit |
| `WORKERSREFRESHMS` | — | Legacy monolith knob — superseded by the cron schedules above |

## Worker thread

`worker.thread.js` (every 30s, own pg pool): `requeueStale()` (reclaim
lease-expired jobs) + `purgeFinished()` (retention). Posts
`{type:'task', ok, detail:{reclaimed, purged, retentionDays}}`; responds to
`{type:'run'}`; never overlaps runs. Status is surfaced in `/health` extras.

## Docker

```bash
docker build -f services/queue-service/Dockerfile -t ghcr.io/animaxia/queue-service:local .
docker run -p 4009:4009 --env-file .env ghcr.io/animaxia/queue-service:local
```

Multi-stage bun:1.2-alpine, non-root uid 10001, `/health` HEALTHCHECK,
`LOCALDATADIR=/app/data` volume (thumbnails) in docker-compose/k8s.

## Quick smoke (direct, no gateway)

```bash
curl -s localhost:4009/health | jq .checks
curl -s -X POST localhost:4009/api/queue/jobs -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" -d '{"type":"maintenance.cleanup-sessions"}' | jq .
curl -s localhost:4009/api/queue/stats | jq .consumers
curl -s -X POST localhost:4009/api/queue/cron/tick | jq .enqueued
curl -s localhost:4009/api/workers/status | jq .pool
```
