/**
 * services/queue-service/server.js — Animaxia Cloud queue-service (:4009).
 *
 * The async backbone of the platform (BLUEPRINT §10):
 *   • /api/queue  — the durable PG job queue REST surface (router.js):
 *     enqueue/list/retry/delete jobs, stats, cron tick + schedules.
 *   • /api/workers — the monolith-compatible worker API (workersCompat.js):
 *     mine/prefetch/thumbnails/refresh enqueue onto the same PG queue and the
 *     jobs list/status/thumbnail-file endpoints map onto it.
 *
 * Three concurrent engines boot with the service:
 *   1. Consumer pool (consumers.js, started after boot): polls the `jobs`
 *      table every QUEUEPOLLMS and runs up to QUEUECONCURRENCY handlers
 *      in-process (SKIP LOCKED claiming, leases, quadratic-backoff retries).
 *   2. Cron scheduler (cron.js, started after boot): evaluates the six frozen
 *      schedules every 30s when QUEUESCHEDULERENABLED !== 'false'.
 *   3. Maintenance worker thread (./worker.thread.js, every 30s): reclaims
 *      lease-expired jobs (requeueStale) and purges finished ones
 *      (purgeFinished) — belt & braces on top of the SQL lease semantics.
 *
 * Schema: ensurePlatformSchema FIRST (auditlogs/refreshtokens/viewevents are
 * used by the maintenance + batch handlers), then ensureQueueSchema (jobs).
 */

import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { createService } from '@animaxia/common/service.js';
import { ensurePlatformSchema } from '@animaxia/common/migrations.js';
import { ensureQueueSchema } from '@animaxia/common/queue.js';
import { logger } from '@animaxia/common/logger.js';
import { queueRouter } from './router.js';
import { workersCompatRouter } from './workersCompat.js';
import { startConsumers } from './consumers.js';
import { startScheduler } from './cron.js';
import { serviceRateLimit } from './rateLimit.js';
import { readiness } from './health.js';

/* NOTE: common/worker.js resolves a RELATIVE `file` against common/ itself, so
   services must pass an ABSOLUTE worker path (computed from this module). This
   works identically in dev (repo root) and in the Docker image (/app). */
const workerFile = fileURLToPath(new URL('./worker.thread.js', import.meta.url));
const WORKER_INTERVAL_MS = 30000; // stale-lease reclaim + finished-job purge

const svc = createService({
  name: 'queue-service',
  version: '3.0.0',
  port: 4009,
  portEnv: 'QUEUEPORT',
  initDb: true, // shared pg pool + content schema
  ensureSchema: async () => {
    // Platform tables first (handlers write auditlogs / clean refreshtokens /
    // roll up viewevents), then the queue's own `jobs` table.
    await ensurePlatformSchema();
    await ensureQueueSchema();
  },
  attachUser: true, // req.user for requireAuth/requireAdmin guards
  rateLimit: serviceRateLimit,
  routers: [
    { path: '/api/queue', router: queueRouter },
    { path: '/api/workers', router: workersCompatRouter },
  ],
  health: { readiness },
  worker: {
    file: workerFile,
    intervalMs: WORKER_INTERVAL_MS,
    workerData: { intervalMs: WORKER_INTERVAL_MS },
  },
});

/* Consumers + cron scheduler start only after the DB pool and schemas are
   ready (createService resolves bootPromise after initDb → ensureSchema).
   Both loops keep unref'd timers so they never hold the process open. */
svc.bootPromise
  .then(() => {
    startConsumers();
    startScheduler();
  })
  .catch((err) => logger.warn(`[queue] post-boot start failed: ${err.message}`));

// Entry point — no default export (Bun 1.3 auto-serves objects with a port property).
