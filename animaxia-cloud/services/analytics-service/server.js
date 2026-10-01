/**
 * services/analytics-service/server.js — Animaxia Cloud analytics service (:4004).
 *
 * Owns the /api/analytics route family (BLUEPRINT §3), backed by the extracted
 * domain module domain/analytics/analytics.js (raw view-event ingestion into
 * `viewevents`, trending windows, per-user activity reports, admin overview).
 *
 * Boot wiring (createService, BLUEPRINT §6):
 *   • initDb          → pg pool + content schema
 *   • ensureSchema    → ensurePlatformSchema (users/viewevents/content/… DDL)
 *   • attachUser      → true — POST /views attributes events to req.user when
 *                       a Bearer token is present (public player telemetry
 *                       endpoint); /user/:id and /overview guard themselves
 *                       with requireAuth (+ requireAdmin) and set req.user
 *                       from the token independently.
 *   • router          → analyticsRouter mounted at /api/analytics (exact
 *                       domain mount)
 *   • worker thread   → ./worker.thread.js every 15 min: idempotent daily
 *                       rollup of raw viewevents into `dailyviewrollups`
 *                       (INSERT … SELECT … ON CONFLICT upsert).
 */

import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { createService } from '@animaxia/common/service.js';
import { ensurePlatformSchema } from '@animaxia/common/migrations.js';
import analyticsRouter from '@animaxia/domain/analytics/analytics.js';
import { readiness } from './health.js';
import { analyticsRateLimit } from './rateLimit.js';
import './cache.js';

// NOTE: common/worker.js resolves a RELATIVE `file` against common/ itself, so
// services must pass an ABSOLUTE worker path (computed from this module). This
// works identically in dev (repo root) and in the Docker image (/app).
const workerFile = fileURLToPath(new URL('./worker.thread.js', import.meta.url));

createService({
  name: 'analytics-service',
  version: '3.0.0',
  port: 4004,
  portEnv: 'ANALYTICSPORT',
  initDb: true,
  ensureSchema: ensurePlatformSchema,
  attachUser: true,
  rateLimit: analyticsRateLimit, // 240/min per IP default — POST /views is the hottest write path in the platform
  routers: [{ path: '/api/analytics', router: analyticsRouter }],
  health: { readiness },
  worker: { file: workerFile, intervalMs: 900000 }, // daily rollup every 15 min
});

// Entry point — no default export (Bun 1.3 auto-serves objects with a port property).
