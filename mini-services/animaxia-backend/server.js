/**
 * server.js — Animaxia backend composition root: Express app, middleware stack,
 * module routers, core content/health/miner routes, DB boot + seeding,
 * graceful shutdown. Listens on PORT (default 4000).
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto'; // TS3 (observability): trace-id generation

import { initDb, listContent, getContentById, getContentByExternalId, upsertContent, deleteContent, countContent, countsByType, driverInfo, poolStats, closeDb, closeShardPools, listShardPools, lastDbActivityAt, query as dbQuery } from './db.js'; // closeShardPools + listShardPools added in FAZA 13 (sharding); lastDbActivityAt added for NEON FREE PLAN optimization; dbQuery added AR10M (/api/health/db manual probe)
import { cache, cacheMiddleware } from './cache.js';
import { rateLimitMiddleware, rateLimitStats } from './rateLimit.js';
import { logger, requestLogger } from './utils/logger.js';
import { breakerStats } from './utils/fetcher.js';
import { mineUrl } from './miner.js';
import { seed } from './seed.js';
import { playerAllowedTypes, resolvePlayer } from './modules/player/player.js';
import { baseAuthSecret } from './modules/tenant/jwt-tenant.js';
import animeRouter from './modules/anime/jikan.js';
import { moviesRouter, tvRouter } from './modules/movies/tmdb.js';
import footballRouter from './modules/sports/football.js';
import basketballRouter from './modules/sports/basketball.js';
import f1Router from './modules/sports/f1.js';

/* Phase-2 platform modules (users, premium, social, ai, analytics, search, cache, workers, security, mobile) */
import { ensurePlatformSchema } from './modules/platform/migrations.js';
import { events } from './modules/platform/events.js';
import { authRouter, attachUser, requireAuth, requireAdmin } from './modules/users/auth.js';
import ar10mRouter, { registerThumbRoute } from './modules/ar10m/routes.js'; // AR10M: real 10M architecture (stats/shards/search/budget/thumbs)
import { securityRouter, auditLog, clientIpOf } from './modules/security/security.js';
import profileRouter from './modules/users/profile.js';
import { plansRouter } from './modules/premium/plans.js';
import stripeRouter from './modules/premium/stripe.js';
import { commentsRouter } from './modules/social/comments.js';
import { feedRouter } from './modules/social/feed.js';
import aiRouter from './modules/ai/ai.js';
import { homeAiRouter } from './modules/ai/home.js'; // FAZA 15: AI Home engine (/api/ai/home/*)
import { hubAiRouter } from './modules/ai/hub.js'; // FAZA 16-b: AI Hub — 6 new AIs (/api/ai/hub/*)
import { aiSuiteRouter } from './modules/aisuite/routes.js'; // FAZA 32 (AI SUITE 100X): 18 motoare AI noi (/api/ai/suite/*) — 100% aditiv
import analyticsRouter from './modules/analytics/analytics.js';
import searchRouter from './modules/search/search.js';
import searchAccelRouter from './modules/searchaccel/index.js'; // FAZA 29-P: accel în jurul motorului protejat (zero atingeri ale acestuia)
import searchUxRouter, { scheduleCuratorReap } from './modules/searchux/index.js'; // FAZA 33 (PLAN 100X · WS3): strat UX căutare — suggest/trending/facets/track (consumă doar API-uri protejate prin loopback); scheduleCuratorReap: NEON FREE PLAN event-driven reaper
import playerxRouter from './modules/playerx/index.js'; // FAZA 34 (PLAN 100X · WS4): strat player experience — markeri episod + setări subtitrări + voturi party (player-ul FAZA 17 protejat doar consumat)
import { aiLabRouter } from './modules/ainew/routes.js'; // FAZA 35 (PLAN 100X · WS5): AI Lab — 8 capabilități AI noi (/api/ai/lab/*) — 100% aditiv
import { persoRouter } from './modules/perso/index.js'; // FAZA 36-R (PLAN 100X · WS6): Personalizare & Recomandări 2.0 — profil de gust + feed „Pentru Tine" + profile cu PIN + memento-uri (/api/perso/*) — 100% aditiv
import searchConsoleRouter from './modules/search/console-routes.js'; // FAZA 29-R: consolele admin restaurate aditiv
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
import { ensureShardingSchema } from './modules/sharding/migrations.js';

/* FAZA 14 (discover): live category feeds for every sidebar menu — TMDB
 * discover slugs, franchise & trilogy hubs. (Radio Live eliminat la cererea
 * utilizatorului — curățare secțiuni Muzică/Documentare/Gaming/Știri/Radio/
 * Divertisment/Show-biz/Reality TV/Emisiuni TV.) */
import { discoverRouter } from './modules/discover/discover.js';
import { franchiseRouter, trilogyRouter } from './modules/discover/collections.js';

/* FAZA 16 (Task 16-a): global source dedup registry (contentsources) +
 * real scale report (live measurements, honest verdicts). */
import ingestRouter from './modules/ingest/dedup.js';
import metadataIngestRouter from './modules/ingest/metadata.js';
import metadataQueueRouter from './modules/ingest/queue-routes.js';
import sourceRegistryRouter from './modules/ingest/source-routes.js';
import providerCatalogRouter from './modules/providers/routes.js';
import { startProviderAutoSync, stopProviderAutoSync } from './modules/providers/auto-sync.js';
import openSearchRoutes from './modules/search/opensearch-routes.js';
import { startOpenSearchWorker, stopOpenSearchWorker } from './modules/search/opensearch.js';
import pgShadowRouter from './modules/postgres/routes.js';
import { startPgShadowWorker,stopPgShadowWorker } from './modules/postgres/shadow.js';
import { startDistributedShadow,stopDistributedShadow } from './modules/postgres/distributed-shadow.js';
import { startMinerAutoSync, stopMinerAutoSync } from './modules/miner/auto-sync.js';
import { ensureMetadataQueueSchema, startMetadataQueueWorker, stopMetadataQueueWorker } from './modules/ingest/queue.js';
import scaleRouter from './modules/platform/scale.js';

/* FAZA 17-a (Task 17-a): resilience core (per-request timeout, load shedding,
 * event-loop/memory monitors, watchdog) + stress laboratory at /api/platform
 * — strictly additive. AR10M: fostul catalog virtual 30B simulat de aici a
 * fost eliminat (fost 30B simulat — eliminat); au rămas doar suite-urile
 * reale search/ingest/mixed. */
import { resilienceMiddleware, stabilitySnapshot } from './modules/platform/resilience.js';
import platformRouter from './modules/platform/stress.js';

/* FAZA 13 (Task 13-3): shard admin/observability router — /api/shards
 * (infra status + per-shard synthetics + admin cluster reindex), fed by the
 * search/vector cluster services in services/. */
import shardingRouter from './modules/sharding/routes.js';

/* FAZA 20 (hub): public hub API — faceted browse, stats, scale, dimensions,
 * feed, recommendations (9 real routes on /api/hub). */
import hubRouter from './modules/hub/hub.js';

/* FAZA 21 (cont utilizator + playerhub): playlists reale, subtitrări WebVTT,
   stats personale, admin playerhub — strictly additive. */
import { ensureFaza21Schema } from './modules/platform/faza21-migrations.js';
import playlistsRouter from './modules/users/playlists.js';
import subtitlesRouter from './modules/player/subtitles.js';
import { playerhubRouter, mystatsRouter } from './modules/analytics/playerhub.js';
import { playerHubRouter } from './modules/player/hub.js'; // FAZA 19 (restaurat FAZA 29-R): player hub — playlists/progress/subtitles/stats (per-route auth în router)

/* TS1 (security/integrity): DB integrity migrations — case-insensitive unique
   usernames, orphan cleanup, FKs from searchdocs/contentsources to content. */
import { ensureIntegritySchema } from './modules/platform/integrity-migrations.js';

/* TS3 (auth avansat): email verification + 2FA TOTP columns (users.*) and the
   emailtokens table; plus the shared-state distributed limiter demo router. */
import { ensureAuthExtraSchema } from './modules/users/auth-extra-migrations.js';
import sharedStateRouter from './modules/platform/shared-state.js';

/* TS2b (admin producție): user management (listare + ban/promovare cu gărzi)
   și coada de moderare — users.banned ensured idempotent în ensureAdminUsersSchema. */
import { adminUsersRouter, adminModerationRouter, ensureAdminUsersSchema } from './modules/users/admin-users.js';

/* FAZA 13 (Task 13-5, ops): search/vector cluster snapshots + per-node health
 * for the 'shards' metrics collector namespace (animaxia_db_shard_*,
 * animaxia_search_cluster_*, animaxia_vector_cluster_*). */
import { searchClusterOpsSnapshot, searchCluster } from './services/search-cluster/index.js';
import { vectorClusterOpsSnapshot, vectorCluster } from './services/vector-cluster/index.js';

/* FAZA 23 (observability): OTel span export + FAZA-23 metric families — strictly additive; failures are silent and never affect request handling. */
import { setupObservability, observabilityMetricsHandler } from './modules/observability/otel.js';

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
/* TS1 (security): CORS allowlist — production default is STRICT (only the
 * CORS_ORIGIN entries + local dev origins); CORSMODE=mirror (dev/sandbox)
 * explicitly reflects the request origin instead of the old de-facto
 * wildcard (`|| true`). No Origin header (curl / same-origin) is always OK. */
const CORS_ALLOWLIST = [
  ...(process.env.CORS_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean),
  ...(process.env.NODE_ENV !== 'production'
    ? ['http://localhost:81', 'http://localhost:3000'] : []),
];
const CORS_MIRROR = process.env.NODE_ENV !== 'production' && process.env.CORSMODE === 'mirror';
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // non-browser caller (curl / same-origin)
      if (CORS_MIRROR) return cb(null, origin); // sandbox: explicit mirror of the caller origin
      return cb(null, CORS_ALLOWLIST.includes(origin) ? origin : false); // strict: allowlist only
    },
  }),
);

/* TS1 (security): baseline security headers on every response — JSON API +
 * gateway, so no CSP here; nosniff, same-origin framing, strict referrer and
 * sensitive browser permissions switched off. */
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  // TS3 (API versioning): contract /api/* = v1. Breaking changes get a
  // selectively mounted /api/v2 (new router) — existing consumers stay on v1.
  res.set('X-API-Version', '1');
  next();
});
app.use(express.json({ limit: '2mb' })); // 2mb: avatar data-URL uploads

/* TS3 (observability): W3C Trace Context propagation — when an incoming
 * `traceparent` header (format `00-<trace-id>-<span-id>-<flags>`, trace-id =
 * exactly 32 hex chars) is present its trace-id is adopted; otherwise a fresh
 * 32-hex id is generated (crypto.randomUUID without dashes). Every response
 * echoes X-Trace-Id, and requestLogger puts it on the access line (or in the
 * JSON log entry under LOGFORMAT=json).
 * OpenTelemetry-ready WITHOUT any otel dependency (documented honestly): an
 * otel collector / gateway in front of the backend can pick up X-Trace-Id for
 * trace correlation — TRACINGENABLED / OTELSENDPOINT / OTELSAMPLERATE in .env
 * are consumed by the edge/gateway staging configs, not by this process.
 * Runs BEFORE requestLogger so access lines always carry the trace id. */
app.use((req, res, next) => {
  let traceId = null;
  const traceparent = req.headers['traceparent'];
  if (typeof traceparent === 'string') {
    const m = /^[\da-f]{2}-([\da-f]{32})-[\da-f]{16}-[\da-f]{2}$/i.exec(traceparent.trim());
    if (m) traceId = m[1].toLowerCase(); // safe-parse: only well-formed ids propagate
  }
  if (!traceId) traceId = crypto.randomUUID().replace(/-/g, '');
  req.traceId = traceId;
  res.set('X-Trace-Id', traceId);
  next();
});
app.use(requestLogger);
app.use(rateLimitMiddleware);
app.use(attachUser); // req.user (from Bearer token) available platform-wide
app.use(metrics.middleware()); // FAZA 9 ops: request counters + latency histograms (finish-hook, no behavior change)
app.use(resilienceMiddleware); // FAZA 17-a: per-request timeout + load shedding + in-flight gauge (before all routes)

/* FAZA 23 (observability): span middleware + pipeline wrap (observation only). */
setupObservability(app);

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
app.use('/api/tv', cacheMiddleware(), tvRouter);
app.use('/api/sports/football', cacheMiddleware(), footballRouter);
app.use('/api/sports/basketball', cacheMiddleware(), basketballRouter);
app.use('/api/sports/f1', cacheMiddleware(), f1Router);

/* ---------------------------- platform (Phase 2) ---------------------------- */

app.use('/api/auth', authRouter);
// FAZA 21: personal stats — mounted BEFORE the profile router so its /me/stats
// literal path is claimed first (profileRouter has no /me/stats route, so the
// order is also safe in reverse — this is the defensive, documented spot).
app.use('/api/users/me/stats', requireAuth, mystatsRouter);
app.use('/api/users', requireAuth, profileRouter);
app.use('/api/premium', plansRouter, stripeRouter);
app.use('/api/social', commentsRouter, feedRouter);
/* FAZA 10 (social): additive mounts — new paths only (people, follow/unfollow,
   following/followers, user/:id/profile, reviews/*, party*, parties, feed/v2). */
app.use('/api/social', socialFollowsRouter, socialReviewsRouter, socialActivityRouter, socialPartyRouter);
app.use('/api/ai/social', socialAiRouter); // friends-also-watched, taste matches, review digest
/* NEON FREE PLAN (scale-to-zero): curator-watch — DOAR cererile care pot lansa
 * curatorScan() (cross-join similarity O(n²)) programează reaper-ul one-shot
 * din searchux. Înainte: reaper-ul interoga pg_stat_activity la 10s, 24/7,
 * ținând Neon treaz permanent. Acum: zero trafic DB de fundal fără utilizatori. */
app.use('/api/ai/hub', (req, _res, next) => {
  if (req.method === 'GET' && (req.path === '/status' || req.path === '/curator/scan')) {
    scheduleCuratorReap();
  }
  next();
});
app.use('/api/ai/hub', hubAiRouter); // FAZA 16-b: must precede /api/ai (curator, forecaster, semantic, watchdog, marathon, translator)
app.use('/api/ai/home', homeAiRouter); // FAZA 15: must precede /api/ai (feed, taxonomy, stats, metadata, trailers, settings, browse)
app.use('/api/ai/suite', aiSuiteRouter); // FAZA 32 (AI SUITE 100X): must precede /api/ai — 18 motoare noi, namespace dedicat
app.use('/api/ai', aiRouter);
app.use('/api/analytics', analyticsRouter);
app.use('/api/search', searchRouter);
app.use('/api/search', searchConsoleRouter); // FAZA 29-R: consolele admin (flow/rate/opt/stress GET) — restaurare aditivă, searchRouter protejat neatins
app.use('/api/searchaccel', searchAccelRouter); // FAZA 29-P (PLAN 100X): strat accelerare ADITIV — keepalive pool + LRU + warming prin loopback (pipeline-ul protejat doar consumat)
app.use('/api/searchux', searchUxRouter); // FAZA 33 (PLAN 100X · WS3): strat UX căutare ADITIV — autocomplete instant + trending anonimizat + fațete + did-you-mean (motorul protejat doar consumat)
app.use('/api/playerx', playerxRouter); // FAZA 34 (PLAN 100X · WS4): strat UX player ADITIV — markeri skip-intro/outro/recap + subtitle studio + vot următorul episod (contract înghețat FAZA-34-b/c)
app.use('/api/ai/lab', aiLabRouter); // FAZA 35 (PLAN 100X · WS5): AI Lab (modules/ainew) ADITIV — companion/recap/mood/shield/dubbing/curation/voice/editor (namespace nou; /api/ai existent are doar căi literale — cade prin el fără conflict, identic /api/ai/tenant)
app.use('/api/perso', persoRouter); // FAZA 36-R (PLAN 100X · WS6): Personalizare (modules/perso) ADITIV — profil de gust învățat pasiv + feed „Pentru Tine" + profile multiple cu PIN + memento-uri de încheiere (namespace nou, zero schemă DB, recomandările existente neatinse)
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
app.use('/api/franchises', cacheMiddleware(), franchiseRouter);
app.use('/api/trilogies', cacheMiddleware(), trilogyRouter);

// FAZA 16 (Task 16-a): /api/ingest MUST precede the content routes below;
// /api/scale is independent (additive mount).
app.use('/api/ingest', ingestRouter);
app.use('/api/ingest', metadataIngestRouter);
app.use('/api/ingest', metadataQueueRouter);
app.use('/api/integrations/sources', sourceRegistryRouter);
app.use('/api/integrations/providers', providerCatalogRouter);
app.use('/api/search', openSearchRoutes);
app.use('/api/migration/postgres', pgShadowRouter);
app.use('/api/scale', scaleRouter);

// FAZA 13 (Task 13-3): /api/shards — sharding model/schema/pools/cluster
// health + ops counters (public read-only) and admin cluster reindex.
app.use('/api/shards', shardingRouter);

// FAZA 17-a: /api/platform — stability snapshot + stress lab cu suite REALE
// (AR10M: fostul catalog virtual 30B simulat — eliminat).
// (no pre-existing /api/platform routes — verified before mounting).
// TS3: shared-state demo mounts FIRST so its literal /shared-state/status path
// is claimed before the FAZA-17 platform router (defensive, both are additive).
app.use('/api/platform/shared-state', sharedStateRouter);
app.use('/api/platform', platformRouter);

/* FAZA 20 (hub): public hub API — faceted browse, stats, scale, dimensions, feed, recommendations. */
app.use('/api/hub', cacheMiddleware(), hubRouter);

/* FAZA 21 (cont utilizator + playerhub): real playlists, WebVTT subtitles
   (public read + admin upsert), admin playerhub gauges — strictly additive
   mounts; /api/player/* and /api/playlists were unused before FAZA 21. */
app.use('/api/playlists', requireAuth, playlistsRouter);
app.use('/api/player/subtitles', subtitlesRouter);
/* FAZA 19 (restaurat FAZA 29-R — pierdut la restaurarea snapshot FAZA 24): player hub
 * la /api/playerhub — status/playlists/progress/continue-watching/subtitles/stats;
 * auth per-rută în interiorul routerului (mount public, ca în canonical). */
app.use('/api/playerhub', playerHubRouter);
app.use('/api/admin/playerhub', requireAuth, requireAdmin, playerhubRouter);

/* TS2b (admin producție): user management + moderare — strict aditiv;
   /api/admin/users și /api/admin/moderation erau neocupate înainte. */
app.use('/api/admin/users', requireAuth, requireAdmin, adminUsersRouter);
app.use('/api/admin/moderation', requireAuth, requireAdmin, adminModerationRouter);

/* ── AR10M: arhitectura reală 10M — catalog minimal (ar10m.content +
 * ar10m.content_sources), shard-router 15 Neon, search-gateway real,
 * buget Neon cu mod economic, thumbnails pe tabletă. Pool-urile shard se
 * creează LAZY (prima interogare reală), zero polling, zero boot-DB. */
app.use('/api/ar10m', ar10mRouter);
registerThumbRoute(app); // GET /thumb/:id — ETag + Cache-Control + placeholder (AR10M §7)

/* -------------------------------- core routes -------------------------------- */

/* ── AR10M (STRICT) — /api/health are ZERO acces PostgreSQL ──
 *
 * Regula utilizatorului (AR10M §5): „Endpointul public /health nu trebuie
 * să interogheze PostgreSQL." Implementare STRICTĂ:
 *   1. /api/health citește EXCLUSIV din memorie (cache-ul healthStats) —
 *      nu declanșează NICIODATĂ vreo interogare Neon, nici măcar fire-and-forget.
 *   2. Valorile totalItems/countsByType se reîmprospătează DOAR piggyback pe
 *      traficul REAL de conținut (piggybackStatsRefresh() din /api/all —
 *      rulat după ce listContent a atins efectiv DB-ul) sau la scrieri reale
 *      (content:changed → dirty → următorul /api/all piggyback).
 *   3. Dacă nu există încă valori (boot proaspăt, zero trafic), /api/health
 *      servește onest totalItems: null + statsFetchedAt: null.
 *   4. Deep-probe manual = /api/health/db (admin, timeout 2s, zero polling).
 * driverInfo() rămâne instant (memorie), la fel toate celelalte câmpuri. */
const HEALTH_STATS_TTL_MS = Math.max(300_000, parseInt(process.env.HEALTHSTATSTTLMS || '3600000', 10) || 3_600_000);
const HEALTH_DB_ACTIVE_WINDOW_MS = Math.max(60_000, parseInt(process.env.HEALTHDBACTIVEMS || '300000', 10) || 300_000);
let healthStats = { totalItems: null, byType: null, fetchedAt: 0, dirty: false, inflight: null };

function healthDbStatsFresh() {
  return healthStats.totalItems !== null && Date.now() - healthStats.fetchedAt < HEALTH_STATS_TTL_MS && !healthStats.dirty;
}

async function refreshHealthDbStats() {
  if (!healthStats.inflight) {
    healthStats.inflight = Promise.all([countContent(), countsByType()])
      .then(([totalItems, byType]) => {
        healthStats = { totalItems, byType, fetchedAt: Date.now(), dirty: false, inflight: null };
        return { totalItems, byType, fetchedAt: healthStats.fetchedAt, stale: false };
      })
      .catch((err) => {
        healthStats.inflight = null; // la eșec păstrăm valorile vechi (stale) — health nu pică din cauza statisticelor
        throw err;
      });
  }
  return healthStats.inflight;
}

/* AR10M: strict zero-DB — /api/health citește DOAR cache-ul din memorie. */
function healthDbStatsFor() {
  if (healthStats.totalItems === null) {
    // boot proaspăt, zero trafic real — onest: încă nemăsurat
    return { totalItems: null, byType: null, fetchedAt: 0, stale: false };
  }
  return { totalItems: healthStats.totalItems, byType: healthStats.byType, fetchedAt: healthStats.fetchedAt, stale: !healthDbStatsFresh() };
}

/* AR10M: reîmprospătare piggyback — apelat DOAR din trafic real de conținut
 * (/api/all), niciodată din /api/health. Fire-and-forget, rate-limit intern
 * de inflight + doar când DB-ul e activ real (lastDbActivityAt recent). */
function piggybackStatsRefresh() {
  if (healthDbStatsFresh() || healthStats.inflight) return;
  if (Date.now() - lastDbActivityAt() > HEALTH_DB_ACTIVE_WINDOW_MS) return; // DB idle → nu trezim Neon
  refreshHealthDbStats().catch(() => {});
}

events.on('content:changed', () => {
  healthStats.dirty = true; // reîmprospătare piggyback la următorul trafic real
});

app.get(
  '/api/health',
  wrap(async (req, res) => {
    const stats = healthDbStatsFor(); // AR10M: strict zero-DB — cache din memorie, NICIODATĂ interogare Neon
    const stability = stabilitySnapshot(); // FAZA 17-a
    res.json({
      status: 'ok',
      service: 'animaxia-backend',
      version: VERSION,
      env: process.env.NODE_ENV || 'development',
      uptimeSec: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
      db: {
        ...driverInfo(),
        totalItems: stats.totalItems,
        countsByType: stats.byType,
        statsFetchedAt: stats.fetchedAt ? new Date(stats.fetchedAt).toISOString() : null,
        statsStale: stats.stale === true, // onest: true ⇒ valori din cache, DB idle (scale-to-zero)
        probe: 'memory-only', // AR10M: /api/health nu interoghează PostgreSQL
      },
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

/* ── AR10M §5: GET /api/health/db — deep-probe MANUAL, protejat admin ──
 * Regula utilizatorului: „acces protejat pentru admin, rulează numai manual,
 * timeout maxim 2 secunde, fără polling automat." Auth: header X-Admin-Token
 * (comparație timing-safe cu AR10M_ADMIN_TOKEN) SAU sesiune admin existentă.
 * ZERO polling — nicio componentă din platformă NU apelează acest endpoint
 * automat (watchdog-ul verifică doar procesul, edge-live probează /api/health
 * zero-DB on-demand). */
function adminTokenOk(req) {
  const expected = process.env.AR10M_ADMIN_TOKEN;
  if (!expected) return false;
  const given = req.get('x-admin-token') || '';
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(a, b);
}

app.get(
  '/api/health/db',
  wrap(async (req, res) => {
    const authorized = adminTokenOk(req) || req.user?.isadmin === true;
    if (!authorized) {
      return res.status(403).json({
        ok: false,
        error: 'acces-respins',
        hint: 'necesită header X-Admin-Token (AR10M_ADMIN_TOKEN) sau sesiune admin — probe manual, zero polling',
      });
    }
    const t0 = Date.now();
    try {
      const withTimeout = (promise, ms) =>
        Promise.race([promise, new Promise((_, reject) => {
          const t = setTimeout(() => reject(new Error(`timeout ${ms}ms`)), ms);
          if (typeof t.unref === 'function') t.unref();
        })]);
      const ping = await withTimeout(dbQuery('SELECT 1'), 2000); // timeout maxim 2s
      const latencyMs = Date.now() - t0;
      let totalItems = null;
      try {
        totalItems = (await withTimeout(dbQuery('SELECT COUNT(*) AS n FROM content'), 2000)).rows[0].n;
      } catch { /* onest: count indisponibil, ping-ul e suficient */ }
      res.json({
        ok: true,
        probe: 'manual-only',
        db: { ...driverInfo(), latencyMs, totalItems },
        measuredAt: new Date().toISOString(),
      });
      void ping;
    } catch (err) {
      res.status(503).json({
        ok: false,
        probe: 'manual-only',
        error: err.message,
        latencyMs: Date.now() - t0,
        measuredAt: new Date().toISOString(),
      });
    }
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

/* FAZA 23 (observability): FAZA-23 metric families (pipeline/hub/ai/auth/player + otel export) — Prometheus text or ?format=json (public aggregate data, like /api/metrics). */
app.get(
  '/api/observability/metrics',
  wrap(async (req, res) => observabilityMetricsHandler(req, res)),
);

/* NEON FREE PLAN — cache catalog 60 min: rutele DB-backed de content primesc
 * TTL lung (CONTENTCACHETTLMS, default 60 min) cu invalidare EXISTENTĂ la
 * orice mutație de conținut (invalidateHttpCache() → clearPrefix('http:') +
 * content:changed, deja apelate de server.js/miner/workers/ai-hub). Astfel
 * homepage-ul (/api/all) atinge Neon doar la primul vizitator după invalidare. */
const CONTENT_CACHE_TTL_MS = Math.max(60_000, parseInt(process.env.CONTENTCACHETTLMS || '3600000', 10) || 3_600_000);

app.get(
  '/api/all',
  cacheMiddleware({ ttlMs: CONTENT_CACHE_TTL_MS }),
  wrap(async (req, res) => {
    const result = await listContent({
      page: parseInt(req.query.page, 10) || 1,
      limit: parseInt(req.query.limit, 10) || 20,
      type: req.query.type || undefined,
      search: req.query.search || undefined,
      sort: req.query.sort === 'title' ? 'title' : 'createdat',
    });
    piggybackStatsRefresh(); // AR10M: reîmprospătare statistic health piggyback pe trafic REAL (nu din /api/health)
    res.status(200).json({ ...result, ...localFallbackWarning() });
  }),
);

app.get(
  '/api/content/external/:externalid',
  cacheMiddleware({ ttlMs: CONTENT_CACHE_TTL_MS }),
  wrap(async (req, res) => {
    const row = await getContentByExternalId(safeDecode(req.params.externalid));
    if (!row) return res.status(404).json({ error: 'Content not found' });
    return res.json(row);
  }),
);

app.get(
  '/api/content/:id',
  cacheMiddleware({ ttlMs: CONTENT_CACHE_TTL_MS }),
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

/* TS1 (security): DELETE content is a privileged mutation — requireAuth + requireAdmin. */
app.delete(
  '/api/content/:id',
  requireAuth,
  requireAdmin,
  wrap(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid content id' });
    }
    const deleted = await deleteContent(id);
    if (!deleted) return res.status(404).json({ error: 'Content not found' });
    invalidateHttpCache();
    // TS1: targeted id event for the incremental searchdocs sync.
    events.emit('content:changed:ids', { ids: [id], action: 'delete' });
    await auditLog({ userid: req.user?.id ?? null, action: 'content.delete', ip: clientIpOf(req), meta: { id, title: deleted.title } });
    return res.json({ ok: true, deleted });
  }),
);

/* TS1 (security): POST content is an authenticated mutation (anonymous
 * "Add to Animaxia" now gets 401 — the frontend adjusts separately). */
app.post(
  '/api/content',
  requireAuth,
  wrap(async (req, res) => {
    const { externalid, type, title, thumbnail, metadata } = req.body || {};
    if (!externalid || !title) {
      return res.status(400).json({ error: 'Missing required fields: externalid, title' });
    }
    const { record, created } = await upsertContent({ externalid, type, title, thumbnail, metadata });
    invalidateHttpCache();
    // TS1: targeted id event for the incremental searchdocs sync (full-resync
    // 'content:changed' above stays for seed & friends).
    events.emit('content:changed:ids', { ids: [record.id], action: created ? 'create' : 'update' });
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
    // TS1: targeted id event for the incremental searchdocs sync (upsert path).
    if (record?.id) events.emit('content:changed:ids', { ids: [record.id], action: 'update' });
    await auditLog({ userid: req.user?.id ?? null, action: 'miner.run', ip: clientIpOf(req), meta: { url, id: record?.id } });
    return res.json({ ok: true, extraction, record });
  } catch (err) {
    return res.status(err.status || 502).json({ error: err.message || 'Mining failed' });
  }
}

// GET /api/miner also UPSERTs (explicitly uncached — every call re-mines and re-upserts).
// TS1 (security): mining upserts content — both verbs now require authentication.
app.get('/api/miner', requireAuth, requireAdmin, wrap(handleMine));
app.post('/api/miner', requireAuth, requireAdmin, wrap(handleMine));

/* TS1 (security): seeding is an admin-only mutation. */
app.post(
  '/api/admin/seed',
  requireAuth,
  requireAdmin,
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

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || 500;
  logger.error(`[error] ${req.method} ${req.originalUrl} → ${status}: ${err.message}`);
  // TS1 (security): 5xx bodies stay generic — internal/PG error details never
  // leak to clients (full message keeps going to the server log). Sub-500
  // errors (validation, 4xx) keep their honest message.
  if (status >= 500) {
    return res.status(status).json({ error: 'Internal server error' });
  }
  return res.status(status).json({ error: err.message || 'Error' });
});

/* ---------------------------------- boot ------------------------------------ */

async function main() {
  // Refuse to expose a production service without a safe, shared JWT signing key.
  if (process.env.NODE_ENV === 'production') baseAuthSecret();
  await initDb();

  // Durable JSON metadata imports: schema always available, worker opt-in.
  // Keep this separate from miner's existing TMDB/Jikan persistent job queue.
  try {
    ensureMetadataQueueSchema();
    startMetadataQueueWorker();
  } catch (err) {
    logger.error('[boot] JSON metadata queue unavailable: ' + err.message);
  }
  // Independent optional integrations must not be skipped when an unrelated
  // miner/provider subsystem fails to initialize.
  for (const [name, start] of [
    ['provider-auto-sync', startProviderAutoSync],
    ['opensearch-outbox', startOpenSearchWorker],
    ['postgres-shadow', startPgShadowWorker],
    ['postgres-distributed', startDistributedShadow],
  ]) {
    try { start(); }
    catch (err) { logger.warn('[boot] '+name+' disabled: '+err.message); }
  }

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
    startMinerAutoSync(); // env-gated TMDB/Jikan periodic scheduling
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

  // FAZA 21 (cont utilizator + playerhub) schema (playlists, playlistitems,
  // subtitles) — idempotent; failures degrade the FAZA-21 routes to 503
  // while the rest of the platform is unaffected.
  try {
    await ensureFaza21Schema();
  } catch (err) {
    logger.warn(`[boot] FAZA 21 schema degraded (playlists/subtitles/playerhub will 503): ${err.message}`);
  }

  // TS1 (security/integrity): unique usernames (case-insensitive), orphan
  // cleanup, FKs searchdocs/contentsources → content — idempotent; failures
  // degrade to the previous behavior (no FK enforcement) without blocking boot.
  try {
    await ensureIntegritySchema();
    logger.info(`[boot] Integrity schema verified (unique usernames, orphans cleaned, FKs enforced)`);
  } catch (err) {
    logger.warn(`[boot] Integrity schema degraded (uniqueness/FK enforcement partial): ${err.message}`);
  }

  // TS3 (auth avansat): emailverification + 2FA columns on users + emailtokens
  // table — idempotent; failures degrade the verify/2FA routes honestly
  // without affecting the core auth flows.
  try {
    await ensureAuthExtraSchema();
  } catch (err) {
    logger.warn(`[boot] Auth-extra schema degraded (email-verify/2FA will be partial): ${err.message}`);
  }

  // TS2b (admin producție): users.banned column for the ban/unban flow —
  // idempotent; failures degrade the admin-users PATCH (banned) honestly.
  try {
    await ensureAdminUsersSchema();
  } catch (err) {
    logger.warn(`[boot] Admin-users schema degraded (ban/unban will fail): ${err.message}`);
  }

  try {
    const count = await countContent();
    if (count === 0) {
      logger.info('[boot] Empty database — seeding initial content…');
      const result = await seed();
      logger.info(
        `[boot] Seeded demo:${result.added.demo} movie:${result.added.movie} tv:${result.added.tv} anime:${result.added.anime} (animeSource=${result.animeSource}, totalItems=${result.totalItems})`,
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
    stopMetadataQueueWorker();
    stopMinerAutoSync();
    stopProviderAutoSync();
    stopOpenSearchWorker();
    await stopDistributedShadow();
    await stopPgShadowWorker();
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
