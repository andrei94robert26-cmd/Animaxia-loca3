/**
 * services/ai-service/worker.thread.js — AI retention pruner.
 *
 * Runs inside a bun/node worker thread (spawned by common/worker.js via
 * createService in server.js). Every `intervalMs` (default 10 min) it deletes
 * rows older than the retention window from TWO tables and posts the result
 * upstream:
 *   • `aichats`     (contentid, userid, role, message, createdat — DDL owned
 *                    by common/migrations.js ensurePlatformSchema) — Phase-3
 *                    chat sessions.
 *   • `aiusagelogs` (traceid, userid, feature, mode, provider, … — DDL owned
 *                    by domain/aicloud/router.js ensureAicloudSchema) —
 *                    Phase-4 AI Cloud LLM usage logs (every LLM call writes
 *                    one row; the analytics live in the in-memory usage ring
 *                    of the live process, so week-old rows are safe to drop).
 *
 *   workerData : { serviceName, boot, workerBootId, intervalMs }
 *   → parent   : { type: 'heartbeat', at }
 *                { type: 'task', ok: true, at, runMs, detail: { deleted, usageDeleted, retention } }
 *                { type: 'task', ok: false, at, runMs, error }
 *   ← parent   : { type: 'run' }  → prune immediately (used by tests/admin)
 *
 * Retention: 7 days for both tables. The chat endpoint replays only the
 * user's last 10 turns per content (domain/ai/ai.js), so sessions older than a
 * week carry no conversational value; aiusagelogs only feeds the Admin AI
 * dashboard's recent-calls views. Pruning bounds table growth and improves
 * privacy hygiene. Frequent pruning keeps the tables (and therefore the
 * un-indexed createdat scans these DELETEs perform) small — DB-light by
 * design.
 *
 * The thread dynamically imports @animaxia/common/db.js, which creates a
 * SEPARATE module instance with its own lazy pg pool: initDb() opens it, the
 * task runs, closeDb() releases it before the thread goes idle (house pattern
 * from domain/workers/tasks/mine.mjs). Runs never overlap.
 */

import { parentPort, workerData } from 'node:worker_threads';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';

// Worker isolates do not inherit the main process's dotenv/config call — load
// the repo-root .env explicitly (services/ai-service → ../../.env). Missing
// file (Docker: env comes from ENVIRONMENT) is a harmless no-op.
dotenv.config({ path: fileURLToPath(new URL('../../.env', import.meta.url)) });

const intervalMs = Math.max(60000, parseInt(workerData?.intervalMs || '600000', 10));

/** Retention window for BOTH tables (see header). */
const RETENTION = '7 days';

/** Prune chat turns older than the retention window; rowCount → detail.deleted. */
const PRUNE_SQL = `DELETE FROM aichats WHERE createdat < NOW() - ($1::text)::interval`;

/** Prune Phase-4 AI usage logs older than the retention window (best-effort:
 *  the table only exists once ensureAicloudSchema has run — a fresh database
 *  reports ok:false with the SQL error and retries next interval). */
const PRUNE_USAGE_SQL = `DELETE FROM aiusagelogs WHERE createdat < NOW() - ($1::text)::interval`;

function post(message) {
  try {
    parentPort?.postMessage(message);
  } catch {
    /* the parent may be shutting down — never crash the thread over a post */
  }
}

let running = false;

/** One prune run: open the worker-side pool, prune, close, report. */
async function runTask() {
  if (running) return; // never overlap runs
  running = true;
  const startedAt = Date.now();
  let db = null;
  try {
    db = await import('@animaxia/common/db.js');
    await db.initDb(); // worker gets its own pool — must open before querying
    if (!db.driverInfo().connected) {
      // Local JSON fallback store has no SQL layer — nothing to prune.
      throw new Error('PostgreSQL driver inactive (local fallback store) — aichats prune skipped');
    }
    const res = await db.query(PRUNE_SQL, [RETENTION]);
    const deleted = Number(res?.rowCount ?? 0);
    // Phase-4 addition: aiusagelogs prune (same retention window). Failure is
    // non-fatal for the aichats prune result — report both counters.
    let usageDeleted = 0;
    let usageError = null;
    try {
      const usageRes = await db.query(PRUNE_USAGE_SQL, [RETENTION]);
      usageDeleted = Number(usageRes?.rowCount ?? 0);
    } catch (err) {
      usageError = String(err?.message || err); // e.g. table not migrated yet
    }
    post({
      type: 'task',
      ok: true,
      at: new Date().toISOString(),
      runMs: Date.now() - startedAt,
      detail: { deleted, usageDeleted, ...(usageError ? { usageError } : {}), retention: RETENTION },
    });
  } catch (err) {
    // Non-fatal by contract: e.g. aichats not migrated yet on a fresh database
    // (main thread runs ensurePlatformSchema at boot) → next interval retries.
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

/* Parent messages: { type: 'run' } → immediate prune (used by tests/admin). */
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
