/**
 * services/search-service/server.js — Animaxia Cloud search service (:4005).
 *
 * Owns the /api/search route family (BLUEPRINT §3), backed by the extracted
 * domain module domain/search/search.js — a local OpenSearch-style engine:
 * in-process inverted index + BM25 ranking (k1=1.2, b=0.75) built from the
 * `content` table, Levenshtein fuzzy expansion (distance ≤ 2), prefix/word-
 * boundary autocomplete and field filters.
 *
 * Boot wiring (createService, BLUEPRINT §6):
 *   • initDb          → pg pool + content schema (the index source of truth)
 *   • ensureSchema    → ensurePlatformSchema (platform DDL; search itself
 *                       only reads `content`)
 *   • attachUser      → false — search is public; the admin-only
 *                       POST /api/search/index guards itself with
 *                       requireAuth + requireAdmin, which verify the Bearer
 *                       token and set req.user independently of attachUser.
 *   • router          → searchRouter mounted at /api/search (exact domain
 *                       mount)
 *   • worker thread   → ./worker.thread.js every 10 min: counts the content
 *                       table (docs + MAX(createdat) watermark) and reports
 *                       whether the corpus changed since the previous run.
 *
 * Cross-service staleness fix (IMPORTANT — how reindexing actually works
 * here): in the monolith all modules shared one process, so the platform
 * event `content:changed` marked the search index dirty immediately. In the
 * cloud, content upserts happen in content-service, so that event never
 * fires inside this process. The domain module exports only the router (no
 * rebuild function), and a worker thread cannot touch the main thread's
 * in-memory index. The sanctioned path is the platform event bus itself:
 * when the worker detects a corpus change, this server emits
 * `content:changed` on the in-process bus (common/events.js — the same
 * EventEmitter instance the domain module subscribed to at import time),
 * which sets the index's dirty flag; the next query then transparently
 * rebuilds the whole index under the module's async lock. Metadata-only
 * updates to pre-existing rows (no createdat/count movement) are covered by
 * the daily 04:00 `maintenance.reindex` queue job or a manual
 * POST /api/search/index (admin).
 */

import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { createService } from '@animaxia/common/service.js';
import { ensurePlatformSchema } from '@animaxia/common/migrations.js';
import { emitPlatform } from '@animaxia/common/events.js';
import { logger } from '@animaxia/common/logger.js';
import searchRouter from '@animaxia/domain/search/search.js';
import { readiness } from './health.js';
import { searchRateLimit } from './rateLimit.js';
import './cache.js';

// NOTE: common/worker.js resolves a RELATIVE `file` against common/ itself, so
// services must pass an ABSOLUTE worker path (computed from this module). This
// works identically in dev (repo root) and in the Docker image (/app).
const workerFile = fileURLToPath(new URL('./worker.thread.js', import.meta.url));

const svc = createService({
  name: 'search-service',
  version: '3.0.0',
  port: 4005,
  portEnv: 'SEARCHPORT',
  initDb: true,
  ensureSchema: ensurePlatformSchema,
  attachUser: false, // public search; POST /api/search/index self-guards via requireAuth
  rateLimit: searchRateLimit, // 240/min per IP default — autocomplete fires per keystroke
  routers: [{ path: '/api/search', router: searchRouter }],
  health: { readiness },
  worker: { file: workerFile, intervalMs: 600000 }, // corpus change detection every 10 min
});

/* ------------------- worker-driven reindex (dirty flag) ------------------- */

// Poll the worker's last task result; when it reports a corpus change, emit
// the platform event on the in-process bus so the domain module's
// `events.on('content:changed')` listener marks the index dirty (lazy
// rebuild on the next query). Same pattern as the gateway feeding its
// upstream gauge from worker probe results.
const WORKER_POLL_MS = 15000;
let lastHandledTaskAt = null;

const reindexTimer = setInterval(() => {
  try {
    const lastTask = svc.worker?.status()?.lastTask;
    if (!lastTask?.ok || !lastTask.detail || lastTask.at === lastHandledTaskAt) return;
    lastHandledTaskAt = lastTask.at;
    if (lastTask.detail.changed) {
      emitPlatform('content:changed');
      logger.info(
        `[search] Worker detected content change (docs=${lastTask.detail.docs}, latest=${lastTask.detail.latestContentAt ?? 'n/a'}) — index marked dirty, lazy rebuild on next query`,
      );
    }
  } catch {
    /* the reindex trigger must never break the service */
  }
}, WORKER_POLL_MS);
if (typeof reindexTimer.unref === 'function') reindexTimer.unref();

// Entry point — no default export (Bun 1.3 auto-serves objects with a port property).
