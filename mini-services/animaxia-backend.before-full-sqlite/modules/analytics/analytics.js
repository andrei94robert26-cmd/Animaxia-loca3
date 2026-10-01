/**
 * modules/analytics/analytics.js — Viewing analytics: raw view-event ingestion,
 * trending content, per-user activity reports and the admin platform overview.
 *
 * Routes (mounted under /api/analytics):
 *   POST /views      { contentId, event: 'view'|'play'|'complete' } → { ok }
 *                    (public; Bearer token attaches userid; 120/min per-IP limit)
 *   GET  /trending   ?window=24h|7d|30d&limit=10
 *                    → { data: [{ content, views, plays, score }], fallback } (public, cached 60s)
 *   GET  /user/:id   ?days=14
 *                    → { totals: { views, plays, completed }, viewsByDay, topTypes }
 *                    (requireAuth; self or admin)
 *   GET  /overview   → { totals, viewsByDay, topContent, planDistribution,
 *                        activeUsers7d, recentSignups }             (requireAdmin, cached 30s)
 *
 * Trending score = plays * 2 + views over the window. When no view events
 * exist in the window (fresh database) the endpoint falls back to the newest
 * content rows with zeroed metrics and `fallback: true`.
 *
 * Caching uses the advancedCache (tag-aware LRU) ONLY — never the global HTTP
 * cacheMiddleware — because these payloads are shared but short-lived:
 *   • analytics:trending:${window}  TTL 60s, tags ['analytics', 'content']
 *   • analytics:overview            TTL 30s, tags ['analytics']
 */

import express from 'express';
import { rows, one, parseJsonb, isoOrNull, num } from '../platform/sql.js';
import { requireAuth, requireAdmin } from '../users/auth.js';
import { userRateLimit } from '../security/security.js';
import { advancedCache } from '../cache/advancedCache.js';
import { getContentById } from '../../db.js';

/* --------------------------------- helpers --------------------------------- */

/** Wrap an async handler so rejections reach the Express error middleware. */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Per-IP view ingestion limit: 120 per minute. */
const viewLimiter = userRateLimit({ scope: 'ip', max: 120, windowMs: 60000, key: 'analytics' });

const VALID_EVENTS = new Set(['view', 'play', 'complete']);

/** Trending window keys → PostgreSQL intervals. */
const WINDOWS = { '24h': '1 day', '7d': '7 days', '30d': '30 days' };

const TRENDING_CACHE_TTL_MS = 60000;
const OVERVIEW_CACHE_TTL_MS = 30000;
const TRENDING_MAX_ROWS = 50;

/** Clamp an integer into [min, max]. */
function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Parse a positive-integer route/body param → number, or NaN when invalid. */
function parseId(value) {
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) && n > 0 ? n : NaN;
}

/**
 * Normalize a raw content row to the canonical content shape
 * (mirrors db.js normalizeRow: id, externalid, type, title, metadata,
 * thumbnail, createdat).
 */
function normalizeContentRow(row) {
  if (!row) return null;
  return {
    id: num(row.id),
    externalid: row.externalid ?? null,
    type: row.type ?? null,
    title: row.title ?? null,
    metadata: parseJsonb(row.metadata, {}),
    thumbnail: row.thumbnail === undefined ? null : row.thumbnail,
    createdat: isoOrNull(row.createdat),
  };
}

/**
 * Compute the trending payload for a window (uncached).
 * @returns {Promise<{ data: Array<{ content, views, plays, score }>, fallback: boolean }>}
 */
async function computeTrending(windowKey) {
  const interval = WINDOWS[windowKey];
  const agg = await rows(
    `SELECT * FROM (
       SELECT v.contentid,
              COUNT(*) FILTER (WHERE v.event = 'view')::int AS views,
              COUNT(*) FILTER (WHERE v.event = 'play')::int AS plays
       FROM viewevents v
       WHERE v.createdat > datetime('now','-' || $1)
       GROUP BY v.contentid
     ) t
     ORDER BY (t.plays * 2 + t.views) DESC, t.contentid ASC
     LIMIT $2`,
    [interval, TRENDING_MAX_ROWS],
  );

  // Fresh database (or no events in the window) → newest content, zeroed metrics.
  if (!agg.length) {
    const fallbackContent = await rows(
      `SELECT * FROM content ORDER BY createdat DESC, id DESC LIMIT 10`,
    );
    return {
      fallback: true,
      data: fallbackContent.map((r) => ({ content: normalizeContentRow(r), views: 0, plays: 0, score: 0 })),
    };
  }

  const contentRows = await rows(
    `SELECT * FROM content WHERE id IN (SELECT value FROM json_each($1))`,
    [JSON.stringify(agg.map((r) => num(r.contentid)))],
  );
  const byId = new Map(contentRows.map((r) => [num(r.id), r]));

  const data = agg
    .map((r) => {
      const content = byId.get(num(r.contentid));
      if (!content) return null; // content deleted between the two queries
      const views = num(r.views);
      const plays = num(r.plays);
      return { content: normalizeContentRow(content), views, plays, score: plays * 2 + views };
    })
    .filter(Boolean);

  return { fallback: false, data };
}

/**
 * Compute the admin overview payload (uncached).
 * viewsByDay covers the last 14 UTC days with zero-fill for missing days.
 */
async function computeOverview() {
  const [totalsRow, byDayRows, topContentRows, planRows, activeRow, signupRows] = await Promise.all([
    one(
      `SELECT
         (SELECT COUNT(*)::int FROM users) AS users,
         (SELECT COUNT(*)::int FROM content) AS content,
         (SELECT COUNT(*)::int FROM comments) AS comments,
         (SELECT COUNT(*) FILTER (WHERE event = 'view')::int FROM viewevents) AS views,
         (SELECT COUNT(*) FILTER (WHERE event = 'play')::int FROM viewevents) AS plays`,
    ),
    rows(
      `SELECT strftime('%Y-%m-%d', createdat) AS date, COUNT(*)::int AS count
       FROM viewevents
       WHERE createdat > datetime('now','-14 days')
       GROUP BY 1
       ORDER BY 1`,
    ),
    rows(
      `SELECT v.contentid, ct.title, ct.type, ct.thumbnail,
              COUNT(*) FILTER (WHERE v.event = 'view')::int AS views,
              COUNT(*) FILTER (WHERE v.event = 'play')::int AS plays
       FROM viewevents v
       JOIN content ct ON ct.id = v.contentid
       GROUP BY v.contentid, ct.title, ct.type, ct.thumbnail
       ORDER BY views DESC, plays DESC, v.contentid ASC
       LIMIT 5`,
    ),
    rows(`SELECT plan, COUNT(*)::int AS count FROM users GROUP BY plan`),
    one(
      `SELECT COUNT(DISTINCT userid)::int AS count
       FROM viewevents
       WHERE userid IS NOT NULL AND createdat > datetime('now','-7 days')`,
    ),
    rows(`SELECT username, createdat FROM users ORDER BY createdat DESC, id DESC LIMIT 5`),
  ]);

  // Zero-fill the last 14 UTC days (inclusive of today).
  const byDay = new Map(byDayRows.map((r) => [r.date, num(r.count)]));
  const viewsByDay = [];
  const now = new Date();
  for (let i = 13; i >= 0; i -= 1) {
    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
    const key = day.toISOString().slice(0, 10);
    viewsByDay.push({ date: key, count: byDay.get(key) ?? 0 });
  }

  const planDistribution = { free: 0, plus: 0, pro: 0 };
  for (const r of planRows) {
    if (Object.prototype.hasOwnProperty.call(planDistribution, r.plan)) {
      planDistribution[r.plan] = num(r.count);
    }
  }

  return {
    totals: {
      users: num(totalsRow?.users),
      content: num(totalsRow?.content),
      comments: num(totalsRow?.comments),
      views: num(totalsRow?.views),
      plays: num(totalsRow?.plays),
    },
    viewsByDay,
    topContent: topContentRows.map((r) => ({
      id: num(r.contentid),
      title: r.title,
      type: r.type,
      thumbnail: r.thumbnail || null,
      views: num(r.views),
      plays: num(r.plays),
    })),
    planDistribution,
    activeUsers7d: num(activeRow?.count),
    recentSignups: signupRows.map((r) => ({ username: r.username, createdat: isoOrNull(r.createdat) })),
  };
}

/* ---------------------------------- router --------------------------------- */

const router = express.Router();

/**
 * POST /views — record a view/play/complete event for a content row.
 * Public endpoint (player telemetry); a valid Bearer token attributes the
 * event to the user via the globally attached req.user.
 */
router.post('/views', viewLimiter, wrap(async (req, res) => {
  const contentId = parseId(req.body?.contentId);
  if (Number.isNaN(contentId)) {
    return res.status(400).json({ error: 'Invalid or missing contentId' });
  }
  const event = String(req.body?.event ?? '');
  if (!VALID_EVENTS.has(event)) {
    return res.status(400).json({ error: "event must be one of 'view', 'play', 'complete'" });
  }

  const content = await getContentById(contentId);
  if (!content) return res.status(404).json({ error: 'Content not found' });

  await rows(
    `INSERT INTO viewevents (contentid, userid, event) VALUES ($1, $2, $3)`,
    [contentId, req.user?.id ?? null, event],
  );

  return res.json({ ok: true });
}));

/**
 * GET /trending?window=24h|7d|30d&limit=10 — most-watched content in the
 * window, scored plays*2 + views. Cached 60s per window (limit-independent
 * payload; the requested limit slices the cached list).
 */
router.get('/trending', wrap(async (req, res) => {
  const windowKey = WINDOWS[req.query.window] ? String(req.query.window) : '7d';
  const limit = clampInt(req.query.limit, 1, TRENDING_MAX_ROWS, 10);

  const cacheKey = `analytics:trending:${windowKey}`;
  let payload = advancedCache.get(cacheKey);
  if (!payload) {
    payload = await computeTrending(windowKey);
    advancedCache.set(cacheKey, payload, { ttlMs: TRENDING_CACHE_TTL_MS, tags: ['analytics', 'content'] });
  }

  return res.json({ data: payload.data.slice(0, limit), fallback: payload.fallback });
}));

/**
 * GET /user/:id?days=14 — personal viewing report (self or admin).
 * totals are all-time; viewsByDay and topTypes cover the last `days` days
 * (clamped 1–90). viewsByDay entries: { date: 'YYYY-MM-DD', count }.
 */
router.get('/user/:id', requireAuth, wrap(async (req, res) => {
  const targetId = parseId(req.params.id);
  if (Number.isNaN(targetId)) return res.status(400).json({ error: 'Invalid user id' });

  if (targetId !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'You can only view your own analytics', code: 'FORBIDDEN' });
  }

  const days = clampInt(req.query.days, 1, 90, 14);

  const [totalsRow, byDayRows, topTypeRows] = await Promise.all([
    one(
      `SELECT COUNT(*) FILTER (WHERE event = 'view')::int AS views,
              COUNT(*) FILTER (WHERE event = 'play')::int AS plays,
              COUNT(*) FILTER (WHERE event = 'complete')::int AS completed
       FROM viewevents WHERE userid = $1`,
      [targetId],
    ),
    rows(
      `SELECT strftime('%Y-%m-%d', createdat) AS date, COUNT(*)::int AS count
       FROM viewevents
       WHERE userid = $1 AND createdat > datetime('now','-' || $2)
       GROUP BY 1
       ORDER BY 1`,
      [targetId, `${days} days`],
    ),
    rows(
      `SELECT ct.type AS type, COUNT(*)::int AS count
       FROM viewevents v
       JOIN content ct ON ct.id = v.contentid
       WHERE v.userid = $1 AND v.createdat > datetime('now','-' || $2)
       GROUP BY ct.type
       ORDER BY count DESC, ct.type ASC
       LIMIT 5`,
      [targetId, `${days} days`],
    ),
  ]);

  return res.json({
    totals: {
      views: num(totalsRow?.views),
      plays: num(totalsRow?.plays),
      completed: num(totalsRow?.completed),
    },
    viewsByDay: byDayRows.map((r) => ({ date: r.date, count: num(r.count) })),
    topTypes: topTypeRows.map((r) => ({ type: r.type, count: num(r.count) })),
  });
}));

/**
 * GET /overview — admin-only platform snapshot (cached 30s):
 * totals, zero-filled 14-day viewsByDay, top 5 content by views, plan
 * distribution, 7-day active viewers, 5 most recent signups.
 */
router.get('/overview', requireAuth, requireAdmin, wrap(async (req, res) => {
  const cached = advancedCache.get('analytics:overview');
  if (cached) return res.json(cached);

  const payload = await computeOverview();
  advancedCache.set('analytics:overview', payload, { ttlMs: OVERVIEW_CACHE_TTL_MS, tags: ['analytics'] });
  return res.json(payload);
}));

export default router;
