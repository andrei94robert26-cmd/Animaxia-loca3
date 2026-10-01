/**
 * services/social-service/health.js — Readiness checks for GET /health
 * (mounted by createService): PostgreSQL ping + live social counters,
 * proving both connectivity AND that the platform schema (comments /
 * contentlikes) is queryable. The module also records the freshest
 * main-process feed-snapshot info (server.js refresh loop) so /health can
 * surface `snapshot.computedAt` as a non-breaking extra check.
 *
 * Returns { db: boolean, comments: number, contentLikes: number,
 *           snapshot: { computedAt, activities } } — the health router marks
 * the service "degraded" (HTTP still 200, liveness semantics) when any value
 * is false/null/undefined. A missing snapshot (before the first refresh, or
 * after a comment:added invalidation) is reported as such via snapshotFresh:
 * false WITHOUT failing readiness — the domain feed routes compute
 * per-request and never depend on the snapshot.
 */

import { ping } from '@animaxia/common/db.js';
import { one, num } from '@animaxia/common/sql.js';

/** Latest snapshot info, updated by server.js's refresh loop. */
let lastSnapshot = null;

/** Record the freshest snapshot result (called from server.js). */
export function noteSnapshot(info) {
  lastSnapshot = info || null;
}

export async function readiness() {
  const db = await ping();
  let comments = null;
  let contentLikes = null;
  if (db) {
    try {
      const [commentRow, likeRow] = await Promise.all([
        one(`SELECT COUNT(*)::int AS count FROM comments`),
        one(`SELECT COUNT(*)::int AS count FROM contentlikes`),
      ]);
      comments = num(commentRow?.count);
      contentLikes = num(likeRow?.count);
    } catch {
      comments = null; // schema not applied yet → readiness fails, liveness stays 200
      contentLikes = null;
    }
  }
  const snapshotAgeMs = lastSnapshot?.computedAt ? Date.now() - Date.parse(lastSnapshot.computedAt) : null;
  return {
    db,
    comments,
    contentLikes,
    snapshot: {
      computedAt: lastSnapshot?.computedAt || null,
      activities: lastSnapshot?.activities ?? null,
      snapshotFresh: Boolean(lastSnapshot), // false until the first refresh — NOT a readiness failure
      ...(snapshotAgeMs !== null && Number.isFinite(snapshotAgeMs) ? { snapshotAgeMs } : {}),
    },
  };
}

export default readiness;
