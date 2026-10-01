/**
 * modules/platform/scale.js — FAZA 16-a → AR10M: REAL scale report (mounted
 * at /api/scale in server.js). Every number under `measured` is computed LIVE
 * (real SQL counters, real SELECT 1 timing, real cache/rate-limit/pool
 * gauges); the verdicts and gaps are honest engineering analysis with the
 * live numbers injected. The report states clearly that a single Node
 * process + a single Neon branch CANNOT sustain 10M users / 10M contents /
 * 10M concurrent searches today.
 *
 * AR10M: ținta 30B SIMULATĂ a fost ELIMINATĂ complet. Capacitatea se declară
 * separat și onest: (1) proiectată — 10.000.000 titluri pe arhitectura reală
 * 15-shard (ar10m.content + content_sources, hash routing); (2) testată —
 * progresiv prin benchmark real 10K → 100K → 1M rânduri; (3) demonstrată —
 * doar ce arată măsurătorile live. Contoarele afișate sunt EXCLUSIV reale.
 *
 * Routes (both public):
 *   GET /api/scale/report  → { measured, targets, verdicts, gaps, hardening, conclusion }
 *   GET /api/scale/metrics → light version for auto-refresh dashboards
 *                            (measured + verdict statuses)
 */

import express from 'express';
import { rows, one } from './sql.js';
import { query, poolStats } from '../../db.js';
import { cache } from '../../cache.js';
import { rateLimitStats } from '../../rateLimit.js';
import { breakerStats } from '../../utils/fetcher.js';
import { searchLatencySnapshot } from '../search/search.js';
import { stabilitySnapshot } from './resilience.js'; // FAZA 17-a
import { logger } from '../../utils/logger.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const TARGETS = {
  users: 10000000, // 10M utilizatori — capacitate PROIECTATĂ (nu garantată)
  connectedAccounts: 10000000, // 10M conturi conectate simultan — proiectată
  contents: 10000000, // 10M contente — capacitate PROIECTATĂ gradual (AR10M; fost 30B simulat — eliminat)
  concurrentSearches: 10000000, // 10M căutări simultane — proiectată
};

/* -------------------------------- measurement ------------------------------- */

async function measure() {
  const measured = {
    measuredAt: new Date().toISOString(),
    uptimeSec: Math.floor(process.uptime()),
  };

  // Real DB latency: one live SELECT 1 round-trip.
  try {
    const t0 = Date.now();
    await query('SELECT 1');
    measured.dbLatencyMs = Date.now() - t0;
  } catch (err) {
    measured.dbLatencyMs = null;
    void err;
  }

  // Search latency: rolling p50/p95 from the live search engine.
  measured.searchLatency = searchLatencySnapshot();

  // Live row counts.
  const counts = await Promise.allSettled([
    one('SELECT COUNT(*)::int AS n FROM content'),
    one('SELECT COUNT(*)::int AS n FROM users'),
    one('SELECT COUNT(*)::int AS n FROM searchdocs'),
    one('SELECT COUNT(*)::int AS n FROM contentsources'),
  ]);
  const [items, users, searchdocs, contentsources] = counts;
  measured.items = items.status === 'fulfilled' ? Number(items.value?.n ?? 0) : null;
  measured.users = users.status === 'fulfilled' ? Number(users.value?.n ?? 0) : null;
  measured.searchdocs = searchdocs.status === 'fulfilled' ? Number(searchdocs.value?.n ?? 0) : null;
  measured.contentsources = contentsources.status === 'fulfilled' ? Number(contentsources.value?.n ?? 0) : null;

  // Database size + top 10 tables by size.
  try {
    const sizeRow = await one('SELECT pg_database_size(current_database())::bigint AS size');
    measured.dbSizeBytes = Number(sizeRow?.size ?? 0);
    const tableRows = await rows(
      `SELECT c.relname AS name, pg_total_relation_size(c.oid)::bigint AS bytes
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r'
       ORDER BY bytes DESC LIMIT 10`,
    );
    measured.tableSizes = tableRows.map((r) => ({ name: r.name, bytes: Number(r.bytes) }));
  } catch (err) {
    measured.dbSizeBytes = null;
    measured.tableSizes = [];
    void err;
  }

  // In-process gauges.
  const cacheStats = cache.stats();
  measured.cache = { hitRate: cacheStats.hitRate, keys: cacheStats.keys };
  const rl = rateLimitStats();
  measured.rateLimit = { max: rl.max, windowMs: rl.windowMs };
  measured.providers = breakerStats().map((p) => ({ name: p.name, state: p.state, failures: p.failures }));

  // Neon deployment facts: branch (db name from DATABASEURL) + pool gauges.
  let branch = null;
  try {
    branch = new URL(process.env.DATABASEURL).pathname.replace(/^\//, '') || null;
  } catch {
    branch = null;
  }
  measured.neon = {
    branch,
    poolMax: parseInt(process.env.PGPOOLMAX || '10', 10),
    pool: poolStats(),
  };

  // FAZA 17-a: live resilience gauges + static hardening configuration.
  const stability = stabilitySnapshot();
  measured.stability = {
    eventLoopLagP95Ms: stability.eventLoopLag.p95Ms,
    rssBytes: stability.memory.rssBytes,
    inFlight: stability.inFlight,
    shedCount: stability.shed.count,
  };
  measured.resilience = {
    requestTimeoutMs: stability.config.requestTimeoutMs,
    loadSheddingEnabled: true,
    keysetPagination: true,
    offsetCap: 10000,
    watchdog: 'animaxia-watchdog',
  };

  return measured;
}

/* ---------------------------- verdicts and analysis --------------------------- */

function buildVerdicts(m) {
  const searchP95 = m.searchLatency?.p95Ms || 0;
  const poolMax = m.neon?.poolMax || 10;
  // Honest ceiling: every concurrent search occupies one pooled connection.
  const searchesPerSec = searchP95 > 0 ? Math.round((1000 / searchP95) * poolMax) : null;

  return [
    {
      target: '10.000.000 utilizatori',
      targetKey: 'users',
      targetValue: TARGETS.users,
      status: 'not-ready',
      currentEstimate:
        `≈ 2.000–5.000 utilizatori activi simultan pe acest singur nod ` +
        `(pool ${poolMax} conexiuni Neon, latență DB ${m.dbLatencyMs ?? '?'}ms, un singur proces Node).`,
      reasoning:
        `Un singur proces Node cu un pool de ${poolMax} conexiuni la un singur branch Neon (` +
        `${m.items ?? '?'} itemi live) servește azi cereri interactive cu latență DB de ` +
        `${m.dbLatencyMs ?? '?'}ms. 10M utilizatori înseamnă mii de ori mai mult trafic concurent: ` +
        `sunt necesare fleet orizontal + load balancer, cache distribuit, pgBouncer și read replicas ` +
        `înainte de orice discuție despre 10M.`,
    },
    {
      target: '10.000.000 conturi conectate simultan',
      targetKey: 'connectedAccounts',
      targetValue: TARGETS.connectedAccounts,
      status: 'not-ready',
      currentEstimate:
        '≈ 50.000 conexiuni simultan per nod (limită practică de file-descriptoși/porturi OS pe un singur proces).',
      reasoning:
        'Autentificarea e JWT stateless (scalabilă teoretic la oricâte conturi înregistrate), dar ' +
        '"10M conturi conectate simultan" înseamnă 10M conexiuni TCP/WebSocket live: imposibil pe un ' +
        'singur proces — necesită gateway-uri WS orizontale, sticky sessions și infrastructură de presence distribuită.',
    },
    {
      target: '10.000.000 contente (capacitate proiectată)',
      targetKey: 'contents',
      targetValue: TARGETS.contents,
      status: 'not-ready',
      currentEstimate:
        `Catalogul REAL AR10M are ${m.items ?? '?'} itemi (ar10m.content + legacy TMDB), DB ` +
        `${(m.dbSizeBytes ? m.dbSizeBytes / 1024 / 1024 : 0).toFixed(1)}MB. Arhitectura 15-shard ` +
        `(hash pe normalized_title+year, pool-uri lazy, circuit breaker) este proiectată gradual ` +
        `pentru 10M — dar capacitatea TESTATĂ este doar ce demonstrează benchmark-ul progresiv ` +
        `(10K → 100K → 1M rânduri, tests/bench-ar10m.mjs).`,
      reasoning:
        `Schema minimală AR10M (content: id/title/year/source_id/shard_id + content_sources deduplicate ` +
        `prin source_hash UNIQUE) elimină balastul de metadata JSONB/tsvector/embeddings per rând. ` +
        `Paginarea keyset cu cursor rămâne nelimitată în adâncime. Pentru 10M reali sunt necesare: ` +
        `activarea efectivă a shardurilor dedicate ANIMAXIA_DB_02..15, benchmark stabil la 1M înainte ` +
        `de orice import mai mare, și resurse Neon plătite — infrastructura gratuită NU garantează ` +
        `10M utilizatori simultan (regula AR10M: nu pretinde).`,
    },
    {
      target: '10.000.000 căutări simultane',
      targetKey: 'concurrentSearches',
      targetValue: TARGETS.concurrentSearches,
      status: 'not-ready',
      currentEstimate:
        searchP95 > 0
          ? `≈ ${searchesPerSec.toLocaleString('ro-RO')} căutări/sec pe acest nod ` +
            `(pool ${poolMax} conexiuni ÷ p95 ${searchP95}ms measured live).`
          : 'insuficiente sample-uri de căutare pentru estimare (rulați câteva căutări întâi).',
      reasoning:
        `Fiecare căutare ocupă o conexiune din pool-ul de ${poolMax} pentru ~${searchP95 || '?'}ms ` +
        `(p50 ${m.searchLatency?.p50Ms || '?'}ms, ${m.searchLatency?.samples || 0} sample-uri live). ` +
        `10M căutări simultane cer un cluster de căutare dedicat + fleet de API orizontal + cache de ` +
        `rezultate — nu un singur proces cu un singur branch Neon.`,
    },
  ];
}

function buildGaps(m) {
  const poolMax = m.neon?.poolMax || 10;
  return [
    {
      severity: 'critical',
      missing: 'Fleet orizontal — un singur proces Node servește tot traficul',
      recommendation: 'Multiple instanțe Express în spatele unui load balancer (cu health checks și rolling deploys).',
    },
    {
      severity: 'critical',
      missing: `Pool de conexiuni la limită (${poolMax}) fără pooling extern`,
      recommendation: 'pgBouncer (sau Neon pooler) în fața Postgres + pool per instanță; mii de clienți nu pot împărți 10 conexiuni directe.',
    },
    {
      severity: 'critical',
      missing: '10M documente necesită sharding real (15 proiecte Neon) + cluster de căutare dedicat',
      recommendation: 'Activează shardurile dedicate ANIMAXIA_DB_02..15 + rebalance (scripts/ar10m-rebalance.mjs); pentru interogări la scară, cluster de căutare dedicat (OpenSearch) sau indexuri prefix text_pattern_ops pe fiecare shard (implementat AR10M).',
    },
    {
      severity: 'critical',
      missing: 'Un singur branch Neon — fără read replicas',
      recommendation: 'Read replicas pentru citiri + sharding pe tenant/categorie; scrierile rămân pe primar cu partitioning.',
    },
    {
      severity: 'high',
      missing: 'Cache in-process (TTLCache în memorie) — incoerent între instanțe',
      recommendation: 'Redis Cluster distribuit cu invalidare prin evenimente (pub/sub) pentru cache HTTP și rezultate de căutare.',
    },
    {
      severity: 'high',
      missing: 'Rate limiter local (in-memory) — neconsistent pe fleet',
      recommendation: 'Limitator distribuit (Redis, sliding window) coerent pe toate nodurile și pe gateway.',
    },
    {
      severity: 'high',
      missing: 'Fără CDN pentru postere/thumbnail-uri/asset-uri statice',
      recommendation: 'CDN multi-regiune în fața backend-ului; SVG-urile din thumbnailcache servite din CDN cu invalidare la regenerare.',
    },
    {
      severity: 'high',
      missing: 'Fără message queue — procesarea async rulează în procesul API',
      recommendation: 'Queue distribuit (SQS/RabbitMQ/Kafka) pentru thumbnails, enrich, miner, refresh; workere separate scalabile independent.',
    },
    {
      severity: 'high',
      missing: 'Fără multi-region — un singur region EU pentru DB și API',
      recommendation: 'Deploy multi-region cu geo-routing și cache la edge; read replicas regionale lângă utilizatori.',
    },
    {
      severity: 'high',
      missing: 'Fără orchestrare/autoscaling (proces manual, bun --watch)',
      recommendation: 'Kubernetes/ECS cu HPA pe CPU și latență, scale-to-zero pentru trafic variabil, self-healing.',
    },
    {
      severity: 'high',
      missing: 'Fără strategie de HA/failover pentru aplicație',
      recommendation: 'Minim 2+ replica API în zone diferite + failover DB documentat și testat.',
    },
    {
      severity: 'medium',
      missing: 'Fără load testing pe țintele declarate',
      recommendation: 'Suite k6/Gatling în CI care să reproducă țintele reale (utilizatori concurenți, căutări/s) și să măsoare p95.',
    },
    {
      severity: 'medium',
      missing: 'Monitoring minimal — fără APM, tracing distribuit și alerting',
      recommendation: 'Prometheus + Grafana (deja există /api/metrics) + APM/tracing (ex. OpenTelemetry) + alerte pe p95/erori/saturare pool.',
    },
    {
      severity: 'medium',
      missing: 'Thumbnail-uri SVG stocate în Postgres (thumbnailcache)',
      recommendation: 'La scară: object storage (S3/R2) + CDN pentru binare; Postgres păstrează doar metadata și referințele.',
    },
    {
      severity: 'medium',
      missing: 'Dedup registry contentsources fără sharding/retention policy',
      recommendation: 'Politica de retenție + particionare pe kind/dată dacă registru crește nelimitat la ingest masiv.',
    },
  ];
}

function buildConclusion(m) {
  const poolMax = m.neon?.poolMax || 10;
  return (
    `Verdict onest: platforma Animaxia este un prototip funcțional complet pe un singur nod — ` +
    `${m.items ?? '?'} itemi în Neon, ${m.searchdocs ?? '?'} documente indexate FTS, latență DB ` +
    `${m.dbLatencyMs ?? '?'}ms, p95 căutare ${m.searchLatency?.p95Ms || '?'}ms — dar NU este pregătită ` +
    `pentru țintele declarate (10M utilizatori, 10M conturi conectate simultan, 10M contente — ` +
    `capacitate PROIECTATĂ gradual pe arhitectura reală 15-shard AR10M, NU garantată pe ` +
    `infrastructura gratuită; capacitatea TESTATĂ = doar benchmark-ul progresiv 10K→100K→1M). ` +
    `Un singur proces Node cu un pool de ${poolMax} conexiuni la un singur branch Neon poate ` +
    `susține astăzi cel mult câteva mii de utilizatori activi simultan. Pentru ținte reale sunt necesare: ` +
    `fleet orizontal + load balancer, pgBouncer, cache distribuit Redis, CDN, cluster de căutare dedicat, ` +
    `message queue, read replicas + sharding, multi-region, load testing, autoscaling și observabilitate ` +
    `completă — exact lipsurile documentate în secțiunea gaps.`
  );
}

/** FAZA 17-a: the hardening layers that ARE live after this phase. */
function buildHardening() {
  return [
    {
      name: 'Timeout pe cereri',
      status: 'live',
      detail: 'Fiecare cerere HTTP are un buget de 15s (REQUESTTIMEMS) — depășire → 504 Request timeout, contorizat în stability.timeouts.',
    },
    {
      name: 'Load shedding',
      status: 'live',
      detail: 'GET non-critice respinse cu 503 + Retry-After când event-loop p95 > 300ms sau rss > 90% din limită; mutările doar la lag > 800ms (evită pierderea datelor).',
    },
    {
      name: 'Keyset pagination nelimitată (AR10M)',
      status: 'live',
      detail: 'Căutarea suportă cursor base64url (normalized_title+id keyset); offset capat la 10.000 rânduri; gateway-ul AR10M paginează keyset pe catalogul REAL fuzionat (ar10m + legacy).',
    },
    {
      name: 'Monitorizare event-loop + memorie',
      status: 'live',
      detail: 'Lag event-loop sample-uit la 500ms (fereastră 200, p50/p95), rss/heap live, gauge cereri în curs — expuse în /api/platform/stability și /api/health.',
    },
    {
      name: 'Laborator stres',
      status: 'live',
      detail: 'POST /api/platform/stress/run — suite search/ingest/mixed (search+ingest), load real in-proces (fără HTTP self-call), 1–30s × 1–32 workere, lock global + rate limit 2/min per IP. AR10M: fostul suite virtual30b simulat — eliminat.',
    },
    {
      name: 'Watchdog procese',
      status: 'live',
      detail: 'Interval 30s: rss > 85% din limită → purge cache HTTP + contor memoryPurges; cererile blocate au timeout per-request; procesul are graceful shutdown (SIGINT/SIGTERM).',
    },
    {
      name: 'Virtualizare DOM frontend',
      status: 'live',
      detail: 'FAZA 17-b',
    },
  ];
}

async function buildReport() {
  const measured = await measure();
  return {
    measured,
    targets: TARGETS,
    verdicts: buildVerdicts(measured),
    gaps: buildGaps(measured),
    hardening: buildHardening(),
    conclusion: buildConclusion(measured),
  };
}

/* ---------------------------------- router ----------------------------------- */

const router = express.Router();

/** GET /api/scale/report — comprehensive honest scale report (public). */
router.get('/report', wrap(async (req, res) => {
  try {
    const report = await buildReport();
    res.json(report);
  } catch (err) {
    logger.error(`[scale] report failed: ${err.message}`);
    res.status(503).json({ error: 'Scale report unavailable', detail: err.message });
  }
}));

/** GET /api/scale/metrics — light version for auto-refresh dashboards (public). */
router.get('/metrics', wrap(async (req, res) => {
  const measured = await measure();
  const verdicts = buildVerdicts(measured).map((v) => ({
    target: v.target,
    targetKey: v.targetKey,
    status: v.status,
  }));
  res.json({ measured, verdicts, updatedAt: new Date().toISOString() });
}));

export default router;
