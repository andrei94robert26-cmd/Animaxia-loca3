/**
 * services/content-service/server.js — Animaxia Cloud content-service (:4002).
 *
 * The cloud extraction of the monolith's content surface: core content CRUD,
 * the URL miner, admin seeding, all six external providers (Jikan anime,
 * TMDB movies/tv, TVmaze schedule, football-data, Ergast F1, RSS news) and
 * the advanced-cache management router. Every route is defined in router.js
 * (contentRouter — verbatim port of the monolith core routes + provider
 * mounts); this file only wires the boot.
 *
 * Boot (createService, BLUEPRINT §6): initDb → ensurePlatformSchema →
 * seedIfEmpty (monolith boot seeding logic, see below) → worker thread →
 * listen. Middleware order is owned by createService (cors → json →
 * requestId → requestLogger → trace → metrics → rate limit → attachUser →
 * routers → health → metrics → 404 → errorHandler); attachUser is ON so
 * req.user is available to the miner/audit paths exactly like the monolith's
 * platform-wide `app.use(attachUser)`.
 *
 * Multi-replica note: with N content-service replicas booting against an
 * empty database, each runs seedIfEmpty — the resulting race is acceptable
 * because seed() only performs idempotent upserts keyed on externalid (all
 * replicas converge to the same rows; at worst duplicate work, never
 * duplicate rows).
 */

import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { createService } from '@animaxia/common/service.js';
import { countContent } from '@animaxia/common/db.js';
import { logger } from '@animaxia/common/logger.js';
import { ensurePlatformSchema } from '@animaxia/common/migrations.js';
import { seed } from '@animaxia/domain/platform/seed.js';
import { contentRouter, invalidateHttpCache } from './router.js';
import { contentReadiness } from './health.js';
import { serviceRateLimit } from './rateLimit.js';

/**
 * Monolith boot-seeding logic (server.js main(), verbatim semantics):
 * count the content table; when empty, seed demo items + TMDB trending
 * movies/TV + top anime (Jikan, TMDB fallback) and log the exact monolith
 * boot lines. seed() returns { added: { movie, tv, anime, demo },
 * totalItems, animeSource }. Never fatal — createService already wraps the
 * hook in a try/catch, and the inner catch keeps the monolith's own
 * "[boot] Seeding failed (non-fatal)" message.
 */
async function seedIfEmpty() {
  try {
    const count = await countContent();
    if (count === 0) {
      logger.info('[boot] Empty database — seeding initial content…');
      const result = await seed();
      logger.info(
        `[boot] Seeded demo:${result.added.demo} movie:${result.added.movie} tv:${result.added.tv} anime:${result.added.anime} (animeSource=${result.animeSource}, totalItems=${result.totalItems})`,
      );
      // Boot seeding mutates content like any other seed — invalidate the
      // (currently cold) HTTP cache and notify platform listeners for
      // symmetry with POST /api/admin/seed.
      invalidateHttpCache();
    } else {
      logger.info(`[boot] Database already has ${count} items — skipping seed`);
    }
  } catch (err) {
    logger.error(`[boot] Seeding failed (non-fatal): ${err.message}`);
  }
}

/* ----------------------------------- boot ----------------------------------- */

// NOTE: common/worker.js resolves a RELATIVE `file` against common/ itself, so
// services must pass an ABSOLUTE worker path (computed from this module). This
// works identically in dev (repo root) and in the Docker image (/app).
const workerFile = fileURLToPath(new URL('./worker.thread.js', import.meta.url));

createService({
  name: 'content-service',
  version: '3.0.0',
  port: 4002,
  portEnv: 'CONTENTPORT',
  initDb: true, // pg pool + content DDL (local JSON fallback when PG is down)
  ensureSchema: ensurePlatformSchema, // platform tables (auditlogs for auditLog, etc.)
  attachUser: true, // req.user from the forwarded Bearer token (miner/audit paths)
  seedIfEmpty,
  rateLimit: serviceRateLimit,
  routers: [
    // Single router mounted at '/' — every route inside is registered with its
    // FULL path (see router.js), so mounting at '/' reproduces the monolith's
    // app.use/route order one-to-one.
    { path: '/', router: contentRouter },
  ],
  worker: {
    file: workerFile,
    intervalMs: 300000, // 5 min — provider reachability prewarm + thumbnails check
  },
  health: { readiness: contentReadiness }, // db ping + content counts
});

// Entry point — no default export (Bun 1.3 auto-serves objects with a port property).
