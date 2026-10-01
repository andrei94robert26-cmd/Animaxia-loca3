/**
 * domain/social/feed.js — Activity feeds (global + personalized).
 *
 * Routes (mounted SECOND under /api/social, after commentsRouter):
 *   GET /feed/global?cursor=&limit=    → { data: [activity], nextCursor }          (public)
 *   GET /feed/personal?cursor=&limit=  → { data, nextCursor, basedOn }             (requireAuth)
 *
 * Activity shape (frozen contract):
 *   { id, type: 'comment'|'like'|'content'|'user', createdat,
 *     user?: { id, username, avatar },
 *     content?: { id, title, type, thumbnail },
 *     preview?: string,   // comment body / content overview, first 140 chars
 *     value?: 1 }
 *
 * Sources merged (newest first): comments (JOIN users+content), content likes
 * with value = 1 (JOIN users+content), new content rows, new user signups.
 *
 * Cursors (opaque base64url strings):
 *   • global  feed: base64(`${createdatIso}|${type}|${id}`) — keyset pagination.
 *     Items strictly newer than the cursor (by createdat, then id) and the
 *     cursor item itself are skipped; items older-or-equal (including ties on
 *     createdat+id with a different type) are kept, so no activity is lost.
 *   • personal feed: base64(`${offset}`) — offset pagination over the ranked
 *     result set (the ranking is score-based, so a stable index is the cursor).
 *
 * Personal ranking (computed over the ~200 most recent activities):
 *   +3 activity.content.type ∈ user.preferences.types
 *   +2 content genres (metadata.genres) ∩ user.preferences.genres (case-insensitive)
 *   +2 activity.content.id ∈ user's watchlist ∪ history
 *   +1 activity.user.id === caller (own activity)
 *   Sorted by (score DESC, createdat DESC).
 *
 * No HTTP cacheMiddleware — feeds are user-dependent.
 */

import express from 'express';
import { rows, parseJsonb, isoOrNull, num } from '@animaxia/common/sql.js';
import { requireAuth } from '../users/auth.js';

/* --------------------------------- helpers --------------------------------- */

/** Wrap an async handler so rejections reach the Express error middleware. */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const PAGE_SIZE_DEFAULT = 20;
const PAGE_SIZE_MAX = 20;
const GLOBAL_SOURCE_LIMIT = 40;
const PERSONAL_SOURCE_LIMIT = 200;
const PREVIEW_MAX = 140;

/** Encode a cursor payload to a URL-safe base64 string. */
function encodeCursor(payload) {
  return Buffer.from(String(payload), 'utf8').toString('base64url');
}

/**
 * Decode a cursor string back to its payload. Tolerates '+' characters that
 * were mangled to spaces by unencoded query strings. Returns null on garbage.
 */
function decodeCursor(cursor) {
  if (!cursor || typeof cursor !== 'string') return null;
  try {
    const repaired = cursor.replace(/ /g, '+');
    return Buffer.from(repaired, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

/** Clamp an integer into [min, max]. */
function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Generic DESC comparator (strings or numbers). */
const desc = (a, b) => (a < b ? 1 : a > b ? -1 : 0);

/** Truncate a preview string to PREVIEW_MAX characters (contract: first 140). */
function preview(text) {
  return String(text || '').trim().slice(0, PREVIEW_MAX);
}

/**
 * Fetch and normalize recent activities from the four sources.
 * @param {number} sourceLimit - per-source LIMIT (40 for global, 200 for personal).
 * @returns {Promise<Array>} activities sorted by (createdat DESC, id DESC, type DESC);
 *   each item also carries a non-contract `genres` array used for personal scoring.
 */
async function fetchActivities(sourceLimit) {
  const [commentRows, likeRows, contentRows, userRows] = await Promise.all([
    rows(
      `SELECT c.id, c.body, c.createdat,
              u.id AS userid, u.username, u.avatar,
              ct.id AS contentid, ct.title AS contenttitle, ct.type AS contenttype,
              ct.thumbnail AS contentthumbnail, ct.metadata AS contentmetadata
       FROM comments c
       JOIN users u ON u.id = c.userid
       JOIN content ct ON ct.id = c.contentid
       ORDER BY c.createdat DESC, c.id DESC
       LIMIT $1`,
      [sourceLimit],
    ),
    rows(
      `SELECT cl.contentid, cl.createdat,
              u.id AS userid, u.username, u.avatar,
              ct.title AS contenttitle, ct.type AS contenttype,
              ct.thumbnail AS contentthumbnail, ct.metadata AS contentmetadata
       FROM contentlikes cl
       JOIN users u ON u.id = cl.userid
       JOIN content ct ON ct.id = cl.contentid
       WHERE cl.value = 1
       ORDER BY cl.createdat DESC, cl.contentid DESC
       LIMIT $1`,
      [sourceLimit],
    ),
    rows(
      `SELECT id, title, type, thumbnail, metadata, createdat
       FROM content
       ORDER BY createdat DESC, id DESC
       LIMIT $1`,
      [sourceLimit],
    ),
    rows(
      `SELECT id, username, avatar, createdat
       FROM users
       ORDER BY createdat DESC, id DESC
       LIMIT $1`,
      [sourceLimit],
    ),
  ]);

  const items = [];

  for (const r of commentRows) {
    const meta = parseJsonb(r.contentmetadata, {});
    items.push({
      id: num(r.id),
      type: 'comment',
      createdat: isoOrNull(r.createdat),
      user: { id: num(r.userid), username: r.username, avatar: r.avatar || null },
      content: { id: num(r.contentid), title: r.contenttitle, type: r.contenttype, thumbnail: r.contentthumbnail || null },
      genres: Array.isArray(meta.genres) ? meta.genres : [],
      preview: preview(r.body),
    });
  }

  for (const r of likeRows) {
    const meta = parseJsonb(r.contentmetadata, {});
    items.push({
      id: num(r.contentid), // contentlikes has no serial id — the content id keys the activity
      type: 'like',
      createdat: isoOrNull(r.createdat),
      user: { id: num(r.userid), username: r.username, avatar: r.avatar || null },
      content: { id: num(r.contentid), title: r.contenttitle, type: r.contenttype, thumbnail: r.contentthumbnail || null },
      genres: Array.isArray(meta.genres) ? meta.genres : [],
      value: 1,
    });
  }

  for (const r of contentRows) {
    const meta = parseJsonb(r.metadata, {});
    items.push({
      id: num(r.id),
      type: 'content',
      createdat: isoOrNull(r.createdat),
      content: { id: num(r.id), title: r.title, type: r.type, thumbnail: r.thumbnail || null },
      genres: Array.isArray(meta.genres) ? meta.genres : [],
      preview: preview(meta.overview || meta.description || ''),
    });
  }

  for (const r of userRows) {
    items.push({
      id: num(r.id),
      type: 'user',
      createdat: isoOrNull(r.createdat),
      user: { id: num(r.id), username: r.username, avatar: r.avatar || null },
      genres: [],
    });
  }

  items.sort((a, b) => desc(a.createdat, b.createdat) || desc(a.id, b.id) || desc(a.type, b.type));
  return items;
}

/** Project an internal activity onto the frozen contract shape (drops `genres`). */
function serializeActivity(item) {
  const out = { id: item.id, type: item.type, createdat: item.createdat };
  if (item.user) out.user = item.user;
  if (item.content) out.content = item.content;
  if (item.preview !== undefined) out.preview = item.preview; // comment bodies / content overviews (may be '')
  if (item.value !== undefined) out.value = item.value;
  return out;
}

/**
 * Keyset-cursor predicate for the global feed: TRUE when the item was already
 * served (strictly newer than the cursor by createdat+id, or the cursor item
 * itself). Ties on createdat+id with a different type are distinct activities
 * and are kept.
 */
function alreadyServed(item, cursor) {
  if (item.createdat !== cursor.createdat) return item.createdat > cursor.createdat;
  if (item.id !== cursor.id) return item.id > cursor.id;
  return item.type === cursor.type;
}

/** Parse a global-feed cursor payload `createdat|type|id`; null when invalid. */
function parseGlobalCursor(raw) {
  const payload = decodeCursor(raw);
  if (!payload) return null;
  const parts = payload.split('|');
  if (parts.length !== 3) return null;
  const [createdat, type, idStr] = parts;
  const id = Number.parseInt(idStr, 10);
  if (!createdat || Number.isNaN(Date.parse(createdat)) || !Number.isInteger(id)) return null;
  if (!['comment', 'like', 'content', 'user'].includes(type)) return null;
  return { createdat, type, id };
}

/* ---------------------------------- router --------------------------------- */

export const feedRouter = express.Router();

/**
 * GET /feed/global?cursor=&limit= — newest activity across comments, likes,
 * content and users (public, keyset cursor pagination).
 */
feedRouter.get('/feed/global', wrap(async (req, res) => {
  const limit = clampInt(req.query.limit, 1, PAGE_SIZE_MAX, PAGE_SIZE_DEFAULT);

  let cursor = null;
  if (req.query.cursor) {
    cursor = parseGlobalCursor(req.query.cursor);
    if (!cursor) return res.status(400).json({ error: 'Invalid cursor', code: 'CURSOR_INVALID' });
  }

  const items = await fetchActivities(GLOBAL_SOURCE_LIMIT);
  const remaining = cursor ? items.filter((item) => !alreadyServed(item, cursor)) : items;

  const hasMore = remaining.length > limit;
  const page = hasMore ? remaining.slice(0, limit) : remaining;
  const last = page[page.length - 1];
  const nextCursor = hasMore && last
    ? encodeCursor(`${last.createdat}|${last.type}|${last.id}`)
    : null;

  return res.json({ data: page.map(serializeActivity), nextCursor });
}));

/**
 * GET /feed/personal?cursor=&limit= — the ~200 most recent activities ranked
 * by the caller's preferences, watchlist and history (offset cursor).
 * Response adds basedOn: { types, genres, trackedContent }.
 */
feedRouter.get('/feed/personal', requireAuth, wrap(async (req, res) => {
  const limit = clampInt(req.query.limit, 1, PAGE_SIZE_MAX, PAGE_SIZE_DEFAULT);

  let offset = 0;
  if (req.query.cursor) {
    const payload = decodeCursor(req.query.cursor);
    const parsed = payload === null ? NaN : Number.parseInt(payload, 10);
    if (!Number.isInteger(parsed) || parsed < 0) {
      return res.status(400).json({ error: 'Invalid cursor', code: 'CURSOR_INVALID' });
    }
    offset = parsed;
  }

  const prefs = req.user.preferences && typeof req.user.preferences === 'object' ? req.user.preferences : {};
  const rawTypes = Array.isArray(prefs.types) ? prefs.types : [];
  const rawGenres = Array.isArray(prefs.genres) ? prefs.genres : [];
  const prefTypes = new Set(rawTypes.map((t) => String(t).toLowerCase()));
  const prefGenres = new Set(rawGenres.map((g) => String(g).toLowerCase()));

  // Watchlist ∪ history in a single query (content the caller tracks).
  const trackedRows = await rows(
    `SELECT contentid FROM watchlist WHERE userid = $1
     UNION
     SELECT contentid FROM watchhistory WHERE userid = $1`,
    [req.user.id],
  );
  const tracked = new Set(trackedRows.map((r) => num(r.contentid)));

  const items = await fetchActivities(PERSONAL_SOURCE_LIMIT);
  for (const item of items) {
    let score = 0;
    if (item.content) {
      if (prefTypes.has(String(item.content.type).toLowerCase())) score += 3;
      if (item.genres.some((g) => prefGenres.has(String(g).toLowerCase()))) score += 2;
      if (tracked.has(item.content.id)) score += 2;
    }
    if (item.user && item.user.id === req.user.id) score += 1;
    item.score = score;
  }
  items.sort((a, b) => (b.score - a.score) || desc(a.createdat, b.createdat) || desc(a.id, b.id));

  const hasMore = offset + limit < items.length;
  const page = items.slice(offset, offset + limit);
  const nextCursor = hasMore ? encodeCursor(String(offset + limit)) : null;

  return res.json({
    data: page.map(serializeActivity),
    nextCursor,
    basedOn: {
      types: [...rawTypes],
      genres: [...rawGenres],
      trackedContent: tracked.size,
    },
  });
}));

export default feedRouter;
