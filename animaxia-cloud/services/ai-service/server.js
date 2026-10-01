/**
 * services/ai-service/server.js — Animaxia Cloud AI service (:4003).
 *
 * Owns the /api/ai + /api/vector route families (BLUEPRINT §3), backed by the
 * extracted domain modules:
 *   • domain/ai/ai.js (Phase 3) — z-ai-web-dev-sdk chat completions with
 *     deterministic heuristic fallbacks, per-plan daily quotas, anonymous IP
 *     buckets, content-scoped chat persisted to the `aichats` table.
 *   • domain/aicloud/* (Phase 4 — Animaxia AI Cloud, BLUEPRINT §11): llm-core
 *     (provider abstraction z-ai|openai|mock with auto-degradation, mode-aware
 *     prompts, token-budgeted context, per-user AND per-plan quotas, full
 *     usage tracking into `aiusagelogs`), vector-service (pluggable vector
 *     backends pgvector|mock|qdrant|pinecone over the `vectorembeddings`
 *     table, local-hash-256 or OpenAI embeddings), rag-engine (retrieve → rank
 *     → prompt → LLM for recommendations/summaries/explanations/chat), tools +
 *     agent (animaxiaAssistant JSON tool-calling with guardrails; the
 *     enqueueQueueJob tool POSTs to queue-service over HTTP), personal
 *     (personal home/feed/player/weekly recap) and admin (AI usage dashboard).
 *
 * Boot wiring (createService, BLUEPRINT §6):
 *   • initDb          → pg pool + content schema
 *   • ensureSchema    → ensurePlatformSchema (users/viewevents/aichats/… DDL)
 *                       THEN ensureAicloudSchema (Phase-4 DDL: aiusagelogs,
 *                       agentconversations, aiprofiles + pgvector attempt)
 *   • attachUser      → true — the AI router's quotaGuard + /recommendations
 *                       personalization read req.user from the optional
 *                       Bearer token (public taste-test endpoints stay usable
 *                       anonymously). /chat guards itself with requireAuth.
 *   • routers         → aiRouter at /api/ai (Phase-3, exact domain mount),
 *                       then aicloudRouter ALSO at /api/ai (Phase-4 endpoints
 *                       — Express falls through to the next mounted router on
 *                       no-match, so the Phase-3 surface is untouched), and
 *                       vectorRouter at /api/vector (vector-service status/
 *                       search/index-content/index-user).
 *   • beforeListen    → aicloudBoot(): resolve the vector backend + background
 *                       auto-index of the content library (runs after the
 *                       schema hooks, exactly like the monolith boot order).
 *   • worker thread   → ./worker.thread.js every 10 min: prunes `aichats`
 *                       sessions AND Phase-4 `aiusagelogs` rows older than
 *                       7 days (retention tasks).
 *
 * Env (Phase-4 AI contract — see .env.example): AI_PROVIDER, AI_API_KEY,
 * AI_MODEL, AI_TIMEOUTMS, VECTOR_BACKEND, QDRANTURL, QDRANTAPIKEY,
 * PINECONEURL, PINECONEAPIKEY.
 *
 * The z-ai SDK is a pure-JS ESM package (dist/, no build step): it lazily
 * reads a .z-ai-config JSON file (cwd → ~/.z-ai-config → /etc/.z-ai-config)
 * on the first completion. Without a config the domain module degrades to
 * heuristic answers — the service still boots and serves.
 */

import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { createService } from '@animaxia/common/service.js';
import { ensurePlatformSchema } from '@animaxia/common/migrations.js';
import aiRouter from '@animaxia/domain/ai/ai.js';
import { aicloudRouter, vectorRouter, ensureAicloudSchema, aicloudBoot } from '@animaxia/domain/aicloud/router.js';
import { readiness } from './health.js';
import { aiRateLimit } from './rateLimit.js';
import './cache.js';

// NOTE: common/worker.js resolves a RELATIVE `file` against common/ itself, so
// services must pass an ABSOLUTE worker path (computed from this module). This
// works identically in dev (repo root) and in the Docker image (/app).
const workerFile = fileURLToPath(new URL('./worker.thread.js', import.meta.url));

createService({
  name: 'ai-service',
  version: '3.0.0',
  port: 4003,
  portEnv: 'AIPORT',
  initDb: true,
  ensureSchema: async () => {
    // Phase-3 platform DDL first, then the Phase-4 AI Cloud tables
    // (aiusagelogs, agentconversations, aiprofiles + pgvector attempt).
    await ensurePlatformSchema();
    await ensureAicloudSchema();
  },
  attachUser: true,
  rateLimit: aiRateLimit, // 60/min per IP default — LLM calls are the most expensive path in the fleet
  routers: [
    { path: '/api/ai', router: aiRouter }, // Phase-3 AI router (recommendations/summarize/describe/chat/status)
    { path: '/api/ai', router: aicloudRouter }, // Phase-4 AI Cloud (cloud/status, rag/*, assistant, personal/*, tools, admin/*)
    { path: '/api/vector', router: vectorRouter }, // Phase-4 vector-service (status/search/index-content/index-user)
  ],
  health: { readiness },
  worker: { file: workerFile, intervalMs: 600000 }, // aichats + aiusagelogs retention prune every 10 min
  beforeListen: () => {
    // Phase-4 boot hook: resolve the vector backend (pgvector/mock/qdrant/
    // pinecone per VECTOR_BACKEND) and kick off the background auto-index of
    // the content library. Runs after ensureSchema — monolith boot order.
    aicloudBoot();
  },
});

// Entry point — no default export (Bun 1.3 auto-serves objects with a port property).
