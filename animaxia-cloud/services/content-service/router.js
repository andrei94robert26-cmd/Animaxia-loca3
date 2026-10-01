/**
 * services/content-service/router.js — contentRouter: EVERYTHING the gateway
 * routes to content-service (BLUEPRINT §3), mounted at '/' by server.js.
 *
 * Composition (registration order mirrors the monolith server.js EXACTLY —
 * every handler body, validation, status code and JSON shape is a verbatim
 * port of `mini-services/animaxia-backend/server.js` lines 89-249, so the
 * frontend contracts survive the extraction unchanged):
 *
 *   1.  /api/anime           cacheMiddleware() + jikan animeRouter
 *   2.  /api/movies          cacheMiddleware() + tmdb moviesRouter
 *   3.  /api/tv              cacheMiddleware() + tvmazeRouter, tmdb tvRouter
 *                             (tvmaze /schedule MUST be registered before the
 *                             TMDB tv router so the paths coexist)
 *   4.  /api/sports/football cacheMiddleware() + footballRouter
 *   5.  /api/sports/f1       cacheMiddleware() + f1Router
 *   6.  /api/news            cacheMiddleware() + rss newsRouter
 *   7.  /api/cache           advancedCacheRouter (domain)
 *   8.  GET /api/all                    listContent (page/limit/type/search/sort)
 *   9.  GET /api/content/external/:externalid
 *   10. GET /api/content/:id            (integer id validation)
 *   11. DELETE /api/content/:id         + invalidate + audit 'content.delete'
 *   12. POST /api/content               upsert + invalidate + audit
 *                                       'content.create'|'content.update'
 *   13. GET /api/content/:id/player     getContentById → resolvePlayer
 *   14. GET|POST /api/miner             handleMine (uncached — every call
 *                                       re-mines and re-upserts) + audit 'miner.run'
 *   15. POST /api/admin/seed            seed() + invalidate + audit 'admin.seed'
 *
 * The monolith's GET /api/health is intentionally NOT ported: in the cloud the
 * gateway owns /api/health (aggregated fan-out) and every service exposes its
 * own GET /health via createService (db ping + content counts — see health.js).
 *
 * Auth note (mirrors the monolith): the core mutation routes are open at the
 * service boundary exactly as in the monolith — auditLog records
 * req.user?.id ?? null (createService's attachUser populates req.user from the
 * forwarded Bearer token). In the cloud topology the gateway's edge ACL
 * admin-gates /api/admin/* before requests reach this service. The domain
 * advancedCacheRouter applies its own requireAuth+requireAdmin on
 * POST /api/cache/invalidate internally.
 */

import express from 'express';
import { listContent, getContentById, getContentByExternalId, upsertContent, deleteContent, driverInfo } from '@animaxia/common/db.js';
import { cache, cacheMiddleware } from '@animaxia/common/cache.js';
import { wrap } from '@animaxia/common/middleware.js';
import { emitPlatform } from '@animaxia/common/events.js';
import animeRouter from '@animaxia/domain/providers/jikan.js';
import { moviesRouter, tvRouter } from '@animaxia/domain/providers/tmdb.js';
import tvmazeRouter from '@animaxia/domain/providers/tvmaze.js';
import footballRouter from '@animaxia/domain/providers/football.js';
import f1Router from '@animaxia/domain/providers/f1.js';
import newsRouter from '@animaxia/domain/providers/rss.js';
import advancedCacheRouter from '@animaxia/domain/cache/advancedCache.js';
import { resolvePlayer } from '@animaxia/domain/player/player.js';
import { mineUrl } from '@animaxia/domain/miner/miner.js';
import { seed } from '@animaxia/domain/platform/seed.js';
import { auditLog, clientIpOf } from '@animaxia/domain/security/security.js';

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function localFallbackWarning() {
  return driverInfo().driver === 'local-fallback'
    ? { warning: 'PostgreSQL credentials rejected — serving from local fallback store' }
    : {};
}

/** Invalidate cached HTTP responses after any data mutation (provider cache stays warm).
 *  Also notifies platform modules (search index, advanced cache) via the event bus.
 *  (Monolith used events.emit('content:changed'); emitPlatform wraps the same
 *  EventEmitter emit with a never-throws guard — identical semantics.) */
export function invalidateHttpCache() {
  cache.clearPrefix('http:');
  emitPlatform('content:changed');
}

export const contentRouter = express.Router();

/* ------------------------------- module routers ------------------------------ */

contentRouter.use('/api/anime', cacheMiddleware(), animeRouter);
contentRouter.use('/api/movies', cacheMiddleware(), moviesRouter);
// TVmaze's /schedule must be registered before the TMDB tv router so the paths coexist.
contentRouter.use('/api/tv', cacheMiddleware(), tvmazeRouter, tvRouter);
contentRouter.use('/api/sports/football', cacheMiddleware(), footballRouter);
contentRouter.use('/api/sports/f1', cacheMiddleware(), f1Router);
contentRouter.use('/api/news', cacheMiddleware(), newsRouter);

/* ---------------------------- platform (advanced cache) --------------------- */

contentRouter.use('/api/cache', advancedCacheRouter);

/* -------------------------------- core routes -------------------------------- */

contentRouter.get(
  '/api/all',
  cacheMiddleware(),
  wrap(async (req, res) => {
    const result = await listContent({
      page: parseInt(req.query.page, 10) || 1,
      limit: parseInt(req.query.limit, 10) || 20,
      type: req.query.type || undefined,
      search: req.query.search || undefined,
      sort: req.query.sort === 'title' ? 'title' : 'createdat',
    });
    res.status(200).json({ ...result, ...localFallbackWarning() });
  }),
);

contentRouter.get(
  '/api/content/external/:externalid',
  cacheMiddleware(),
  wrap(async (req, res) => {
    const row = await getContentByExternalId(safeDecode(req.params.externalid));
    if (!row) return res.status(404).json({ error: 'Content not found' });
    return res.json(row);
  }),
);

contentRouter.get(
  '/api/content/:id',
  cacheMiddleware(),
  wrap(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid content id' });
    }
    const row = await getContentById(id);
    if (!row) return res.status(404).json({ error: 'Content not found' });
    return res.json(row);
  }),
);

contentRouter.delete(
  '/api/content/:id',
  wrap(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid content id' });
    }
    const deleted = await deleteContent(id);
    if (!deleted) return res.status(404).json({ error: 'Content not found' });
    invalidateHttpCache();
    await auditLog({ userid: req.user?.id ?? null, action: 'content.delete', ip: clientIpOf(req), meta: { id, title: deleted.title } });
    return res.json({ ok: true, deleted });
  }),
);

contentRouter.post(
  '/api/content',
  wrap(async (req, res) => {
    const { externalid, type, title, thumbnail, metadata } = req.body || {};
    if (!externalid || !title) {
      return res.status(400).json({ error: 'Missing required fields: externalid, title' });
    }
    const { record, created } = await upsertContent({ externalid, type, title, thumbnail, metadata });
    invalidateHttpCache();
    await auditLog({ userid: req.user?.id ?? null, action: created ? 'content.create' : 'content.update', ip: clientIpOf(req), meta: { id: record.id, externalid } });
    return res.json({ ok: true, record, created });
  }),
);

contentRouter.get(
  '/api/content/:id/player',
  cacheMiddleware(),
  wrap(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid content id' });
    }
    const content = await getContentById(id);
    if (!content) return res.status(404).json({ error: 'Content not found' });
    const resolved = await resolvePlayer(content);
    return res.json(resolved);
  }),
);

async function handleMine(req, res) {
  const url = req.method === 'GET' ? req.query.url : req.body?.url;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'Missing url' });
  }
  const options =
    req.method === 'GET'
      ? { type: req.query.type, externalId: req.query.externalId }
      : { type: req.body?.type, externalId: req.body?.externalId };
  try {
    const { extraction, record } = await mineUrl(url, options);
    invalidateHttpCache();
    await auditLog({ userid: req.user?.id ?? null, action: 'miner.run', ip: clientIpOf(req), meta: { url, id: record?.id } });
    return res.json({ ok: true, extraction, record });
  } catch (err) {
    return res.status(err.status || 502).json({ error: err.message || 'Mining failed' });
  }
}

// GET /api/miner also UPSERTs (explicitly uncached — every call re-mines and re-upserts).
contentRouter.get('/api/miner', wrap(handleMine));
contentRouter.post('/api/miner', wrap(handleMine));

contentRouter.post(
  '/api/admin/seed',
  wrap(async (req, res) => {
    const result = await seed();
    invalidateHttpCache();
    await auditLog({ userid: req.user?.id ?? null, action: 'admin.seed', ip: clientIpOf(req), meta: { added: result.added } });
    return res.json({ ok: true, ...result });
  }),
);

export default contentRouter;
