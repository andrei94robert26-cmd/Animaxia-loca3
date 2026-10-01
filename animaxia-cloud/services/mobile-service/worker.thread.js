/**
 * services/mobile-service/worker.thread.js — Mobile refresh-check thread
 * (BLUEPRINT §7 mobile-service task).
 *
 * Runs inside a worker thread (spawned by common/worker.js via createService
 * in server.js). Every `intervalMs` (default 5 min) it opens its own lazy pg
 * pool (worker isolates do not share the main process's db module instance),
 * counts the content table (SELECT COUNT(*) FROM content via countContent —
 * same query, with local-fallback support), closes the pool and posts the
 * result:
 *
 *   workerData : { serviceName, boot, workerBootId, intervalMs }
 *   → parent   : { type: 'heartbeat', at }
 *                { type: 'task', ok, at, runMs,
 *                    detail: { content: n, driver: 'postgres'|'local-fallback' } }
 *   ← parent   : { type: 'run' }  → run the check immediately
 *
 * Honest scope note: this is a REFRESH CHECK, not a cache warm. The real
 * /api/mobile/home cache lives in the MAIN process's advancedCache (domain
 * mobile router, key 'mobile:home', 60s TTL) and its builder (buildHome) is
 * module-private in @animaxia/domain/mobile/mobile.js — a worker isolate
 * cannot warm it, and the main process has no exported builder to call
 * either. The payload therefore warms lazily on the first anonymous /home
 * request after boot/TTL expiry (≤60s cold window). The count posted here is
 * the refresh signal operators watch (content arriving → next /home request
 * rebuilds the rows). See services/mobile-service/README.md.
 *
 * The repo-root .env is loaded explicitly because worker isolates do not
 * inherit the main process's dotenv/config call (DATABASEURL needed for
 * initDb). Per-run open→query→close keeps the pool clean (same pattern as
 * domain/workers/tasks/mine.mjs).
 */

import { parentPort, workerData } from 'node:worker_threads';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';

// services/mobile-service → ../../.env is the repo root .env.
dotenv.config({ path: fileURLToPath(new URL('../../.env', import.meta.url)) });

const intervalMs = Math.max(5000, parseInt(workerData?.intervalMs || '300000', 10));

function post(message) {
  try {
    parentPort?.postMessage(message);
  } catch {
    /* the parent may be shutting down — never crash the thread over a post */
  }
}

/** One full task run — catch-all errors become a failed task post. */
async function runTask() {
  const startedAt = Date.now();
  let db = null;
  try {
    db = await import('@animaxia/common/db.js');
    await db.initDb(); // worker gets its own lazy pool — must open before querying
    const content = await db.countContent(); // SELECT COUNT(*)::int FROM content
    const { driverInfo, closeDb } = db;
    const driver = driverInfo().driver;
    await closeDb(); // release worker-side connections before posting
    post({
      type: 'task',
      ok: true,
      at: new Date().toISOString(),
      runMs: Date.now() - startedAt,
      detail: { content, driver },
    });
  } catch (err) {
    try {
      if (db) await db.closeDb();
    } catch {
      /* pool may never have opened */
    }
    post({
      type: 'task',
      ok: false,
      at: new Date().toISOString(),
      runMs: Date.now() - startedAt,
      error: String(err?.message || err),
    });
  }
}

/* Parent messages: { type: 'run' } → immediate check (used by tests/admin). */
if (parentPort) {
  parentPort.on('message', (msg) => {
    if (msg && msg.type === 'run') runTask();
  });
}

/* Boot heartbeat + immediate first check, then the periodic loop. */
post({ type: 'heartbeat', at: new Date().toISOString() });
runTask();

const timer = setInterval(() => {
  post({ type: 'heartbeat', at: new Date().toISOString() });
  runTask();
}, intervalMs);
if (typeof timer.unref === 'function') timer.unref();
