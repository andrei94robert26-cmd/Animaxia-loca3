/**
 * services/social-service/server.js — Animaxia Cloud social-service (:4007).
 *
 * Owns the community plane (BLUEPRINT §3):
 *   • /api/social — commentsRouter (threaded comments, comment votes, content
 *     likes) + feedRouter (global + personalized activity feeds) mounted
 *     together exactly like the monolith:
 *     app.use('/api/social', commentsRouter, feedRouter).
 *
 * Feed snapshot maintenance — DUAL approach (deliberate, see README):
 *   • Worker thread (./worker.thread.js, every 5 min) runs DB-light COUNT
 *     checks over the four activity sources and posts the stats. It CANNOT
 *     warm any main-process cache: a worker isolate has separate module
 *     state, so an advancedCache.set() in the thread would be invisible to
 *     the request handlers. Its value is the health/metrics signal.
 *   • MAIN process (this file): every 5 min we recompute the global-feed
 *     snapshot — a faithful replication of the heaviest query in
 *     domain/social/feed.js (fetchActivities(), which is module-private) —
 *     and store it via advancedCache.set('feed:global:snapshot', …) with
 *     tags ['social', 'feed']. The snapshot is invalidated automatically on
 *     every 'comment:added' event (advancedCache subscribes to the platform
 *     bus, and comments are created in THIS process) and re-warmed by the
 *     next interval tick. Honest scope note: the domain feed routes compute
 *     per-request (user-dependent myVote/personalization) and do not read
 *     this snapshot — it keeps the query hot in the PG buffers, provides a
 *     precomputed global page for diagnostics/future use, and is exposed in
 *     /health (snapshot.computedAt).
 */

import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { createService } from '@animaxia/common/service.js';
import { ensurePlatformSchema } from '@animaxia/common/migrations.js';
import { rows, parseJsonb, isoOrNull, num } from '@animaxia/common/sql.js';
import { advancedCache } from '@animaxia/domain/cache/advancedCache.js';
import { logger } from '@animaxia/common/logger.js';
import { socialRouter } from './router.js';
import { serviceRateLimit } from './rateLimit.js';
import { readiness, noteSnapshot } from './health.js';

/* NOTE: common/worker.js resolves a RELATIVE `file` against common/ itself, so
   services must pass an ABSOLUTE worker path (computed from this module). This
   works identically in dev (repo root) and in the Docker image (/app). */
const workerFile = fileURLToPath(new URL('./worker.thread.js', import.meta.url));
const WORKER_INTERVAL_MS = 300000; // 5 minutes — worker counts + snapshot refresh

/* ------------------------- global-feed snapshot refresh ----------------------- */

const SNAPSHOT_KEY = 'feed:global:snapshot';
const GLOBAL_SOURCE_LIMIT = 40; // identical to domain/social/feed.js
const PREVIEW_MAX = 140;
const desc = (a, b) => (a < b ? 1 : a > b ? -1 : 0);
const preview = (text) => String(text || '').trim().slice(0, PREVIEW_MAX);

/**
 * Replication of domain/social/feed.js fetchActivities(GLOBAL_SOURCE_LIMIT) +
 * serializeActivity() — the four source queries, normalized and sorted
 * newest-first. Kept in sync with the domain module by review; it exists here
 * only because fetchActivities is not exported (frozen domain surface).
 */
async function computeGlobalFeedSnapshot() {
  const [commentRows, likeRows, contentRows, userRows] = await Promise.all([
    rows(
      `SELECT c.id, c.body, c.createdat,
              u.id AS userid, u.username, u.avatar,
              ct.id AS contentid, ct.title AS contenttitle, ct.type AS contenttype,
              ct.thumbnail AS contentthumbnail
       FROM comments c
       JOIN users u ON u.id = c.userid
       JOIN content ct ON ct.id = c.contentid
       ORDER BY c.createdat DESC, c.id DESC
       LIMIT $1`,
      [GLOBAL_SOURCE_LIMIT],
    ),
    rows(
      `SELECT cl.contentid, cl.createdat,
              u.id AS userid, u.username, u.avatar,
              ct.title AS contenttitle, ct.type AS contenttype,
              ct.thumbnail AS contentthumbnail
       FROM contentlikes cl
       JOIN users u ON u.id = cl.userid
       JOIN content ct ON ct.id = cl.contentid
       WHERE cl.value = 1
       ORDER BY cl.createdat DESC, cl.contentid DESC
       LIMIT $1`,
      [GLOBAL_SOURCE_LIMIT],
    ),
    rows(
      `SELECT id, title, type, thumbnail, metadata, createdat
       FROM content
       ORDER BY createdat DESC, id DESC
       LIMIT $1`,
      [GLOBAL_SOURCE_LIMIT],
    ),
    rows(
      `SELECT id, username, avatar, createdat
       FROM users
       ORDER BY createdat DESC, id DESC
       LIMIT $1`,
      [GLOBAL_SOURCE_LIMIT],
    ),
  ]);

  const items = [];
  for (const r of commentRows) {
    items.push({
      id: num(r.id),
      type: 'comment',
      createdat: isoOrNull(r.createdat),
      user: { id: num(r.userid), username: r.username, avatar: r.avatar || null },
      content: { id: num(r.contentid), title: r.contenttitle, type: r.contenttype, thumbnail: r.contentthumbnail || null },
      preview: preview(r.body),
    });
  }
  for (const r of likeRows) {
    items.push({
      id: num(r.contentid), // contentlikes has no serial id — content id keys the activity
      type: 'like',
      createdat: isoOrNull(r.createdat),
      user: { id: num(r.userid), username: r.username, avatar: r.avatar || null },
      content: { id: num(r.contentid), title: r.contenttitle, type: r.contenttype, thumbnail: r.contentthumbnail || null },
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
      preview: preview(meta.overview || meta.description || ''),
    });
  }
  for (const r of userRows) {
    items.push({
      id: num(r.id),
      type: 'user',
      createdat: isoOrNull(r.createdat),
      user: { id: num(r.id), username: r.username, avatar: r.avatar || null },
    });
  }
  items.sort((a, b) => desc(a.createdat, b.createdat) || desc(a.id, b.id) || desc(a.type, b.type));

  return {
    data: items,
    sourceCounts: {
      comments: commentRows.length,
      likes: likeRows.length,
      content: contentRows.length,
      users: userRows.length,
    },
  };
}

/** One snapshot refresh: compute + store in the main-process advancedCache. */
async function refreshFeedSnapshot() {
  const startedAt = Date.now();
  const { data, sourceCounts } = await computeGlobalFeedSnapshot();
  const computedAt = new Date().toISOString();
  advancedCache.set(
    SNAPSHOT_KEY,
    { key: SNAPSHOT_KEY, computedAt, sourceCounts, activities: data.length, data },
    { ttlMs: WORKER_INTERVAL_MS * 2, tags: ['social', 'feed'] },
  );
  noteSnapshot({ computedAt, activities: data.length, sourceCounts });
  logger.debug(
    `[social] feed snapshot refreshed: ${data.length} activities from ${JSON.stringify(sourceCounts)} in ${Date.now() - startedAt}ms`,
  );
}

/* ----------------------------------- boot ----------------------------------- */

const svc = createService({
  name: 'social-service',
  version: '3.0.0',
  port: 4007,
  portEnv: 'SOCIALPORT',
  initDb: true, // shared pg pool + content schema (comments FKs reference content)
  ensureSchema: ensurePlatformSchema, // platform DDL: users, comments, commentvotes, contentlikes, …
  attachUser: true, // req.user from the forwarded Bearer token (myVote on public routes)
  rateLimit: serviceRateLimit,
  routers: [{ path: '/api/social', router: socialRouter }],
  health: { readiness },
  worker: {
    file: workerFile,
    intervalMs: WORKER_INTERVAL_MS,
    workerData: { intervalMs: WORKER_INTERVAL_MS },
  },
});

/* Main-process snapshot loop: first run after the DB is up, then every 5 min.
   Errors are logged and never fatal — the domain routes compute per-request. */
svc.bootPromise
  .then(() => refreshFeedSnapshot())
  .catch((err) => logger.warn(`[social] initial feed snapshot failed: ${err.message}`));

const snapshotTimer = setInterval(() => {
  refreshFeedSnapshot().catch((err) => logger.warn(`[social] feed snapshot refresh failed: ${err.message}`));
}, WORKER_INTERVAL_MS);
if (typeof snapshotTimer.unref === 'function') snapshotTimer.unref();

// Entry point — no default export (Bun 1.3 auto-serves objects with a port property).
