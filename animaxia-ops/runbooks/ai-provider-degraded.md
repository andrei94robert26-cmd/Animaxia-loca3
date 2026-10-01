# Runbook — AI provider degraded (z-ai → openai → mock chain)

**Service:** AI/LLM layer of the monolith backend (`mini-services/animaxia-backend/` :4000) —
`llm-core` provider chain with degradation, plus the vector backend.
**Chain:** `AI_PROVIDER` selects **z-ai** (default) | openai | mock; on failure the chain
auto-degrades z-ai → openai → mock, so AI endpoints keep answering 200 — but the content is
coming from the fallback (mock = deterministic/templated answers). This runbook confirms the
degradation and/or pins a provider explicitly.
**Current state in this environment:** z-ai is the sandbox default and healthy.

## Symptoms

- `/api/health` (FAZA 9 `ai` section) shows the primary provider down:

```json
"ai": {
  "provider": { "provider": "z-ai", "model": "...", "available": false,
                "lastError": "<upstream error>", "fallback": "<fallback in use>" },
  "quota": { "plan": "...", "used": N, "limit": M }
}
```

- Metrics: `animaxia_ai_degraded_total` increasing, `animaxia_ai_errors_total` climbing,
  `animaxia_ai_latency_*` (p50/p95) spiking — series available at `/api/metrics`.
- Admin stats (`/api/ai/admin/stats`, requireAdmin): `errorRate` climbing, per-provider
  breakdown (`byProvider`) shifting traffic to the fallback.
- User-visible: assistant/RAG answers are still **200** (the mock fallback answers), but become
  deterministic/templated — same canned phrasing regardless of input. The platform does NOT
  error out; you have to look at telemetry to notice.

## Diagnosis

```bash
# 1. AI + vector + quota snapshot
curl -s http://localhost:4000/api/ai/cloud/status
# llm { provider, model, available, lastError }, vector { backend, dims, counts }, quota

# 2. Health ai section (FAZA 9)
curl -s http://localhost:4000/api/health | grep -A 10 '"ai"'
# provider { provider, model, available, lastError, fallback }, quota { plan, used, limit }

# 3. Metrics — the whole AI family
curl -s http://localhost:4000/api/metrics | grep animaxia_ai_
# animaxia_ai_calls_* / animaxia_ai_errors_* / animaxia_ai_degraded_total /
# animaxia_ai_tokens_* / animaxia_ai_latency_* (p50, p95)

# 4. Admin stats (needs an admin token)
curl -s http://localhost:4000/api/ai/admin/stats -H "authorization: Bearer <ADMIN_JWT>"
# errorRate, latency p50/p95, byProvider
```

Interpretation: primary `available:false` + `lastError` set while calls keep succeeding means the
chain degraded and the fallback (usually mock) is serving. `animaxia_ai_calls_by_provider`
shifting to the fallback provider confirms it. If the vector side is affected too
(`VECTOR_BACKEND=auto` can't reach pgvector), `/api/ai/cloud/status` shows
`vector.backend: "mock"` and the boot log prints `[aicloud] vector backend: mock` instead of
`[aicloud] vector backend: pgvector (configured: auto, embeds: local-hash-256)`.

## Mitigation

Pin the provider explicitly (deterministic behavior instead of silent auto-degrade), and/or
force the vector backend down. Edit **only the AI vars** in `mini-services/animaxia-backend/.env`:

```bash
# pin to mock (always available, deterministic — keeps the product up)
AI_PROVIDER=mock

# ...or pin to openai (requires a valid key):
# AI_PROVIDER=openai
# AI_API_KEY=<key>

# force the retrieval/vector side down if pgvector is unreachable:
# VECTOR_BACKEND=mock
```

**NEVER edit other vars** — `DATABASEURL`, `TMDBAPIKEY`, `AUTHSECRET` etc. must stay untouched.
(Env naming trap: most backend vars have NO underscores — `DATABASEURL`, `TMDBAPIKEY`,
`AUTHSECRET` — while the AI ones do: `AI_PROVIDER`, `AI_API_KEY`, `VECTOR_BACKEND`.)

Restart the backend with the safe kill + relaunch pattern — **do NOT use `restore-env.sh` for
this**, it would overwrite your `.env` edit with the ZIP copy:

```bash
# 1. Find backend pids and verify EACH cwd before killing (never kill the :3000 web server)
for p in $(pgrep -f "bun --watch server.js"); do readlink /proc/$p/cwd; done
# kill ONLY the pids whose cwd is mini-services/animaxia-backend
kill <backend-pid>

# 2. Relaunch detached
cd mini-services/animaxia-backend && (setsid bun run dev > log 2>&1 < /dev/null &)
```

Note: because the chain already auto-degrades to mock, pinning is about determinism, visibility
and cost control — not availability. A pinned provider also makes the telemetry unambiguous
(`animaxia_ai_calls_by_provider` shows exactly what you configured).

## Verification

```bash
# 1. Provider pinned and available
curl -s http://localhost:4000/api/ai/cloud/status
# llm.provider "mock", llm.available true, no lastError

# 2. Product surfaces still healthy
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/
# 200  (personal / home views still render; assistant + RAG endpoints still answer 200)

# 3. AI synthetics suite only (29-check suite set, single-suite run)
cd /home/z/my-project/animaxia-ops && bun run ops:synthetics --only ai

# 4. Metrics series moved to the pinned provider
curl -s http://localhost:4000/api/metrics | grep animaxia_ai_calls_by_provider
# animaxia_ai_calls_by_provider{provider="mock"} now increasing
```

## Rollback

```bash
# 1. Restore the default provider in mini-services/animaxia-backend/.env
AI_PROVIDER=z-ai

# 2. Restart with the same safe kill + setsid pattern (see Mitigation)

# 3. Verify the chain serves z-ai again
curl -s http://localhost:4000/api/ai/cloud/status
# llm.provider "z-ai", llm.available true

curl -s http://localhost:4000/api/metrics | grep animaxia_ai_calls_by_provider
# animaxia_ai_calls_by_provider{provider="z-ai"} increasing again
```

## Notes

- **Quota side-effects:** degraded/mock calls still consume quota — anonymous 5/day per IP,
  free 10/day, plus 100/day, pro 500/day; 402 responses are counted in
  `animaxia_quota_responses_total`. A long silent degradation can burn through quotas while
  serving templated content.
- Provider facts: z-ai = sandbox default (healthy); openai requires `AI_API_KEY`; mock never fails.
- `VECTOR_BACKEND=auto` resolves pgvector when Neon + the pgvector extension are available,
  else mock (qdrant/pinecone adapters activate when configured).
- `llmProviderStatus()` is the single source of truth for
  provider/model/available/lastError/fallback — surfaced by both `/api/health` (ai section) and
  `/api/ai/cloud/status`; the degradation counter is exported as `animaxia_ai_degraded_total`
  and the per-provider detail as `/api/ai/admin/stats` (requireAdmin).
