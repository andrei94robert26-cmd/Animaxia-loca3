/**
 * services/queue-service/worker.thread.js — Queue maintenance thread.
 *
 * Runs inside a bun/node worker thread (spawned by common/worker.js via
 * createService in server.js). Every `intervalMs` (default 30s) it performs
 * the two queue-housekeeping passes (BLUEPRINT §7 queue-service task):
 *
 *   1. requeueStale()   — reclaim `running` jobs whose lease expired
 *      (leaseexpiresat < NOW, lease length QUEUEWORKERTTLSEC): crashed or
 *      stuck consumers lose their claim and the job returns to `pending`.
 *   2. purgeFinished()  — delete done/failed/dead jobs older than
 *      QUEUERETENTIONDAYS (default 7) days (retention pass).
 *
 *   workerData : { serviceName, boot, workerBootId, intervalMs }
 *   → parent   : { type: 'heartbeat', at }
 *                { type: 'task', ok: true, at, runMs,
 *                  detail: { reclaimed, purged, retentionDays } }
 *                { type: 'task', ok: false, at, runMs, error }
 *   ← parent   : { type: 'run' } → run both passes immediately
 *
 * The thread dynamically imports @animaxia/common/db.js, which creates a
 * SEPARATE module instance with its own lazy pg pool: initDb() opens it, the
 * task runs, closeDb() releases it before the thread goes idle (house
 * pattern from domain/workers/tasks/mine.mjs). Runs never overlap.
 */

import { parentPort, workerData } from 'node:worker_threads';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';

// Worker isolates do not inherit the main process's dotenv/config call — load
// the repo-root .env explicitly (services/queue-service → ../../.env).
// Missing file (Docker: env comes from ENVIRONMENT) is a harmless no-op.
dotenv.config({ path: fileURLToPath(new URL('../../.env', import.meta.url)) });

const intervalMs = Math.max(5000, parseInt(workerData?.intervalMs || '30000', 10));
const RETENTION_DAYS = parseInt(process.env.QUEUERETENTIONDAYS || '7', 10);

function post(message) {
  try {
    parentPort?.postMessage(message);
  } catch {
    /* the parent may be shutting down — never crash the thread over a post */
  }
}

let running = false;

/** One maintenance pass: open the worker-side pool, requeue stale, purge, close, report. */
async function runTask() {
  if (running) return; // never overlap runs
  running = true;
  const startedAt = Date.now();
  let db = null;
  try {
    db = await import('@animaxia/common/db.js');
    await db.initDb(); // worker gets its own pool — must open before querying
    if (!db.driverInfo().connected) {
      // Local JSON fallback store has no SQL layer — no queue to maintain.
      throw new Error('PostgreSQL driver inactive (local fallback store) — queue maintenance skipped');
    }
    const queue = await import('@animaxia/common/queue.js');
    const reclaimed = await queue.requeueStale();
    const purged = await queue.purgeFinished({ olderThanDays: RETENTION_DAYS });
    post({
      type: 'task',
      ok: true,
      at: new Date().toISOString(),
      runMs: Date.now() - startedAt,
      detail: { reclaimed, purged, retentionDays: RETENTION_DAYS },
    });
  } catch (err) {
    // Non-fatal by contract (e.g. transient Postgres hiccup) — next interval retries.
    post({
      type: 'task',
      ok: false,
      at: new Date().toISOString(),
      runMs: Date.now() - startedAt,
      error: String(err?.message || err),
    });
  } finally {
    running = false;
    try {
      if (db) await db.closeDb(); // release worker-side connections between runs
    } catch {
      /* pool may never have opened */
    }
  }
}

/* Parent messages: { type: 'run' } → immediate maintenance pass (tests/admin). */
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
