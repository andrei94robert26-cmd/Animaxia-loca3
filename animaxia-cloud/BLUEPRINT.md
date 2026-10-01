# ANIMAXIA CLOUD — BLUEPRINT (FROZEN CONTRACT)

This document is the **single source of truth** for every agent working on Animaxia Cloud (Phase 3). Read it fully before writing code. Do NOT deviate from names, ports, paths or export signatures defined here.

Monolith source of truth (read-only reference): `/home/z/my-project/mini-services/animaxia-backend/` — the working Phase-1/2 backend. The cloud is an extraction of those modules into microservices. **Never modify the monolith.**

---

## 1. Directory layout (frozen)

```
animaxia-cloud/
├── package.json               # workspaces root (bun)
├── .env / .env.example        # house env style: DATABASEURL, TMDBAPIKEY, ... (no underscores)
├── common/                    # @animaxia/common — shared infra library (written by lead)
├── domain/                    # @animaxia/domain — extracted business modules (agent 2-a)
│   ├── package.json
│   ├── users/auth.js          # authRouter, attachUser, requireAuth, requireAdmin, publicUser, getUserById, issueSession
│   ├── users/profile.js       # default profileRouter
│   ├── security/security.js   # securityRouter, auditLog, clientIpOf, bruteForce, userRateLimit
│   ├── providers/jikan.js     # default animeRouter
│   ├── providers/tmdb.js      # { moviesRouter, tvRouter }
│   ├── providers/tvmaze.js    # default tvmazeRouter
│   ├── providers/football.js  # default footballRouter
│   ├── providers/f1.js        # default f1Router
│   ├── providers/rss.js       # default newsRouter
│   ├── player/player.js       # { resolvePlayer, playerAllowedTypes }
│   ├── miner/miner.js         # { mineUrl }
│   ├── ai/ai.js               # default aiRouter
│   ├── analytics/analytics.js # default analyticsRouter
│   ├── search/search.js       # default searchRouter
│   ├── cache/advancedCache.js # { advancedCache, advancedCacheRouter }
│   ├── premium/plans.js       # { plansRouter }
│   ├── premium/stripe.js      # default stripeRouter
│   ├── social/comments.js     # { commentsRouter }
│   ├── social/feed.js         # { feedRouter }
│   ├── mobile/mobile.js       # default mobileRouter
│   ├── platform/seed.js       # { seed }
│   └── workers/tasks/*.mjs    # mine.mjs, prefetch.mjs (worker-thread task files)
├── services/
│   ├── gateway-service/       # :8080 — API gateway (agent 2-b)
│   ├── auth-service/          # :4001
│   ├── content-service/       # :4002
│   ├── ai-service/            # :4003
│   ├── analytics-service/     # :4004
│   ├── search-service/        # :4005
│   ├── premium-service/       # :4006
│   ├── social-service/        # :4007
│   ├── mobile-service/        # :4008
│   └── queue-service/         # :4009 — Postgres queue + cron scheduler (agent 3-a)
├── deploy/
│   ├── docker/                # docker-compose.yml, docker-compose.observability.yml (agent 2-g)
│   ├── k8s/                   # raw Kubernetes manifests (agent 2-h)
│   └── helm/animaxia-cloud/   # Helm chart (agent 2-h)
├── .github/workflows/         # ci.yml, cd-deploy.yml, rollback.yml (agent 2-i)
├── observability/             # prometheus, grafana, loki, otel (agent 2-j)
├── cdn/cloudflare/            # edge worker, wrangler, terraform (agent 2-k)
├── disaster-recovery/         # PLAN.md + scripts (agent 2-l)
├── scripts/                   # dev-up.sh, dev-down.sh, smoke-test.sh (agent 2-l)
└── README.md
```

## 2. Ports & service registry (frozen)

| Service           | Default port | Env override |
|-------------------|--------------|--------------|
| gateway-service   | 8080         | GATEWAYPORT  |
| auth-service      | 4001         | AUTHPORT     |
| content-service   | 4002         | CONTENTPORT  |
| ai-service        | 4003         | AIPORT       |
| analytics-service | 4004         | ANALYTICSPORT|
| search-service    | 4005         | SEARCHPORT   |
| premium-service   | 4006         | PREMIUMPORT  |
| social-service    | 4007         | SOCIALPORT   |
| mobile-service    | 4008         | MOBILEPORT   |
| queue-service     | 4009         | QUEUEPORT    |

Inter-service base URLs: `AUTHSERVICEURL`, `CONTENTSERVICEURL`, `AISERVICEURL`, `ANALYTICSSERVICEURL`, `SEARCHSERVICEURL`, `PREMIUMSERVICEURL`, `SOCIALSERVICEURL`, `MOBILESERVICEURL`, `QUEUESERVICEURL` (all default to `http://localhost:<port>`). Resolve via `serviceUrl(name)` from `@animaxia/common/services.js`.

## 3. Route allocation (frozen — gateway proxies by prefix)

| Prefix                        | Upstream         | Monolith source |
|-------------------------------|------------------|-----------------|
| `/api/auth`, `/api/users`     | auth-service     | users/auth.js, users/profile.js |
| `/api/security`               | auth-service     | security/security.js (requireAuth+requireAdmin) |
| `/api/all`, `/api/content`, `/api/miner`, `/api/admin`, `/api/anime`, `/api/movies`, `/api/tv`, `/api/sports`, `/api/news`, `/api/cache` | content-service | server.js core routes + providers + cache/advancedCache.js |
| `/api/ai`                     | ai-service       | ai/ai.js |
| `/api/analytics`              | analytics-service| analytics/analytics.js |
| `/api/search`                 | search-service   | search/search.js |
| `/api/premium`                | premium-service  | premium/plans.js + premium/stripe.js |
| `/api/social`                 | social-service   | social/comments.js + social/feed.js |
| `/api/mobile`                 | mobile-service   | mobile/mobile.js |
| `/api/queue`, `/api/workers`  | queue-service    | NEW (PG-backed) + workers compat API |
| `/api/health`                 | gateway itself   | aggregated health (fan-out to all services) |
| `/api/gateway/*`              | gateway itself   | routes table, breaker states, edge-cache purge |

Every service ALSO exposes its own `GET /health`, `GET /metrics` (Prometheus), `GET /` (service info) on its own port.

## 4. Import rewrite map (for domain extraction — agent 2-a)

Monolith import → cloud import (exact):

```
'../../db.js'            → '@animaxia/common/db.js'
'../db.js'               → '@animaxia/common/db.js'
'../../cache.js'         → '@animaxia/common/cache.js'
'../../rateLimit.js'     → '@animaxia/common/rateLimit.js'
'../../utils/logger.js'  → '@animaxia/common/logger.js'
'../../utils/fetcher.js' → '@animaxia/common/fetcher.js'
'../platform/events.js'  → '@animaxia/common/events.js'
'../platform/sql.js'     → '@animaxia/common/sql.js'
'../platform/migrations.js' → '@animaxia/common/migrations.js'
'../../miner.js'         → '@animaxia/domain/miner/miner.js'
'../player/player.js'    → '@animaxia/domain/player/player.js'
'../../seed.js'          → '@animaxia/domain/platform/seed.js'
'../cache/advancedCache.js' → '@animaxia/domain/cache/advancedCache.js'
'../../modules/...' never appears inside domain modules (only server.js referenced those)
```

Special cases (agent 2-a MUST apply):
- `domain/users/auth.js`: DELETE the local `signJwt`/`verifyJwt`/`authSecret` implementations and `import { signJwt, verifyJwt, authSecret } from '@animaxia/common/jwt.js'` instead (identical semantics — HS256, `typ:'access'`, 15-min TTL, secret = AUTHSECRET or sha256(`animaxia-auth:${DATABASEURL}`)). Keep everything else identical.
- `domain/workers/tasks/*.mjs`: tasks run in worker isolates — they must load env from the repo root `.env` (path `../../../../.env` relative to the task file — verify with fileURLToPath) and dynamically import `@animaxia/common/db.js` / domain modules. Bun resolves workspaces from node_modules, so bare specifiers work in workers.
- `domain/platform/seed.js`: imports from `@animaxia/common/db.js`, `@animaxia/common/logger.js`, `@animaxia/domain/miner/miner.js` — check the monolith seed.js imports and map them with the table above.

`domain/package.json` — name `@animaxia/domain`, type module, `"exports": { "./*": "./~/*" }`-style NOT allowed; use explicit wildcard: `"exports": { "./*": "./*" }` plus `"main": "index.js"` optional. Dependencies: express, fast-xml-parser, z-ai-web-dev-sdk (same versions as monolith `mini-services/animaxia-backend/package.json`).

## 5. `@animaxia/common` surface (written by lead — DO NOT re-implement)

```js
// config.js
export const cfg = { env, isProd, isDev, serviceName, servicePort }
export function envStr(name, def), envInt(name, def), envBool(name, def)

// logger.js — structured JSON logs (Loki-friendly), API-compatible with monolith
export const logger = { debug, info, warn, error }   // (message, fields?)
export function requestLogger(req, res, next)         // adds requestId/traceId/duration

// db.js — EXACT port of monolith db.js (same exports)
export { initDb, listContent, getContentById, getContentByExternalId, upsertContent,
         deleteContent, countContent, countsByType, driverInfo, closeDb, query, ping }
export default db

// cache.js — monolith cache + factory
export const cache                      // default TTLCache singleton (CACHETTLMS)
export function cacheMiddleware()       // X-Cache HIT/MISS
export function createCache({ ttlMs, maxEntries, name })  // per-service cache instance (LRU-bounded)

// rateLimit.js — monolith limiter + factory
export { rateLimitMiddleware, rateLimitStats }
export function createRateLimit({ windowMs, max, name, keyFn })  // per-service limiter

// metrics.js — zero-dep Prometheus exposition
export class Counter, Gauge, Histogram  // .inc/.set/.observe with labels
export function registerMetric(m), renderMetrics()   // text/plain; version=0.0.4
export function httpMetricsMiddleware(serviceName)   // http_requests_total, http_request_duration_seconds
export function processMetrics()                     // uptime, memory rss/heap, event loop lag

// telemetry.js — W3C traceparent + OTLP/HTTP-JSON span exporter
export function traceMiddleware(serviceName)         // parses/creates traceparent, sets res header
export function currentTrace()                       // { traceId, spanId, traceparent }
export function startSpan(name, attributes), span.end({ status, attributes })
export function injectTrace(headers = {})            // returns headers + traceparent for downstream
export async function serviceFetch(url, init = {}, { timeoutMs, traceparent } = {})

// jwt.js — token layer extracted from monolith users/auth.js (identical crypto)
export function authSecret(), signJwt(payload), verifyJwt(token)

// middleware.js
export function requestId(), errorHandler(), notFoundHandler(), wrap(fn)
export function attachUserFromToken(req, res, next)  // verifies Bearer JWT → req.user (DB fetch, no throw)

// fetcher.js — provider fetch layer (monolith utils/fetcher.js)
export class ProviderError
export { fetchProviderJson, fetchProviderText, breakerStats }

// events.js — platform event bus (monolith platform/events.js)
export { events, emitPlatform, PLATFORM_EVENTS }

// sql.js — SQL helpers (monolith platform/sql.js)
export { assertPostgres, rows, one, jsonb, parseJsonb, isoOrNull, num }  // (+ any other monolith exports — port them all)

// migrations.js — platform DDL (agent 2-a ports from monolith platform/migrations.js; same export: ensurePlatformSchema)
// queue.js — Postgres-backed durable queue
export { ensureQueueSchema, enqueue, claimJobs, completeJob, failJob, requeueStale, queueStats, listJobs, getJob, retryJob, deleteJob, purgeFinished }

// health.js
export function createHealthRouter({ name, version, readiness })

// worker.js
export function startWorkerThread({ file, workerData, serviceName })  // + auto metrics/heartbeat

// service.js — microservice boot factory (THE way every service starts)
export function createService(options) // see §6

// services.js — registry
export const SERVICE_PORTS, export function serviceUrl(name), SERVICE_NAMES

// http.js
export { serviceFetch }  // re-export convenience
```

## 6. `createService(options)` — every microservice uses this

```js
import { createService } from '@animaxia/common/service.js';

createService({
  name: 'auth-service',            // required — SERVICENAME override
  version: '3.0.0',
  port: 4001,                      // default; overridden by AUTHPORT/PORT env
  cors: true,                      // default true (CORS_ORIGIN aware)
  bodyLimit: '2mb',
  initDb: true,                    // boot the pg pool + content schema (default true)
  ensureSchema: ensurePlatformSchema,  // optional: platform DDL at boot
  seedIfEmpty: false,              // content-service only sets true
  attachUser: true,                // mount attachUserFromToken (services needing req.user)
  rateLimit: { windowMs: 60000, max: 120 },  // per-service limiter
  routers: [                       // mount order matters
    { path: '/api/auth', router: authRouter },
  ],
  health: { readiness: async () => ({ db: await ping() }) },
  worker: { file: './worker.thread.js', intervalMs: 60000 },  // own worker thread
});
```

Boot sequence inside createService: initDb (optional) → ensureSchema (optional) → seedIfEmpty → start worker thread → listen. Standard middleware order: cors → express.json → requestId → requestLogger → traceMiddleware → httpMetricsMiddleware → rateLimit → attachUser (optional) → routers → health → metrics → 404 → errorHandler. Graceful SIGTERM/SIGINT shutdown closing db pool.

`GET /health` response shape (ALL services):
```json
{ "status": "ok", "service": "auth-service", "version": "3.0.0", "env": "development",
  "uptimeSec": 123, "timestamp": "...", "checks": { "db": true } }
```
`status` is `"ok"` when all readiness checks pass, `"degraded"` otherwise (health router still 200 for liveness; readiness detail in `checks`).

## 7. Microservice folder template (frozen — every service)

```
services/<name>/
├── package.json     # { "name": "@animaxia/auth-service", "type": "module", "dependencies": { "@animaxia/common": "*", "@animaxia/domain": "*", "express": "^4.21.2" } }
├── server.js        # createService({...}) — own server
├── router.js        # own Express router composing domain routers + service-specific routes
├── health.js        # own readiness checks (db ping, dependencies)
├── rateLimit.js     # own limits (exports { windowMs, max } used by server.js)
├── cache.js         # own cache instance via createCache({ ttlMs, maxEntries, name })
├── worker.thread.js # own worker thread: receives { intervalMs, ... }, posts { ok, type, ... } messages, handles 'run' messages from main thread
├── Dockerfile       # template in §8
├── .env.example     # service-specific notes (optional, minimal)
└── README.md        # endpoints, env vars, run instructions
```

Worker thread contract (common/worker.js handles spawn/respawn/metrics):
- workerData: `{ intervalMs, serviceName, now: ISO }`
- The thread runs its service-specific maintenance task every `intervalMs` (setInterval) and posts `{ ok: true, type: '<task>', at: ISO, detail?: {...} }` messages to the parent. It must also respond to a `'run'` parentPort message by executing the task once and posting the result. Keep tasks idempotent, non-fatal (catch + post `{ ok: false, error }`), and DB-light.

Suggested per-service worker tasks (agents may refine):
- auth-service: delete expired/revoked refreshtokens; report counts
- content-service: provider cache prewarm (top content ping) + thumbnails existence check
- ai-service: prune stale aichat sessions; prewarm recommendations cache
- analytics-service: aggregate raw viewevents into daily rollups (INSERT ... SELECT)
- search-service: incremental reindex of content changed since last watermark
- premium-service: expire plans whose planexpiresat < now (plan → free); audit
- social-service: recompute hot/global feed snapshot into advancedCache
- mobile-service: refresh cached /mobile/home payload
- gateway-service: probe all upstreams `/health` (feeds breaker half-open + metrics)
- queue-service: requeueStale (lease timeout reclaim) + purgeFinished (retention)

## 8. Dockerfile template (frozen — bun + alpine, multi-stage)

Build context is ALWAYS the repo root (`animaxia-cloud/`). Replace `<name>` and `<port>`:

```dockerfile
# syntax=docker/dockerfile:1
# Build from repo root: docker build -f services/<name>/Dockerfile .
FROM oven/bun:1.2-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY common/package.json common/
COPY domain/package.json domain/
COPY services/<name>/package.json services/<name>/
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.2-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production SERVICEPORT=<port> PORT=<port>
RUN apk add --no-cache curl && adduser -D -u 10001 animaxia
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/bun.lock ./bun.lock
COPY common ./common
COPY domain ./domain
COPY services/<name> ./services/<name>
USER animaxia
EXPOSE <port>
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS http://127.0.0.1:${PORT}/health || exit 1
CMD ["bun", "services/<name>/server.js"]
```

Image names: `ghcr.io/animaxia/<name>:<tag>` (e.g. `ghcr.io/animaxia/gateway-service:latest`). Container port is always the service default port (4001–4009, gateway 8080). Services read `PORT` or their `<NAME>PORT` env.

## 9. Env var style (frozen)

House style = the user's .env: **no underscores** (`DATABASEURL`, `TMDBAPIKEY`, `CACHETTLMS`) except legacy keys that already have them (`RATELIMITWINDOW_MS`, `PROVIDERCACHETTL_MS`, `PROVIDERFAILURETHRESHOLD`, `PROVIDERCIRCUITOPEN_MS`, `MINERMAXHTML_BYTES`, `MINERALLOWPRIVATE_NETWORK`, `MINERTIMEOUTMS` ok, `WORKERSREFRESHMS`, `ADVANCEDCACHEMAX`, `ADVANCEDCACHETTLMS`, `FOOTBALLDATAAPI_KEY`, `FOOTBALLDATABASE_URL`). New cloud vars follow §2 + the root `.env.example`. NEVER invent new underscore names.

## 10. Queue + cron (agent 3-a — frozen contract)

Postgres-backed durable queue (table `jobs`, `FOR UPDATE SKIP LOCKED` claiming, lease timeout `QUEUEWORKERTTLSEC`, retries `maxattempts` with backoff, statuses `pending|running|done|failed|dead`).

Job types (frozen): `miner.mine`, `miner.prefetch`, `ai.batch`, `analytics.batch`, `indexing.batch`, `providers.refresh` (payload `{ source: 'tmdb'|'jikan' }`), `maintenance.cleanup-logs`, `maintenance.cleanup-audit`, `maintenance.cleanup-sessions`, `maintenance.reindex`, `thumbnails.generate`.

REST (queue-service, port 4009):
- `POST /api/queue/jobs` `{ type, payload?, priority?, runAt?, maxAttempts? }` → 201 job
- `GET /api/queue/jobs?status=&type=&limit=` · `GET /api/queue/jobs/:id`
- `POST /api/queue/jobs/:id/retry` · `DELETE /api/queue/jobs/:id`
- `GET /api/queue/stats` (counts by status/type, oldest pending age, dead letter count, worker heartbeat)
- `POST /api/queue/cron/tick` — evaluate schedules (k8s CronJob target)
- `GET /api/workers/...` — monolith-compatible surface: `POST /api/workers/mine|prefetch|thumbnails|refresh` enqueue + return `{ ok, jobId }`; `GET /api/workers/jobs`, `GET /api/workers/jobs/:id`, `GET /api/workers/status` map onto the PG queue.

Cron schedules (queue-service internal scheduler, `QUEUESCHEDULERENABLED`):
- TMDB refresh: every 6h (`0 */6 * * *`) → enqueues `providers.refresh { source:'tmdb' }`
- Jikan refresh: every 6h offset (`30 */6 * * *`) → `providers.refresh { source:'jikan' }`
- Cleanup logs: daily 03:00 → `maintenance.cleanup-logs`
- Cleanup audit: daily 03:15 → `maintenance.cleanup-audit`
- Cleanup sessions: hourly → `maintenance.cleanup-sessions`
- Reindex: daily 04:00 → `maintenance.reindex`

K8s CronJobs (agent 2-h) hit `POST http://queue-service:4009/api/queue/cron/tick` per schedule (belt & braces with the internal scheduler).

## 11. Observability (agent 2-j — frozen contract)

- Every service: `GET /metrics` (Prometheus text, `METRICSENABLED`), logs are single-line JSON on stdout (Loki via promtail), traces via OTLP/HTTP JSON to `${OTELSENDPOINT}` (default `http://localhost:4318/v1/traces`), sampling `OTELSAMPLERATE`.
- Metrics names (already implemented by common): `animaxia_http_requests_total{service,method,route,status}`, `animaxia_http_request_duration_seconds{service,method,route}` (buckets .005/.01/.025/.05/.1/.25/.5/1/2.5/5/10), `animaxia_uptime_seconds{service}`, `animaxia_memory_rss_bytes{service}`, `animaxia_cache_hits_total{service}`/`animaxia_cache_misses_total{service}`, `animaxia_rate_limited_total{service}`, `animaxia_circuit_state{service,breaker}` (0 closed,1 half,2 open), `animaxia_queue_depth{type,status}`, `animaxia_queue_job_duration_seconds{type}`.
- Stack: Prometheus (scrape gateway:8080/metrics + 4001-4009/metrics + otel-collector:8889), alert rules, Grafana (provisioned datasources prometheus+loki+tempo + ≥2 dashboards), Loki + promtail (docker/k8s label scraping, JSON parsing), OpenTelemetry Collector (otlp http+grpc receivers → batch → otlphttp exporter to Tempo + prometheus exporter :8889), Tempo (trace store). All wired in `deploy/docker/docker-compose.observability.yml`.

## 12. Conventions

- ESM everywhere (`"type": "module"`), Node/Bun compatible (no Node-only APIs without fallback; `node:worker_threads` is supported by bun).
- `wrap(fn)` async handler wrapper from `@animaxia/common/middleware.js`.
- Every file starts with a doc comment like the monolith style.
- Zero new runtime deps beyond: express, cors, dotenv, pg, fast-xml-parser, z-ai-web-dev-sdk (already used). Everything else (metrics, tracing, JWT, queue) is zero-dependency in `common/`.
- Never import `@animaxia/domain` from `common`, never import service internals across services (cross-service calls go through `serviceFetch` or stay in-process via domain).
- README.md at repo root: architecture diagram (ASCII), quickstart (bun install → bun run dev → curl gateway), service table, links to deploy/observability/cdn/disaster-recovery docs.

## 13. Worklog protocol

Before working: read `/home/z/my-project/worklog.md` (tail is enough). After finishing: APPEND (never overwrite) a section:

```markdown
---
Task ID: <your task id>
Agent: <agent name>
Task: <what you were asked to do>

Work Log:
- <concrete steps>

Stage Summary:
- <key results / decisions / artifacts>
```

---

## 14. Phase 4 — Animaxia AI Cloud (addendum)

> Appended after the Phase-3 freeze by agent 7-b (cloud port of the Phase-4 AI
> layer built in the monolith by the lead). Section number kept as specified by
> the Phase-4 task contract; the Phase-3 sections above are unchanged.

### Module list — `domain/aicloud/` (new `@animaxia/domain` package dir)

| File | One-liner |
|---|---|
| `llm-core.js` | Single entry for every LLM call: provider abstraction `z-ai \| openai \| mock` with auto-degradation chain, mode-aware prompt builder, token-budgeted context builder, per-user AND per-plan quotas (planLimits().aiPerDay daily + 6/20/60 per-min + 5/day anon IP bucket), full usage tracking (traceId per call, in-memory ring of 2000 + best-effort `aiusagelogs` rows). |
| `vector-service.js` | Embeddings + pluggable vector backends: local-hash-256 FNV-1a unigram+bigram (or OpenAI text-embedding-3-small @ dims=256 when AI_PROVIDER=openai+key) over pgvector (`vectorembeddings`, cosine `<=>`), in-memory mock, Qdrant and Pinecone REST adapters; `indexContent/indexUser/indexFeed/storeMemory/searchMemories/vectorSearch`; boot auto-index + debounced `content:changed` re-index. |
| `rag-engine.js` | Retrieve → rank (0.62·vector + 0.18·lexical + 0.10·affinity + 0.10·popularity) → prompt → LLM for modes recommendations / summaries / explanations / chat-with-content, deterministic composers as degraded fallbacks, `moreLikeThis`, `userMatchScore`, `recommendForUser`. |
| `tools.js` | Six whitelisted tools with JSON descriptors (searchContent, searchUserHistory, getTrending, getFeed, getPremiumPlan, enqueueQueueJob), argument clamping, per-tool timing, audit log — the cloud variant of enqueueQueueJob POSTs to queue-service over HTTP (see below). |
| `agent.js` | animaxiaAssistant: persona, provider-agnostic JSON tool-calling protocol (multi-call parsing, ≤3 rounds / ≤3 tools per round), long-term memory (private vector memories + `agentconversations` rows), guardrails (input sanitation, piracy/hack refusal, DATA-delimiter prompt-injection defense, tool whitelist, PII masking, raw-tool-JSON leak guard). |
| `personal.js` | Personal AI: home (LLM greeting + 6 daily picks + becauseYouWatched + `aiprofiles` row + quota meter, 10-min cache), taste-ranked feed with aiWhy per item, player companion (beforeYouWatch / moreLikeThis / predictedRating / nextUp), weekly recap cached per ISO week. |
| `admin.js` | Admin AI dashboard aggregations: usage/cost/error-rate/latency p50+p95, top prompts, recent calls and recent errors over the llm-core usage ring + vector index stats + persisted `aiusagelogs` count. |
| `router.js` | The API surface: exports `aicloudRouter`, `vectorRouter`, `ensureAicloudSchema` (idempotent DDL) and `aicloudBoot` (vector backend init + background auto-index). |

### New endpoints (all served by ai-service :4003)

`aicloudRouter` (mounted at `/api/ai` right after the Phase-3 aiRouter —
Express falls through to the next mounted router on no-match, so no Phase-3
route changes):

- `GET  /api/ai/cloud/status` — provider + vector + quota snapshot (public)
- `POST /api/ai/rag/recommend | /rag/summarize | /rag/explain` — RAG modes (public, anon quota)
- `POST /api/ai/rag/chat` — chat-with-content (requireAuth)
- `POST /api/ai/assistant` + `GET /api/ai/assistant/history` — animaxiaAssistant (requireAuth)
- `GET  /api/ai/personal/home | /feed | /player | /recap` — personal AI (requireAuth)
- `GET  /api/ai/tools` (public) + `POST /api/ai/tools/run` (requireAuth, 20/min)
- `GET  /api/ai/admin/stats | /prompts | /errors` — Admin AI dashboard (requireAdmin)

`vectorRouter` (mounted at `/api/vector`):

- `GET  /api/vector/status` — backend, dims, per-kind counts (public)
- `POST /api/vector/search` — similarity search (public, 30/min per IP)
- `POST /api/vector/index-content` — re-index the library (requireAdmin)
- `POST /api/vector/index-user` — index the caller's taste embedding (requireAuth)

### Route allocation addendum (extends §3)

| Prefix       | Upstream  | Source |
|--------------|-----------|--------|
| `/api/vector`| ai-service| domain/aicloud (vectorRouter) |

### New env contract (Phase-4 — house style, no underscores)

| Var | Default | Purpose |
|---|---|---|
| `AI_PROVIDER` | `z-ai` | llm-core provider: `z-ai` \| `openai` \| `mock` |
| `AI_API_KEY` | — | key for the openai provider (secret; unused by z-ai/mock) |
| `AI_MODEL` | `gpt-4o-mini` | optional model override (openai provider) |
| `AI_TIMEOUTMS` | `25000` | per-call LLM timeout |
| `VECTOR_BACKEND` | `auto` | `auto` \| `pgvector` \| `mock` \| `qdrant` \| `pinecone` |
| `QDRANTURL` / `QDRANTAPIKEY` | — | Qdrant adapter endpoint / key |
| `PINECONEURL` / `PINECONEAPIKEY` | — | Pinecone adapter endpoint / key |

Wired into: root `.env`/`.env.example` (Phase-4 block), docker-compose
ai-service environment, k8s `01-configmap.yaml` (non-secret) +
`02-secret.yaml` (`AI_API_KEY`, `QDRANTAPIKEY`, `PINECONEAPIKEY` placeholders)
flowing into the ai-service container through the existing envFrom pair, and
the Helm chart (`values.yaml` `env.config` / `env.secret`).

### Pluggable vector backends

`VECTOR_BACKEND=auto` (default) resolves pgvector when the `vector` extension
+ `vectorembeddings` table initialize on the shared Neon Postgres, else the
in-memory mock. Explicit `pgvector | mock | qdrant | pinecone` selections
auto-degrade to the mock backend on any failure (offline adapter, SQL hiccup)
— vector search never 500s. Embeddings are 256-dim, L2-normalized.

### New tables (idempotent DDL in `ensureAicloudSchema`, boot of ai-service)

- `aiusagelogs` — one row per LLM call (trace, tokens, cost, latency, status)
- `agentconversations` — every animaxiaAssistant turn (long-term DB memory)
- `aiprofiles` — per-user taste tags + summary (personal AI)
- `vectorembeddings` — pgvector store (kind: content | user | feed | memory)

### Cloud variant of `enqueueQueueJob`

The monolith tool called the in-process Phase-2 `workerPool` directly. The
cloud has no in-process worker pool — jobs live in queue-service (the PG-backed
durable queue, §10). The ported tool POSTs over HTTP using
`serviceUrl('queue')` from `@animaxia/common/services.js`:

- `POST /api/queue/cron/tick` body `{ job, payload }` → `{ ok: true, jobId }`
  (public, type-validated direct-enqueue surface — the same one the k8s
  CronJobs use; the canonical `POST /api/queue/jobs` is requireAuth'd for a
  user Bearer token, which a server-to-server tool call does not carry)
- tool type mapping: `mine → miner.mine`, `prefetch → miner.prefetch`,
  `thumbnail → thumbnails.generate`, `refresh → providers.refresh`
- returns `{ jobId, type, queued: true }` on success, `{ error }` on failure
  (8 s timeout, audit-logged exactly like the monolith)

## 15. Phase 5 — Animaxia Mobile App (addendum)

Zero backend changes: the mobile client (`animaxia-mobile/`, React Native /
Expo SDK 52 + expo-router + TypeScript strict) is a pure consumer of the
frozen route surface above, talking to ONE origin — the gateway `:8080`
(monolith `:4000` in dev). `EXPO_PUBLIC_API_URL` is the single config knob
(.env / EAS profiles in `eas.json`).

Folder contract (frozen):

- `app/` — expo-router screens: `index` (Home, `GET /api/mobile/home`),
  `login`, `content/[id]` (details + AI panel: Explain / More like this /
  Ask → `POST /api/ai/rag/explain|recommend|chat`), `player/[id]`
  (`GET /api/mobile/player/:id` + analytics `POST /api/analytics/views` +
  throttled `POST /api/users/me/history`), `feed` (`/api/social/feed/*` +
  `GET /api/ai/personal/feed`), `ai` (Personal + Assistant hub:
  `/api/ai/personal/*`, `POST /api/ai/assistant`), `watchlist`, `profile`
  (`GET /api/mobile/profile`, avatar/preferences), `premium`
  (`/api/premium/*` incl. sandbox checkout confirm flow)
- `api/` — `client.ts` (Bearer inject, single-flight rotating-refresh on 401
  + one retry, 15 s AbortController timeout, typed `ApiError
  { status, code, upgrade }`), `cache.ts` (AsyncStorage stale-while-error +
  TTL cache-first), one module per prefix (`auth`, `mobile`, `ai`, `users`,
  `social`, `premium`, `analytics`), `config.ts` (base-URL resolution:
  env → Android-emulator `10.0.2.2:8080` → `localhost:8080`)
- `auth/` — `tokenStore` (SecureStore/Keychain session + user snapshot),
  `AuthContext` (instant boot from snapshot, background `/api/auth/me`
  validation, client-emitted refresh/logout events)
- `player/` — `VideoPlayer` (expo-av: mp4/HLS native, youtube/iframe →
  Linking) + `tracking` (view/play/complete events + 5 % progress throttle)
- `feed/`, `ai/`, `watchlist/`, `premium/` — feature modules
- `components/`, `hooks/useApi`, `theme/` (dark cinema tokens, rose accent)

Client-side conventions: manual `encodeURIComponent` query building (Hermes
has no `URLSearchParams`); AI quota per plan rendered live from the `quota`
field every AI response carries (free 10 / plus 100 / pro 500 per day);
`402 + upgrade:true` → upgrade card → Premium screen; version gate against
`GET /api/mobile/config` `versions.min` (app `1.2.0`, bundle ids
`com.animaxia.mobile`, scheme `animaxia://`).

Builds: EAS (`eas build -p android --profile preview|production`, same for
ios — profiles inject `EXPO_PUBLIC_API_URL`) or local `npx expo prebuild` +
`run:android` / `run:ios`. Full steps in `animaxia-mobile/README.md`.
