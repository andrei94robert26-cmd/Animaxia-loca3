/**
 * modules/social/activity-events.js — FAZA 10 shared helper: write one
 * activityevents row + best-effort webhook to the realtime service.
 *
 * Used by activity.js (comment:added bus mirror) and directly by
 * follows.js / reviews.js / watchparty.js after their writes. Kept in its own
 * file so routers can import it without circular dependencies.
 *
 * The webhook POSTs to ${REALTIMEURL}/internal/activity (default
 * http://127.0.0.1:4010) with the serialized activity event; failures are
 * swallowed after 1.5s — the REST feed (GET /api/social/feed/v2) stays the
 * source of truth, the webhook only powers the live ticker.
 */

import { rows, one, jsonb, num, isoOrNull } from '../platform/sql.js';
import { logger } from '../../utils/logger.js';

export const ACTIVITY_TYPES = ['comment', 'review', 'follow', 'party:create', 'party:join', 'party:ended'];

const REALTIME_URL = (process.env.REALTIMEURL || process.env.REALTIME_URL || 'http://127.0.0.1:4010').replace(/\/$/, '');

/** Fire-and-forget notify of the realtime service. Never throws. */
async function notifyRealtime(event) {
  try {
    const headers = { 'Content-Type': 'application/json' };
    const token = process.env.REALTIMETOKEN || process.env.REALTIME_TOKEN;
    if (token) headers['X-Internal-Token'] = token;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    await fetch(`${REALTIME_URL}/internal/activity`, {
      method: 'POST',
      headers,
      body: JSON.stringify(event),
      signal: controller.signal,
    });
    clearTimeout(timer);
  } catch {
    // Realtime service down or restarting — REST feed unaffected.
  }
}

/**
 * Insert one activity event (with actor + content join for the realtime
 * payload) and notify the realtime service. Returns the shaped event.
 * @param {{actorid:number, type:string, contentid?:number|null, targetuserid?:number|null, metadata?:object}} input
 */
export async function insertActivityEvent({ actorid, type, contentid = null, targetuserid = null, metadata = {} }) {
  const aid = num(actorid);
  if (!aid || !ACTIVITY_TYPES.includes(type)) return null;

  const inserted = await one(
    `INSERT INTO activityevents (actorid, type, contentid, targetuserid, metadata)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, createdat`,
    [aid, type, contentid ? num(contentid) : null, targetuserid ? num(targetuserid) : null, jsonb(metadata)],
  );
  if (!inserted) return null;

  const actor = await one(
    `SELECT id, username, avatar FROM users WHERE id = $1`,
    [aid],
  );
  let content = null;
  if (contentid) {
    const c = await one(
      `SELECT id, title, type, thumbnail FROM content WHERE id = $1`,
      [num(contentid)],
    );
    if (c) content = { id: num(c.id), title: c.title, type: c.type, thumbnail: c.thumbnail };
  }

  const event = {
    id: num(inserted.id),
    type,
    createdat: isoOrNull(inserted.createdat),
    user: actor
      ? { id: num(actor.id), username: actor.username, avatar: actor.avatar || null }
      : null,
    content,
    preview: metadata.preview || null,
    metadata,
  };

  void notifyRealtime(event);
  return event;
}
