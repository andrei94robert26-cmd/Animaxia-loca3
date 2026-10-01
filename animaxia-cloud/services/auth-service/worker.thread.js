/**
 * services/auth-service/worker.thread.js — Refresh-token housekeeping thread.
 *
 * Runs in its own worker isolate (spawned by common/worker.js via
 * createService in server.js). Every `intervalMs` (default 5 min) it deletes
 * dead rows from the shared `refreshtokens` table:
 *
 *   1. EXPIRED tokens     — expiresat < NOW() (useless for /api/auth/refresh)
 *   2. AGED-OUT REVOKED   — revoked = TRUE AND createdat < NOW() - 7 days.
 *      The schema (common/migrations.js) has NO revokedat column — only
 *      id/userid/tokenhash/expiresat/revoked/createdat — so `createdat` is
 *      the best available retention anchor: revoked tokens are useless the
 *      moment they are rotated out, this keeps a 7-day debug/audit window
 *      around their creation before hard-deleting them.
 *
 * Protocol (common/worker.js contract):
 *   workerData : { serviceName, boot, workerBootId, intervalMs }
 *   → parent   : { type: 'heartbeat', at }
 *                { type: 'task', ok: true, at, runMs, detail: { deleted, remaining } }
 *                { type: 'task', ok: false, at, runMs, error }
 *   ← parent   : { type: 'run' }  → execute once immediately
 *
 * The thread never throws out of its interval: every run is wrapped in
 * try/catch and failures are posted as ok:false task messages (the parent
 * logs them and keeps the service alive).
 */

import { parentPort, workerData } from 'node:worker_threads';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';

/* Worker isolates do not inherit the main process's dotenv/config call —
   load the repo-root .env explicitly (services/auth-service → ../../.env).
   In containers the env comes from ENV vars; dotenv never overrides those. */
dotenv.config({ path: fileURLToPath(new URL('../../.env', import.meta.url)) });

const intervalMs = Math.max(5000, parseInt(workerData?.intervalMs || '300000', 10));
const REVOKED_RETENTION_SEC = 7 * 24 * 60 * 60; // 7 days

function post(message) {
  try {
    parentPort?.postMessage(message);
  } catch {
    /* the parent may be shutting down — never crash the thread over a post */
  }
}

/** One cleanup run: delete dead refresh tokens, report the counts. */
async function runTask() {
  const startedAt = Date.now();
  try {
    // Dynamic import: the worker isolate gets its OWN @animaxia/common/db.js
    // module instance (separate pg pool) — it must be opened with initDb().
    const { initDb } = await import('@animaxia/common/db.js');
    const { rows, one, num } = await import('@animaxia/common/sql.js');

    await initDb();

    const deletedRows = await rows(
      `DELETE FROM refreshtokens
       WHERE expiresat < NOW()
          OR (revoked = TRUE AND createdat < NOW() - ($1::text)::interval)
       RETURNING id`,
      [`${REVOKED_RETENTION_SEC} seconds`],
    );
    const remainingRow = await one(`SELECT COUNT(*)::int AS count FROM refreshtokens`);

    post({
      type: 'task',
      ok: true,
      at: new Date().toISOString(),
      runMs: Date.now() - startedAt,
      detail: {
        deleted: deletedRows.length,
        remaining: num(remainingRow?.count),
        policy: `expired OR (revoked AND createdat older than ${REVOKED_RETENTION_SEC / 86400}d)`,
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

/* Parent messages: { type: 'run' } → immediate cleanup (tests/admin). */
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
