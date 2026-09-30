/**
 * modules/search/opt.js — FAZA 17 (Task 17-1): Search Optimization Layer —
 * dedup + batching + micro-cache sitting between the FAZA 15 window
 * dispatcher and the real Neon FTS execution.
 *
 * WHAT IT IS (pinned spec, "FAZA 17 — Search Optimization Layer"):
 *   • SEARCH BATCHING — identical concurrent requests share ONE real Neon FTS
 *     execution. The first dispatched request for a canonical query creates a
 *     batch (batchMap[queryHash] = { promise, fanout, shardIds }); every
 *     identical request dispatched while the batch is in-flight attaches to it
 *     (`stats.batchHits`) and receives the SAME 100% real result. The batch is
 *     removed on settle — it can never leak (the 8s query budget guarantees
 *     settlement of the underlying execution).
 *   • SEARCH CACHE — successful results are stored in a global micro-cache
 *     keyed by the query hash: `searchCache[queryHash] = { result, storedAt,
 *     expiresAt }`. A request arriving within `cacheTtlMs` (default 3000 ms,
 *     1000–5000 ms) is served from the cache (`stats.cacheHits`) — Neon is
 *     never touched for it. The cached value IS the result of a real Neon
 *     query made ≤ ttl ms ago (nothing is fabricated). Expired entries are
 *     swept on the 1s history tick; 'content:changed' clears the whole cache
 *     (an index resync means the results changed — no stale serving).
 *   • SEARCH DEDUPLICATION — the umbrella counter: every request served from
 *     the cache OR attached to a batch is a deduplicated request
 *     (`stats.deduplicatedRequests`): 1000 identical requests → 1 real Neon
 *     query + 999 deduplicated servings (reduction 1000×).
 *   • PIPELINE — the layer runs INSIDE the FAZA 15 queue entry (after the
 *     window dispatch, before the FTS): the pinned deterministic order is
 *     antiSpam → rateLimit → cooldown → queue → priority → windowing →
 *     dedup → batching → cache → fts (SEARCH_PIPELINE_STAGES, exposed in
 *     /api/search/status as `pipeline`).
 *
 * WHAT IT IS NOT: it never fabricates, alters or merges search results. A
 * cache/batch serving returns the EXACT object the real Neon FTS execution
 * produced; the additive `opt: { source, queryHash }` response field documents
 * the provenance ('neon' | 'batch' | 'cache' | 'bypass'). Failures are never
 * cached — a failed execution propagates honestly to every attached request
 * and the next arrival retries a fresh real query.
 *
 * SHARD-AWARENESS: results are identical for every shard (the cluster fan-out
 * union is the whole 30×1B logical space; the hint only orders the nodes), so
 * the batch/cache key is GLOBAL on the semantic query params — one identical
 * query = ONE Neon execution regardless of which shards the users map to.
 * Every serving is still ATTRIBUTED per shard (served / cacheHits / batchHits
 * / ftsQueries per shard, 30 rows) — the per-shard table shows each shard's
 * Neon reduction. The cluster queryKey additionally includes the shardHint
 * (it cosmetically orders the cluster node report), so hinted and unhinted
 * variants of a query never share a cache entry (byte-identical responses).
 *
 * KEYING: queryKey = canonical JSON of ALL semantic params (q, type, genre,
 * year, minRating, actor, studio, category, sort, fuzzy, limit, page, cursor
 * for the legacy path / shardHint for the cluster path / q for autocomplete).
 * queryHash = sha256(key).slice(0, 16) — the observability handle.
 *
 * CONFIG (env, overridable at runtime by POST /api/search/opt/settings):
 *   SEARCHOPTENABLED        default true   — false bypasses the whole layer
 *   SEARCHOPTCACHETTLMS     default 3000   — cache TTL (1000–5000 ms, pinned range)
 *   SEARCHOPTCACHEMAX       default 5000   — max cache entries (LRU-ish eviction)
 *   SEARCHOPTBATCHMAX       default 10000  — max concurrent distinct batches
 *                                            (protective cap — beyond it the
 *                                            request executes directly, source
 *                                            'bypass', nothing is dropped)
 *
 * OBSERVABILITY (pinned in animaxia-ops/metrics/METRICS.md §10):
 *   animaxia_search_batch_hits / animaxia_search_cache_hits /
 *   animaxia_search_cache_misses / animaxia_search_dedup_count (the four
 *   spec-pinned series) + opt_enabled / cache_ttl_ms / cache_entries /
 *   cache_hit_ratio / active_batches / batches_created / batches_completed /
 *   batch_max_fanout / fts_queries_total / served_total / cache_evictions /
 *   bypassed_total / fts_errors_total gauges and sparse *_by_shard series —
 *   via the 'searchopt' pull collector wired in server.js. GET /api/search/opt
 *   serves the full console (config + counters + active batch list + 180×1s
 *   history + per-shard table); /api/search/status gains the pinned
 *   `batching` / `cache` / `dedup` / `pipeline` blocks. LOGS (bounded-rate —
 *   a 5000-request burst never blocks the event loop on console I/O):
 *   [search-opt] BATCH CREATED / BATCH COMPLETED (per real execution, with
 *   the fan-out N) / CACHE MISS (per real execution) / CACHE HIT (first
 *   serve per entry + every 100th global hit) / BATCH FAILED + a 1s sampler
 *   summary line (requests · cache hits · dedup-attach · real Neon queries)
 *   whenever the layer served traffic in the last second.
 *
 * This module is PURE optimization: it imports nothing from db.js or the
 * search engine — callers hand it a run() closure (the untouched FAZA 14 FTS
 * code path) and it decides whether Neon actually sees the query.
 */

import { createHash } from 'node:crypto';
import { shardCount } from '../sharding/model.js';
import { events } from '../platform/events.js';
import { logger } from '../../utils/logger.js';

/* --------------------------------- config ----------------------------------- */

/** Clamp an int with a floor/ceiling; NaN → fallback. */
function clampInt(raw, fallback, min, max) {
  const n = parseInt(raw, 10);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function envConfig() {
  return {
    enabled: String(process.env.SEARCHOPTENABLED ?? 'true') !== 'false',
    cacheTtlMs: clampInt(process.env.SEARCHOPTCACHETTLMS, 3000, 1000, 5000),
    cacheMax: clampInt(process.env.SEARCHOPTCACHEMAX, 5000, 100, 100000),
    batchMax: clampInt(process.env.SEARCHOPTBATCHMAX, 10000, 100, 50000),
  };
}

/** Live config — env at boot, adjustable at runtime via the admin endpoint. */
const config = envConfig();

/* --------------------------------- pipeline ---------------------------------- */

/**
 * The pinned FAZA 17 optimization pipeline — the deterministic order every
 * search request traverses. Exposed verbatim in /api/search/status as the
 * `pipeline` block (contract: pipeline: ["antiSpam", "rateLimit", "cooldown",
 * "queue", "priority", "windowing", "dedup", "batching", "cache", "fts"]).
 */
export const SEARCH_PIPELINE_STAGES = [
  'antiSpam', // FAZA 16 — flood detection (≥3 arrivals / 200ms → auto-block)
  'rateLimit', // FAZA 16 — per-user pacing (1 search / perUserMs, per kind)
  'cooldown', // FAZA 16 — post-result cooldown (1200ms default)
  'queue', // FAZA 15 — admission (queueCap, explicit 503/504, never silent)
  'priority', // FAZA 15 — high (admin/ops) → normal (logged) → low (anon)
  'windowing', // FAZA 15 — intervalMs × batchSize controlled dispatch
  'dedup', // FAZA 17 — identical requests counted as one logical query
  'batching', // FAZA 17 — in-flight identical requests share one execution
  'cache', // FAZA 17 — 1–5s micro-cache of REAL results
  'fts', // Neon FTS — the 100% real full-text search (FAZA 14 semantics)
];

/** pipeline block for /api/search/status (pinned contract — exact array). */
export function searchOptPipelineSnapshot() {
  return [...SEARCH_PIPELINE_STAGES];
}

/* --------------------------------- counters ---------------------------------- */

const stats = {
  served: 0, // requests that entered the opt layer (any disposition)
  ftsQueries: 0, // REAL Neon FTS executions started (the Neon-side truth)
  ftsErrors: 0, // executions that failed (never cached, honest propagation)
  cacheHits: 0, // served from the micro-cache (Neon untouched)
  cacheMisses: 0, // cache lookups that had to execute a real query
  batchHits: 0, // requests attached to an in-flight batch (Neon untouched)
  batchesCreated: 0, // distinct batches (== distinct real executions)
  batchesCompleted: 0, // batches that settled successfully (result cached)
  batchMaxFanout: 0, // largest batch observed (requests sharing 1 query)
  deduplicatedRequests: 0, // cacheHits + batchHits (the dedup umbrella)
  cacheEvictions: 0, // entries evicted by the cacheMax bound
  bypassed: 0, // served with the layer disabled / above the batch cap
  lastBatchAt: null,
  lastBatchCompletedAt: null,
  lastCacheHitAt: null,
  lastCacheMissAt: null,
};

/* Per-shard attribution (shard id → { served, cacheHits, batchHits, ftsQueries }). */
function blankShardStats() {
  return { served: 0, cacheHits: 0, batchHits: 0, ftsQueries: 0 };
}
const byShard = new Map();
function shardStats(shardId) {
  let entry = byShard.get(shardId);
  if (!entry) {
    entry = blankShardStats();
    byShard.set(shardId, entry);
  }
  return entry;
}

/* ------------------------------- history sampler ------------------------------ */

/* Rolling console history — 1s samples of requests / fts / cache / batch.
 * The chart this feeds is the money chart: requests served vs REAL Neon
 * queries executed (the visual 1000× reduction). */
const HISTORY_LIMIT = 180;
const history = [];
let reqSamples = 0;
let ftsSamples = 0;
let cacheHitSamples = 0;
let batchHitSamples = 0;

/* ---------------------------------- cache ------------------------------------ */

/** Global micro-cache: queryHash → { result, storedAt, expiresAt, hits }. */
const searchCache = new Map();

/* ---------------------------------- batches ---------------------------------- */

/**
 * Global batch map: queryHash → { promise, fanout, createdAt, kind, describe,
 * shardIds }. Created by the FIRST dispatched request for a query; identical
 * requests dispatched while in-flight attach (fanout += 1). Removed on settle
 * — the 8s query budget of the underlying execution guarantees settlement.
 */
const batchMap = new Map();

/** sha256(queryKey) — first 16 hex chars, the observability handle. */
function hashQueryKey(queryKey) {
  return createHash('sha256').update(String(queryKey), 'utf8').digest('hex').slice(0, 16);
}

/**
 * Expired-entry sweep + capacity bound — piggybacked on the 1s history tick.
 * Map iteration is insertion-ordered, so the capacity eviction drops the
 * OLDEST entry (insertion order ≈ LRU for a TTL-bounded cache).
 */
function sweepCache(now) {
  for (const [hash, entry] of searchCache) {
    if (entry.expiresAt <= now) searchCache.delete(hash);
  }
  while (searchCache.size > config.cacheMax) {
    const oldest = searchCache.keys().next().value;
    if (oldest === undefined) break;
    searchCache.delete(oldest);
    stats.cacheEvictions += 1;
  }
}

/* 'content:changed' (index resync debounced 3s upstream) → drop every cached
 * result: a rebuilt searchdocs index means the cached pages may be stale.
 * In-flight batches complete normally (their query already started against
 * the pre-resync index — the same window any concurrent request would see). */
events.on('content:changed', () => {
  if (searchCache.size > 0) {
    logger.info(`[search-opt] CACHE FLUSH — content:changed → ${searchCache.size} entr(ies) dropped (index resync)`);
    searchCache.clear();
  }
});

/* --------------------------------- execution --------------------------------- */

/**
 * FAZA 17 optimization executor — called INSIDE the FAZA 15 queue entry (the
 * run() closure handed to searchFlowExecute), i.e. AFTER the window dispatch
 * and BEFORE the Neon FTS. Pure dedup/batch/cache decision; the run() closure
 * is the untouched FAZA 14 execution path.
 *
 * Decision order (deterministic, single-threaded atomic check-then-set — the
 * pinned pipeline stages dedup → batching → cache → fts):
 *   1. layer disabled → run directly (source 'bypass');
 *   2. batch map hit (identical execution in flight) → attach to the batch
 *      promise (source 'batch'), Neon untouched;
 *   3. cache hit (entry younger than cacheTtlMs) → serve the stored REAL
 *      result (source 'cache'), Neon untouched;
 *   4. cache miss → create a batch and run the REAL execution (source
 *      'neon'); on success the result is cached for cacheTtlMs. Every cache
 *      miss therefore corresponds to exactly one real Neon query (the clean
 *      invariant: cacheMisses ≈ ftsQueries while under the batch cap).
 *
 * @param {{
 *   queryKey: string,            — canonical JSON of ALL semantic query params
 *   kind?: 'advanced'|'autocomplete',
 *   shardId?: number,            — attribution shard (X-Animaxia-Shard > tenant)
 *   describe?: string,           — human label for the logs
 *   run: () => Promise<any>,     — the 100% real FTS execution closure
 * }} input
 * @returns {Promise<{ result: any, source: 'neon'|'batch'|'cache'|'bypass',
 *                     queryHash: string|null, cached: boolean, batched: boolean }>}
 */
export function searchOptExecute({ queryKey, kind = 'advanced', shardId = 0, describe = '', run }) {
  if (typeof run !== 'function') {
    return Promise.reject(new Error('searchOptExecute: run() is required'));
  }
  const now = Date.now();
  const queryHash = hashQueryKey(queryKey);
  stats.served += 1;
  reqSamples += 1;
  shardStats(shardId).served += 1;

  /* 1. Bypass path: the whole FAZA 17 layer disabled → FAZA 15/16 behavior
   *    (the caller may still layer its own single-flight — legacy path does). */
  if (!config.enabled) {
    stats.bypassed += 1;
    return Promise.resolve()
      .then(run)
      .then((result) => ({ result, source: 'bypass', queryHash, cached: false, batched: false }));
  }

  /* 2. DEDUP + BATCHING — an identical execution is already in flight →
   *    attach to it (the pinned pipeline order: dedup → batching run BEFORE
   *    the cache stage). The check-then-set on batchMap is atomic within the
   *    event loop (no await between the map get and set), so exactly ONE
   *    batch per queryHash can exist at any moment — determinism is
   *    structural, not probabilistic. An in-flight batch and a valid cache
   *    entry can never coexist (a batch only starts on a cache miss and the
   *    entry is written only when it settles).
   *    (No per-attach log line: a 5000-request burst would print 5000 lines
   *    and block the event loop — the fan-out is reported by the BATCH
   *    COMPLETED line and by the 1s sampler summary below.) */
  const inFlight = batchMap.get(queryHash);
  if (inFlight) {
    inFlight.fanout += 1;
    inFlight.shardIds.add(shardId);
    stats.batchHits += 1;
    batchHitSamples += 1;
    stats.deduplicatedRequests += 1;
    shardStats(shardId).batchHits += 1;
    return inFlight.promise.then((result) => ({
      result,
      source: 'batch',
      queryHash,
      cached: false,
      batched: true,
    }));
  }

  /* 3. CACHE — a REAL result produced ≤ cacheTtlMs ago for the exact query.
   *    (Per-hit logging is SAMPLED — the first serve of each entry plus every
   *    100th global hit — so a 5000-request burst does not block the event
   *    loop on synchronous console I/O; the 1s sampler summary below keeps
   *    continuous cache-hit evidence in the log.) */
  const cached = searchCache.get(queryHash);
  if (cached && cached.expiresAt > now) {
    cached.hits += 1;
    stats.cacheHits += 1;
    cacheHitSamples += 1;
    stats.deduplicatedRequests += 1;
    stats.lastCacheHitAt = new Date(now).toISOString();
    shardStats(shardId).cacheHits += 1;
    if (cached.hits === 1 || stats.cacheHits % 100 === 0) {
      logger.info(
        `[search-opt] CACHE HIT — ${kind} ${describe || queryHash} (hash=${queryHash}, age=${now - cached.storedAt}ms ≤ ttl=${config.cacheTtlMs}, shard=${shardId}, entry hits=${cached.hits}, total hits=${stats.cacheHits})`,
      );
    }
    return Promise.resolve({
      result: cached.result,
      source: 'cache',
      queryHash,
      cached: true,
      batched: false,
    });
  }
  if (cached) searchCache.delete(queryHash); // expired → honest miss
  stats.cacheMisses += 1;
  stats.lastCacheMissAt = new Date(now).toISOString();
  logger.info(
    `[search-opt] CACHE MISS — ${kind} ${describe || queryHash} (hash=${queryHash}, shard=${shardId}) → real FTS execution`,
  );

  /* 4. Protective cap: too many DISTINCT concurrent batches → execute this
   *    request directly (honest bypass, nothing dropped, nothing cached). */
  if (batchMap.size >= config.batchMax) {
    stats.bypassed += 1;
    stats.ftsQueries += 1;
    ftsSamples += 1;
    shardStats(shardId).ftsQueries += 1;
    logger.warn(
      `[search-opt] BATCH CAP — ${batchMap.size} concurrent batches ≥ batchMax=${config.batchMax}; ${kind} ${queryHash} executes directly (no batch, no cache)`,
    );
    return Promise.resolve()
      .then(run)
      .then(
        (result) => ({ result, source: 'bypass', queryHash, cached: false, batched: false }),
        (err) => {
          stats.ftsErrors += 1;
          throw err;
        },
      );
  }

  /* 5. NEW BATCH + the ONE real Neon FTS execution. Every identical request
   *    dispatched while this promise is pending attaches to it (step 3); on
   *    success the result is cached; on failure the error propagates honestly
   *    to every attached request and NOTHING is cached. */
  stats.batchesCreated += 1;
  stats.ftsQueries += 1;
  ftsSamples += 1;
  stats.lastBatchAt = new Date(now).toISOString();
  shardStats(shardId).ftsQueries += 1;
  logger.info(
    `[search-opt] BATCH CREATED — ${kind} ${describe || queryHash} (hash=${queryHash}, shard=${shardId}) → 1 real Neon FTS query starts`,
  );

  const batch = {
    fanout: 1,
    createdAt: now,
    kind,
    describe: describe || queryHash,
    shardIds: new Set([shardId]),
    promise: null,
  };
  const promise = (async () => {
    try {
      const result = await run();
      const settledAt = Date.now();
      stats.batchesCompleted += 1;
      stats.lastBatchCompletedAt = new Date(settledAt).toISOString();
      if (batch.fanout > stats.batchMaxFanout) stats.batchMaxFanout = batch.fanout;
      searchCache.set(queryHash, {
        result,
        storedAt: settledAt,
        expiresAt: settledAt + config.cacheTtlMs,
        hits: 0,
      });
      logger.info(
        `[search-opt] BATCH COMPLETED — ${batch.describe} (hash=${queryHash}) ${batch.fanout} request(s) shared 1 Neon query, took ${settledAt - batch.createdAt}ms, result cached ${config.cacheTtlMs}ms`,
      );
      return result;
    } catch (err) {
      stats.ftsErrors += 1;
      logger.warn(
        `[search-opt] BATCH FAILED — ${batch.describe} (hash=${queryHash}) after ${Date.now() - batch.createdAt}ms — error propagates to ${batch.fanout} request(s), nothing cached: ${err?.message ?? err}`,
      );
      throw err;
    } finally {
      batchMap.delete(queryHash);
    }
  })();
  batch.promise = promise;
  batchMap.set(queryHash, batch);

  return promise.then((result) => ({
    result,
    source: 'neon',
    queryHash,
    cached: false,
    batched: false,
  }));
}

/* ------------------------------ history sampler ------------------------------ */

let historyTimer = null;
function startHistorySampler() {
  if (historyTimer) return;
  historyTimer = setInterval(() => {
    try {
      const now = Date.now();
      history.push({
        t: new Date(now).toISOString(),
        requests: reqSamples, // requests served by the opt layer
        fts: ftsSamples, // REAL Neon FTS executions started
        cacheHits: cacheHitSamples,
        batchHits: batchHitSamples,
        cacheEntries: searchCache.size,
        activeBatches: batchMap.size,
      });
      if (history.length > HISTORY_LIMIT) history.shift();
      /* 1s observability summary — the bounded-rate replacement for
       * per-request cache-hit/dedup log lines (a 5000-request burst must
       * never block the event loop on synchronous console I/O). Only logged
       * when the layer actually served something in the last second. */
      if (reqSamples > 0 || ftsSamples > 0) {
        logger.info(
          `[search-opt] 1s — ${reqSamples} cereri · ${cacheHitSamples} cache hits · ${batchHitSamples} dedup-attach · ${ftsSamples} interogari Neon reale · cache ${searchCache.size} intrari · ${batchMap.size} batch-uri active`,
        );
      }
      reqSamples = 0;
      ftsSamples = 0;
      cacheHitSamples = 0;
      batchHitSamples = 0;
      sweepCache(now); // expired entries + capacity bound ride the same tick
    } catch (err) {
      logger.error(`[search-opt] history sampler failed: ${err?.message ?? err}`);
    }
  }, 1000);
  if (typeof historyTimer.unref === 'function') historyTimer.unref();
}

/* --------------------------------- snapshots --------------------------------- */

/** batching block for /api/search/status — the pinned FAZA 17 contract:
 *  { enabled: true, activeBatches: N } + live fan-out state. */
export function searchOptBatchingSnapshot() {
  return {
    enabled: config.enabled,
    activeBatches: batchMap.size,
    batchHits: stats.batchHits,
    created: stats.batchesCreated,
    completed: stats.batchesCompleted,
    maxFanout: stats.batchMaxFanout,
    maxConcurrentBatches: config.batchMax,
    lastBatchAt: stats.lastBatchAt,
    lastBatchCompletedAt: stats.lastBatchCompletedAt,
  };
}

/** cache block for /api/search/status — the pinned FAZA 17 contract:
 *  { ttlMs: 3000, hits: X, misses: Y } + live entries / ratio state. */
export function searchOptCacheSnapshot() {
  const lookups = stats.cacheHits + stats.cacheMisses;
  return {
    enabled: config.enabled,
    ttlMs: config.cacheTtlMs,
    hits: stats.cacheHits,
    misses: stats.cacheMisses,
    entries: searchCache.size,
    hitRatio: lookups > 0 ? Number((stats.cacheHits / lookups).toFixed(4)) : 0,
    evictions: stats.cacheEvictions,
    maxEntries: config.cacheMax,
    lastHitAt: stats.lastCacheHitAt,
    lastMissAt: stats.lastCacheMissAt,
  };
}

/** dedup block for /api/search/status — the pinned FAZA 17 contract:
 *  { active: true, deduplicatedRequests: N } + the served/Neon split. */
export function searchOptDedupSnapshot() {
  return {
    active: config.enabled,
    deduplicatedRequests: stats.deduplicatedRequests,
    cacheServed: stats.cacheHits,
    batchServed: stats.batchHits,
    ftsQueries: stats.ftsQueries,
    ftsErrors: stats.ftsErrors,
    served: stats.served,
    bypassed: stats.bypassed,
    /** The reduction factor: requests served per REAL Neon query (×N). */
    reductionFactor:
      stats.ftsQueries > 0 ? Number((stats.served / stats.ftsQueries).toFixed(2)) : 0,
  };
}

/** Per-shard attribution table — one row per shard of the logical topology. */
function perShardSnapshot() {
  const out = [];
  const n = shardCount();
  for (let i = 0; i < n; i += 1) {
    const entry = byShard.get(i) ?? blankShardStats();
    out.push({ shardid: i, ...entry });
  }
  return out;
}

/** Live in-flight batch list (top 50 by fanout) for the admin console. */
function activeBatchesList() {
  const now = Date.now();
  return [...batchMap.entries()]
    .map(([queryHash, batch]) => ({
      queryHash,
      kind: batch.kind,
      describe: batch.describe,
      fanout: batch.fanout,
      ageMs: now - batch.createdAt,
      shards: batch.shardIds.size,
    }))
    .sort((a, b) => b.fanout - a.fanout || b.ageMs - a.ageMs)
    .slice(0, 50);
}

/** Full console snapshot for GET /api/search/opt (pinned blocks + config +
 *  counters + active batch list + rolling history + per-shard table).
 *  Public read-only (same policy as /flow and /rate). */
export function searchOptConsoleSnapshot() {
  return {
    batching: searchOptBatchingSnapshot(),
    cache: searchOptCacheSnapshot(),
    dedup: searchOptDedupSnapshot(),
    pipeline: searchOptPipelineSnapshot(),
    config: { ...config },
    counters: {
      served: stats.served,
      ftsQueries: stats.ftsQueries,
      ftsErrors: stats.ftsErrors,
      cacheHits: stats.cacheHits,
      cacheMisses: stats.cacheMisses,
      batchHits: stats.batchHits,
      batchesCreated: stats.batchesCreated,
      batchesCompleted: stats.batchesCompleted,
      batchMaxFanout: stats.batchMaxFanout,
      deduplicatedRequests: stats.deduplicatedRequests,
      cacheEvictions: stats.cacheEvictions,
      bypassed: stats.bypassed,
      reductionFactor:
        stats.ftsQueries > 0 ? Number((stats.served / stats.ftsQueries).toFixed(2)) : 0,
    },
    activeBatches: activeBatchesList(),
    history: history.slice(),
    perShard: perShardSnapshot(),
  };
}

/**
 * Flat metrics shape for the 'searchopt' pull collector — consumed by
 * modules/ops/metrics.js renderPrometheus (animaxia_search_opt_*,
 * animaxia_search_batch_hits, animaxia_search_cache_hits,
 * animaxia_search_cache_misses, animaxia_search_dedup_count series) and
 * available as collectors.searchopt in the ?format=json snapshot.
 */
export function searchOptMetricsSnapshot() {
  return {
    enabled: config.enabled,
    cacheTtlMs: config.cacheTtlMs,
    cacheMax: config.cacheMax,
    batchMax: config.batchMax,
    activeBatches: batchMap.size,
    cacheEntries: searchCache.size,
    cacheHits: stats.cacheHits,
    cacheMisses: stats.cacheMisses,
    cacheHitRatio:
      stats.cacheHits + stats.cacheMisses > 0
        ? Number((stats.cacheHits / (stats.cacheHits + stats.cacheMisses)).toFixed(4))
        : 0,
    cacheEvictions: stats.cacheEvictions,
    batchHits: stats.batchHits,
    batchesCreated: stats.batchesCreated,
    batchesCompleted: stats.batchesCompleted,
    batchMaxFanout: stats.batchMaxFanout,
    deduplicatedRequests: stats.deduplicatedRequests,
    ftsQueries: stats.ftsQueries,
    ftsErrors: stats.ftsErrors,
    served: stats.served,
    bypassed: stats.bypassed,
    perShard: perShardSnapshot(),
  };
}

/**
 * Runtime reconfiguration (POST /api/search/opt/settings, admin only).
 * Validates and clamps every knob; ttlMs changes do NOT flush the cache
 * (each entry carries its own expiresAt — old entries keep their old TTL,
 * new stores use the new one). Disabling the layer never strands anyone:
 * in-flight batches settle normally, cached entries simply stop being read.
 */
export function updateSearchOptConfig(patch = {}) {
  const before = { ...config };
  if (patch.enabled !== undefined) config.enabled = Boolean(patch.enabled);
  if (patch.cacheTtlMs !== undefined) {
    config.cacheTtlMs = clampInt(patch.cacheTtlMs, config.cacheTtlMs, 1000, 5000);
  }
  if (patch.cacheMax !== undefined) {
    config.cacheMax = clampInt(patch.cacheMax, config.cacheMax, 100, 100000);
  }
  if (patch.batchMax !== undefined) {
    config.batchMax = clampInt(patch.batchMax, config.batchMax, 100, 50000);
  }
  logger.info(
    `[search-opt] config updated${config.enabled ? '' : ' (DISABLED)'} — cacheTtlMs=${config.cacheTtlMs} cacheMax=${config.cacheMax} batchMax=${config.batchMax} (was: cacheTtlMs=${before.cacheTtlMs})`,
  );
  return { ...config };
}

/** Is the FAZA 17 layer enabled? (The search routes use this to pick between
 *  the optimization executor and their legacy single-flight path.) */
export function searchOptEnabled() {
  return config.enabled === true;
}

/* Boot: the 1s history sampler + cache sweeper run from module load (a tick
 * over empty state is a no-op). bun --watch restarts re-import the module
 * and the timer re-arms. */
startHistorySampler();

logger.info(
  `[search-opt] FAZA 17 Search Optimization Layer ready — ${config.enabled ? 'ENABLED' : 'disabled'} · cache ttl=${config.cacheTtlMs}ms max=${config.cacheMax} · batches max=${config.batchMax} · pipeline ${SEARCH_PIPELINE_STAGES.length} stages (dedup → batching → cache → fts)`,
);
