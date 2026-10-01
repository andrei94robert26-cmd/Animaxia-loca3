/**
 * modules/aicloud/router.js — Animaxia AI Cloud API surface (Phase 4).
 *
 * Two Express routers mounted by server.js (extensions only — no existing
 * Phase-1/2 route is touched):
 *
 *   app.use('/api/ai', aicloudRouter)   — Phase-4 AI endpoints
 *   app.use('/api/vector', vectorRouter)— vector-service endpoints
 *
 * aicloudRouter (all under /api/ai):
 *   GET  /cloud/status          — providers, vector backend, quotas (public)
 *   POST /rag/recommend         — RAG recommendations (public, anon quota)
 *   POST /rag/summarize         — RAG summary of a title (public, anon quota)
 *   POST /rag/explain           — RAG explanation (public, anon quota)
 *   POST /rag/chat              — chat-with-content (requireAuth)
 *   POST /assistant             — animaxiaAssistant (requireAuth)
 *   GET  /assistant/history     — persisted agent turns (requireAuth)
 *   GET  /personal/home         — personal AI home (requireAuth)
 *   GET  /personal/feed         — AI-ranked feed + weekly recap (requireAuth)
 *   GET  /personal/player       — player companion (requireAuth)
 *   GET  /personal/recap        — weekly recap (requireAuth)
 *   GET  /tools                 — tool catalog (public)
 *   POST /tools/run             — run a tool (requireAuth, 20/min)
 *   GET  /admin/stats           — Admin AI dashboard (requireAdmin)
 *   GET  /admin/prompts         — top prompts + recent calls (requireAdmin)
 *   GET  /admin/errors          — recent errors (requireAdmin)
 *
 * vectorRouter (all under /api/vector):
 *   GET  /status                — backend, dims, counts (public)
 *   POST /search                — similarity search (public, 30/min)
 *   POST /index-content         — re-index library (requireAdmin)
 *   POST /index-user            — index caller's taste embedding (requireAuth)
 *
 * Also exports:
 *   ensureAicloudSchema() — idempotent DDL (aiusagelogs, agentconversations,
 *                           aiprofiles + pgvector attempt)
 *   aicloudBoot()         — vector backend init + background auto-index
 */

import express from 'express';
import crypto from 'node:crypto';
import { rows } from '../platform/sql.js';
import { requireAuth, requireAdmin } from '../users/auth.js';
import { userRateLimit, clientIpOf, auditLog } from '../security/security.js';
import { logger } from '../../utils/logger.js';

import {
  llmProviderStatus,
  aiQuotaStatus,
  consumeAiQuota,
  llmConfig,
} from './llm-core.js';
import {
  vectorStatus,
  vectorSearch,
  indexContent,
  indexUser,
  aicloudVectorBoot,
  ensureVectorSchema,
} from './vector-service.js';
import { runRag } from './rag-engine.js';
import { TOOLS, runTool } from './tools.js';
import { runAssistant, getAssistantHistory } from './agent.js';
import { getPersonalHome, getPersonalFeed, getPersonalPlayer, getWeeklyRecap } from './personal.js';
import { adminStats, adminPrompts, adminErrors } from './admin.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* --------------------------------- schema ----------------------------------- */

/**
 * Idempotent Phase-4 DDL (Neon PostgreSQL; safe to re-run, no-op on the local
 * fallback driver): LLM usage logs, agent conversations, AI profiles and the
 * pgvector `vectorembeddings` table when the extension is available.
 */
export async function ensureAicloudSchema() {
  const DDL = [
    `CREATE TABLE IF NOT EXISTS aiusagelogs (
      id SERIAL PRIMARY KEY,
      traceid TEXT NOT NULL,
      userid INTEGER,
      feature TEXT NOT NULL,
      mode TEXT,
      provider TEXT NOT NULL,
      model TEXT,
      prompttokens INTEGER NOT NULL DEFAULT 0,
      completiontokens INTEGER NOT NULL DEFAULT 0,
      costusd REAL NOT NULL DEFAULT 0,
      latencyms INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'ok',
      degraded BOOLEAN NOT NULL DEFAULT FALSE,
      errormessage TEXT,
      promptsnippet TEXT,
      createdat TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS idx_aiusagelogs_created ON aiusagelogs (createdat DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_aiusagelogs_feature ON aiusagelogs (feature)`,
    `CREATE TABLE IF NOT EXISTS agentconversations (
      id SERIAL PRIMARY KEY,
      userid INTEGER NOT NULL,
      role TEXT NOT NULL,
      message TEXT NOT NULL,
      traceid TEXT,
      toolsused JSONB NOT NULL DEFAULT '{}',
      createdat TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS idx_agentconversations_user ON agentconversations (userid, createdat DESC)`,
    `CREATE TABLE IF NOT EXISTS aiprofiles (
      userid INTEGER PRIMARY KEY,
      summary TEXT,
      tastetags JSONB NOT NULL DEFAULT '{}',
      lastrecap TEXT,
      lastrecapat TIMESTAMPTZ,
      updatedat TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
  ];
  for (const statement of DDL) {
    await rows(statement);
  }
  // pgvector is optional — 'auto' falls back to the in-memory mock backend.
  const pgvector = await ensureVectorSchema().catch(() => false);
  logger.info(`[aicloud] schema ready (pgvector: ${pgvector ? 'yes' : 'no'})`);
  return { pgvector };
}

/** Boot hook — resolve the vector backend + auto-index content (background). */
export function aicloudBoot() {
  void aicloudVectorBoot().catch((err) => logger.warn(`[aicloud] vector boot failed: ${err.message}`));
}

/* ------------------------------- quota guard -------------------------------- */

/**
 * Per-user AND per-plan LLM quota (llm-core). Anonymous callers are allowed
 * only when { allowAnonymous } and share a 5/day per-IP bucket.
 * Attaches req.aiQuota = { plan, used, limit } on success.
 */
function quotaGuard({ allowAnonymous = false } = {}) {
  return (req, res, next) => {
    const hasUser = Boolean(req.user && req.user.id != null);
    if (!hasUser && !allowAnonymous) {
      return res.status(401).json({ error: 'Sign in to use this AI feature' });
    }
    const quota = consumeAiQuota(hasUser ? { user: req.user, ip: clientIpOf(req) } : { ip: clientIpOf(req) });
    if (!quota.allowed) {
      return res.status(quota.status).json({
        error: quota.error,
        ...(quota.upgrade ? { upgrade: true } : {}),
        plan: quota.plan,
        limit: quota.limit,
      });
    }
    req.aiQuota = quota;
    return next();
  };
}

function traceOf(req) {
  return crypto.randomUUID();
}

/* ------------------------------ aicloud router ------------------------------ */

export const aicloudRouter = express.Router();

/* GET /api/ai/cloud/status — provider + vector + quota snapshot (public) */
aicloudRouter.get(
  '/cloud/status',
  wrap(async (req, res) => {
    const vector = await vectorStatus().catch(() => ({ backend: 'mock', counts: {} }));
    res.json({
      ok: true,
      llm: llmProviderStatus(),
      config: { provider: llmConfig().provider, vectorBackend: vector.configured ?? vector.backend },
      vector: { backend: vector.backend, dims: vector.dims, counts: vector.counts, lastIndexedAt: vector.lastIndexedAt },
      assistant: { tools: TOOLS.length },
      quota: aiQuotaStatus({ user: req.user ?? null, ip: clientIpOf(req) }),
      plans: { free: 10, plus: 100, pro: 500, anonymous: 5 },
    });
  }),
);

/* POST /api/ai/rag/recommend { query?, limit? } */
aicloudRouter.post(
  '/rag/recommend',
  quotaGuard({ allowAnonymous: true }),
  wrap(async (req, res) => {
    const traceId = traceOf(req);
    const result = await runRag({
      mode: 'recommendations',
      query: String(req.body?.query || '').slice(0, 400),
      user: req.user ?? null,
      limit: Math.max(1, Math.min(10, parseInt(req.body?.limit, 10) || 6)),
      traceId,
    });
    res.set('X-Ai-Trace-Id', traceId);
    res.json({ ...result, quota: req.aiQuota });
  }),
);

/* POST /api/ai/rag/summarize { contentId } */
aicloudRouter.post(
  '/rag/summarize',
  quotaGuard({ allowAnonymous: true }),
  wrap(async (req, res) => {
    const traceId = traceOf(req);
    const contentId = parseInt(req.body?.contentId, 10);
    if (!Number.isInteger(contentId) || contentId <= 0) {
      return res.status(400).json({ error: 'Invalid contentId' });
    }
    const result = await runRag({ mode: 'summaries', contentId, user: req.user ?? null, traceId });
    res.set('X-Ai-Trace-Id', traceId);
    res.json({ ...result, quota: req.aiQuota });
  }),
);

/* POST /api/ai/rag/explain { contentId, question? } */
aicloudRouter.post(
  '/rag/explain',
  quotaGuard({ allowAnonymous: true }),
  wrap(async (req, res) => {
    const traceId = traceOf(req);
    const contentId = parseInt(req.body?.contentId, 10);
    if (!Number.isInteger(contentId) || contentId <= 0) {
      return res.status(400).json({ error: 'Invalid contentId' });
    }
    const result = await runRag({
      mode: 'explanations',
      contentId,
      query: String(req.body?.question || '').slice(0, 400),
      user: req.user ?? null,
      traceId,
    });
    res.set('X-Ai-Trace-Id', traceId);
    res.json({ ...result, quota: req.aiQuota });
  }),
);

/* POST /api/ai/rag/chat { contentId, message, history? } (requireAuth) */
aicloudRouter.post(
  '/rag/chat',
  quotaGuard({ allowAnonymous: false }),
  wrap(async (req, res) => {
    const traceId = traceOf(req);
    const contentId = parseInt(req.body?.contentId, 10);
    const message = String(req.body?.message || '').slice(0, 2000);
    if (!Number.isInteger(contentId) || contentId <= 0) {
      return res.status(400).json({ error: 'Invalid contentId' });
    }
    if (!message.trim()) return res.status(400).json({ error: 'Message is required' });
    const result = await runRag({
      mode: 'chat-with-content',
      contentId,
      query: message,
      history: Array.isArray(req.body?.history) ? req.body.history : [],
      user: req.user ?? null,
      traceId,
    });
    res.set('X-Ai-Trace-Id', traceId);
    res.json({ ...result, quota: req.aiQuota });
  }),
);

/* POST /api/ai/assistant { message, history? } (requireAuth) */
aicloudRouter.post(
  '/assistant',
  quotaGuard({ allowAnonymous: false }),
  wrap(async (req, res) => {
    const result = await runAssistant({
      message: String(req.body?.message || ''),
      history: Array.isArray(req.body?.history) ? req.body.history : [],
      user: req.user,
      ip: clientIpOf(req),
    });
    res.set('X-Ai-Trace-Id', result.traceId);
    res.json({ ...result, quota: req.aiQuota });
  }),
);

/* GET /api/ai/assistant/history?limit= */
aicloudRouter.get(
  '/assistant/history',
  requireAuth,
  wrap(async (req, res) => {
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 20));
    const data = await getAssistantHistory(req.user.id, limit);
    res.json({ ok: true, data });
  }),
);

/* GET /api/ai/personal/home */
aicloudRouter.get(
  '/personal/home',
  requireAuth,
  wrap(async (req, res) => {
    const result = await getPersonalHome(req.user, { traceId: traceOf(req) });
    res.set('X-Ai-Trace-Id', result.traceId);
    res.json(result);
  }),
);

/* GET /api/ai/personal/feed?limit= */
aicloudRouter.get(
  '/personal/feed',
  requireAuth,
  wrap(async (req, res) => {
    const limit = Math.max(1, Math.min(20, parseInt(req.query.limit, 10) || 10));
    const result = await getPersonalFeed(req.user, { limit, traceId: traceOf(req) });
    res.set('X-Ai-Trace-Id', result.traceId);
    res.json(result);
  }),
);

/* GET /api/ai/personal/player?contentId= */
aicloudRouter.get(
  '/personal/player',
  requireAuth,
  wrap(async (req, res) => {
    const contentId = parseInt(req.query.contentId, 10);
    if (!Number.isInteger(contentId) || contentId <= 0) {
      return res.status(400).json({ error: 'Invalid contentId' });
    }
    const result = await getPersonalPlayer(req.user, contentId, { traceId: traceOf(req) });
    res.set('X-Ai-Trace-Id', result.traceId);
    res.json(result);
  }),
);

/* GET /api/ai/personal/recap */
aicloudRouter.get(
  '/personal/recap',
  requireAuth,
  wrap(async (req, res) => {
    const result = await getWeeklyRecap(req.user, {
      traceId: traceOf(req),
      refresh: req.query.refresh === 'true',
    });
    res.set('X-Ai-Trace-Id', result.traceId);
    res.json(result);
  }),
);

/* GET /api/ai/tools — catalog (public) */
aicloudRouter.get('/tools', (req, res) => {
  res.json({ ok: true, data: TOOLS });
});

/* POST /api/ai/tools/run { name, args } (requireAuth, 20/min) */
aicloudRouter.post(
  '/tools/run',
  requireAuth,
  userRateLimit({ scope: 'user', max: 20, windowMs: 60000, key: 'aicloud-tools' }),
  wrap(async (req, res) => {
    const name = String(req.body?.name || '');
    const args = req.body?.args && typeof req.body.args === 'object' ? req.body.args : {};
    const result = await runTool(name, args, { user: req.user, ip: clientIpOf(req) });
    if (!result.ok && result.error?.startsWith('Unknown tool')) {
      return res.status(404).json({ error: result.error });
    }
    res.json(result);
  }),
);

/* ------------------------------ admin AI router ----------------------------- */

aicloudRouter.get(
  '/admin/stats',
  requireAuth,
  requireAdmin,
  wrap(async (req, res) => {
    res.json(await adminStats());
  }),
);

aicloudRouter.get(
  '/admin/prompts',
  requireAuth,
  requireAdmin,
  wrap(async (req, res) => {
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 20));
    res.json(await adminPrompts(limit));
  }),
);

aicloudRouter.get(
  '/admin/errors',
  requireAuth,
  requireAdmin,
  wrap(async (req, res) => {
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 20));
    res.json(await adminErrors(limit));
  }),
);

/* ------------------------------ vector router ------------------------------- */

export const vectorRouter = express.Router();

/* GET /api/vector/status (public) */
vectorRouter.get(
  '/status',
  wrap(async (req, res) => {
    res.json(await vectorStatus());
  }),
);

/* POST /api/vector/search { query, kind?, topK? } (public, 30/min per IP) */
vectorRouter.post(
  '/search',
  userRateLimit({ scope: 'ip', max: 30, windowMs: 60000, key: 'vector-search' }),
  wrap(async (req, res) => {
    const query = String(req.body?.query || '').trim();
    if (!query) return res.status(400).json({ error: 'query is required' });
    const result = await vectorSearch({
      query,
      kind: String(req.body?.kind || 'content'),
      topK: Math.max(1, Math.min(24, parseInt(req.body?.topK, 10) || 8)),
    });
    res.json({ ok: true, ...result });
  }),
);

/* POST /api/vector/index-content (requireAdmin) */
vectorRouter.post(
  '/index-content',
  requireAuth,
  requireAdmin,
  wrap(async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map((n) => parseInt(n, 10)).filter(Number.isInteger) : null;
    const result = await indexContent({ ids });
    await auditLog({
      userid: req.user.id,
      action: 'aicloud.vector.index-content',
      ip: clientIpOf(req),
      meta: { indexed: result.indexed, backend: result.backend },
    }).catch(() => {});
    res.json({ ok: true, ...result });
  }),
);

/* POST /api/vector/index-user (requireAuth) — index caller's taste embedding */
vectorRouter.post(
  '/index-user',
  requireAuth,
  wrap(async (req, res) => {
    const result = await indexUser(req.user);
    res.json({ ok: true, ...result, text: undefined });
  }),
);
