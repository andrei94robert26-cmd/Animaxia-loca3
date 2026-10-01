/**
 * services/search-service/worker.thread.js — Corpus change detection for the
 * search index (incremental-reindex watchdog).
 *
 * What the search engine actually is (domain/search/search.js): an IN-PROCESS
 * inverted index (BM25, k1=1.2 / b=0.75, Levenshtein fuzzy expansion) built
 * from the `content` table — there is NO Postgres index table and the module
 * exports only the router (no rebuild function). A worker thread runs in its
 * own isolate, so it cannot rebuild or warm the main thread's index directly;
 * rebuilding here would only build a throwaway copy. What the worker CAN do
 * (and does): watch the content table for changes and tell the parent.
 *
 * Runs every `intervalMs` (default 10 min):
 *   1. SELECT COUNT(*)::int AS docs, MAX(createdat) AS latest FROM content
 *   2. compare against the previous run's watermark (kept in this thread's
 *      memory; the content table has no updatedat column, so
 *      (COUNT, MAX(createdat)) is the best available change signal)
 *   3. post the result upstream:
 *
 *   workerData : { serviceName, boot, workerBootId, intervalMs }
 *   → parent   : { type: 'heartbeat', at }
 *                { type: 'task', ok: true, at, runMs,
 *                  detail: { docs, latestContentAt, changed, baseline } }
 *                { type: 'task', ok: false, at, runMs, error }
 *   ← parent   : { type: 'run' }  → check immediately (used by tests/admin)
 *
 * `baseline: true` on the first run after (re)spawn — establishes the
 * watermark without signalling a change. server.js polls these results and,
 * on `changed: true`, emits the `content:changed` platform event on the
 * in-process bus, which marks the domain module's index dirty → the next
 * query transparently rebuilds it (full rebuild under an async lock — the
 * engine does not support incremental merges; the corpus is a single table
 * of titles, so a full rebuild is the correct granularity).
 *
 * Known blind spot (documented honestly): an upsert that only rewrites
 * metadata of a PRE-EXISTING row changes neither COUNT(*) nor MAX(createdat),
 * so this watermark misses it. Backstops: the daily 04:00
 * `maintenance.reindex` queue job (queue-service) and the manual
 * POST /api/search/index (admin) endpoint both force a full rebuild.
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
// the repo-root .env explicitly (services/search-service → ../../.env).
// Missing file (Docker: env comes from ENVIRONMENT) is a harmless no-op.
dotenv.config({ path: fileURLToPath(new URL('../../.env', import.meta.url)) });

const intervalMs = Math.max(60000, parseInt(workerData?.intervalMs || '600000', 10));

/** Corpus watermark probe: row count + newest createdat (no updatedat column). */
const CORPUS_SQL = `SELECT COUNT(*)::int AS docs, MAX(createdat) AS latest FROM content`;

function post(message) {
  try {
    parentPort?.postMessage(message);
  } catch {
    /* the parent may be shutting down — never crash the thread over a post */
  }
}

/** Last-seen watermark (this thread's memory; resets on respawn → baseline). */
let lastWatermark = null;

/** Normalize the probe row into a comparable watermark. */
function watermarkOf(row) {
  const latest = row?.latest;
  return {
    docs: Number(row?.docs ?? 0),
    latest: latest instanceof Date ? latest.toISOString() : latest ? String(latest) : null,
  };
}

let running = false;

/** One probe run: open the worker-side pool, read the watermark, compare, close, report. */
async function runTask() {
  if (running) return; // never overlap runs
  running = true;
  const startedAt = Date.now();
  let db = null;
  try {
    db = await import('@animaxia/common/db.js');
    await db.initDb(); // worker gets its own pool — must open before querying
    if (!db.driverInfo().connected) {
      // Local JSON fallback store has no SQL layer — cannot probe the corpus.
      throw new Error('PostgreSQL driver inactive (local fallback store) — corpus check skipped');
    }
    const res = await db.query(CORPUS_SQL);
    const current = watermarkOf(res?.rows?.[0]);
    const baseline = lastWatermark === null;
    const changed = !baseline && (
      current.docs !== lastWatermark.docs || current.latest !== lastWatermark.latest
    );
    lastWatermark = current;
    post({
      type: 'task',
      ok: true,
      at: new Date().toISOString(),
      runMs: Date.now() - startedAt,
      detail: {
        docs: current.docs,
        latestContentAt: current.latest,
        changed,
        baseline,
      },
    });
  } catch (err) {
    // Non-fatal by contract (e.g. transient DB outage) → next interval retries.
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

/* Parent messages: { type: 'run' } → immediate probe (used by tests/admin). */
if (parentPort) {
  parentPort.on('message', (msg) => {
    if (msg && msg.type === 'run') runTask();
  });
}

/* Boot heartbeat + immediate first run (baseline), then the periodic loop. */
post({ type: 'heartbeat', at: new Date().toISOString() });
runTask();

const timer = setInterval(() => {
  post({ type: 'heartbeat', at: new Date().toISOString() });
  runTask();
}, intervalMs);
if (typeof timer.unref === 'function') timer.unref();
