/**
 * services/analytics-service/worker.thread.js — Daily view-event rollup.
 *
 * Runs inside a bun/node worker thread (spawned by common/worker.js via
 * createService in server.js). Every `intervalMs` (default 15 min) it
 * (re)aggregates raw `viewevents` rows into the pre-computed daily rollup
 * table `dailyviewrollups` and posts the result upstream:
 *
 *   workerData : { serviceName, boot, workerBootId, intervalMs }
 *   → parent   : { type: 'heartbeat', at }
 *                { type: 'task', ok: true, at, runMs,
 *                  detail: { inserted, windowFrom, lookback } }
 *                { type: 'task', ok: false, at, runMs, error }
 *   ← parent   : { type: 'run' }  → roll up immediately (used by tests/admin)
 *
 * common/migrations.js defines `viewevents` but NO rollup table, so this
 * worker owns a small idempotent one, house-style (lowercase, no
 * underscores — same naming family as `viewevents` / `watchhistory`):
 *
 *   dailyviewrollups (
 *     contentid     INTEGER NOT NULL REFERENCES content(id) ON DELETE CASCADE,
 *     day           DATE    NOT NULL,
 *     views         INTEGER NOT NULL DEFAULT 0,
 *     plays         INTEGER NOT NULL DEFAULT 0,
 *     completed     INTEGER NOT NULL DEFAULT 0,
 *     uniqueviewers INTEGER NOT NULL DEFAULT 0,
 *     updatedat     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 *     PRIMARY KEY (contentid, day)
 *   )
 *
 * Rollup semantics (idempotent): an INSERT … SELECT … ON CONFLICT DO UPDATE
 * recomputes the trailing window — today plus yesterday
 * (`createdat >= date_trunc('day', NOW()) - interval '1 day'`) — so the
 * still-accumulating current day is refreshed every run and late-arriving
 * events for yesterday are folded in; older days are immutable. `inserted`
 * in the task detail is the statement's rowCount (rows inserted or updated
 * by the upsert). The table is a cheap pre-aggregation for dashboards —
 * the live /api/analytics endpoints keep querying `viewevents` directly.
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
// the repo-root .env explicitly (services/analytics-service → ../../.env).
// Missing file (Docker: env comes from ENVIRONMENT) is a harmless no-op.
dotenv.config({ path: fileURLToPath(new URL('../../.env', import.meta.url)) });

const intervalMs = Math.max(60000, parseInt(workerData?.intervalMs || '900000', 10));

/** Trailing recompute window: yesterday + today (see header). */
const LOOKBACK = '1 day';

const CREATE_ROLLUP_DDL = [
  `CREATE TABLE IF NOT EXISTS dailyviewrollups (
     contentid INTEGER NOT NULL REFERENCES content(id) ON DELETE CASCADE,
     day DATE NOT NULL,
     views INTEGER NOT NULL DEFAULT 0,
     plays INTEGER NOT NULL DEFAULT 0,
     completed INTEGER NOT NULL DEFAULT 0,
     uniqueviewers INTEGER NOT NULL DEFAULT 0,
     updatedat TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     PRIMARY KEY (contentid, day)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_dailyviewrollups_day ON dailyviewrollups (day)`,
];

/** Resolve the window start with the SAME session timezone the rollup uses. */
const WINDOW_FROM_SQL = `SELECT (date_trunc('day', NOW()) - ($1::text)::interval) AS windowfrom`;

/** Idempotent upsert of the per-content daily aggregates for the window. */
const ROLLUP_SQL = `
  INSERT INTO dailyviewrollups (contentid, day, views, plays, completed, uniqueviewers, updatedat)
  SELECT v.contentid,
         date_trunc('day', v.createdat)::date AS day,
         COUNT(*) FILTER (WHERE v.event = 'view')::int     AS views,
         COUNT(*) FILTER (WHERE v.event = 'play')::int    AS plays,
         COUNT(*) FILTER (WHERE v.event = 'complete')::int AS completed,
         COUNT(DISTINCT v.userid)::int                     AS uniqueviewers,
         NOW()
  FROM viewevents v
  WHERE v.createdat >= date_trunc('day', NOW()) - ($1::text)::interval
  GROUP BY v.contentid, date_trunc('day', v.createdat)::date
  ON CONFLICT (contentid, day) DO UPDATE SET
    views         = EXCLUDED.views,
    plays         = EXCLUDED.plays,
    completed     = EXCLUDED.completed,
    uniqueviewers = EXCLUDED.uniqueviewers,
    updatedat     = NOW()`;

function post(message) {
  try {
    parentPort?.postMessage(message);
  } catch {
    /* the parent may be shutting down — never crash the thread over a post */
  }
}

let running = false;

/** One rollup run: open the worker-side pool, ensure the table, roll up, close, report. */
async function runTask() {
  if (running) return; // never overlap runs
  running = true;
  const startedAt = Date.now();
  let db = null;
  try {
    db = await import('@animaxia/common/db.js');
    await db.initDb(); // worker gets its own pool — must open before querying
    if (!db.driverInfo().connected) {
      // Local JSON fallback store has no SQL layer — nothing to aggregate.
      throw new Error('PostgreSQL driver inactive (local fallback store) — rollup skipped');
    }
    for (const statement of CREATE_ROLLUP_DDL) {
      await db.query(statement); // idempotent DDL (IF NOT EXISTS)
    }
    const fromRes = await db.query(WINDOW_FROM_SQL, [LOOKBACK]);
    const windowFrom = fromRes?.rows?.[0]?.windowfrom;
    const res = await db.query(ROLLUP_SQL, [LOOKBACK]);
    const inserted = Number(res?.rowCount ?? 0);
    post({
      type: 'task',
      ok: true,
      at: new Date().toISOString(),
      runMs: Date.now() - startedAt,
      detail: {
        inserted, // upserted rows (inserts + updates) for the trailing window
        windowFrom: windowFrom instanceof Date ? windowFrom.toISOString() : String(windowFrom ?? ''),
        lookback: LOOKBACK,
      },
    });
  } catch (err) {
    // Non-fatal by contract: e.g. viewevents not migrated yet on a fresh
    // database (main thread runs ensurePlatformSchema at boot) → next
    // interval retries.
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

/* Parent messages: { type: 'run' } → immediate rollup (used by tests/admin). */
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
