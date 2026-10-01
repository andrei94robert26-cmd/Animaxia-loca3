/**
 * modules/social/activity.js — FAZA 10: social activity events + feed v2.
 *
 * The activityevents table is the single source for the FAZA-10 social feed.
 * Events are written by:
 *   • this module — comment:added platform-bus subscription (Phase-2
 *     comments.js stays byte-identical; the bus decouples us);
 *   • follows.js / reviews.js / watchparty.js — via insertActivityEvent().
 *
 * Every insert also fire-and-forget POSTs the serialized event to the
 * animaxia-realtime service (:4010 /internal/activity) so connected clients
 * get a live ticker. The webhook is best-effort: silent failure when the
 * realtime service is down (feed v2 still works via REST polling).
 *
 * Routes (mounted under /api/social AFTER the Phase-2 routers — no path
 * collisions: Phase-2 owns /content/:id/comments, /comments/:id/*,
 * /content/:id/like|likes, /feed/global, /feed/personal):
 *   GET /feed/v2        → { data: [activity], nextCursor }   (requireAuth — following + own)
 *   GET /feed/v2/public → { data: [activity], nextCursor }   (public — whole platform)
 *
 * Activity shape (extends the frozen Phase-2 shape with metadata):
 *   { id, type: 'comment'|'review'|'follow'|'party:create'|'party:join'|'party:ended',
 *     createdat, user: {id, username, avatar}, content: {id, title, type, thumbnail}|null,
 *     preview: string|null, metadata: object }
 *
 * Cursor: opaque base64url `${createdatIso}|${id}` — keyset pagination over
 * (createdat DESC, id DESC), same approach as Phase-2 feed.js.
 */

import express from 'express';
import { rows, one, jsonb, parseJsonb, isoOrNull, num } from '../platform/sql.js';
import { assertPostgres } from '../platform/sql.js';
import { requireAuth, attachUser } from '../users/auth.js';
import { events } from '../platform/events.js';
import { logger } from '../../utils/logger.js';
import { insertActivityEvent } from './activity-events.js';

/* --------------------------------- helpers --------------------------------- */

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const PAGE_SIZE_DEFAULT = 20;
const PAGE_SIZE_MAX = 30;
const PREVIEW_MAX = 140;
const FOLLOWING_CAP = 500;

/** Where the realtime service listens (internal webhook). */
const REALTIME_URL = (process.env.REALTIMEURL || process.env.REALTIME_URL || 'http://127.0.0.1:4010').replace(/\/$/, '');

function encodeCursor(createdat, id) {
  return Buffer.from(`${isoOrNull(createdat)}|${num(id)}`, 'utf8').toString('base64url');
}

function decodeCursor(raw) {
  if (!raw) return null;
  try {
    const [ts, id] = Buffer.from(String(raw), 'base64url').toString('utf8').split('|');
    const parsedId = Number.parseInt(id, 10);
    if (!ts || !Number.isInteger(parsedId)) return null;
    return { ts, id: parsedId };
  } catch {
    return null;
  }
}

/** Shape one activityevents row into the public activity contract. */
function shapeActivity(row) {
  return {
    id: num(row.id),
    type: row.type,
    createdat: isoOrNull(row.createdat),
    user: row.actorid != null
      ? { id: num(row.actorid), username: row.actorname || null, avatar: row.actoravatar || null }
      : null,
    content: row.contentid != null
      ? {
          id: num(row.contentid),
          title: row.contenttitle || null,
          type: row.contenttype || null,
          thumbnail: row.contentthumbnail || null,
        }
      : null,
    preview: (row.metadata && (row.metadata.preview || row.metadata.body))?.slice?.(0, PREVIEW_MAX) || null,
    metadata: parseJsonb(row.metadata, {}),
  };
}

/* --------------------------- platform-bus wiring --------------------------- */

let wired = false;

/**
 * Subscribe to Phase-2 platform events and mirror them into activityevents.
 * Called once from server.js boot. The comment:added payload is
 * { contentid, userid } — the latest comment body is fetched for the preview
 * (tiny race with concurrent posts is acceptable for a preview field).
 */
export function initSocialActivity() {
  if (wired) return;
  wired = true;
  events.on('comment:added', async ({ contentid, userid } = {}) => {
    try {
      const actorid = num(userid);
      const cid = num(contentid);
      if (!actorid || !cid) return;
      const latest = await one(
        `SELECT id, body FROM comments WHERE userid = $1 AND contentid = $2 ORDER BY id DESC LIMIT 1`,
        [actorid, cid],
      );
      await insertActivityEvent({
        actorid,
        type: 'comment',
        contentid: cid,
        metadata: latest
          ? { commentid: num(latest.id), preview: String(latest.body || '').slice(0, PREVIEW_MAX) }
          : {},
      });
    } catch (err) {
      logger.warn(`[social] comment:added mirror failed: ${err.message}`);
    }
  });
  logger.info('[social] activity bus wired (comment:added → activityevents + realtime webhook)');
}

/* --------------------------------- router ---------------------------------- */

export const socialActivityRouter = express.Router();

/** GET /feed/v2 — activity from people I follow + my own, newest first. */
socialActivityRouter.get(
  '/feed/v2',
  requireAuth,
  wrap(async (req, res) => {
    assertPostgres();
    const me = num(req.user.id);
    const limit = Math.min(Math.max(num(req.query.limit, PAGE_SIZE_DEFAULT), 1), PAGE_SIZE_MAX);
    const cursor = decodeCursor(req.query.cursor);

    const followingRows = await rows(
      `SELECT followeeid FROM follows WHERE followerid = $1 ORDER BY id DESC LIMIT ${FOLLOWING_CAP}`,
      [me],
    );
    const actorIds = [me, ...followingRows.map((r) => num(r.followeeid))].filter((id) => id > 0);

    const params = [JSON.stringify(actorIds)];
    let where = 'ae.actorid IN (SELECT value FROM json_each($1))';
    if (cursor) {
      params.push(cursor.ts, cursor.id);
      where += ' AND (ae.createdat, ae.id) < ($2, $3::int)';
    }
    params.push(limit + 1);

    const data = await rows(
      `SELECT ae.id, ae.type, ae.createdat, ae.contentid, ae.metadata,
              u.id AS actorid, u.username AS actorname, u.avatar AS actoravatar,
              c.title AS contenttitle, c.type AS contenttype, c.thumbnail AS contentthumbnail
       FROM activityevents ae
       JOIN users u ON u.id = ae.actorid
       LEFT JOIN content c ON c.id = ae.contentid
       WHERE ${where}
       ORDER BY ae.createdat DESC, ae.id DESC
       LIMIT $${params.length}`,
      params,
    );

    const hasMore = data.length > limit;
    const page = hasMore ? data.slice(0, limit) : data;
    res.json({
      data: page.map(shapeActivity),
      nextCursor: hasMore && page.length ? encodeCursor(page[page.length - 1].createdat, page[page.length - 1].id) : null,
    });
  }),
);

/** GET /feed/v2/public — whole-platform activity (logged-out friendly). */
socialActivityRouter.get(
  '/feed/v2/public',
  attachUser,
  wrap(async (req, res) => {
    assertPostgres();
    const limit = Math.min(Math.max(num(req.query.limit, PAGE_SIZE_DEFAULT), 1), PAGE_SIZE_MAX);
    const cursor = decodeCursor(req.query.cursor);

    const params = [];
    let where = 'TRUE';
    if (cursor) {
      params.push(cursor.ts, cursor.id);
      where = '(ae.createdat, ae.id) < ($1::timestamptz, $2::int)';
    }
    params.push(limit + 1);

    const data = await rows(
      `SELECT ae.id, ae.type, ae.createdat, ae.contentid, ae.metadata,
              u.id AS actorid, u.username AS actorname, u.avatar AS actoravatar,
              c.title AS contenttitle, c.type AS contenttype, c.thumbnail AS contentthumbnail
       FROM activityevents ae
       JOIN users u ON u.id = ae.actorid
       LEFT JOIN content c ON c.id = ae.contentid
       WHERE ${where}
       ORDER BY ae.createdat DESC, ae.id DESC
       LIMIT $${params.length}`,
      params,
    );

    const hasMore = data.length > limit;
    const page = hasMore ? data.slice(0, limit) : data;
    res.json({
      data: page.map(shapeActivity),
      nextCursor: hasMore && page.length ? encodeCursor(page[page.length - 1].createdat, page[page.length - 1].id) : null,
    });
  }),
);
