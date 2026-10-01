/**
 * modules/aicloud/tools.js — Tools layer (Phase 4, requirement 4).
 *
 * Six whitelisted platform tools with JSON descriptors (served by
 * GET /api/ai/tools and injected into the animaxiaAssistant prompt):
 *
 *   searchContent      { query, type?, limit? }   — library search (title LIKE)
 *   searchUserHistory  { limit? }                 — caller's watch history
 *   getTrending        { window?, limit? }        — viewevents aggregation
 *   getFeed            { limit? }                 — recent comments/likes/content
 *   getPremiumPlan     { plan? }                  — plan catalog + limits
 *   enqueueQueueJob    { type, payload? }         — worker-pool job (mine,
 *       prefetch, thumbnail, refresh) — the Phase-2 worker system
 *
 * Every tool runs through runTool(): name whitelist, argument clamping,
 * per-tool execution + timing, error capture (tools degrade to empty results,
 * they never crash a caller) and audit logging for job enqueues.
 */

import { listContent } from '../../db.js';
import { rows, isoOrNull } from '../platform/sql.js';
import { PLANS, planLimits } from '../premium/plans.js';
import { workerPool } from '../workers/workers.js';
import { auditLog } from '../security/security.js';
import { logger } from '../../utils/logger.js';

/* -------------------------------- descriptors ------------------------------- */

export const TOOLS = [
  {
    name: 'searchContent',
    description: 'Search the Animaxia library by title (optionally filtered by type: movie, tv, anime, mined, featured). Returns id, title, type, thumbnail, rating and year.',
    parameters: { query: 'string', type: 'string (optional)', limit: 'number 1-20 (default 8)' },
    required: ['query'],
    example: { query: 'naruto', type: 'anime', limit: 5 },
  },
  {
    name: 'searchUserHistory',
    description: "Read the CALLING user's watch history (most recent first) with titles, types, genres and progress. Only ever returns the requesting user's own history.",
    parameters: { limit: 'number 1-20 (default 8)' },
    required: [],
    example: { limit: 5 },
  },
  {
    name: 'getTrending',
    description: 'Most-watched titles on Animaxia aggregated from view/play events over a time window (24h, 7d or 30d). Falls back to newest additions when analytics are sparse.',
    parameters: { window: "'24h' | '7d' | '30d' (default 7d)", limit: 'number 1-20 (default 8)' },
    required: [],
    example: { window: '7d', limit: 5 },
  },
  {
    name: 'getFeed',
    description: 'Recent platform activity: latest comments (with authors and content titles), likes and new library additions.',
    parameters: { limit: 'number 1-20 (default 8)' },
    required: [],
    example: { limit: 5 },
  },
  {
    name: 'getPremiumPlan',
    description: 'Premium plan catalog: one plan (plus/pro/free) or all plans with prices and limits (watchlist, history, aiPerDay, quality).',
    parameters: { plan: "'free' | 'plus' | 'pro' (optional)" },
    required: [],
    example: { plan: 'pro' },
  },
  {
    name: 'enqueueQueueJob',
    description: 'Enqueue an async worker job on the Animaxia worker pool. Types: "mine" { url, type?, externalId? }, "prefetch" { contentId }, "thumbnail" { contentId? , missing? }, "refresh" { source: tmdb|jikan }. Returns a jobId.',
    parameters: {
      type: "'mine' | 'prefetch' | 'thumbnail' | 'refresh'",
      payload: 'object (depends on type)',
    },
    required: ['type'],
    example: { type: 'refresh', payload: { source: 'tmdb' } },
  },
];

const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));
const JOB_TYPES = new Set(['mine', 'prefetch', 'thumbnail', 'refresh']);
const WINDOWS = { '24h': '1 day', '7d': '7 days', '30d': '30 days' };

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function minimalRow(row) {
  const meta = row?.metadata && typeof row.metadata === 'object' ? row.metadata : {};
  return {
    id: row.id,
    title: row.title,
    type: row.type ?? null,
    thumbnail: row.thumbnail ?? null,
    rating: typeof meta.rating === 'number' ? meta.rating : typeof meta.score === 'number' ? meta.score : null,
    year: meta.year ?? null,
    genres: Array.isArray(meta.genres) ? meta.genres.map(String) : [],
  };
}

/* --------------------------------- tool impls ------------------------------- */

async function searchContent(args) {
  const query = String(args.query || '').trim().slice(0, 120);
  const limit = clampInt(args.limit, 1, 20, 8);
  if (!query) {
    const recent = await listContent({ page: 1, limit });
    return { query: null, data: recent.data.map(minimalRow), total: recent.total };
  }
  const result = await listContent({ page: 1, limit, search: query, type: args.type || undefined });
  return { query, type: args.type || null, data: result.data.map(minimalRow), total: result.total };
}

async function searchUserHistory(args, ctx) {
  if (!ctx.user || ctx.user.id == null) {
    return { error: 'This tool requires a signed-in user', data: [] };
  }
  const limit = clampInt(args.limit, 1, 20, 8);
  try {
    const history = await rows(
      `SELECT c.id, c.title, c.type, c.thumbnail, c.metadata, wh.progress, wh.watchedat
       FROM watchhistory wh JOIN content c ON c.id = wh.contentid
       WHERE wh.userid = $1 ORDER BY wh.watchedat DESC LIMIT $2`,
      [ctx.user.id, limit],
    );
    return {
      data: history.map((r) => ({
        ...minimalRow(r),
        progress: Number(r.progress ?? 0),
        watchedat: isoOrNull(r.watchedat),
      })),
    };
  } catch (err) {
    logger.debug(`[aicloud] searchUserHistory failed: ${err.message}`);
    return { data: [], note: 'history unavailable right now' };
  }
}

async function getTrending(args) {
  const window = WINDOWS[args.window] ? args.window : '7d';
  const limit = clampInt(args.limit, 1, 20, 8);
  try {
    const trending = await rows(
      `SELECT ve.contentid, COUNT(*)::int AS views, MAX(ve.createdat) AS lastview
       FROM viewevents ve
       WHERE ve.createdat > NOW() - $1::interval AND ve.event IN ('view','play')
       GROUP BY ve.contentid
       ORDER BY views DESC
       LIMIT $2`,
      [WINDOWS[window], limit],
    );
    const detailed = [];
    for (const t of trending) {
      const row = await rows(`SELECT id, title, type, thumbnail, metadata FROM content WHERE id = $1`, [t.contentid]);
      if (row[0]) detailed.push({ ...minimalRow(row[0]), views: t.views });
    }
    if (detailed.length > 0) return { window, data: detailed };
  } catch (err) {
    logger.debug(`[aicloud] getTrending aggregation skipped: ${err.message}`);
  }
  const recent = await listContent({ page: 1, limit });
  return { window, fallback: 'recent additions', data: recent.data.map(minimalRow) };
}

async function getFeed(args) {
  const limit = clampInt(args.limit, 1, 20, 8);
  const activities = [];
  try {
    const comments = await rows(
      `SELECT cm.body, cm.createdat, c.title AS contenttitle, u.username
       FROM comments cm
       LEFT JOIN content c ON c.id = cm.contentid
       LEFT JOIN users u ON u.id = cm.userid
       ORDER BY cm.createdat DESC LIMIT $1`,
      [limit],
    );
    for (const r of comments) {
      activities.push({
        type: 'comment',
        user: r.username ?? 'someone',
        content: r.contenttitle,
        preview: String(r.body || '').slice(0, 140),
        createdat: isoOrNull(r.createdat),
      });
    }
  } catch {
    /* comments unavailable — continue with content */
  }
  try {
    const latest = await listContent({ page: 1, limit });
    for (const row of latest.data) {
      activities.push({
        type: 'content',
        content: row.title,
        preview: 'new on Animaxia',
        createdat: row.createdat,
      });
    }
  } catch {
    /* ignore */
  }
  activities.sort((a, b) => String(b.createdat || '').localeCompare(String(a.createdat || '')));
  return { data: activities.slice(0, limit) };
}

function getPremiumPlan(args) {
  const key = String(args.plan || '').toLowerCase();
  if (key && PLANS[key]) {
    return { plan: PLANS[key], limits: planLimits(key) };
  }
  return { plans: Object.values(PLANS).map((p) => ({ key: p.key, name: p.name, price: p.price, limits: p.limits })) };
}

async function enqueueQueueJob(args, ctx) {
  const type = String(args.type || '').toLowerCase();
  if (!JOB_TYPES.has(type)) {
    return { error: `Unknown job type "${type}". Valid: ${[...JOB_TYPES].join(', ')}` };
  }
  const payload =
    args.payload && typeof args.payload === 'object' && !Array.isArray(args.payload) ? args.payload : {};
  if (type === 'mine' && !payload.url) return { error: 'mine jobs require payload.url' };
  if (type === 'prefetch' && !payload.contentId) return { error: 'prefetch jobs require payload.contentId' };
  if (type === 'refresh' && !['tmdb', 'jikan'].includes(payload.source)) {
    return { error: 'refresh jobs require payload.source (tmdb|jikan)' };
  }
  const { jobId } = workerPool.enqueue(type, { ...payload, userid: ctx.user?.id ?? null });
  await auditLog({
    userid: ctx.user?.id ?? null,
    action: 'aicloud.tool.enqueue',
    ip: ctx.ip ?? null,
    meta: { type, jobId, tool: 'enqueueQueueJob' },
  }).catch(() => {});
  return { jobId, type, queued: true };
}

const IMPLEMENTATIONS = {
  searchContent,
  searchUserHistory,
  getTrending,
  getFeed,
  getPremiumPlan,
  enqueueQueueJob,
};

/* --------------------------------- runTool ---------------------------------- */

/**
 * Execute a whitelisted tool with clamped arguments.
 * Never throws — failures return { ok: false, error } to the caller.
 *
 * @param {string} name
 * @param {object} args
 * @param {{ user?: object|null, ip?: string|null }} ctx
 * @returns {Promise<{ ok: boolean, tool: string, result?: unknown, error?: string, ms: number }>}
 */
export async function runTool(name, args = {}, ctx = {}) {
  const started = Date.now();
  if (!TOOL_NAMES.has(name)) {
    return { ok: false, tool: name, error: `Unknown tool "${name}"`, ms: 0 };
  }
  try {
    const result = await IMPLEMENTATIONS[name](args || {}, ctx);
    const ms = Date.now() - started;
    logger.info(`[aicloud] tool ${name} ok ${ms}ms`);
    return { ok: true, tool: name, result, ms };
  } catch (err) {
    const ms = Date.now() - started;
    logger.warn(`[aicloud] tool ${name} failed: ${err.message}`);
    return { ok: false, tool: name, error: err.message || 'Tool execution failed', ms };
  }
}

/** Compact tool specs for the assistant prompt (requirement 4). */
export function toolSpecsForPrompt() {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
    example: t.example,
  }));
}
