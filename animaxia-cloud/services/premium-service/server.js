/**
 * services/premium-service/server.js — Animaxia Cloud premium-service (:4006).
 *
 * Owns the monetization plane (BLUEPRINT §3):
 *   • /api/premium — plansRouter (GET /plans public, GET /me, GET /verify
 *     requireAuth) + stripeRouter (POST /checkout|/confirm|/cancel,
 *     requireAuth each) mounted together exactly like the monolith:
 *     app.use('/api/premium', plansRouter, stripeRouter).
 *
 *   Stripe modes are identical to the monolith: sandbox by default (no
 *   STRIPESECRETKEY, cs_sandbox_* sessions mirrored into `subscriptions`),
 *   live mode when STRIPESECRETKEY starts with 'sk_'.
 *
 * Worker thread (./worker.thread.js, every hour): expires lapsed paid plans —
 *   UPDATE users SET plan='free'
 *    WHERE planexpiresat IS NOT NULL AND planexpiresat < NOW() AND plan <> 'free'
 * The thread posts the expired ids; worker threads cannot emit into the main
 * process's platform event bus, so the main process logs the expirations here
 * (plan:changed cache invalidations happen naturally on the next user fetch —
 * requireAuth/attachUser always read a fresh row).
 */

import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { createService } from '@animaxia/common/service.js';
import { ensurePlatformSchema } from '@animaxia/common/migrations.js';
import { logger } from '@animaxia/common/logger.js';
import { premiumRouter } from './router.js';
import { serviceRateLimit } from './rateLimit.js';
import { readiness } from './health.js';

/* NOTE: common/worker.js resolves a RELATIVE `file` against common/ itself, so
   services must pass an ABSOLUTE worker path (computed from this module). This
   works identically in dev (repo root) and in the Docker image (/app). */
const workerFile = fileURLToPath(new URL('./worker.thread.js', import.meta.url));
const WORKER_INTERVAL_MS = 3600000; // 1 hour

const svc = createService({
  name: 'premium-service',
  version: '3.0.0',
  port: 4006,
  portEnv: 'PREMIUMPORT',
  initDb: true, // shared pg pool + content schema
  ensureSchema: ensurePlatformSchema, // platform DDL: users, subscriptions, auditlogs, …
  attachUser: true, // req.user from the forwarded Bearer token (publicUser shape)
  rateLimit: serviceRateLimit,
  routers: [{ path: '/api/premium', router: premiumRouter }],
  health: { readiness },
  worker: {
    file: workerFile,
    intervalMs: WORKER_INTERVAL_MS,
    workerData: { intervalMs: WORKER_INTERVAL_MS },
  },
});

/* Surface plan expirations in the main-process logs: poll the worker handle's
   last task and log once per new result (the worker cannot emit platform
   events across the isolate boundary). */
let lastLoggedTaskAt = null;
const workerLogTimer = setInterval(() => {
  try {
    const lastTask = svc.worker?.status()?.lastTask;
    if (lastTask && lastTask.ok && lastTask.at !== lastLoggedTaskAt) {
      lastLoggedTaskAt = lastTask.at;
      const expired = Array.isArray(lastTask.detail?.expiredUserIds)
        ? lastTask.detail.expiredUserIds.length
        : Number(lastTask.detail?.expired || 0);
      if (expired > 0) {
        logger.info(
          `[premium] Worker expired ${expired} lapsed plan(s) → free: ${JSON.stringify(lastTask.detail)}`,
        );
      } else {
        logger.debug(`[premium] Worker plan-expiry sweep: ${JSON.stringify(lastTask.detail)}`);
      }
    }
  } catch {
    /* never let observability break the service */
  }
}, 60000);
if (typeof workerLogTimer.unref === 'function') workerLogTimer.unref();

// Entry point — no default export (Bun 1.3 auto-serves objects with a port property).
