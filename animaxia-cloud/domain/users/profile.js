/**
 * domain/users/profile.js — Authenticated user profile: profile edits, avatar
 * uploads, watchlist, watch history and content preferences.
 *
 * Mount: app.use('/api/users', requireAuth, profileRouter) — authentication is
 * enforced at MOUNT level, so every route below assumes req.user is a fresh
 * publicUser() snapshot (requireAuth re-reads the row on each request; the
 * plan field is therefore always current).
 *
 * Routes:
 *   GET    /me                      → { user, stats: { watchlist, history, comments } }
 *   PATCH  /me                      { username?, avatar?, preferences? } → { user }
 *   POST   /me/avatar               { image: dataURL ≤512KB } → { user }
 *   GET    /me/watchlist            → { data: [{ content, addedat }] }
 *   POST   /me/watchlist            { contentId } → { ok, added }     (plan-limited)
 *   DELETE /me/watchlist/:contentId → { ok, removed }
 *   GET    /me/history?limit=       → { data: [{ content, watchedat, progress }] }
 *   POST   /me/history              { contentId, progress } → { ok }  (rolling window)
 *   GET    /me/preferences          → { preferences }
 *   PUT    /me/preferences          { types?, genres?, franchises? } → { preferences }
 *
 * Plan limits come from ../premium/plans.js (free 20/50, plus 200/500, pro -1
 * = unlimited). Profile/preferences mutations emit 'user:changed' on the
 * platform event bus (advanced-cache invalidation, feed personalization).
 */

import express from 'express';
import { rows, one, jsonb, parseJsonb, isoOrNull, num } from '@animaxia/common/sql.js';
import { publicUser } from './auth.js';
import { planLimits } from '../premium/plans.js';
import { emitPlatform } from '@animaxia/common/events.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* -------------------------------- validation --------------------------------- */

const USERNAME_RE = /^[a-zA-Z0-9._-]{3,24}$/;
const PREF_KEYS = ['types', 'genres', 'franchises'];
const PREF_MAX_ITEMS = 20; // per preferences array

const MAX_AVATAR_BYTES = 512 * 1024; // 512KB decoded base64 payload
const ALLOWED_AVATAR_MIME = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'];
const AVATAR_DATA_URL_RE = /^data:(image\/(?:png|jpeg|gif|webp|svg\+xml));base64,([A-Za-z0-9+/=]+)$/;

/** Validate an avatar data-URL. Returns an error string, or null when valid. */
function validateAvatarDataUrl(image) {
  const match = AVATAR_DATA_URL_RE.exec(String(image || '').trim());
  if (!match) {
    return 'image must be a base64 data-URL: data:image/png|jpeg|gif|webp|svg+xml;base64,…';
  }
  const [, mime, base64] = match;
  if (!ALLOWED_AVATAR_MIME.includes(mime)) {
    return `Unsupported image type "${mime}" — allowed: ${ALLOWED_AVATAR_MIME.join(', ')}`;
  }
  const bytes = Buffer.from(base64, 'base64').length;
  if (bytes > MAX_AVATAR_BYTES) {
    return `Image too large — decoded payload is ~${Math.round(bytes / 1024)}KB, limit is 512KB`;
  }
  return null;
}

/**
 * Sanitize a preferences payload (partial or full). Every known key that is
 * present must be an array of strings; entries are trimmed, blank entries
 * dropped and each list capped at 20 items. Unknown keys are ignored.
 * @returns {{ error?: string, value?: Record<string, string[]> }}
 */
function sanitizePreferences(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { error: 'preferences must be an object' };
  }
  const out = {};
  for (const key of PREF_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
    const raw = input[key];
    if (!Array.isArray(raw)) {
      return { error: `preferences.${key} must be an array of strings` };
    }
    out[key] = raw.map((v) => String(v).trim()).filter(Boolean).slice(0, PREF_MAX_ITEMS);
  }
  return { value: out };
}

/** Normalize a raw content row (e.g. from a JOIN) into the public content shape. */
function contentRow(row) {
  if (!row) return null;
  return {
    id: num(row.id),
    externalid: row.externalid ?? null,
    type: row.type ?? null,
    title: row.title ?? null,
    metadata: parseJsonb(row.metadata, {}),
    thumbnail: row.thumbnail ?? null,
    createdat: isoOrNull(row.createdat),
  };
}

/* ---------------------------------- router ---------------------------------- */

const router = express.Router();

/* --------------------------------- profile ---------------------------------- */

/** GET /me — profile snapshot + activity counters. */
router.get('/me', wrap(async (req, res) => {
  const stats = await one(
    `SELECT
       (SELECT COUNT(*)::int FROM watchlist WHERE userid = $1) AS watchlist,
       (SELECT COUNT(*)::int FROM watchhistory WHERE userid = $1) AS history,
       (SELECT COUNT(*)::int FROM comments WHERE userid = $1) AS comments`,
    [req.user.id],
  );
  res.json({
    user: req.user,
    stats: { watchlist: num(stats?.watchlist), history: num(stats?.history), comments: num(stats?.comments) },
  });
}));

/** PATCH /me — partial profile update (username / avatar / preferences merge). */
router.patch('/me', wrap(async (req, res) => {
  const body = req.body || {};
  const sets = [];
  const params = [];

  if (Object.prototype.hasOwnProperty.call(body, 'username')) {
    if (typeof body.username !== 'string' || !USERNAME_RE.test(body.username)) {
      return res.status(400).json({ error: 'Username must be 3-24 characters (letters, numbers, . _ -)' });
    }
    params.push(body.username);
    sets.push(`username = $${params.length}`);
  }

  if (Object.prototype.hasOwnProperty.call(body, 'avatar')) {
    const avatar = body.avatar;
    if (avatar === null || avatar === '') {
      params.push(null);
      sets.push(`avatar = $${params.length}`);
    } else if (typeof avatar === 'string') {
      const trimmed = avatar.trim();
      if (trimmed.startsWith('data:')) {
        const problem = validateAvatarDataUrl(trimmed);
        if (problem) return res.status(400).json({ error: problem });
        params.push(trimmed);
      } else if (/^https?:\/\//.test(trimmed) && trimmed.length <= 2048) {
        params.push(trimmed); // external image URL
      } else {
        return res.status(400).json({ error: 'avatar must be a data:image/… URL, an http(s) image URL, or null' });
      }
      sets.push(`avatar = $${params.length}`);
    } else {
      return res.status(400).json({ error: 'avatar must be a string or null' });
    }
  }

  if (body.preferences !== undefined && body.preferences !== null) {
    const sanitized = sanitizePreferences(body.preferences);
    if (sanitized.error) return res.status(400).json({ error: sanitized.error });
    // Partial merge into the existing JSONB preferences.
    const current = req.user.preferences && typeof req.user.preferences === 'object' ? req.user.preferences : {};
    params.push(jsonb({ ...current, ...sanitized.value }));
    sets.push(`preferences = $${params.length}::jsonb`);
  }

  if (!sets.length) {
    return res.json({ user: req.user }); // nothing to update — idempotent no-op
  }

  params.push(req.user.id);
  const updated = await one(`UPDATE users SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
  emitPlatform('user:changed', { userid: req.user.id });
  return res.json({ user: publicUser(updated) });
}));

/** POST /me/avatar — set the avatar from a base64 data-URL (payload ≤512KB). */
router.post('/me/avatar', wrap(async (req, res) => {
  const { image } = req.body || {};
  if (!image || typeof image !== 'string') {
    return res.status(400).json({ error: 'Missing image (data-URL string expected)' });
  }
  const problem = validateAvatarDataUrl(image);
  if (problem) return res.status(400).json({ error: problem });

  const updated = await one(
    `UPDATE users SET avatar = $2 WHERE id = $1 RETURNING *`,
    [req.user.id, image.trim()],
  );
  emitPlatform('user:changed', { userid: req.user.id });
  return res.json({ user: publicUser(updated) });
}));

/* -------------------------------- watchlist ---------------------------------- */

/** GET /me/watchlist — the user's saved titles, newest first. */
router.get('/me/watchlist', wrap(async (req, res) => {
  const data = await rows(
    `SELECT c.id, c.externalid, c.type, c.title, c.metadata, c.thumbnail, c.createdat,
            w.createdat AS addedat
     FROM watchlist w
     JOIN content c ON c.id = w.contentid
     WHERE w.userid = $1
     ORDER BY w.createdat DESC, w.id DESC`,
    [req.user.id],
  );
  res.json({ data: data.map((r) => ({ content: contentRow(r), addedat: isoOrNull(r.addedat) })) });
}));

/** POST /me/watchlist — save a title (plan-limited; idempotent re-adds). */
router.post('/me/watchlist', wrap(async (req, res) => {
  const contentId = Number(req.body?.contentId);
  if (!Number.isInteger(contentId) || contentId <= 0) {
    return res.status(400).json({ error: 'Invalid content id' });
  }

  const content = await one(`SELECT id, title FROM content WHERE id = $1`, [contentId]);
  if (!content) return res.status(404).json({ error: 'Content not found' });

  // Already saved → idempotent success (re-saving never trips the plan limit).
  const existing = await one(
    `SELECT id FROM watchlist WHERE userid = $1 AND contentid = $2`,
    [req.user.id, contentId],
  );
  if (existing) return res.json({ ok: true, added: false });

  const limit = planLimits(req.user.plan).watchlist; // -1 = unlimited
  if (limit >= 0) {
    const countRow = await one(`SELECT COUNT(*)::int AS count FROM watchlist WHERE userid = $1`, [req.user.id]);
    if (num(countRow?.count) >= limit) {
      return res.status(402).json({
        error: 'Plan limit reached — upgrade to add more',
        upgrade: true,
        plan: req.user.plan,
        limit,
      });
    }
  }

  // ON CONFLICT DO NOTHING keeps concurrent adds race-safe.
  const inserted = await one(
    `INSERT INTO watchlist (userid, contentid) VALUES ($1, $2)
     ON CONFLICT (userid, contentid) DO NOTHING RETURNING id`,
    [req.user.id, contentId],
  );
  return res.json({ ok: true, added: Boolean(inserted) });
}));

/** DELETE /me/watchlist/:contentId — remove a saved title. */
router.delete('/me/watchlist/:contentId', wrap(async (req, res) => {
  const contentId = Number(req.params.contentId);
  if (!Number.isInteger(contentId) || contentId <= 0) {
    return res.status(400).json({ error: 'Invalid content id' });
  }
  const removed = await one(
    `DELETE FROM watchlist WHERE userid = $1 AND contentid = $2 RETURNING id`,
    [req.user.id, contentId],
  );
  return res.json({ ok: true, removed: Boolean(removed) });
}));

/* --------------------------------- history ----------------------------------- */

/** GET /me/history — watch history, most recently watched first. */
router.get('/me/history', wrap(async (req, res) => {
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const data = await rows(
    `SELECT c.id, c.externalid, c.type, c.title, c.metadata, c.thumbnail, c.createdat,
            h.watchedat, h.progress
     FROM watchhistory h
     JOIN content c ON c.id = h.contentid
     WHERE h.userid = $1
     ORDER BY h.watchedat DESC, h.id DESC
     LIMIT $2`,
    [req.user.id, limit],
  );
  res.json({
    data: data.map((r) => ({
      content: contentRow(r),
      watchedat: isoOrNull(r.watchedat),
      progress: num(r.progress),
    })),
  });
}));

/**
 * POST /me/history — upsert watch progress for a title.
 *
 * Rolling-window semantics (the enterprise pattern for capped history): when
 * an upsert pushes the user past their plan's history limit, the OLDEST
 * entries beyond the limit are silently evicted instead of rejecting the
 * write — a media platform must never refuse to record playback progress.
 * The watchlist, by contrast, is an explicit user action and correctly
 * rejects with 402 (see POST /me/watchlist above).
 */
router.post('/me/history', wrap(async (req, res) => {
  const contentId = Number(req.body?.contentId);
  const rawProgress = req.body?.progress;
  const progress = rawProgress === undefined || rawProgress === null ? 0 : Number(rawProgress);
  if (!Number.isInteger(contentId) || contentId <= 0) {
    return res.status(400).json({ error: 'Invalid content id' });
  }
  if (!Number.isInteger(progress) || progress < 0) {
    return res.status(400).json({ error: 'progress must be a non-negative integer (seconds)' });
  }

  const content = await one(`SELECT id FROM content WHERE id = $1`, [contentId]);
  if (!content) return res.status(404).json({ error: 'Content not found' });

  await one(
    `INSERT INTO watchhistory (userid, contentid, progress, watchedat)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (userid, contentid)
     DO UPDATE SET progress = EXCLUDED.progress, watchedat = NOW()`,
    [req.user.id, contentId, progress],
  );

  // Evict the oldest entries beyond the plan limit (-1 = unlimited → skip).
  const limit = planLimits(req.user.plan).history;
  if (limit >= 0) {
    await rows(
      `DELETE FROM watchhistory
       WHERE userid = $1 AND id NOT IN (
         SELECT id FROM watchhistory WHERE userid = $1
         ORDER BY watchedat DESC, id DESC
         LIMIT $2
       )`,
      [req.user.id, limit],
    );
  }

  return res.json({ ok: true });
}));

/* ------------------------------- preferences --------------------------------- */

/** GET /me/preferences — the user's content preferences. */
router.get('/me/preferences', (req, res) => {
  const preferences =
    req.user.preferences && typeof req.user.preferences === 'object' ? req.user.preferences : {};
  res.json({ preferences });
});

/** PUT /me/preferences — full replace with sanitized arrays (PUT semantics). */
router.put('/me/preferences', wrap(async (req, res) => {
  const sanitized = sanitizePreferences(req.body || {});
  if (sanitized.error) return res.status(400).json({ error: sanitized.error });

  // Full replace: only the provided (sanitized) keys remain in the object.
  const updated = await one(
    `UPDATE users SET preferences = $2::jsonb WHERE id = $1 RETURNING *`,
    [req.user.id, jsonb(sanitized.value)],
  );
  emitPlatform('user:changed', { userid: req.user.id });
  return res.json({ preferences: parseJsonb(updated?.preferences, sanitized.value) });
}));

export default router;
