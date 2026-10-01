/**
 * common/events.js — Per-service platform event bus (ported from the monolith
 * modules/platform/events.js). Each microservice process gets its own bus;
 * cross-service reactions (e.g. content:changed → search reindex) are handled
 * by the queue-service jobs in the cloud topology.
 *
 * Emitted events:
 *   content:changed  { ids?: number[] }    — after any content upsert/delete/seed
 *   comment:added    { contentid, userid } — after a comment/reply is created
 *   plan:changed     { userid, plan }      — after a subscription change
 *   user:changed     { userid }            — after profile/preference updates
 */

import { EventEmitter } from 'node:events';

export const PLATFORM_EVENTS = [
  'content:changed',
  'comment:added',
  'plan:changed',
  'user:changed',
];

export const events = new EventEmitter();
events.setMaxListeners(100);

/** Emit a platform event (never throws — logging only on listener errors). */
export function emitPlatform(event, payload = {}) {
  if (!PLATFORM_EVENTS.includes(event)) return;
  try {
    events.emit(event, payload);
  } catch (err) {
    // A misbehaving listener must never break the request path.
    console.error(`[events] listener error on "${event}": ${err.message}`);
  }
}

export default events;
