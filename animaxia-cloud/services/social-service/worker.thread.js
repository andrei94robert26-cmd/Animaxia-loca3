/**
 * services/social-service/worker.thread.js — Activity-source health checks.
 *
 * Runs in its own worker isolate (spawned by common/worker.js via
 * createService in server.js). Every `intervalMs` (default 5 min) it runs
 * DB-light COUNT checks over the four global-feed activity sources and posts
 * the stats to the parent.
 *
 * IMPORTANT (why this thread does NOT compute the feed snapshot): a worker
 * isolate has SEPARATE module state from the main process — an
 * advancedCache.set() executed here would populate a cache instance the
 * request handlers never see. The actual snapshot refresh therefore lives in
 * the MAIN process (server.js: setInterval → computeGlobalFeedSnapshot() →
 * advancedCache.set('feed:global:snapshot', …)). This thread's job is the
 * independent early-warning signal: source counts + a note pointing at the
 * main-process refresher.
 *
 * Protocol (common/worker.js contract):
 *   workerData : { serviceName, boot, workerBootId, intervalMs }
 *   → parent   : { type: 'heartbeat', at }
 *                { type: 'task', ok: true, at, runMs,
 *                  detail: { note, comments, commentsLast24h, likes, content, users } }
 *                { type: 'task', ok: false, at, runMs, error }
 *   ← parent   : { type: 'run' }  → execute once immediately
 *
 * The thread never throws out of its interval: every run is wrapped in
 * try/catch and failures are posted as ok:false task messages.
 */

import { parentPort, workerData } from 'node:worker_threads';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';

/* Worker isolates do not inherit the main process's dotenv/config call —
   load the repo-root .env explicitly (services/social-service → ../../.env).
   In containers the env comes from ENV vars; dotenv never overrides those. */
dotenv.config({ path: fileURLToPath(new URL('../../.env', import.meta.url)) });

const intervalMs = Math.max(5000, parseInt(workerData?.intervalMs || '300000', 10));

function post(message) {
  try {
    parentPort?.postMessage(message);
  } catch {
    /* the parent may be shutting down — never crash the thread over a post */
  }
}

/** One check run: COUNT the four activity sources, post the stats. */
async function runTask() {
  const startedAt = Date.now();
  try {
    // Dynamic import: the worker isolate gets its OWN @animaxia/common/db.js
    // module instance (separate pg pool) — it must be opened with initDb().
    const { initDb } = await import('@animaxia/common/db.js');
    const { one, num } = await import('@animaxia/common/sql.js');

    await initDb();

    const [comments, comments24h, likes, content, users] = await Promise.all([
      one(`SELECT COUNT(*)::int AS count FROM comments`),
      one(`SELECT COUNT(*)::int AS count FROM comments WHERE createdat > NOW() - INTERVAL '24 hours'`),
      one(`SELECT COUNT(*)::int AS count FROM contentlikes WHERE value = 1`),
      one(`SELECT COUNT(*)::int AS count FROM content`),
      one(`SELECT COUNT(*)::int AS count FROM users`),
    ]);

    post({
      type: 'task',
      ok: true,
      at: new Date().toISOString(),
      runMs: Date.now() - startedAt,
      detail: {
        note: 'feed snapshot is main-process (server.js refreshes feed:global:snapshot)',
        comments: num(comments?.count),
        commentsLast24h: num(comments24h?.count),
        likes: num(likes?.count),
        content: num(content?.count),
        users: num(users?.count),
      },
    });
  } catch (err) {
    post({
      type: 'task',
      ok: false,
      at: new Date().toISOString(),
      runMs: Date.now() - startedAt,
      error: String(err?.message || err),
    });
  }
}

/* Parent messages: { type: 'run' } → immediate check (tests/admin). */
if (parentPort) {
  parentPort.on('message', (msg) => {
    if (msg && msg.type === 'run') runTask();
  });
}

/* Boot heartbeat + immediate first run, then the periodic loop. */
post({ type: 'heartbeat', at: new Date().toISOString() });
runTask();

const timer = setInterval(() => {
  post({ type: 'heartbeat', at: new Date().toISOString() });
  runTask();
}, intervalMs);
if (typeof timer.unref === 'function') timer.unref();
