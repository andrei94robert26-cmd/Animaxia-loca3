/**
 * services/content-service/worker.thread.js — Provider prewarm + thumbnails
 * existence check (BLUEPRINT §7 content-service task).
 *
 * Runs inside a worker thread (spawned by common/worker.js via createService
 * in server.js). Every `intervalMs` (default 5 min):
 *
 *   1. Provider reachability prewarm — plain fetch (5s timeout) against the
 *      TMDB and Jikan base URLs (TMDBBASEURL / JIKANBASEURL). Any HTTP
 *      response counts as reachable (TMDB answers 401/404 without an API key
 *      — the point is DNS + TCP + TLS liveness and an early-warning signal,
 *      not API correctness). The per-provider breaker states live in the MAIN
 *      process (common/fetcher.js), so real traffic is what warms/closes the
 *      actual provider cache and breakers; this thread is the independent
 *      liveness probe (same philosophy as the gateway's upstream prober).
 *   2. Thumbnails existence check — count files in <LOCALDATADIR>/thumbnails
 *      (default ./data/thumbnails, the same location common/db.js uses for
 *      its local-fallback store; in docker/k8s LOCALDATADIR=/app/data on the
 *      animaxia-data volume).
 *
 *   workerData : { serviceName, boot, workerBootId, intervalMs }
 *   → parent   : { type: 'heartbeat', at }
 *                { type: 'task', ok, at, runMs,
 *                    detail: { providers: { tmdb: {...}, jikan: {...} },
 *                              thumbnails: n, thumbnailsDir } }
 *   ← parent   : { type: 'run' }  → run the check immediately
 *
 * DELIBERATELY DB-free and dependency-free (node: builtins only) — the DB
 * ping lives in /health (health.js); the worker must stay cheap and never
 * compete with request traffic for pool connections. The repo-root .env is
 * loaded explicitly because worker isolates do not inherit the main
 * process's dotenv/config call.
 */

import { parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';

// services/content-service → ../../.env is the repo root .env.
dotenv.config({ path: fileURLToPath(new URL('../../.env', import.meta.url)) });

const intervalMs = Math.max(5000, parseInt(workerData?.intervalMs || '300000', 10));
const PROBE_TIMEOUT_MS = 5000;

const TMDB_BASE = process.env.TMDBBASEURL || 'https://api.themoviedb.org/3';
const JIKAN_BASE = process.env.JIKANBASEURL || 'https://api.jikan.moe/v4';

function post(message) {
  try {
    parentPort?.postMessage(message);
  } catch {
    /* the parent may be shutting down — never crash the thread over a post */
  }
}

/**
 * One provider probe: GET the base URL (some providers reject HEAD) and treat
 * ANY HTTP response as reachable. Never throws.
 */
async function probeProvider(name, base) {
  const startedAt = Date.now();
  try {
    const res = await fetch(base, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers: { accept: 'application/json' },
    });
    return { name, reachable: true, status: res.status, ms: Date.now() - startedAt };
  } catch (err) {
    return { name, reachable: false, status: null, ms: Date.now() - startedAt, error: String(err?.message || err) };
  }
}

/**
 * Count files in the thumbnails directory (same LOCALDATADIR resolution rule
 * as common/db.js: env override, else ./data relative to the cwd). A missing
 * directory reports 0 + missing: true — never throws.
 */
async function countThumbnails() {
  const dataDir = process.env.LOCALDATADIR
    ? path.resolve(process.env.LOCALDATADIR)
    : path.resolve('./data');
  const thumbsDir = path.join(dataDir, 'thumbnails');
  try {
    const entries = await fs.readdir(thumbsDir, { withFileTypes: true });
    const files = entries.filter((e) => e.isFile());
    return { thumbnails: files.length, thumbnailsDir: thumbsDir, missing: false };
  } catch {
    return { thumbnails: 0, thumbnailsDir: thumbsDir, missing: true };
  }
}

/** One full task run — catch-all errors become a failed task post. */
async function runTask() {
  const startedAt = Date.now();
  try {
    const [tmdb, jikan, thumbs] = await Promise.all([
      probeProvider('tmdb', TMDB_BASE),
      probeProvider('jikan', JIKAN_BASE),
      countThumbnails(),
    ]);
    post({
      type: 'task',
      ok: true,
      at: new Date().toISOString(),
      runMs: Date.now() - startedAt,
      detail: {
        providers: { tmdb, jikan },
        ...thumbs,
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
