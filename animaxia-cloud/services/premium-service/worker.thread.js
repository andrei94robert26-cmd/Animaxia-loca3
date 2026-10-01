/**
 * services/premium-service/worker.thread.js — Plan-expiry sweep thread.
 *
 * Runs in its own worker isolate (spawned by common/worker.js via
 * createService in server.js). Every `intervalMs` (default 1 hour) it expires
 * lapsed paid plans back to the free tier (BLUEPRINT §7 "premium-service:
 * expire plans whose planexpiresat < now (plan → free)"):
 *
 *   UPDATE users
 *      SET plan = 'free', planexpiresat = NULL
 *    WHERE planexpiresat IS NOT NULL
 *      AND planexpiresat < NOW()
 *      AND plan <> 'free'
 *   RETURNING id;
 *
 * (Column names verified against common/migrations.js — `users.plan` and
 * `users.planexpiresat`; clearing planexpiresat keeps the row consistent with
 * POST /api/premium/cancel, which sets the same pair.)
 *
 * Protocol (common/worker.js contract):
 *   workerData : { serviceName, boot, workerBootId, intervalMs }
 *   → parent   : { type: 'heartbeat', at }
 *                { type: 'task', ok: true, at, runMs,
 *                  detail: { expired, expiredUserIds (≤100), paidRemaining } }
 *                { type: 'task', ok: false, at, runMs, error }
 *   ← parent   : { type: 'run' }  → execute once immediately
 *
 * The worker CANNOT emit 'plan:changed' into the main process's platform event
 * bus (separate module state per isolate) — it only posts the detail; the main
 * process (server.js) logs expirations. Entitlement checks always read the
 * fresh users row, so expired plans lose access immediately regardless.
 *
 * The thread never throws out of its interval: every run is wrapped in
 * try/catch and failures are posted as ok:false task messages.
 */

import { parentPort, workerData } from 'node:worker_threads';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';

/* Worker isolates do not inherit the main process's dotenv/config call —
   load the repo-root .env explicitly (services/premium-service → ../../.env).
   In containers the env comes from ENV vars; dotenv never overrides those. */
dotenv.config({ path: fileURLToPath(new URL('../../.env', import.meta.url)) });

const intervalMs = Math.max(5000, parseInt(workerData?.intervalMs || '3600000', 10));
const MAX_REPORTED_IDS = 100; // keep the posted message small on mass expirations

function post(message) {
  try {
    parentPort?.postMessage(message);
  } catch {
    /* the parent may be shutting down — never crash the thread over a post */
  }
}

/** One sweep run: expire lapsed plans, report the affected user ids. */
async function runTask() {
  const startedAt = Date.now();
  try {
    // Dynamic import: the worker isolate gets its OWN @animaxia/common/db.js
    // module instance (separate pg pool) — it must be opened with initDb().
    const { initDb } = await import('@animaxia/common/db.js');
    const { rows, one, num } = await import('@animaxia/common/sql.js');

    await initDb();

    const expiredRows = await rows(
      `UPDATE users
          SET plan = 'free', planexpiresat = NULL
        WHERE planexpiresat IS NOT NULL
          AND planexpiresat < NOW()
          AND plan <> 'free'
        RETURNING id`,
    );
    const paidRow = await one(
      `SELECT COUNT(*)::int AS count FROM users
        WHERE plan <> 'free' AND (planexpiresat IS NULL OR planexpiresat > NOW())`,
    );

    const expiredUserIds = expiredRows.map((r) => num(r.id)).slice(0, MAX_REPORTED_IDS);
    post({
      type: 'task',
      ok: true,
      at: new Date().toISOString(),
      runMs: Date.now() - startedAt,
      detail: {
        expired: expiredRows.length,
        expiredUserIds,
        expiredTruncated: expiredRows.length > MAX_REPORTED_IDS,
        paidRemaining: num(paidRow?.count),
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

/* Parent messages: { type: 'run' } → immediate sweep (tests/admin). */
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
