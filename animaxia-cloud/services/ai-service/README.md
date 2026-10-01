# @animaxia/ai-service

Animaxia Cloud **AI service** (:4003) — LLM-backed recommendations, content
summaries, marketing descriptions and content-scoped assistant chat, with
deterministic heuristic fallbacks so the platform never hard-depends on the
LLM being reachable. Mounted route families: **`/api/ai`** + **`/api/vector`**
(the gateway proxies both prefixes here, BLUEPRINT §3).

Business logic lives in `@animaxia/domain/ai/ai.js` (Phase 3, mounted
verbatim) and `@animaxia/domain/aicloud/*` (Phase 4 — the Animaxia AI Cloud
layer: llm-core, vector-service, rag-engine, tools, agent, personal, admin,
router; BLUEPRINT §11) — this service adds only boot wiring, rate policy,
worker and health.

## Endpoints (from domain/ai/ai.js — mounted at `/api/ai`)

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/api/ai/recommendations?limit=10` | optional Bearer | LLM-ranked personalised picks `{ data: [{ content, reason }], provider }`; limit clamped 1–20; cached per user (or `anon`) 5 min via advancedCache; quota-guarded |
| `POST` | `/api/ai/summarize` `{ contentId }` | optional Bearer | 3–4 sentence summary + 3 key points `{ summary, provider }`; 404 unknown content; cached globally 10 min; quota-guarded |
| `POST` | `/api/ai/describe` `{ title, type, genres? }` | public | Marketing blurb `{ description, provider }`; 10/min per IP (router-level) + anonymous daily quota |
| `POST` | `/api/ai/chat` `{ contentId, message }` | **required** (401) | Content-scoped assistant `{ reply, provider }`; replays the user's last 10 turns for that content from the `aichats` table; 30/min per user (router-level) + quota; message 1–1000 chars |
| `GET` | `/api/ai/status` | public | Provider health + daily usage `{ provider, available, model, requestsToday, quota }` — **no quota cost** |

Service-level (createService): `GET /` (info), `GET /health` (readiness), `GET /metrics` (Prometheus).

## Phase 4 — Animaxia AI Cloud (domain/aicloud, mounted after the Phase-3 router)

Express falls through to the next mounted router on no-match, so the Phase-3
surface above is untouched. New tables (idempotent DDL at boot):
`aiusagelogs`, `agentconversations`, `aiprofiles` + pgvector `vectorembeddings`.

**aicloudRouter (also under `/api/ai`):**

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/api/ai/cloud/status` | public | Provider + vector backend + quota snapshot |
| `POST` | `/api/ai/rag/recommend` `{ query?, limit? }` | public (anon quota) | RAG recommendations |
| `POST` | `/api/ai/rag/summarize` `{ contentId }` | public (anon quota) | RAG watch-decision summary |
| `POST` | `/api/ai/rag/explain` `{ contentId, question? }` | public (anon quota) | RAG match explanation |
| `POST` | `/api/ai/rag/chat` `{ contentId, message, history? }` | **required** | Spoiler-safe chat-with-content |
| `POST` | `/api/ai/assistant` `{ message, history? }` | **required** | animaxiaAssistant (JSON tool-calling, memory, guardrails) |
| `GET` | `/api/ai/assistant/history?limit=` | **required** | Persisted agent turns |
| `GET` | `/api/ai/personal/home` \| `/feed` \| `/player?contentId=` \| `/recap` | **required** | Personal AI surfaces |
| `GET` | `/api/ai/tools` | public | Tool catalog (6 tools) |
| `POST` | `/api/ai/tools/run` `{ name, args }` | **required**, 20/min | Run one whitelisted tool |
| `GET` | `/api/ai/admin/stats` \| `/prompts` \| `/errors` | **admin** | Admin AI dashboard |

**vectorRouter (under `/api/vector`):**

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/api/vector/status` | public | Backend, dims, per-kind counts |
| `POST` | `/api/vector/search` `{ query, kind?, topK? }` | public, 30/min per IP | Similarity search |
| `POST` | `/api/vector/index-content` `{ ids? }` | **admin** | Re-index the library |
| `POST` | `/api/vector/index-user` | **required** | Index the caller's taste embedding |

Cloud-specific behaviour: the `enqueueQueueJob` tool does NOT use an
in-process worker pool (the monolith did) — it POSTs to queue-service over
HTTP (`POST /api/queue/cron/tick { job, payload }` via `serviceUrl('queue')`,
mapping mine→`miner.mine`, prefetch→`miner.prefetch`, thumbnail→`thumbnails.generate`,
refresh→`providers.refresh`). Phase-4 quotas stack on top of the Phase-3
model: per-plan per-minute windows (6/20/60) + the shared daily caps.

## Quota & cost model (router-owned)

Every endpoint **except `GET /status`** is quota-guarded:

- **Authenticated**: `planLimits(plan).aiPerDay` per UTC calendar day —
  free **10** / plus **100** / pro **500**. Exceed → `402 { error, upgrade: true, plan, limit }`.
- **Anonymous** (on `/recommendations`, `/summarize`, `/describe`): **5/day per client IP**,
  shared across those three endpoints. Same `402` shape with `plan: 'anonymous'`.
- On top, this service's outer limiter allows **60 req/min per IP** (see
  `rateLimit.js`) — AI is the most expensive path in the fleet, hence tighter
  than the 120/min fleet default.

Provider field is `'z-ai'` when the LLM answered and `'heuristic'` when the
deterministic fallback produced the answer (SDK unavailable / timeout / empty
completion — the SDK call has a 20 s timeout and 1 retry).

## z-ai SDK setup

`z-ai-web-dev-sdk@^0.0.18` is a pure-JS ESM package (no build step) that
lazily reads a **`.z-ai-config` JSON file** (`{ "baseUrl": "...", "apiKey": "..." }`)
on first use, searching in order:

1. `$PWD/.z-ai-config` (in containers: `/app/.z-ai-config`)
2. `~/.z-ai-config`
3. `/etc/.z-ai-config`

There are **no env vars** for the SDK. In Docker/K8s mount the config as a
secret at `/etc/.z-ai-config` (world-readable not required) — without it the
service still boots and serves heuristic answers (`available: false` in
`/api/ai/status`).

## Worker thread (`worker.thread.js`, every 10 min)

Prunes stale AI data, both with a 7-day retention window:
`DELETE FROM aichats WHERE createdat < NOW() - interval '7 days'` (the chat
endpoint only replays each user's last 10 turns per content) and, since Phase
4, `DELETE FROM aiusagelogs WHERE createdat < NOW() - interval '7 days'` (LLM
usage logs — live analytics live in the in-memory usage ring). Posts
`{ type: 'task', ok: true, detail: { deleted, usageDeleted, retention: '7 days' } }` to the
parent — visible in `GET /health` → `worker.lastTask`. Responds to a
`{ type: 'run' }` parent message with an immediate run.

## Env vars

| Var | Default | Purpose |
|---|---|---|
| `AIPORT` / `PORT` | `4003` | listen port (`PORT` wins, then `AIPORT`) |
| `DATABASEURL` | — | Postgres (required for `aichats`, users, quotas; without it the local fallback store serves content only and AI chat/user quota paths fail closed) |
| `PGSSL`, `PGPOOLMAX` | `false`, `10` | pg pool tuning |
| `AUTHSECRET` | derived | JWT secret for Bearer verification (must match auth-service) |
| `RATELIMITWINDOW_MS`, `RATELIMITMAX` | `60000`, `60` | outer per-IP limiter (AI default tighter than fleet) |
| `ADVANCEDCACHETTLMS`, `ADVANCEDCACHEMAX` | `300000`, `1000` | advancedCache tuning (recommendations/summaries caching) |
| `AI_PROVIDER` | `z-ai` | Phase 4 llm-core provider: `z-ai` \| `openai` \| `mock` (auto-degrades to mock) |
| `AI_API_KEY` | — | Phase 4 openai provider key (unused by z-ai/mock) |
| `AI_MODEL` | `gpt-4o-mini` | Phase 4 model override (openai provider) |
| `AI_TIMEOUTMS` | `25000` | Phase 4 per-call LLM timeout |
| `VECTOR_BACKEND` | `auto` | Phase 4 vector backend: `auto` \| `pgvector` \| `mock` \| `qdrant` \| `pinecone` (auto-degrades to mock) |
| `QDRANTURL`, `QDRANTAPIKEY` | — | Phase 4 Qdrant adapter |
| `PINECONEURL`, `PINECONEAPIKEY` | — | Phase 4 Pinecone adapter |
| `CORS_ORIGIN`, `TRACINGENABLED`, `OTELSENDPOINT`, `OTELSAMPLERATE`, `METRICSENABLED` | — | standard common/ knobs |

`SERVICENAME` defaults to `ai-service`; `NODE_ENV` standard.

## Run

```bash
# from repo root (bun workspaces)
bun run ai                      # or: bun services/ai-service/server.js
AIPORT=4300 bun services/ai-service/server.js   # custom port

# docker (repo root context)
docker build -f services/ai-service/Dockerfile -t ghcr.io/animaxia/ai-service:local .
docker run --rm -p 4003:4003 --env-file .env -v $HOME/.z-ai-config:/etc/.z-ai-config:ro ghcr.io/animaxia/ai-service:local
```

## Try it (through the gateway on :8080)

```bash
curl -s http://localhost:8080/api/ai/status
curl -s 'http://localhost:8080/api/ai/recommendations?limit=5'
curl -s -X POST http://localhost:8080/api/ai/summarize -H 'content-type: application/json' -d '{"contentId":1}'
curl -s -X POST http://localhost:8080/api/ai/describe -H 'content-type: application/json' \
  -d '{"title":"Frieren","type":"anime","genres":["fantasy"]}'
# chat needs a Bearer token from auth-service /api/auth/login
curl -s -X POST http://localhost:8080/api/ai/chat -H 'authorization: Bearer <token>' \
  -H 'content-type: application/json' -d '{"contentId":1,"message":"Is this good for kids?"}'

# Phase 4 — Animaxia AI Cloud
curl -s http://localhost:8080/api/ai/cloud/status
curl -s http://localhost:8080/api/vector/status
curl -s -X POST http://localhost:8080/api/vector/search -H 'content-type: application/json' \
  -d '{"query":"mecha anime","topK":3}'
curl -s -X POST http://localhost:8080/api/ai/rag/recommend -H 'content-type: application/json' \
  -d '{"query":"space opera","limit":3}'

# direct (bypassing the gateway)
curl -s http://localhost:4003/health
```
