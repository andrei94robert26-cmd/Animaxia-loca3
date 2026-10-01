/**
 * server.js — Animaxia backend composition root: Express app, middleware stack,
 * module routers, core content/health/miner routes, DB boot + seeding,
 * graceful shutdown. Listens on PORT (default 4000).
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';

import { initDb, listContent, getContentById, getContentByExternalId, upsertContent, deleteContent, countContent, countsByType, driverInfo, poolStats, closeDb, closeShardPools, listShardPools } from './db.js'; // closeShardPools + listShardPools added in FAZA 13 (sharding)
import { cache, cacheMiddleware } from './cache.js';
import { rateLimitMiddleware, rateLimitStats } from './rateLimit.js';
import { logger, requestLogger } from './utils/logger.js';
import { breakerStats } from './utils/fetcher.js';
import { mineUrl } from './miner.js';
import { seed } from './seed.js';
import { playerAllowedTypes, resolvePlayer, resolveExternalSource } from './modules/player/player.js';
import animeRouter from './modules/anime/jikan.js';
import { moviesRouter, tvRouter } from './modules/movies/tmdb.js';
import tvmazeRouter from './modules/tv/tvmaze.js';
import footballRouter from './modules/sports/football.js';
import f1Router from './modules/sports/f1.js';
import newsRouter from './modules/news/rss.js';

/* Phase-2 platform modules (users, premium, social, ai, analytics, search, cache, workers, security, mobile) */
import { ensurePlatformSchema } from './modules/platform/migrations.js';
import { events } from './modules/platform/events.js';
import { authRouter, attachUser, requireAuth, requireAdmin } from './modules/users/auth.js';
import { securityRouter, auditLog, clientIpOf } from './modules/security/security.js';
import profileRouter from './modules/users/profile.js';
import { plansRouter } from './modules/premium/plans.js';
import stripeRouter from './modules/premium/stripe.js';
import { commentsRouter } from './modules/social/comments.js';
import { feedRouter } from './modules/social/feed.js';
import aiRouter from './modules/ai/ai.js';
import { homeAiRouter } from './modules/ai/home.js'; // FAZA 15: AI Home engine (/api/ai/home/*)
import { hubAiRouter } from './modules/ai/hub.js'; // FAZA 16-b: AI Hub — 6 new AIs (/api/ai/hub/*)
import analyticsRouter from './modules/analytics/analytics.js';
import searchRouter from './modules/search/search.js';
import advancedCacheRouter from './modules/cache/advancedCache.js';
import workersRouter from './modules/workers/workers.js';
import mobileRouter from './modules/mobile/mobile.js';

/* Phase-4 AI Cloud layer (llm-core, vector-service, rag-engine, tools,
   animaxiaAssistant, personal AI, admin AI) — extends /api/ai + adds /api/vector */
import { aicloudRouter, vectorRouter, ensureAicloudSchema, aicloudBoot } from './modules/aicloud/router.js';
import { llmProviderStatus, llmUsageStats, aiQuotaStatus } from './modules/aicloud/llm-core.js';
import { vectorStatus } from './modules/aicloud/vector-service.js';
import { metrics, registerStandardCollectors, registerShardingCollectors } from './modules/ops/metrics.js'; // FAZA 9 ops + FAZA 13-5 sharding collectors

/* FAZA 10 (social): follows, reviews, activity feed v2, watch parties,
   AI × social — additive routers, no changes to Phase-2 comments/feed. */
import { ensureSocialSchema } from './modules/social/social-migrations.js';
import { socialFollowsRouter } from './modules/social/follows.js';
import { socialReviewsRouter } from './modules/social/reviews.js';
import { socialActivityRouter, initSocialActivity } from './modules/social/activity.js';
import { socialPartyRouter } from './modules/social/watchparty.js';
import { socialAiRouter } from './modules/social/aisocial.js';

/* FAZA 11 (multi-tenant): tenant registry, tenant-aware auth/JWT helpers,
   tenant AI Cloud quotas + scoped vector search, admin tenant CRUD,
   metered billing — strictly additive, contracts frozen. */
import { ensureTenantSchema } from './modules/tenant/tenant-migrations.js';
import { tenantAdminRouter, tenantContextRouter } from './modules/tenant/tenant-routes.js';
import { tenantAiRouter } from './modules/tenant/tenant-ai.js';
import { tenantBillingRouter } from './modules/tenant/billing.js';

/* FAZA 12 (miner): ingest + indexing service — persistent job queue in Neon
 * (miner_jobs/sources/logs/manifests), TMDB/Jikan providers, tenant-scoped
 * vector indexing + search catalog push — strictly additive. */
import { ensureMinerSchema } from './modules/miner/miner-migrations.js';
import { minerBoot } from './modules/miner/core.js';
import minerRouter from './modules/miner/routes.js';

/* FAZA 13 (sharding): shardid columns on content/searchdocs/vectorembeddings
 * (logical sharding by default — dedicated Neon branch pools activate via
 * SHARD{N}URL, see db.js + modules/sharding/). */
import { ensureShardingSchema, restampVectorShardIds } from './modules/sharding/migrations.js';

/* FAZA 14 (discover): live category feeds for every sidebar menu — TMDB
 * discover slugs, real radio-browser stations, franchise & trilogy hubs. */
import { discoverRouter } from './modules/discover/discover.js';
import { radioRouter } from './modules/discover/radio.js';
import { franchiseRouter, trilogyRouter } from './modules/discover/collections.js';

/* FAZA 16 (Task 16-a): global source dedup registry (contentsources) +
 * real scale report (live measurements, honest verdicts). */
import ingestRouter from './modules/ingest/dedup.js';
import scaleRouter from './modules/platform/scale.js';

/* FAZA 17-a (Task 17-a): resilience core (per-request timeout, load shedding,
 * event-loop/memory monitors, watchdog) + stress laboratory + virtual 30B
 * catalog at /api/platform — strictly additive. */
import { resilienceMiddleware, stabilitySnapshot } from './modules/platform/resilience.js';
import platformRouter from './modules/platform/stress.js';

/* FAZA 13 (Task 13-3): shard admin/observability router — /api/shards
 * (infra status + per-shard synthetics + admin cluster reindex), fed by the
 * search/vector cluster services in services/. */
import shardingRouter from './modules/sharding/routes.js';

/* FAZA 13 (Task 13-5, ops): search/vector cluster snapshots + per-node health
 * for the 'shards' metrics collector namespace (animaxia_db_shard_*,
 * animaxia_search_cluster_*, animaxia_vector_cluster_*). */
import { searchClusterOpsSnapshot, searchCluster } from './services/search-cluster/index.js';
import { vectorClusterOpsSnapshot, vectorCluster } from './services/vector-cluster/index.js';

/* FAZA 15 (Search Flow Control): the 'searchflow' metrics collector —
 * animaxia_search_* series (queue, inflight, windowing, dropped, …) fed by
 * modules/search/flow.js. */
import { searchFlowMetricsSnapshot } from './modules/search/flow.js';

/* FAZA 16 (Search Rate Management): the 'searchrate' metrics collector —
 * animaxia_search_rate_* / animaxia_search_cooldown_active /
 * animaxia_search_spam_blocked / animaxia_search_burst_events series fed by
 * modules/search/rate.js. */
import { searchRateMetricsSnapshot } from './modules/search/rate.js';

/* FAZA 17 (Search Optimization Layer): the 'searchopt' metrics collector —
 * animaxia_search_opt_* / animaxia_search_batch_hits / _cache_hits /
 * _cache_misses / animaxia_search_dedup_count series fed by
 * modules/search/opt.js. */
import { searchOptMetricsSnapshot } from './modules/search/opt.js';

/* FAZA 18 (Full Integration + Stress Test): the 'searchstress' metrics
 * collector — animaxia_search_pipeline_integrated / animaxia_search_stress_*
 * series (the integrated 10-stage pipeline contract + the last
 * 10,000-simultaneous-searches run verdict) fed by
 * modules/search/stress.js. */
import { searchStressMetricsSnapshot } from './modules/search/stress.js';

/* FAZA 19 (Task 19-1): Player Hub API — playlists, progress/resume (unified
 * watchhistory), continue-watching, WebVTT subtitle tracks + stats. Strictly
 * additive; modules/player/player.js (the REAL external player) untouched. */
import { playerHubRouter } from './modules/player/hub.js';

/* FAZA 20 (Task 20-1): Hub-urile API complete — faceted browse /content,
 *  /stats, /scale, /years, /genres, /actors, /studios, /feed,
 *  /recommendations. Strictly additive, 100% real SQL aggregates;
 *  modules/search/*, modules/sharding/* and player.js are imported
 *  read-only (status exports only). */
import { hubRouter } from './modules/hub/hub.js';

const PORT = parseInt(process.env.PORT || '4000', 10);
const VERSION = '1.0.0';
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

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
 *  Also notifies platform modules (search index, advanced cache) via the event bus. */
function invalidateHttpCache() {
  cache.clearPrefix('http:');
  events.emit('content:changed');
}

const app = express();
app.set('trust proxy', 1);

/* FAZA 9 (ops): pull collectors for /api/metrics — read live state from the
 * modules already imported above; nothing is polled until a scrape happens. */
registerStandardCollectors({
  driverInfo,
  poolStats,
  cacheStats: () => cache.stats(),
  breakerStats,
  llmProviderStatus,
  llmUsageStats,
  vectorStatus,
});
// FAZA 13 (Task 13-5, ops): per-shard pools + search/vector cluster metrics — 'shards' pull collector (additive).
registerShardingCollectors({
  listShardPools,
  searchClusterOpsSnapshot,
  searchClusterHealth: () => searchCluster.health(),
  vectorClusterOpsSnapshot,
  vectorClusterHealth: () => vectorCluster.health(),
});
// FAZA 15 (Search Flow Control): animaxia_search_* series — 'searchflow' pull collector (additive).
metrics.attachPull('searchflow', () => searchFlowMetricsSnapshot());
// FAZA 16 (Search Rate Management): animaxia_search_rate_* series — 'searchrate' pull collector (additive).
metrics.attachPull('searchrate', () => searchRateMetricsSnapshot());
// FAZA 17 (Search Optimization Layer): animaxia_search_opt_* series — 'searchopt' pull collector (additive).
metrics.attachPull('searchopt', () => searchOptMetricsSnapshot());
// FAZA 18 (Full Integration + Stress Test): animaxia_search_stress_* + pipeline series — 'searchstress' pull collector (additive).
metrics.attachPull('searchstress', () => searchStressMetricsSnapshot());
app.use(
  cors({
    origin: (origin, cb) => cb(null, !origin || origin === process.env.CORS_ORIGIN || true),
  }),
);
app.use(express.json({ limit: '2mb' })); // 2mb: avatar data-URL uploads
app.use(requestLogger);
app.use(rateLimitMiddleware);
app.use(attachUser); // req.user (from Bearer token) available platform-wide
app.use(metrics.middleware()); // FAZA 9 ops: request counters + latency histograms (finish-hook, no behavior change)
app.use(resilienceMiddleware); // FAZA 17-a: per-request timeout + load shedding + in-flight gauge (before all routes)

app.get('/', (req, res) => {
  res.json({
    service: 'animaxia-backend',
    version: VERSION,
    status: 'ok',
    docs: 'Try /api/health',
  });
});

/* ------------------------------- module routers ------------------------------ */

app.use('/api/anime', cacheMiddleware(), animeRouter);
app.use('/api/movies', cacheMiddleware(), moviesRouter);
// TVmaze's /schedule must be registered before the TMDB tv router so the paths coexist.
app.use('/api/tv', cacheMiddleware(), tvmazeRouter, tvRouter);
app.use('/api/sports/football', cacheMiddleware(), footballRouter);
app.use('/api/sports/f1', cacheMiddleware(), f1Router);
app.use('/api/news', cacheMiddleware(), newsRouter);

/* ---------------------------- platform (Phase 2) ---------------------------- */

app.use('/api/auth', authRouter);
app.use('/api/users', requireAuth, profileRouter);
app.use('/api/premium', plansRouter, stripeRouter);
app.use('/api/social', commentsRouter, feedRouter);
/* FAZA 10 (social): additive mounts — new paths only (people, follow/unfollow,
   following/followers, user/:id/profile, reviews/*, party*, parties, feed/v2). */
app.use('/api/social', socialFollowsRouter, socialReviewsRouter, socialActivityRouter, socialPartyRouter);
app.use('/api/ai/social', socialAiRouter); // friends-also-watched, taste matches, review digest
app.use('/api/ai/hub', hubAiRouter); // FAZA 16-b: must precede /api/ai (curator, forecaster, semantic, watchdog, marathon, translator)
app.use('/api/ai/home', homeAiRouter); // FAZA 15: must precede /api/ai (feed, taxonomy, stats, metadata, trailers, settings, browse)
app.use('/api/ai', aiRouter);
app.use('/api/analytics', analyticsRouter);
app.use('/api/search', searchRouter);
app.use('/api/cache', advancedCacheRouter);
app.use('/api/workers', workersRouter);
app.use('/api/security', requireAuth, requireAdmin, securityRouter);
app.use('/api/mobile', mobileRouter);

/* ---------------------------- AI Cloud (Phase 4) ---------------------------- */

app.use('/api/ai', aicloudRouter); // rag/*, assistant, personal/*, tools, admin/*, cloud/status
app.use('/api/vector', vectorRouter); // vector-service: status, search, index-content, index-user

/* ------------------------- Multi-tenant (FAZA 11) ------------------------- */

// Tenant AI surface — mounted BEFORE the base aicloud router would matter
// only if it had a /tenant catch-all (it does not — explicit literal paths
// only), so ordering here is defensive, not functional.
app.use('/api/ai/tenant', tenantAiRouter); // status, rag/:mode, vector/*, usage
app.use('/api/tenants', tenantAdminRouter, tenantBillingRouter); // admin CRUD + billing/*
app.use('/api/tenant', tenantContextRouter); // whoami context

// FAZA 12 (miner): ingest + indexing — jobs, status, search push.
app.use('/api/miner', minerRouter);

// FAZA 14 (discover): live sidebar menus + radio + franchise/trilogy hubs.
app.use('/api/discover', cacheMiddleware(), discoverRouter);
app.use('/api/radio', cacheMiddleware(), radioRouter);
app.use('/api/franchises', cacheMiddleware(), franchiseRouter);
app.use('/api/trilogies', cacheMiddleware(), trilogyRouter);

// FAZA 16 (Task 16-a): /api/ingest MUST precede the content routes below;
// /api/scale is independent (additive mount).
app.use('/api/ingest', ingestRouter);
app.use('/api/scale', scaleRouter);

// FAZA 13 (Task 13-3): /api/shards — sharding model/schema/pools/cluster
// health + ops counters (public read-only) and admin cluster reindex.
app.use('/api/shards', shardingRouter);

// FAZA 17-a: /api/platform — stability snapshot, stress lab, virtual 30B catalog
// (no pre-existing /api/platform routes — verified before mounting).
app.use('/api/platform', platformRouter);

/* FAZA 19: player hub — playlists, progress/resume, continue-watching,
   subtitle tracks, stats (public status/subtitle-reads/stats, per-route
   auth inside the router). */
app.use('/api/playerhub', playerHubRouter);

/* FAZA 20: hub-uri API complete — browse faceted, statistici, scară, ani/genuri/
   actori/studiouri, feed + recomandări (toate publice, cache 60s ca /api/discover). */
app.use('/api/hub', cacheMiddleware(), hubRouter);

/* -------------------------------- core routes -------------------------------- */

app.get(
  '/api/health',
  wrap(async (req, res) => {
    const [totalItems, byType] = await Promise.all([countContent(), countsByType()]);
    const stability = stabilitySnapshot(); // FAZA 17-a
    res.json({
      status: 'ok',
      service: 'animaxia-backend',
      version: VERSION,
      env: process.env.NODE_ENV || 'development',
      uptimeSec: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
      db: { ...driverInfo(), totalItems, countsByType: byType },
      cache: { ...cache.stats(), enabled: true, ttlMs: parseInt(process.env.CACHETTLMS || '60000', 10) },
      rateLimit: rateLimitStats(),
      providers: breakerStats(),
      player: { allowedTypes: playerAllowedTypes() },
      ai: { // FAZA 9 (ops): AI provider + per-caller quota snapshot
        provider: llmProviderStatus(),
        quota: aiQuotaStatus({ user: req.user ?? null, ip: clientIpOf(req) }),
      },
      stability: { // FAZA 17-a: live resilience gauges
        eventLoopLagP95Ms: stability.eventLoopLag.p95Ms,
        inFlight: stability.inFlight,
        shedCount: stability.shed.count,
      },
    });
  }),
);

/* FAZA 9 (ops): unified metrics — Prometheus text (default) or ?format=json.
 * Aggregate counters/gauges only; safe to expose like /api/health. */
app.get(
  '/api/metrics',
  wrap(async (req, res) => {
    if (req.query.format === 'json') {
      return res.json(await metrics.snapshot());
    }
    res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    return res.send(await metrics.renderPrometheus());
  }),
);

app.get(
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

app.get(
  '/api/content/external/:externalid',
  cacheMiddleware(),
  wrap(async (req, res) => {
    const row = await getContentByExternalId(safeDecode(req.params.externalid));
    if (!row) return res.status(404).json({ error: 'Content not found' });
    return res.json(row);
  }),
);

app.get(
  '/api/content/:id',
  cacheMiddleware(),
  wrap(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid content id' });
    }
    // FAZA 13 (sharding): gateway shard hint (x-animaxia-shard) — optional
    // read affinity; a bogus/absent header keeps the legacy unfiltered path.
    const shardHint = parseInt(req.headers['x-animaxia-shard'], 10);
    const row = await getContentById(id, { shardId: Number.isInteger(shardHint) && shardHint >= 0 ? shardHint : undefined });
    if (!row) return res.status(404).json({ error: 'Content not found' });
    return res.json(row);
  }),
);

app.delete(
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

app.post(
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

app.get(
  '/api/content/:id/player',
  cacheMiddleware(),
  wrap(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid content id' });
    }
    // FAZA 13 (sharding): pass the gateway shard hint through (same affinity
    // semantics as GET /api/content/:id).
    const shardHint = parseInt(req.headers['x-animaxia-shard'], 10);
    const content = await getContentById(id, { shardId: Number.isInteger(shardHint) && shardHint >= 0 ? shardHint : undefined });
    if (!content) return res.status(404).json({ error: 'Content not found' });
    const resolved = await resolvePlayer(content);
    return res.json(resolved);
  }),
);

/* FAZA 14 (Task 14-2): UNIVERSAL EXTERNAL PLAYBACK — resolve ANY external URL
 * (YouTube / Vimeo / Rumble / MP4 / HLS m3u8 / any iframe-embed JS) to a
 * playable descriptor with ZERO database access: the player never depends on
 * how many real content rows exist in Neon (definitive spec rule 4).
 * Policy-filtered (PLAYERALLOW* flags) + SSRF-guarded (private networks
 * blocked unless MINERALLOWPRIVATE_NETWORK=true). Public + cacheable. */
app.get(
  '/api/player/external',
  cacheMiddleware(),
  wrap(async (req, res) => {
    const resolved = resolveExternalSource(String(req.query.url || ''));
    if (!resolved.ok) {
      return res.status(400).json(resolved);
    }
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
app.get('/api/miner', wrap(handleMine));
app.post('/api/miner', wrap(handleMine));

app.post(
  '/api/admin/seed',
  wrap(async (req, res) => {
    const result = await seed();
    invalidateHttpCache();
    await auditLog({ userid: req.user?.id ?? null, action: 'admin.seed', ip: clientIpOf(req), meta: { added: result.added } });
    return res.json({ ok: true, ...result });
  }),
);

/* ------------------------------ error handling ------------------------------ */

app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Express error middleware requires the 4-arg signature (err, req, res, next).
app.use((err, req, res, next) => {
  const status = err.status || 500;
  logger.error(`[error] ${req.method} ${req.originalUrl} → ${status}: ${err.message}`);
  res.status(status).json({ error: err.message || 'Internal server error' });
});

/* ---------------------------------- boot ------------------------------------ */

async function main() {
  await initDb();

  // Phase-2 platform schema (users, tokens, watchlist, history, comments,
  // votes, likes, views, subscriptions, audit logs, ai chats) — idempotent.
  try {
    await ensurePlatformSchema();
  } catch (err) {
    logger.error(`[boot] Platform schema migration failed (platform modules will answer 503): ${err.message}`);
  }

  // Phase-4 AI Cloud schema (aiusagelogs, agentconversations, aiprofiles +
  // pgvector attempt) — idempotent; failures degrade to in-memory mode.
  try {
    await ensureAicloudSchema();
    aicloudBoot(); // vector backend init + background content auto-index
  } catch (err) {
    logger.warn(`[boot] AI Cloud schema degraded (in-memory mode): ${err.message}`);
    aicloudBoot();
  }

  // FAZA 10 (social) schema (follows, reviews, reviewlikes, activityevents,
  // watchparties, watchpartymembers, partymessages) — idempotent; failures
  // degrade social routes to 503 without affecting the rest of the platform.
  try {
    await ensureSocialSchema();
    initSocialActivity(); // platform-bus → activityevents mirror + realtime webhook
  } catch (err) {
    logger.warn(`[boot] Social schema degraded (social routes will answer 503): ${err.message}`);
  }

  // FAZA 11 (multi-tenant) schema (tenants, tenantusers, tenantlimits,
  // tenantconfig, tenantusageevents, tenantinvoices + additive tenantid
  // columns on vectorembeddings/refreshtokens) — idempotent; failures degrade
  // tenant routes to 503 while the rest of the platform stays on 'global'.
  try {
    await ensureTenantSchema();
  } catch (err) {
    logger.warn(`[boot] Tenant schema degraded (tenant routes will answer 503/404): ${err.message}`);
  }

  // FAZA 12 (miner) schema (miner_jobs, miner_sources, miner_logs,
  // miner_manifests) — idempotent; failures degrade miner routes to 503
  // while the rest of the platform is unaffected.
  let minerReady = false;
  try {
    await ensureMinerSchema();
    minerBoot(); // interrupted-job recovery + metrics collector + queue resume
    minerReady = true;
  } catch (err) {
    logger.warn(`[boot] Miner schema degraded (miner routes will answer 503): ${err.message}`);
  }

  // FAZA 13 (sharding): shardid columns on content/searchdocs/vectorembeddings — idempotent; failures degrade shard routing to legacy (shard 0).
  try {
    await ensureShardingSchema();
  } catch (err) {
    logger.warn(`[boot] Sharding schema degraded (shard routing falls back to legacy shard 0): ${err.message}`);
  }

  // FAZA 14: re-stamp vectorembeddings under the current hash rule (SHARDCOUNT
  // 4 → 30 changed the correct shardid for existing vector rows). Idempotent,
  // never throws, no-op once converged.
  try {
    await restampVectorShardIds();
  } catch {
    /* already never throws — belt and braces */
  }

  try {
    const count = await countContent();
    if (count === 0) {
      logger.info('[boot] Empty database — seeding initial content…');
      const result = await seed();
      logger.info(
        `[boot] Seeded openmovies:${result.added.openmovies} movie:${result.added.movie} tv:${result.added.tv} anime:${result.added.anime} (animeSource=${result.animeSource}, totalItems=${result.totalItems})`,
      );
    } else {
      logger.info(`[boot] Database already has ${count} items — skipping seed`);
    }
  } catch (err) {
    logger.error(`[boot] Seeding failed (non-fatal): ${err.message}`);
  }

  const info = driverInfo();
  const server = app.listen(PORT, () => {
    logger.info('============================================================');
    logger.info(`  ANIMAXIA BACKEND v${VERSION} — listening on http://localhost:${PORT}`);
    logger.info(`  DB driver: ${info.driver} (connected: ${info.connected})`);
    logger.info(`  Env: ${process.env.NODE_ENV || 'development'} · Cache TTL: ${process.env.CACHETTLMS}ms · Miner: ${minerReady ? 'ready' : 'degraded'}`);
    logger.info('============================================================');
  });

  const shutdown = async (signal) => {
    logger.info(`[shutdown] ${signal} received — closing server`);
    server.close(async () => {
      await closeDb();
      await closeShardPools(); // FAZA 13 (sharding): dedicated shard branch pools (main pool closed by closeDb)
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    logger.error(`[process] Unhandled rejection: ${reason instanceof Error ? reason.stack || reason.message : reason}`);
  });
  process.on('uncaughtException', (err) => {
    logger.error(`[process] Uncaught exception: ${err instanceof Error ? err.stack || err.message : err}`);
  });
}

main().catch((err) => {
  logger.error(`[boot] Fatal startup error: ${err.stack || err.message}`);
  process.exit(1);
});
