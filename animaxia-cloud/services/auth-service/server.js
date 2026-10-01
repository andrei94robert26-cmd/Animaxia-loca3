/**
 * services/auth-service/server.js — Animaxia Cloud auth-service (:4001).
 *
 * Owns the identity plane (BLUEPRINT §3):
 *   • /api/auth     — domain/users/auth.js   (register/login/refresh/logout/me,
 *                     brute-force protection, rotating refresh tokens)
 *   • /api/users    — domain/users/profile.js (mount-level requireAuth:
 *                     profile, avatar, watchlist, history, preferences)
 *   • /api/security — domain/security/security.js (mount-level
 *                     requireAuth+requireAdmin: status + audit trail)
 *   • /internal     — verifyAdmin.js: the FROZEN gateway admin-check contract
 *                     (POST /internal/verify-admin { sub } → { ok, admin, user }).
 *                     Internal-only: the gateway is the sole intended caller;
 *                     it caches results (true AND false) for 60s per sub, so
 *                     the call volume is ≤ 1 per admin per minute. createService
 *                     mounts its global limiter (120/min/IP) ahead of the
 *                     routers — plenty of headroom for that.
 *
 * The gateway forwards the original Authorization header on every proxied
 * request; createService's attachUserFromToken then sets req.user process-wide
 * and the domain requireAuth/requireAdmin guards re-verify per mount (same
 * publicUser() shape — identical contract to the monolith).
 *
 * Worker thread (./worker.thread.js, every 5 min): deletes expired + aged-out
 * revoked refresh tokens from the shared `refreshtokens` table.
 */

import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { createService } from '@animaxia/common/service.js';
import { ensurePlatformSchema } from '@animaxia/common/migrations.js';
import { logger } from '@animaxia/common/logger.js';
import { authRouter, usersRouter, securityAdminRouter } from './router.js';
import { verifyAdminRouter } from './verifyAdmin.js';
import { serviceRateLimit } from './rateLimit.js';
import { readiness } from './health.js';

/* NOTE: common/worker.js resolves a RELATIVE `file` against common/ itself, so
   services must pass an ABSOLUTE worker path (computed from this module). This
   works identically in dev (repo root) and in the Docker image (/app). */
const workerFile = fileURLToPath(new URL('./worker.thread.js', import.meta.url));
const WORKER_INTERVAL_MS = 300000; // 5 minutes

const svc = createService({
  name: 'auth-service',
  version: '3.0.0',
  port: 4001,
  portEnv: 'AUTHPORT',
  initDb: true, // shared pg pool + content schema (users FKs reference content)
  ensureSchema: ensurePlatformSchema, // platform DDL: users, refreshtokens, watchlist, …
  attachUser: true, // req.user from the forwarded Bearer token (publicUser shape)
  rateLimit: serviceRateLimit,
  routers: [
    { path: '/internal', router: verifyAdminRouter }, // gateway admin-check (frozen contract)
    { path: '/api/auth', router: authRouter },
    { path: '/api/users', router: usersRouter }, // requireAuth + profileRouter
    { path: '/api/security', router: securityAdminRouter }, // requireAuth + requireAdmin + securityRouter
  ],
  health: { readiness },
  worker: {
    file: workerFile,
    intervalMs: WORKER_INTERVAL_MS,
    workerData: { intervalMs: WORKER_INTERVAL_MS },
  },
});

/* Surface the latest refresh-token cleanup counts in the logs (the worker
   thread posts its results; createService records them in the handle). */
const workerLogTimer = setInterval(() => {
  try {
    const lastTask = svc.worker?.status()?.lastTask;
    if (lastTask && lastTask.ok && lastTask.detail) {
      logger.debug(`[auth] refresh-token cleanup: ${JSON.stringify(lastTask.detail)}`);
    }
  } catch {
    /* never let observability break the service */
  }
}, WORKER_INTERVAL_MS);
if (typeof workerLogTimer.unref === 'function') workerLogTimer.unref();

// Entry point — no default export (Bun 1.3 auto-serves objects with a port property).
