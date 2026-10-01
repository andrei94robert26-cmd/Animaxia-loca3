/**
 * services/queue-service/cron.js — Cron scheduler for the Animaxia queue.
 *
 * A minimal 5-field cron matcher (minute hour dom month dow — supports `*`,
 * step values, `a,b` lists and `a-b` ranges, dow 0 and 7 both meaning Sunday)
 * plus the internal scheduler that evaluates the frozen SCHEDULES table
 * (BLUEPRINT §10) every 30s and enqueues matching jobs:
 *
 *   '0 0/6 * * *'   → providers.refresh {source:'tmdb'}   (every 6h on the hour)
 *   '30 0/6 * * *'  → providers.refresh {source:'jikan'}  (every 6h, :30 offset)
 *   '0 3 * * *'     → maintenance.cleanup-logs
 *   '15 3 * * *'    → maintenance.cleanup-audit
 *   '0 * * * *'     → maintenance.cleanup-sessions
 *   '0 4 * * *'     → maintenance.reindex
 *
 * Fire-once-per-minute guarantees (the 30s interval can hit the same cron
 * minute twice):
 *   1. `schedules` persistence table (name TEXT PK, lastrunat TIMESTAMPTZ) —
 *      a schedule is skipped when its lastrunat is within a 55s window.
 *   2. a pending/running job of the same type already exists
 *      (`SELECT 1 FROM jobs WHERE type = $1 AND status IN ('pending','running')`).
 *
 * The same evaluateSchedules() backs POST /api/queue/cron/tick, so the K8s
 * CronJobs (deploy/k8s/90-cronjobs) and this internal interval are belt &
 * braces: whichever fires first records lastrunat, the other dedupes.
 * QUEUESCHEDULERENABLED=false disables the internal interval (tick route
 * keeps working) — all timers are unref'd.
 */

import { query } from '@animaxia/common/db.js';
import { enqueue } from '@animaxia/common/queue.js';
import { logger } from '@animaxia/common/logger.js';

/* -------------------------------- schedules --------------------------------- */

export const SCHEDULES = {
  '0 */6 * * *': { type: 'providers.refresh', payload: { source: 'tmdb' } },
  '30 */6 * * *': { type: 'providers.refresh', payload: { source: 'jikan' } },
  '0 3 * * *': { type: 'maintenance.cleanup-logs', payload: {} },
  '15 3 * * *': { type: 'maintenance.cleanup-audit', payload: {} },
  '0 * * * *': { type: 'maintenance.cleanup-sessions', payload: {} },
  '0 4 * * *': { type: 'maintenance.reindex', payload: {} },
};

const SCHEDULER_INTERVAL_MS = 30000;
const DEDUPE_WINDOW_MS = 55000; // minute-level dedupe across the 30s interval

const CREATE_SCHEDULES_DDL = `CREATE TABLE IF NOT EXISTS schedules (
  name TEXT PRIMARY KEY,
  lastrunat TIMESTAMPTZ NOT NULL
)`;

/* ------------------------------ cron expression ------------------------------ */

/** Match one comma-separated token (`*`, `* / n` step, `a`, `a-b`, `a-b/n`) against a value. */
function tokenMatches(token, value, min, max) {
  let range = token;
  let step = 1;
  const stepIdx = token.indexOf('/');
  if (stepIdx !== -1) {
    range = token.slice(0, stepIdx);
    step = parseInt(token.slice(stepIdx + 1), 10);
    if (!Number.isFinite(step) || step < 1) return false;
  }
  let lo;
  let hi;
  if (range === '*') {
    lo = min;
    hi = max;
  } else if (range.includes('-')) {
    const [rawLo, rawHi] = range.split('-');
    lo = parseInt(rawLo, 10);
    hi = parseInt(rawHi, 10);
  } else {
    lo = parseInt(range, 10);
    hi = stepIdx !== -1 ? max : lo; // "5/10" → from 5 to max every 10
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return false;
  if (lo < min || hi > max || lo > hi) return false;
  if (value < lo || value > hi) return false;
  return (value - lo) % step === 0;
}

/** Match one cron field (may be a comma list of tokens) against a value. */
function fieldMatches(field, value, min, max) {
  for (const token of String(field).split(',')) {
    if (tokenMatches(token.trim(), value, min, max)) return true;
  }
  return false;
}

/**
 * Standard 5-field cron matcher.
 * @param {string} expr - "min hour dom mon dow" (`*`, step values, `a,b`, `a-b`).
 * @param {Date} [date] - moment to test (default: now).
 * @returns {boolean}
 */
export function matchesCron(expr, date = new Date()) {
  const parts = String(expr || '').trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const minute = date.getMinutes();
  const hour = date.getHours();
  const dom = date.getDate();
  const month = date.getMonth() + 1;
  const dow = date.getDay(); // 0 = Sunday
  return (
    fieldMatches(parts[0], minute, 0, 59) &&
    fieldMatches(parts[1], hour, 0, 23) &&
    fieldMatches(parts[2], dom, 1, 31) &&
    fieldMatches(parts[3], month, 1, 12) &&
    (fieldMatches(parts[4], dow, 0, 7) || (dow === 0 && fieldMatches(parts[4], 7, 0, 7)))
  );
}

/* ------------------------------- persistence --------------------------------- */

async function ensureSchedulesTable() {
  await query(CREATE_SCHEDULES_DDL);
}

/** Record a run for the named schedule (upsert keyed by the cron expression). */
async function recordRun(name) {
  await query(
    `INSERT INTO schedules (name, lastrunat) VALUES ($1, NOW())
     ON CONFLICT (name) DO UPDATE SET lastrunat = NOW()`,
    [name],
  );
}

/* ------------------------------- evaluation ---------------------------------- */

/**
 * Evaluate every schedule against `now` and enqueue matching jobs (subject to
 * the 55s minute-dedupe and the pending/running-type dedupe).
 * @param {Date} [now]
 * @returns {Promise<Array<{schedule: string, type: string, jobId: number}>>} enqueued jobs
 */
export async function evaluateSchedules(now = new Date()) {
  const enqueued = [];
  await ensureSchedulesTable();
  for (const [expr, schedule] of Object.entries(SCHEDULES)) {
    if (!matchesCron(expr, now)) continue;

    // Dedupe 1: ran within the last 55s (same cron minute).
    let lastMs = NaN;
    try {
      const res = await query('SELECT lastrunat FROM schedules WHERE name = $1', [expr]);
      const last = res.rows[0]?.lastrunat;
      if (last) lastMs = last instanceof Date ? last.getTime() : Date.parse(last);
    } catch {
      /* table just created / transient — fall through to the enqueue guard */
    }
    if (Number.isFinite(lastMs) && now.getTime() - lastMs < DEDUPE_WINDOW_MS) continue;

    // Dedupe 2: a pending/running job of this type already exists.
    let active = false;
    try {
      const res = await query(
        `SELECT 1 FROM jobs WHERE type = $1 AND status IN ('pending', 'running') LIMIT 1`,
        [schedule.type],
      );
      active = res.rows.length > 0;
    } catch {
      /* jobs table unreachable — skip this round rather than double-enqueue */
      continue;
    }
    if (active) {
      await recordRun(expr); // a run is in flight; still count the minute
      continue;
    }

    const job = await enqueue({ type: schedule.type, payload: schedule.payload });
    await recordRun(expr);
    enqueued.push({ schedule: expr, type: schedule.type, jobId: job.id });
    logger.info(`[cron] ${expr} → enqueued ${schedule.type} as job #${job.id}`);
  }
  return enqueued;
}

/** Schedules + their persisted lastrunat (GET /api/queue/cron/schedules, /api/workers/status). */
export async function schedulesOverview() {
  await ensureSchedulesTable();
  const res = await query('SELECT name, lastrunat FROM schedules ORDER BY name');
  const lastrun = {};
  for (const row of res.rows) {
    lastrun[row.name] = row.lastrunat instanceof Date ? row.lastrunat.toISOString() : String(row.lastrunat);
  }
  return Object.entries(SCHEDULES).map(([expr, schedule]) => ({
    schedule: expr,
    type: schedule.type,
    payload: schedule.payload,
    lastrunat: lastrun[expr] ?? null,
  }));
}

/* --------------------------------- starter ----------------------------------- */

let schedulerTimer = null;

/** Start the internal scheduler interval (idempotent, unref'd, env-gated). */
export function startScheduler() {
  if (schedulerTimer) return;
  if (String(process.env.QUEUESCHEDULERENABLED ?? 'true').toLowerCase() === 'false') {
    logger.info('[cron] internal scheduler disabled (QUEUESCHEDULERENABLED=false) — /api/queue/cron/tick still works');
    return;
  }
  schedulerTimer = setInterval(() => {
    evaluateSchedules(new Date()).catch((err) => logger.warn(`[cron] evaluate failed: ${err.message}`));
  }, SCHEDULER_INTERVAL_MS);
  if (typeof schedulerTimer.unref === 'function') schedulerTimer.unref();
  logger.info(
    `[cron] scheduler started (${Object.keys(SCHEDULES).length} schedules, interval ${SCHEDULER_INTERVAL_MS}ms)`,
  );
  evaluateSchedules(new Date()).catch((err) => logger.warn(`[cron] initial evaluate failed: ${err.message}`));
}

export default { SCHEDULES, matchesCron, evaluateSchedules, schedulesOverview, startScheduler };
