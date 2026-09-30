/**
 * modules/tenant/tenant-ai.js — FAZA 11 tenant-aware AI Cloud surface
 * (additive; mounted at /api/ai/tenant by server.js).
 *
 * Every route resolves the caller's tenant (X-Animaxia-Tenant header → JWT
 * tenant claim → user membership → 'global') and scopes the AI pipeline:
 *   • quotas  — tenant pool (tenantlimits) stacked over the per-user/plan
 *               pool (consumeTenantAiQuota)
 *   • vectors — per-tenant namespace (tenant-vector.js); 'global' keeps the
 *               platform-wide behavior via the base services
 *   • RAG     — retrieve (tenant-scoped) → rank (rankDocs) → prompt → LLM
 *               (z-ai→openai→mock chain, unchanged)
 *
 * Routes:
 *   GET  /status            — tenant + quota + vector + provider snapshot
 *   POST /rag/:mode         — mode: recommend | summarize | explain | chat
 *                             (long aliases accepted) — tenant-scoped RAG
 *   POST /vector/search     — { query, kind?, topK? } tenant-scoped search
 *   POST /vector/index      — admin: (re)index the tenant namespace
 *   GET  /usage             — metered usage rollup + recent ai_call volume
 */

import express from 'express';
import crypto from 'node:crypto';
import { rows } from '../platform/sql.js';
import { requireAuth, requireAdmin } from '../users/auth.js';
import { clientIpOf, auditLog } from '../security/security.js';
import { logger } from '../../utils/logger.js';
import { llmProviderStatus, llmComplete, buildPrompt, buildContext } from '../aicloud/llm-core.js';
import { loadProfileText, rankDocs } from '../aicloud/rag-engine.js';
import { getContentById } from '../../db.js';
import {
  resolveTenantOf,
  serializeTenant,
  recordTenantUsage,
  tenantUsageRollup,
  GLOBAL_TENANT_SLUG,
} from './core.js';
import { consumeTenantAiQuota, tenantAiQuotaStatus } from './ai-quota.js';
import { tenantVectorSearch, tenantMoreLikeThis, tenantVectorStatus, indexTenantContent } from './tenant-vector.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const MODE_ALIASES = {
  recommend: 'recommendations',
  recommendations: 'recommendations',
  summarize: 'summaries',
  summaries: 'summaries',
  explain: 'explanations',
  explanations: 'explanations',
  chat: 'chat-with-content',
  'chat-with-content': 'chat-with-content',
};

export const tenantAiRouter = express.Router();

/** Resolve the tenant or map the failure to its HTTP status. */
async function tenantOr404(req, res) {
  try {
    return await resolveTenantOf(req);
  } catch (err) {
    res.status(err.status || 404).json({ error: err.message, code: err.code || 'TENANT_NOT_FOUND' });
    return null;
  }
}

function quotaReject(res, q) {
  return res.status(q.status || 402).json({
    error: q.error,
    code: q.code || 'TENANT_AI_QUOTA',
    tenant: q.tenant,
    used: q.tenantUsed,
    limit: q.tenantLimit,
  });
}

/* --------------------------------- status ----------------------------------- */

tenantAiRouter.get('/status', wrap(async (req, res) => {
  const tenant = await tenantOr404(req, res);
  if (!tenant) return;
  const provider = llmProviderStatus();
  res.json({
    ok: true,
    tenant: serializeTenant(tenant),
    quota: tenantAiQuotaStatus(tenant),
    vector: await tenantVectorStatus(tenant),
    provider: { provider: provider.provider, model: provider.model, available: provider.available, fallback: provider.fallback },
  });
}));

/* ---------------------------------- RAG ------------------------------------- */

tenantAiRouter.post('/rag/:mode', requireAuth, wrap(async (req, res) => {
  const tenant = await tenantOr404(req, res);
  if (!tenant) return;
  const mode = MODE_ALIASES[String(req.params.mode || '').toLowerCase()];
  if (!mode) {
    return res.status(400).json({ error: `Unknown mode '${req.params.mode}' — use recommend | summarize | explain | chat` });
  }

  const { query = '', contentId = null, history = [], topK = 12, limit = 6 } = req.body || {};
  const quota = consumeTenantAiQuota({ user: req.user, ip: clientIpOf(req), tenant });
  if (!quota.allowed) return quotaReject(res, quota);

  const traceId = crypto.randomUUID();
  try {
    const profileText = await loadProfileText(req.user).catch(() => null);

    /* ---- mode: recommendations (tenant-scoped retrieval) ---- */
    if (mode === 'recommendations') {
      let effectiveQuery = String(query || '').trim();
      if (!effectiveQuery) effectiveQuery = profileText || 'popular high-quality movies tv anime on Animaxia';
      const retrieved = await tenantVectorSearch({ query: effectiveQuery, tenant, kind: 'content', topK: Math.max(8, Number(topK) || 12) });
      const docs = retrieved.data.map((d) => ({
        id: d.refid, title: d.title, type: d.type, thumbnail: d.thumbnail,
        genres: d.genres, rating: d.metadata?.rating ?? null, year: d.metadata?.year ?? null,
        text: d.snippet, score: d.score,
      }));
      const ranked = rankDocs(effectiveQuery, docs, profileText).slice(0, Math.max(1, Math.min(12, Number(limit) || 6)));
      const context = buildContext({
        docs: ranked.map((d) => ({ title: d.title, type: d.type, genres: d.genres, text: d.text })),
        profile: req.user ? { username: req.user.username, plan: req.user.plan, types: req.user.preferences?.types, genres: req.user.preferences?.genres } : null,
        budgetTokens: 1500,
      });
      const prompt = buildPrompt('recommendations', { query: effectiveQuery, context });
      const result = await llmComplete({
        messages: [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }],
        feature: 'rag-tenant', mode: 'recommendations', user: req.user, query: effectiveQuery, traceId,
        fallback: () => `Tenant picks for ${tenant.slug}: ${ranked.map((d) => d.title).join(', ')}.`,
      });
      return res.json({
        ok: true, mode, tenant: tenant.slug, scoped: tenant.slug !== GLOBAL_TENANT_SLUG,
        provider: result.provider, degraded: result.degraded, traceId,
        vectorBackend: retrieved.backend,
        data: ranked.map((d) => ({
          id: d.id, title: d.title, type: d.type, thumbnail: d.thumbnail, rating: d.rating,
          year: d.year, genres: d.genres, score: d.rankScore ?? d.score,
          reason: `matched on ${d.genres?.slice(0, 2).join(' / ') || d.type} within the ${tenant.slug} index`,
        })),
        intro: ranked.length && !result.degraded ? result.text.split(/(?<=\.)\s/)[0] || null : null,
      });
    }

    /* ---- content-anchored modes ---- */
    const content = contentId != null ? await getContentById(Number(contentId)) : null;
    if (!content) {
      return res.status(404).json({ error: 'Content not found — contentId is required for summarize/explain/chat', code: 'CONTENT_REQUIRED' });
    }
    const neighbors = await tenantMoreLikeThis(tenant, content.id, 5).catch(() => []);
    const doc = {
      title: content.title, type: content.type || 'title', genres: Array.isArray(content.metadata?.genres) ? content.metadata.genres : [],
      rating: content.metadata?.rating ?? null, year: content.metadata?.year ?? null,
      text: [content.title, content.type, (content.metadata?.genres || []).join(', ')].filter(Boolean).join('. '),
    };
    const context = buildContext({
      docs: [doc, ...neighbors.slice(0, 2).map((n) => ({ title: n.title, type: n.type, text: `similar: ${n.title}` }))],
      budgetTokens: 1200,
    });
    const modePrompt = {
      summaries: `Summarize ${content.title} for a viewer deciding whether to watch it.`,
      explanations: `Explain why ${content.title} matches (or not) this viewer's taste.`,
      'chat-with-content': String(query || `Tell me about ${content.title}`),
    }[mode];
    const prompt = buildPrompt(mode, { query: modePrompt, context, history: Array.isArray(history) ? history.slice(-6) : [] });
    const result = await llmComplete({
      messages: [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }],
      feature: 'rag-tenant', mode, user: req.user, query: modePrompt, traceId,
      fallback: () => `${content.title} (${(doc.genres || []).join(', ')}) — tenant-scoped ${mode} for ${tenant.slug}.`,
    });
    return res.json({
      ok: true, mode, tenant: tenant.slug, scoped: tenant.slug !== GLOBAL_TENANT_SLUG,
      provider: result.provider, degraded: result.degraded, traceId,
      contentId: content.id, title: content.title,
      [mode === 'summaries' ? 'summary' : mode === 'explanations' ? 'explanation' : 'reply']: result.text,
      neighbors: neighbors.map((n) => ({ id: n.refid, title: n.title, score: n.score })),
    });
  } catch (err) {
    logger.warn(`[tenant-ai][trace:${traceId}] rag ${mode} failed: ${err.message}`);
    if (err.status) return res.status(err.status).json({ error: err.message, code: err.code || 'TENANT_RAG_ERROR' });
    return res.status(500).json({ error: 'Tenant RAG pipeline failed', detail: err.message, traceId });
  }
}));

/* -------------------------------- vector ------------------------------------ */

tenantAiRouter.post('/vector/search', wrap(async (req, res) => {
  const tenant = await tenantOr404(req, res);
  if (!tenant) return;
  const { query, kind = 'content', topK = 8 } = req.body || {};
  if (!query) return res.status(400).json({ error: 'query is required' });
  const result = await tenantVectorSearch({ query, tenant, kind, topK });
  res.json({ ok: true, ...result });
}));

tenantAiRouter.post('/vector/index', requireAuth, requireAdmin, wrap(async (req, res) => {
  const tenant = await tenantOr404(req, res);
  if (!tenant) return;
  const { limit } = req.body || {};
  const result = await indexTenantContent(tenant, { limit: Number(limit) || undefined });
  await auditLog({ userid: req.user.id, action: 'tenant.vector.index', ip: clientIpOf(req), meta: { tenant: tenant.slug, indexed: result.indexed } });
  res.json({ ok: true, ...result });
}));

/* --------------------------------- usage ------------------------------------ */

tenantAiRouter.get('/usage', wrap(async (req, res) => {
  const tenant = await tenantOr404(req, res);
  if (!tenant) return;
  const days = Math.min(90, Math.max(1, Number(req.query.days) || 30));
  const rollup = await tenantUsageRollup(tenant.id, days);
  let recent = [];
  if (!tenant.isfallback) {
    try {
      recent = await rows(
        `SELECT metric, quantity, unit, createdat FROM tenantusageevents
         WHERE tenantid = $1 ORDER BY createdat DESC LIMIT 20`,
        [tenant.id],
      );
    } catch { /* fallback driver */ }
  }
  res.json({ ok: true, tenant: tenant.slug, usage: rollup, recent });
}));

export default tenantAiRouter;
