/**
 * services/mobile-service/server.js — Animaxia Cloud mobile-service (:4008).
 *
 * Mobile backend-for-frontend: a thin mount of the domain mobile router
 * (compact, bandwidth-friendly payloads for the Animaxia mobile client).
 * The router talks to the shared PostgreSQL directly (content, viewevents,
 * watchhistory, watchlist, users tables — the same database every service
 * uses; no in-process dependency on content-service), which is why
 * initDb + ensurePlatformSchema run here too.
 *
 * Boot (createService, BLUEPRINT §6): initDb → ensurePlatformSchema →
 * (no seeding — content-service owns that) → worker thread → listen.
 * attachUser is ON: the domain router's GET /home branches on req.user
 * (Continue-watching row) and GET /profile enforces requireAuth.
 *
 * Cache-warming posture (honest): the anonymous /api/mobile/home payload is
 * cached INSIDE the domain router via the advancedCache (key 'mobile:home',
 * 60s TTL, tagged 'content' → auto-invalidated on content:changed). The
 * cache builder (buildHome) is module-private in
 * @animaxia/domain/mobile/mobile.js, so this service cannot pre-warm it
 * in-process — it warms lazily on the first anonymous /home request after
 * boot or TTL expiry (a ≤60s cold window). The worker thread reports the
 * content count every 5 min as the refresh signal instead (see
 * worker.thread.js and README).
 */

import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { createService } from '@animaxia/common/service.js';
import { ensurePlatformSchema } from '@animaxia/common/migrations.js';
import { mobileApi } from './router.js';
import { mobileReadiness } from './health.js';
import { serviceRateLimit } from './rateLimit.js';

/* ----------------------------------- boot ----------------------------------- */

// NOTE: common/worker.js resolves a RELATIVE `file` against common/ itself, so
// services must pass an ABSOLUTE worker path (computed from this module). This
// works identically in dev (repo root) and in the Docker image (/app).
const workerFile = fileURLToPath(new URL('./worker.thread.js', import.meta.url));

createService({
  name: 'mobile-service',
  version: '3.0.0',
  port: 4008,
  portEnv: 'MOBILEPORT',
  initDb: true, // own pg pool over the shared database (content + platform tables)
  ensureSchema: ensurePlatformSchema, // viewevents/watchhistory/watchlist/users DDL
  attachUser: true, // req.user from the forwarded Bearer token (/home, /profile)
  rateLimit: serviceRateLimit,
  routers: [
    { path: '/api/mobile', router: mobileApi },
  ],
  worker: {
    file: workerFile,
    intervalMs: 300000, // 5 min — content refresh check (see worker.thread.js)
  },
  health: { readiness: mobileReadiness }, // db ping + content count
});

// Entry point — no default export (Bun 1.3 auto-serves objects with a port property).
