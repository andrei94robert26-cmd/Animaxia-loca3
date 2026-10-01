/**
 * services/vector-cluster/index.js — FAZA 13 (Task 13-3): the Animaxia vector
 * cluster — pgvector similarity search over the SHARDED `vectorembeddings`
 * table, one node per shard.
 *
 * NODE MODEL (same honest logical/physical cluster as the search cluster):
 *   • one node per shard (shardId 0..SHARDCOUNT-1);
 *   • LOGICAL mode (no SHARD{N}URL — default): every node's queries run
 *     through queryOnShard(shardId) → MAIN pool + `AND shardid = $n` scope;
 *   • PHYSICAL mode (SHARD{N}URL configured): identical code hits the shard's
 *     dedicated Neon branch pool;
 *   • health/counters/metrics REAL in both modes — nothing is faked.
 *
 * NO-SPLIT-BRAIN INVARIANT (pinned DESIGN): vectorembeddings rows live on
 * computeShardIdFromVectorRef(refKey(item)) — the cluster's upsertBatch routes
 * every item via the EXACT SAME rule, so writes and reads agree by
 * construction. "Vector shards per tenant" is realized as QUERY-SIDE AFFINITY
 * ONLY: when a tenant (or shardHint) is known, its computed shard node is
 * queried FIRST (targeted), and the parallel fan-out over the REMAINING nodes
 * completes the result set (merge → dedupe by refkey → top-K by score DESC).
 * An affinity hint therefore never blanks results.
 *
 * NOTE — refKey replication: vector-service.js computes refKey(item) as
 * `${item.kind}:${item.refid ?? 0}:${item.userid ?? 0}` but does NOT export
 * it; the identical logic is replicated below as refKeyOf() so the cluster's
 * shard routing provably matches PgVectorBackend.upsert's stamping rule.
 *
 * QUERY SEMANTICS — per node the SAME SQL as PgVectorBackend.search (13-2):
 *   SELECT refkey, kind, refid, userid, 1 - (embedding <=> $1::vector) AS score,
 *          metadata, contenttext
 *   FROM vectorembeddings
 *   WHERE kind = $2 [AND userid = $3 when kind memory/user and userId]
 *     AND shardid = $n
 *   ORDER BY embedding <=> $1::vector LIMIT $k
 * with the same row mapping ({ refkey, kind, refid, userid, score, text,
 * metadata }).
 *
 * TOGGLE: VECTORCLUSTENABLED (default false when unset; .env sets it true).
 * When disabled — or when the active vector backend is NOT pgvector —
 * vector-service.js keeps the byte-identical legacy path (the cluster is a
 * pgvector-only fan-out; a cluster failure falls back to backend.search — a
 * user query is NEVER failed because the cluster failed).
 */

import { queryOnShard, ensureShardPool, listShardPools } from '../../db.js';
import {
  shardCount,
  shardBranchName,
  shardingModelSnapshot,
  computeShardIdFromTenant,
  computeShardIdFromVectorRef,
} from '../../modules/sharding/model.js';
import { jsonb, parseJsonb } from '../../modules/platform/sql.js';
import { logger } from '../../utils/logger.js';

const EMBED_DIMS = 256; // mirrors vector-service.js EMBED_DIMS (not exported there)
const TOPK_CAP = 50; // max hits per query
const LATENCY_WINDOW = 50; // rolling latency samples for p50/p95

/* ------------------------------ refKey replication --------------------------- */

/**
 * EXACT replication of vector-service.js refKey(item) (not exported upstream):
 * `${kind}:${refid ?? 0}:${userid ?? 0}` — the key whose fnv1a('vectorref:…')
 * hash decides the vector's shard. Must never diverge from vector-service.js.
 */
function refKeyOf(item) {
  return `${item.kind}:${item.refid ?? 0}:${item.userid ?? 0}`;
}

/* ------------------------------- ops counters -------------------------------- */

const ops = { queries: 0, errors: 0, upserts: 0, coalesced: 0, lastError: null };
const latencies = [];
const byShardStats = new Map(); // shardId -> { queries, errors, upserts }

function byShard(shardId) {
  let entry = byShardStats.get(shardId);
  if (!entry) {
    entry = { queries: 0, errors: 0, upserts: 0 };
    byShardStats.set(shardId, entry);
  }
  return entry;
}

function byShardSnapshot() {
  const out = {};
  for (const [shardId, entry] of byShardStats) out[String(shardId)] = { ...entry };
  return out;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return Number(sorted[idx].toFixed(2));
}

function recordLatency(ms) {
  latencies.push(ms);
  if (latencies.length > LATENCY_WINDOW) latencies.shift();
}

/** Cluster is enabled only when VECTORCLUSTENABLED === 'true'. */
export function enabled() {
  return process.env.VECTORCLUSTENABLED === 'true';
}

/**
 * Ops snapshot for /api/shards:
 * { enabled, queries, errors, upserts, nodesHealthy, nodesTotal,
 *   latencyP50Ms, latencyP95Ms, byShard, lastError }.
 */
export function vectorClusterOpsSnapshot() {
  let nodesHealthy = 0;
  let nodesTotal = 0;
  try {
    const pools = listShardPools();
    nodesTotal = pools.length;
    nodesHealthy = pools.filter((p) => p.connected === true).length;
  } catch {
    /* registry unavailable — report zeros */
  }
  const sorted = [...latencies].sort((a, b) => a - b);
  return {
    enabled: enabled(),
    queries: ops.queries,
    errors: ops.errors,
    upserts: ops.upserts,
    nodesHealthy,
    nodesTotal,
    latencyP50Ms: percentile(sorted, 0.5),
    latencyP95Ms: percentile(sorted, 0.95),
    byShard: byShardSnapshot(),
    lastError: ops.lastError,
  };
}

/* ------------------------------ node primitives ------------------------------ */

function nodeIds() {
  const n = shardCount();
  return Array.from({ length: n }, (_, i) => i);
}

/** Per-node pool mode: 'branch' (dedicated pool) or 'main' (logical mode). */
function nodeMode(shardId) {
  try {
    return ensureShardPool(shardId).ownPool ? 'branch' : 'main';
  } catch {
    return 'main';
  }
}

/**
 * Run the SAME similarity query as PgVectorBackend.search on ONE shard node
 * (vectorembeddings scoped by `AND shardid = $n` via queryOnShard), with the
 * same row mapping. Returns the mapped hit array.
 */
async function runNodeQuery(shardId, { vectorLiteral, kind, userId, limit }) {
  const startedAt = Date.now();
  const params = [vectorLiteral];
  let where = 'kind = $2';
  params.push(kind);
  if ((kind === 'memory' || kind === 'user') && userId != null) {
    where += ' AND userid = $3';
    params.push(userId);
  }
  params.push(shardId);
  where += ` AND shardid = $${params.length}`;
  params.push(limit);
  const res = await queryOnShard(
    shardId,
    `SELECT refkey, kind, refid, userid, 1 - (embedding <=> $1::vector) AS score,
            metadata, contenttext
     FROM vectorembeddings
     WHERE ${where}
     ORDER BY embedding <=> $1::vector
     LIMIT $${params.length}`,
    params,
  );
  const tookMs = Date.now() - startedAt;
  const hits = (res.rows ?? []).map((r) => ({
    refkey: r.refkey,
    kind: r.kind,
    refid: Number(r.refid),
    userid: r.userid == null ? null : Number(r.userid),
    score: Number(r.score),
    text: r.contenttext,
    metadata: parseJsonb(r.metadata, {}),
  }));
  return { shardid: shardId, hits, tookMs };
}

/* ------------------------- single-flight coalescing -------------------------- */

const inflight = new Map();

function coalesce(key, run) {
  const existing = inflight.get(key);
  if (existing) {
    ops.coalesced += 1;
    return existing;
  }
  const promise = run().finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, promise);
  return promise;
}

/* ----------------------------------- query ----------------------------------- */

/**
 * Cluster vector similarity search — query-side affinity (tenant/shardHint
 * node FIRST) + fan-out over the remaining nodes, merge → dedupe by refkey →
 * top-K by score DESC.
 *
 * @param {object} opts { vector (number[]), kind, topK (cap 50), userId,
 *   tenant (slug|null), shardHint (int|null) }
 * @returns {Promise<{hits: Array, took: number, cluster: object}>} — hits use
 *   the SAME row shape as PgVectorBackend.search; cluster is the additive
 *   per-node report ({ nodes, mode, affinity }).
 */
async function query(opts = {}) {
  const vector = Array.isArray(opts.vector) ? opts.vector.map(Number) : null;
  if (!vector || vector.length === 0) {
    throw new Error('vectorCluster.query requires a non-empty vector');
  }
  const kind = String(opts.kind || 'content');
  const topK = Math.max(1, Math.min(TOPK_CAP, parseInt(opts.topK, 10) || 8));
  const userId = opts.userId != null ? Number(opts.userId) : null;
  const n = shardCount();

  // Query-side affinity (pinned DESIGN): tenant slug first, then shardHint.
  // 'global'/empty tenant skips affinity (consistent with sharding/model.js).
  const tenantSlug = String(opts.tenant ?? '').trim();
  let affinity = null;
  if (tenantSlug && tenantSlug !== 'global') {
    affinity = computeShardIdFromTenant(tenantSlug);
  } else {
    const h = parseInt(opts.shardHint, 10);
    if (Number.isInteger(h) && h >= 0 && h < n) affinity = h;
  }

  // Single-flight key — vectors are rounded to stabilize the JSON key
  // (embedTexts is deterministic, so identical queries produce identical keys).
  const vectorLiteral = `[${vector.join(',')}]`;
  const key = JSON.stringify({
    v: vector.map((v) => Number(v.toFixed(6))),
    kind,
    topK,
    userId,
    affinity,
  });

  return coalesce(key, () => runClusterQuery({ vectorLiteral, kind, topK, userId, affinity }));
}

/** Leader execution: affinity-first fan-out over the nodes + merge. */
async function runClusterQuery({ vectorLiteral, kind, topK, userId, affinity }) {
  const startedAt = Date.now();
  ops.queries += 1;

  const ids = nodeIds();
  const nodeResults = [];
  const nodeErrors = [];

  const runOne = async (shardId) => {
    const stats = byShard(shardId);
    stats.queries += 1;
    try {
      nodeResults.push(await runNodeQuery(shardId, { vectorLiteral, kind, userId, limit: topK }));
    } catch (err) {
      stats.errors += 1;
      nodeErrors.push({ shardid: shardId, error: err.message });
      logger.warn(`[vector-cluster] node ${shardId} query failed: ${err.message}`);
    }
  };

  if (affinity != null) {
    // Targeted affinity: the tenant/hint node runs FIRST, the remaining nodes
    // complete the result set in parallel (never blanks results).
    await runOne(affinity);
    await Promise.allSettled(ids.filter((id) => id !== affinity).map(runOne));
  } else {
    await Promise.allSettled(ids.map(runOne));
  }

  if (nodeResults.length === 0 && nodeErrors.length > 0) {
    ops.errors += 1;
    ops.lastError = nodeErrors.map((e) => `shard ${e.shardid}: ${e.error}`).join('; ');
    const err = new Error(`Vector cluster: all ${nodeErrors.length} nodes failed — ${ops.lastError}`);
    err.status = 503;
    throw err;
  }

  // Merge: concat → dedupe by refkey (keep the highest score) → score DESC.
  const best = new Map();
  for (const node of nodeResults) {
    for (const hit of node.hits) {
      const existing = best.get(hit.refkey);
      if (!existing || hit.score > existing.score) best.set(hit.refkey, hit);
    }
  }
  const hits = [...best.values()].sort((a, b) => b.score - a.score || String(a.refkey).localeCompare(String(b.refkey))).slice(0, topK);

  const ordered = affinity != null ? [affinity, ...ids.filter((id) => id !== affinity)] : ids;
  const nodes = ordered.map((shardId) => {
    const ok = nodeResults.find((r) => r.shardid === shardId);
    const failed = nodeErrors.find((e) => e.shardid === shardId);
    return {
      shardid: shardId,
      branch: shardBranchName(shardId),
      mode: nodeMode(shardId),
      hits: ok ? ok.hits.length : 0,
      tookMs: ok ? ok.tookMs : null,
      error: failed ? failed.error : null,
    };
  });

  const took = Date.now() - startedAt;
  recordLatency(took);
  ops.lastError = null;

  return {
    hits,
    took,
    cluster: {
      nodes,
      mode: shardingModelSnapshot().mode,
      affinity, // shard id of the affinity-first node (null = plain fan-out)
    },
  };
}

/* --------------------------------- upsertBatch -------------------------------- */

/**
 * Upsert embeddings into the cluster — each item routed via
 * computeShardIdFromVectorRef(refKeyOf(item)) to queryOnShard with the SAME
 * 9-column + shardid upsert SQL as PgVectorBackend.upsert (13-2). Items are
 * the same shape PgVectorBackend.upsert takes:
 * { kind, refid, userid, vector, text, metadata }.
 *
 * @returns {Promise<{upserted: number, byShard: object, tookMs: number}>}
 */
async function upsertBatch(items) {
  const startedAt = Date.now();
  const list = Array.isArray(items) ? items : [];
  let upserted = 0;
  const byShardCounts = {};
  for (const item of list) {
    if (!item || !Array.isArray(item.vector) || item.vector.length === 0) continue;
    const refkey = refKeyOf(item); // EXACT vector-service.js refKey logic
    const shardid = computeShardIdFromVectorRef(refkey); // same stamp rule as 13-2
    try {
      await queryOnShard(
        shardid,
        `INSERT INTO vectorembeddings (refkey, kind, refid, userid, dims, embedding, metadata, contenttext, shardid)
         VALUES ($1,$2,$3,$4,$5,$6::vector,$7,$8,$9)
         ON CONFLICT (refkey) DO UPDATE SET
           embedding = EXCLUDED.embedding,
           dims = EXCLUDED.dims,
           metadata = EXCLUDED.metadata,
           contenttext = EXCLUDED.contenttext,
           shardid = EXCLUDED.shardid,
           updatedat = CURRENT_TIMESTAMP`,
        [
          refkey,
          item.kind,
          item.refid ?? 0,
          item.userid ?? null,
          EMBED_DIMS,
          `[${item.vector.join(',')}]`,
          jsonb(item.metadata || {}),
          String(item.text || '').slice(0, 4000),
          shardid,
        ],
      );
      upserted += 1;
      ops.upserts += 1;
      byShard(shardid).upserts += 1;
      byShardCounts[String(shardid)] = (byShardCounts[String(shardid)] || 0) + 1;
    } catch (err) {
      byShard(shardid).errors += 1;
      throw err; // upserts are writes — surface failures to the caller
    }
  }
  return { upserted, byShard: byShardCounts, tookMs: Date.now() - startedAt };
}

/* ----------------------------------- health ---------------------------------- */

/**
 * Per-node health: ping (SELECT 1 via queryOnShard) + embedding count
 * (COUNT(*) WHERE shardid = $n) + latencyMs. Real in logical AND physical mode.
 */
async function health() {
  const nodes = await Promise.all(
    nodeIds().map(async (shardId) => {
      const startedAt = Date.now();
      try {
        await queryOnShard(shardId, 'SELECT 1 AS ok');
        const cnt = await queryOnShard(shardId, 'SELECT COUNT(*) AS n FROM vectorembeddings WHERE shardid = $1', [shardId]);
        return {
          shardid: shardId,
          branch: shardBranchName(shardId),
          mode: nodeMode(shardId),
          healthy: true,
          docs: Number(cnt.rows?.[0]?.n ?? 0),
          latencyMs: Date.now() - startedAt,
          lastError: null,
        };
      } catch (err) {
        return {
          shardid: shardId,
          branch: shardBranchName(shardId),
          mode: nodeMode(shardId),
          healthy: false,
          docs: 0,
          latencyMs: Date.now() - startedAt,
          lastError: err.message,
        };
      }
    }),
  );
  return {
    enabled: enabled(),
    mode: shardingModelSnapshot().mode,
    nodes,
    healthy: nodes.length > 0 && nodes.every((n) => n.healthy),
    generatedAt: new Date().toISOString(),
  };
}

/* ---------------------------------- exports ---------------------------------- */

export const vectorCluster = { enabled, query, upsertBatch, health };
export default vectorCluster;
