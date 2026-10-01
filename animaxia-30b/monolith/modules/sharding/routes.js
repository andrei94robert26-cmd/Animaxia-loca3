/**
 * modules/sharding/routes.js — FAZA 13 (Task 13-3): shard administration +
 * observability routes. Mounted additively in server.js as
 * `app.use('/api/shards', shardingRouter)` near the /api/scale mount.
 *
 * Routes:
 *   GET  /api/shards           — public read-only infra status: sharding model
 *                                snapshot, shardid schema status, shard pool
 *                                registry, both cluster healths, ops counters.
 *                                Every sub-part sits in its own try/catch — a
 *                                failing component degrades to { error } instead
 *                                of 500ing the whole endpoint.
 *   GET  /api/shards/health    — lightweight synthetics shape:
 *                                { ok, shards: [{ shardid, branch, mode,
 *                                status: 'healthy'|'degraded'|'down' }] } —
 *                                down = pool not connected / branch unhealthy,
 *                                degraded = pool stats.errors > 0 or a cluster
 *                                node reported an error, healthy otherwise.
 *   POST /api/shards/reindex   — (requireAuth + requireAdmin) runs
 *                                searchCluster.indexBatch over the current
 *                                content rows (docs built from content metadata
 *                                JSONB exactly like search.js syncIndex, incl.
 *                                the title+genres+overview document text).
 *
 * STRICTLY ADDITIVE — no pre-existing route or FAZA 1–12 contract is touched.
 */

import express from 'express';
import { requireAuth, requireAdmin } from '../users/auth.js';
import { listShardPools } from '../../db.js';
import { rows, parseJsonb } from '../platform/sql.js';
import { shardingModelSnapshot, shardCount, logicalAddressSpace, SHARD_SPAN_IDS } from './model.js';
import { shardingSchemaStatus } from './migrations.js';
import { searchCluster, searchClusterOpsSnapshot } from '../../services/search-cluster/index.js';
import { vectorCluster, vectorClusterOpsSnapshot } from '../../services/vector-cluster/index.js';
import { logger } from '../../utils/logger.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const router = express.Router();

/* --------------------------- metadata helpers (mirrored from
 *   search.js — not exported there) used to build reindex docs ---------------- */

/** Coerce a metadata value to a clean string array (strings or {name} objects). */
function toNameArray(value) {
  if (value == null) return [];
  const list = Array.isArray(value) ? value : [value];
  const out = [];
  for (const item of list) {
    if (typeof item === 'string') {
      const name = item.trim();
      if (name) out.push(name);
    } else if (item && typeof item === 'object') {
      const name = String(item.name ?? '').trim();
      if (name) out.push(name);
    }
  }
  return out;
}

function toIntOrNull(value) {
  const n = parseInt(value, 10);
  return Number.isInteger(n) ? n : null;
}

function toFloatOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** FTS document text — mirrors search.js buildTsvText (title + genres + first
 *  500 chars of the overview/synopsis/description from the metadata JSONB). */
function buildTsvText(title, genres, meta) {
  const overview = String(meta.overview || meta.synopsis || meta.description || '');
  return [String(title || ''), genres.join(' '), overview.slice(0, 500)].join(' ').trim();
}

/* ------------------------------------ routes --------------------------------- */

/** GET /api/shards — public read-only sharding/cluster infra status. */
router.get('/', wrap(async (req, res) => {
  // Each component in its own try/catch — one failing part degrades to
  // { error } instead of 500ing the whole composite.
  const part = async (fn) => {
    try {
      return { value: await fn() };
    } catch (err) {
      return { error: err.message };
    }
  };
  const valueOf = (p) => (p && p.error === undefined ? p.value : { error: p?.error ?? 'unavailable' });

  const [model, schema, pools, searchHealth, vectorHealth, searchOps, vectorOps] = await Promise.all([
    part(() => Promise.resolve(shardingModelSnapshot())),
    part(() => shardingSchemaStatus()),
    part(() => Promise.resolve(listShardPools())),
    part(() => (searchCluster.enabled() ? searchCluster.health() : { enabled: false })),
    part(() => (vectorCluster.enabled() ? vectorCluster.health() : { enabled: false })),
    part(() => Promise.resolve(searchClusterOpsSnapshot())),
    part(() => Promise.resolve(vectorClusterOpsSnapshot())),
  ]);

  const parts = [model, schema, pools, searchHealth, vectorHealth, searchOps, vectorOps];
  res.json({
    ok: !parts.some((p) => p && p.error !== undefined),
    generatedAt: new Date().toISOString(),
    model: valueOf(model),
    schema: valueOf(schema),
    // FAZA 14: the LOGICAL 30B address space this topology serves —
    // 30 shards × 1B ids = 30B simulated content ids (volume is logical;
    // real rows in Neon are real).
    logical: {
      addressSpace: logicalAddressSpace(),
      shardcount: shardCount(),
      shardSpan: SHARD_SPAN_IDS,
      mode: 'logical',
    },
    pools: valueOf(pools),
    searchCluster: valueOf(searchHealth),
    vectorCluster: valueOf(vectorHealth),
    ops: { search: valueOf(searchOps), vector: valueOf(vectorOps) },
  });
}));

/** GET /api/shards/health — lightweight per-shard synthetics. */
router.get('/health', wrap(async (req, res) => {
  const pools = listShardPools();
  const [searchHealth, vectorHealth] = await Promise.all([
    searchCluster.enabled() ? searchCluster.health().catch(() => null) : null,
    vectorCluster.enabled() ? vectorCluster.health().catch(() => null) : null,
  ]);

  const shards = pools.map((pool) => {
    let status = 'healthy';
    if (pool.connected !== true || pool.healthy === false) {
      // down = pool not connected / branch pool unhealthy
      status = 'down';
    } else if ((pool.stats?.errors ?? 0) > 0) {
      // degraded = the pool registry recorded query errors on this shard
      status = 'degraded';
    } else {
      // degraded = a cluster node reported an error on this shard
      const searchNode = searchHealth?.nodes?.find((n) => n.shardid === pool.shardid);
      const vectorNode = vectorHealth?.nodes?.find((n) => n.shardid === pool.shardid);
      if (searchNode?.lastError || vectorNode?.lastError || searchNode?.healthy === false || vectorNode?.healthy === false) {
        status = 'degraded';
      }
    }
    return { shardid: pool.shardid, branch: pool.branch, mode: pool.mode, status };
  });

  res.json({ ok: shards.length > 0 && shards.every((s) => s.status === 'healthy'), shards });
}));

/** POST /api/shards/reindex — (admin) reindex the search cluster from content. */
router.post('/reindex', requireAuth, requireAdmin, wrap(async (req, res) => {
  const raw = await rows('SELECT id, externalid, type, title, metadata FROM content');
  // Build the docs exactly like search.js syncIndex: year/rating/genres/actors/
  // studios/category extracted from the JSONB metadata + the same FTS document
  // text (title + genres + first 500 chars of the overview), passed explicitly
  // as `documenttext` so indexBatch writes byte-equivalent searchdocs rows.
  const docs = raw.map((row) => {
    const meta = parseJsonb(row.metadata, {});
    const genres = toNameArray(meta.genres);
    return {
      contentid: Number(row.id),
      externalid: row.externalid ?? null,
      type: row.type ?? null,
      title: row.title ?? 'untitled',
      year: toIntOrNull(meta.year),
      rating: toFloatOrNull(meta.rating ?? meta.score),
      genres,
      actors: toNameArray(meta.actors ?? meta.cast),
      studios: toNameArray(meta.studios ?? meta.studio),
      category: row.type ?? null,
      documenttext: buildTsvText(row.title, genres, meta),
    };
  });

  const result = await searchCluster.indexBatch(docs); // chunks of 25 (SYNC_CHUNK)
  logger.info(
    `[sharding] Cluster reindex by user ${req.user?.id ?? '?'} — ${result.indexed} docs across shards ${JSON.stringify(result.byShard)} in ${result.tookMs}ms`,
  );
  res.json({ ok: true, indexed: result.indexed, byShard: result.byShard, tookMs: result.tookMs });
}));

export default router;
