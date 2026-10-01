# @animaxia/search-service

Animaxia Cloud **search service** (:4005) — the local OpenSearch-style search
engine (`animaxia-local-opensearch`): an in-process inverted index with BM25
ranking (k1=1.2, b=0.75), Levenshtein fuzzy term expansion (distance ≤ 2, max
3 candidates per query term), prefix/word-boundary autocomplete and field
filters, built from the `content` table. Mounted route family:
**`/api/search`** (gateway proxies this prefix here, BLUEPRINT §3).

Business logic lives in `@animaxia/domain/search/search.js` (mounted
verbatim — this service adds only boot wiring, rate policy, worker and
health).

## Endpoints (from domain/search/search.js — mounted at `/api/search`)

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/api/search/advanced?q=&type=&genre=&year=&minRating=&sort=score\|year\|rating\|title&fuzzy=true&limit=20` | public | BM25 + fuzzy search → `{ took, total, max_score, data: [content rows + _score] }`; `q` required (400); limit clamped 1–50; `fuzzy=false` disables typo expansion |
| `GET` | `/api/search/autocomplete?q=` | public | Prefix/word-boundary title suggestions → `{ suggestions: [{ id, title, type, thumbnail }] }` (max 8, prefix hits first, then rating desc); `q` required (400) |
| `POST` | `/api/search/index` | **required + admin** | Force a synchronous full index rebuild → `{ ok: true, indexed }`; audits the requesting user |
| `GET` | `/api/search/status` | public | Index snapshot → `{ docs, terms, lastSync, dirty, engine: 'animaxia-local-opensearch' }` |

Service-level (createService): `GET /` (info), `GET /health` (readiness), `GET /metrics` (Prometheus).

## How the index works (and how it stays fresh)

- **In-process memory** — the inverted index lives in the service's main
  thread. There is no Postgres index table; the `content` table is the source
  of truth and a rebuild = full `SELECT` + re-tokenize (small corpus, fast).
- **Lazy build** — starts dirty; the first `/advanced` or `/autocomplete`
  query after boot rebuilds it under an async lock (concurrent requests await
  the same rebuild).
- **Cross-service staleness** — in the monolith, `content:changed` platform
  events marked the index dirty immediately. In the cloud, content upserts
  happen in **content-service**, so this service detects corpus changes
  itself:
  - the **worker thread** (below) probes `COUNT(*) + MAX(createdat)` every
    10 min and reports changes;
  - **server.js** polls the worker result and emits `content:changed` on the
    in-process event bus (the same bus the domain module subscribed to),
    which marks the index dirty → the next query rebuilds transparently.
- **Blind spot (honest)** — a metadata-only update of a pre-existing row
  moves neither `COUNT(*)` nor `MAX(createdat)`. Backstops: the daily 04:00
  `maintenance.reindex` queue job (queue-service) and manual
  `POST /api/search/index` (admin) both force a full rebuild.
- Comparison tip: `GET /api/search/status` (`docs`) vs the worker's
  `GET /health → worker.lastTask.detail.docs` (DB count) reveals index
  staleness at a glance.

## Worker thread (`worker.thread.js`, every 10 min)

Corpus change detection (the incremental-reindex watchdog):

```sql
SELECT COUNT(*)::int AS docs, MAX(createdat) AS latest FROM content;
```

- Keeps the last watermark `(docs, latest)` in thread memory; the content
  table has no `updatedat` column, so this pair is the best available signal.
- Posts `{ type:'task', ok:true, detail: { docs, latestContentAt, changed,
  baseline } }` — `baseline: true` on the first run after (re)spawn (no
  change signalled); visible in `GET /health` → `worker.lastTask`; responds
  to a `{ type:'run' }` parent message with an immediate probe.
- It warms nothing by design: a worker thread is a separate isolate and
  cannot touch the main thread's in-memory index — its job is to *detect*
  change; the *rebuild* happens lazily in the request path (see above).

## Env vars

| Var | Default | Purpose |
|---|---|---|
| `SEARCHPORT` / `PORT` | `4005` | listen port (`PORT` wins, then `SEARCHPORT`) |
| `DATABASEURL` | — | Postgres (the index source; local fallback store has no SQL layer → search returns 503 on query paths) |
| `PGSSL`, `PGPOOLMAX` | `false`, `10` | pg pool tuning |
| `AUTHSECRET` | derived | JWT secret for the admin guard on `POST /api/search/index` (must match auth-service) |
| `RATELIMITWINDOW_MS`, `RATELIMITMAX` | `60000`, `240` | outer per-IP limiter (generous — autocomplete fires per keystroke) |
| `CORS_ORIGIN`, `TRACINGENABLED`, `OTELSENDPOINT`, `OTELSAMPLERATE`, `METRICSENABLED` | — | standard common/ knobs |

`SERVICENAME` defaults to `search-service`; `NODE_ENV` standard.

## Run

```bash
# from repo root (bun workspaces)
bun run search                    # or: bun services/search-service/server.js
SEARCHPORT=4300 bun services/search-service/server.js   # custom port

# docker (repo root context)
docker build -f services/search-service/Dockerfile -t ghcr.io/animaxia/search-service:local .
docker run --rm -p 4005:4005 --env-file .env ghcr.io/animaxia/search-service:local
```

## Try it (through the gateway on :8080)

```bash
curl -s 'http://localhost:8080/api/search/advanced?q=frieren&fuzzy=true&limit=5'
curl -s 'http://localhost:8080/api/search/advanced?q=action&type=movie&sort=rating&minRating=7'
curl -s 'http://localhost:8080/api/search/autocomplete?q=fri'
curl -s http://localhost:8080/api/search/status

# force a rebuild (admin token from auth-service /api/auth/login)
curl -s -X POST http://localhost:8080/api/search/index -H 'authorization: Bearer <admin-token>'

# direct (bypassing the gateway)
curl -s http://localhost:4005/health
```
