/**
 * services/search-cluster/index.js — FAZA 13 (Task 13-3): the Animaxia search
 * cluster — Neon FTS over the SHARDED `searchdocs` index.
 *
 * NODE MODEL (honest logical/physical cluster):
 *   • one node per shard (shardId 0..SHARDCOUNT-1);
 *   • LOGICAL mode (no SHARD{N}URL — default): every node's queries run
 *     through queryOnShard(shardId), which lands on the MAIN pool with an
 *     `AND shardid = $n` scope — REAL fan-out code on a single physical DB;
 *   • PHYSICAL mode (SHARD{N}URL configured): the identical code hits that
 *     shard's dedicated Neon branch pool (data placement per branch is a
 *     deployment concern — routing, counters, health are real in both modes);
 *   • health/counters/metrics are REAL in both modes — nothing is faked.
 *
 * QUERY SEMANTICS — per node the SAME query as the monolith's legacy
 * runAdvancedQuery (modules/search/search.js, FAZA 16/17): text match
 * `tsv @@ websearch_to_tsquery('simple', $q)` with a trigram fallback per node
 * when the FTS pass returns 0 hits and fuzzy !== 'false' (title % q OR
 * per-word ILIKE, similarity() > 0.1 guard), combined score
 * `ts_rank(tsv, q) * 2 + similarity(title, q) + (title ILIKE 'q%' → +0.5)`,
 * empty q + filters → filter-only (no text score), SQL-side filters
 * (type/genre/year/actor/studio/category/minRating — array filters use the
 * exact search.js EXISTS(unnest(...) ILIKE ...) semantics), ORDER BY per sort
 * (score/year/rating/title + contentid tie-breaks), LIMIT/OFFSET per node,
 * plus the per-node `AND shardid = $n` scope. Merge: concat → dedupe by
 * contentid → re-sort by the sort criterion → slice to limit; total = SUM of
 * the per-node COUNT(*) (the COUNT runs per node too).
 *
 * OFFSET CAP MIRROR (FAZA 17 contract): page*limit > 10000 →
 * { error, useCursor: true } — the route passes it through as 400 exactly
 * like the legacy path; keyset (cursor) requests ALWAYS stay on the legacy
 * single-index path in search.js (cluster responses are paginationMode
 * 'offset' with nextCursor null by design).
 *
 * TARGETED vs ALL FAN-OUT (query-side affinity only — pinned DESIGN):
 *   when shardHint is a valid shard id (gateway `X-Animaxia-Shard` header),
 *   the hinted node is queried FIRST (targeted affinity) and the parallel
 *   fan-out over the REMAINING nodes completes the result set — the union is
 *   always the full cluster, so a hint never blanks results (no split brain:
 *   searchdocs rows live on computeShardIdFromContentId(contentid), the same
 *   RANGE rule search.js syncIndex stamps). Without a hint: parallel fan-out
 *   over ALL nodes (Promise.allSettled). A failing node is reported in
 *   cluster.nodes[].error; the query only fails when EVERY node fails.
 *
 * ENGINE LABEL: 'animaxia-neon-fts' — the FAZA 16 engine label is KEPT (the
 * cluster is the same engine, fanned out; the additive `cluster` field is the
 * only shape change vs the legacy /advanced response).
 *
 * TOGGLE: SEARCHCLUSTENABLED (default false when unset; .env sets it true) —
 * when disabled, search.js keeps the byte-identical legacy path.
 *
 * FAZA 14 (Task 14-1) — COALESCED-LOGICAL EXECUTION (mandatory at 30 shards):
 * when shardingModelSnapshot().mode === 'logical' (every shard backed by the
 * MAIN pool — one physical Neon), the per-node fan-out would fire
 * 2 × SHARDCOUNT queries per search (60 at 30 shards) through the same pool.
 * Instead the cluster runs ONE merged data query (the EXACT legacy
 * runAdvancedQuery SQL — no shard predicate) + ONE count query with
 * GROUP BY s.shardid for per-shard attribution: 2 queries total, identical
 * results (the union over all shardid scopes IS the unsharded table), and
 * MORE faithful to legacy semantics than the fan-out (the trigram fallback
 * decision is taken once over the whole index, exactly like legacy, instead
 * of per node). Response shape preserved: cluster.nodes still carries one
 * entry per shard (hits = per-shard GROUP BY counts, Σ hits = total), with
 * tookMs null per node (no per-node execution) and the additive field
 * cluster.execution = 'coalesced-logical' | 'fanout'. byShard stats count a
 * query on EVERY covered shard (documented semantics). PHYSICAL mode keeps
 * the untouched per-node fan-out. health() coalesces the same way in logical
 * mode (1 ping + 1 GROUP BY COUNT instead of 2 × SHARDCOUNT probes — critical
 * because /api/shards, /api/shards/health and every /api/metrics scrape call
 * health()).
 */

import { queryOnShard, ensureShardPool, listShardPools } from '../../db.js';
import {
  shardCount,
  shardBranchName,
  shardingModelSnapshot,
  computeShardIdFromContentId,
} from '../../modules/sharding/model.js';
import { parseJsonb } from '../../modules/platform/sql.js';
import { logger } from '../../utils/logger.js';

const ENGINE = 'animaxia-neon-fts'; // FAZA 16 engine label — KEPT
const OFFSET_CAP = 10000; // FAZA 17 offset pagination ceiling (rows)
const LIMIT_CAP = 50; // max rows per request (legacy /advanced cap)
const LATENCY_WINDOW = 50; // rolling latency samples for p50/p95
const SYNC_CHUNK = 25; // rows per multi-row searchdocs upsert (search.js SYNC_CHUNK)

const SORTS = new Set(['score', 'year', 'rating', 'title']);

/* ------------------------------- ops counters -------------------------------- */

const ops = { queries: 0, errors: 0, coalesced: 0, lastError: null };
const latencies = []; // took ms of the last 50 executed cluster queries
const byShardStats = new Map(); // shardId -> { queries, errors }

function byShard(shardId) {
  let entry = byShardStats.get(shardId);
  if (!entry) {
    entry = { queries: 0, errors: 0 };
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

/** Cluster is enabled only when SEARCHCLUSTENABLED === 'true'. */
export function enabled() {
  return process.env.SEARCHCLUSTENABLED === 'true';
}

/**
 * Ops snapshot for /api/shards + /api/search/status:
 * { enabled, queries, errors, coalesced, nodesHealthy, nodesTotal,
 *   latencyP50Ms, latencyP95Ms, byShard, lastError } — nodesHealthy/nodesTotal
 * are read live from the shard pool registry (real in logical AND physical
 * mode); coalesced counts identical concurrent queryFTS calls that shared one
 * promise (FAZA 17 single-flight style).
 */
export function searchClusterOpsSnapshot() {
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
    coalesced: ops.coalesced,
    nodesHealthy,
    nodesTotal,
    latencyP50Ms: percentile(sorted, 0.5),
    latencyP95Ms: percentile(sorted, 0.95),
    byShard: byShardSnapshot(),
    lastError: ops.lastError,
  };
}

/* ------------------------------ node primitives ------------------------------ */

/** All shard ids (one cluster node per shard). */
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

/** Normalize a joined row to the canonical content shape (mirrors search.js
 *  normalizeHit — id/externalid/type/title/metadata/thumbnail/createdat/_score). */
function normalizeHit(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    externalid: row.externalid ?? null,
    type: row.type ?? null,
    title: row.title ?? null,
    metadata: parseJsonb(row.metadata, {}),
    thumbnail: row.thumbnail === undefined ? null : row.thumbnail,
    createdat:
      row.createdat instanceof Date ? row.createdat.toISOString() : String(row.createdat ?? ''),
    _score: row._score == null ? 0 : Number(Number(row._score).toFixed(6)),
  };
}

/**
 * Run the SAME advanced query as the legacy runAdvancedQuery on ONE shard node
 * (searchdocs scoped by `AND s.shardid = $n` via queryOnShard — real routing).
 * Mirrors the count pass, the trigram fuzzy fallback and the data pass of
 * modules/search/search.js; returns { shardid, total, maxScore, rows, tookMs }.
 */
async function runNodeQuery(shardId, input) {
  const startedAt = Date.now();
  const { q, fuzzyEnabled, sort, limit, offset } = input;
  const { params, P, scoreExpr, textMatch, whereFor } = buildQueryPlan(input, shardId);

  // 1. FTS pass (or filter-only when q is empty) — COUNT + MAX(score) per node.
  let matchSql = textMatch;
  let countRes = await queryOnShard(
    shardId,
    `SELECT COUNT(*)::int AS total, COALESCE(MAX(${scoreExpr}), 0) AS maxscore FROM searchdocs s ${whereFor(matchSql)}`,
    params,
  );
  let countRow = countRes.rows?.[0] ?? { total: 0, maxscore: 0 };

  // 2. Trigram fuzzy fallback per node when the FTS pass matched nothing
  //    (identical clause construction to search.js: per-word ILIKE + % + sim).
  if (q && fuzzyEnabled && Number(countRow?.total ?? 0) === 0) {
    matchSql = buildTrigramFallback(q, P);
    countRes = await queryOnShard(
      shardId,
      `SELECT COUNT(*)::int AS total, COALESCE(MAX(${scoreExpr}), 0) AS maxscore FROM searchdocs s ${whereFor(matchSql)}`,
      params,
    );
    countRow = countRes.rows?.[0] ?? { total: 0, maxscore: 0 };
  }

  // 3. Data page — same subquery + JOIN content + ORDER BY as the legacy path.
  const limitPh = P(limit);
  const offsetPh = P(offset);
  const dataRes = await queryOnShard(
    shardId,
    `SELECT c.id, c.externalid, c.type, c.title, c.metadata, c.thumbnail, c.createdat,
            t.score AS _score, t.year AS _year, t.rating AS _rating, t.title AS _title
     FROM (
       SELECT s.contentid, s.year, s.rating, s.title, ${scoreExpr} AS score
       FROM searchdocs s
       ${whereFor(matchSql)}
     ) t
     JOIN content c ON c.id = t.contentid
     ORDER BY ${orderExprFor(sort)}
     LIMIT ${limitPh} OFFSET ${offsetPh}`,
    params,
  );

  return {
    shardid: shardId,
    total: Number(countRow?.total ?? 0),
    maxScore: Number(countRow?.maxscore ?? 0),
    rows: dataRes.rows ?? [],
    tookMs: Date.now() - startedAt,
  };
}

/** ORDER BY expression per sort (mirrors the legacy runAdvancedQuery sorts,
 *  NULLS LAST included) — shared by the node query and the coalesced query. */
function orderExprFor(sort) {
  return sort === 'year'
    ? 't.year DESC NULLS LAST, t.contentid ASC'
    : sort === 'rating'
      ? 't.rating DESC NULLS LAST, t.score DESC, t.contentid ASC'
      : sort === 'title'
        ? 't.title ASC, t.contentid ASC'
        : sort === 'contentid'
          ? 't.contentid ASC'
          : 't.score DESC, t.contentid ASC';
}

/** Trigram fuzzy fallback match SQL — identical clause construction to
 *  search.js (per-word ILIKE + % + similarity > 0.1). P is the plan's param
 *  placeholder builder (params keep accumulating, placeholders stay stable). */
function buildTrigramFallback(q, P) {
  const words = q.split(/\s+/).filter(Boolean);
  const trigramClauses = [];
  for (const candidate of [q, ...words]) {
    trigramClauses.push(`s.title ILIKE ${P(`%${candidate}%`)}`);
  }
  const qSim = P(q);
  trigramClauses.push(`(s.title % ${qSim} OR similarity(s.title, ${qSim}) > 0.1)`);
  return `(${trigramClauses.join(' OR ')})`;
}

/**
 * FAZA 14: shared query plan — filters, score expression and match SQL built
 * EXACTLY like the legacy runAdvancedQuery fragments. shardId !== null adds
 * the per-node `AND s.shardid = $n` scope (fan-out path); shardId null builds
 * the coalesced-logical plan (no shard predicate — the merged query IS the
 * legacy unsharded query). Param ORDER is identical in both variants.
 */
function buildQueryPlan(input, shardId) {
  const { q, type, genre, year, minRating, actor, studio, category } = input;
  const params = [];
  const P = (v) => {
    params.push(v);
    return `$${params.length}`;
  };

  // Field filters — identical fragments to search.js runAdvancedQuery
  // (array containment via EXISTS(unnest(...) ILIKE ...) exactly like legacy).
  const filters = [];
  if (type) filters.push(`s.type = ${P(type)}`);
  if (genre) filters.push(`EXISTS (SELECT 1 FROM unnest(s.genres) g WHERE g ILIKE ${P(genre)})`);
  if (year != null) filters.push(`s.year = ${P(year)}`);
  if (actor) {
    filters.push(`EXISTS (SELECT 1 FROM unnest(s.actors) a WHERE a ILIKE '%' || ${P(actor)} || '%')`);
  }
  if (studio) {
    filters.push(`EXISTS (SELECT 1 FROM unnest(s.studios) st WHERE st ILIKE '%' || ${P(studio)} || '%')`);
  }
  if (category) filters.push(`s.category = ${P(category)}`);
  if (minRating != null) filters.push(`s.rating >= ${P(minRating)}`);
  // FAZA 13: the per-node shard scope — this is the actual cluster routing.
  // (Skipped for the FAZA 14 coalesced-logical merged plan.)
  if (shardId !== null && shardId !== undefined) filters.push(`s.shardid = ${P(shardId)}`);
  const filterSql = filters.length ? ` AND ${filters.join(' AND ')}` : '';

  // Text score expression (combined: ts_rank * 2 + similarity + prefix bonus).
  let scoreExpr = '0';
  let textMatch = '';
  if (q) {
    const qp = P(q);
    scoreExpr =
      `ts_rank(s.tsv, websearch_to_tsquery('simple', ${qp})) * 2` +
      ` + similarity(s.title, ${qp})` +
      ` + CASE WHEN s.title ILIKE ${qp} || '%' THEN 0.5 ELSE 0 END`;
    textMatch = `s.tsv @@ websearch_to_tsquery('simple', ${qp})`;
  }

  const whereFor = (matchSql) => `WHERE (${matchSql || 'TRUE'})${filterSql}`;
  return { params, P, filterSql, scoreExpr, textMatch, whereFor };
}

/**
 * FAZA 14 (Task 14-1): COALESCED-LOGICAL merged query — the legacy
 * runAdvancedQuery SQL over the WHOLE index (no shard predicate) plus a
 * GROUP BY s.shardid count pass for per-shard attribution. Two queries total,
 * identical param ORDER to the node plan. The trigram fallback decision is
 * taken once over the whole index (exactly like legacy). Returns
 * { groups: [{shardid, total, maxScore}], rows, tookMs }.
 */
async function runCoalescedQuery(input) {
  const startedAt = Date.now();
  const { q, fuzzyEnabled, sort, limit, offset } = input;
  const { params, P, scoreExpr, textMatch, whereFor } = buildQueryPlan(input, null);

  // 1. FTS pass (or filter-only) — per-shard COUNT + MAX(score) via GROUP BY.
  let matchSql = textMatch;
  let countRes = await queryOnShard(
    0, // logical mode: every shard routes to the MAIN pool — node 0 IS that pool
    `SELECT s.shardid AS sid, COUNT(*)::int AS total, COALESCE(MAX(${scoreExpr}), 0) AS maxscore
     FROM searchdocs s ${whereFor(matchSql)} GROUP BY s.shardid`,
    params,
  );
  let countRows = countRes.rows ?? [];
  const sumOf = (rows) => rows.reduce((acc, r) => acc + Number(r.total ?? 0), 0);

  // 2. Trigram fuzzy fallback when the FTS pass matched nothing (whole index).
  if (q && fuzzyEnabled && sumOf(countRows) === 0) {
    matchSql = buildTrigramFallback(q, P);
    countRes = await queryOnShard(
      0,
      `SELECT s.shardid AS sid, COUNT(*)::int AS total, COALESCE(MAX(${scoreExpr}), 0) AS maxscore
       FROM searchdocs s ${whereFor(matchSql)} GROUP BY s.shardid`,
      params,
    );
    countRows = countRes.rows ?? [];
  }

  // 3. Data page — the legacy query itself (global ORDER BY + LIMIT/OFFSET).
  const limitPh = P(limit);
  const offsetPh = P(offset);
  const dataRes = await queryOnShard(
    0,
    `SELECT c.id, c.externalid, c.type, c.title, c.metadata, c.thumbnail, c.createdat,
            t.score AS _score, t.year AS _year, t.rating AS _rating, t.title AS _title
     FROM (
       SELECT s.contentid, s.year, s.rating, s.title, ${scoreExpr} AS score
       FROM searchdocs s
       ${whereFor(matchSql)}
     ) t
     JOIN content c ON c.id = t.contentid
     ORDER BY ${orderExprFor(sort)}
     LIMIT ${limitPh} OFFSET ${offsetPh}`,
    params,
  );

  return {
    groups: (countRows ?? []).map((r) => ({
      shardid: Number(r.sid),
      total: Number(r.total ?? 0),
      maxScore: Number(r.maxscore ?? 0),
    })),
    rows: dataRes.rows ?? [],
    tookMs: Date.now() - startedAt,
  };
}

/* ------------------------------ merge utilities ------------------------------ */

/** DESC with NULLS LAST semantics for the merged re-sort (year/rating sorts). */
function descNullsLast(va, vb) {
  if (va == null && vb == null) return 0;
  if (va == null) return 1; // nulls last
  if (vb == null) return -1;
  return vb - va; // DESC
}

/** JS comparator mirroring the SQL ORDER BY of each sort (contentid tie-break). */
function mergeComparator(effectiveSort) {
  if (effectiveSort === 'year') {
    return (a, b) => descNullsLast(a._year, b._year) || a.id - b.id;
  }
  if (effectiveSort === 'rating') {
    return (a, b) => descNullsLast(a._rating, b._rating) || b._score - a._score || a.id - b.id;
  }
  if (effectiveSort === 'title') {
    return (a, b) => String(a._title ?? '').localeCompare(String(b._title ?? '')) || a.id - b.id;
  }
  if (effectiveSort === 'contentid') {
    return (a, b) => a.id - b.id;
  }
  return (a, b) => b._score - a._score || a.id - b.id; // 'score'
}

/* ------------------------- single-flight coalescing -------------------------- */

const inflight = new Map();

/** FAZA 17-style single-flight: identical concurrent queryFTS calls share one
 *  promise (coalesced counter, map entry removed on settle). */
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

/* --------------------------------- queryFTS ---------------------------------- */

/**
 * Cluster advanced search — fan-out over the per-shard searchdocs nodes, merge
 * + dedupe by contentid, re-sort, slice; total = SUM of per-node COUNT(*).
 *
 * @param {object} params { q, type, genre, year, minRating, actor, studio,
 *   category, sort ('score'|'year'|'rating'|'title'), fuzzy ('true'/'false'),
 *   limit (cap 50), page, shardHint (int|null) }
 * @returns {Promise<object>} legacy /advanced response shape + additive
 *   `cluster` field (the ONLY shape change); { error, useCursor: true } when
 *   page*limit > 10000 (FAZA 17 offset cap mirror).
 */
async function queryFTS(params = {}) {
  const q = params.q != null ? String(params.q).trim() : '';
  const type = params.type ? String(params.type) : null;
  const genre = params.genre ? String(params.genre) : null;
  const actor = params.actor ? String(params.actor) : null;
  const studio = params.studio ? String(params.studio) : null;
  const category = params.category ? String(params.category) : null;
  const sortRaw = params.sort ? String(params.sort) : 'score';
  const sort = SORTS.has(sortRaw) ? sortRaw : 'score';
  const fuzzyEnabled = !(params.fuzzy === 'false' || params.fuzzy === false);
  const limit = Math.min(LIMIT_CAP, Math.max(1, parseInt(params.limit, 10) || 20));
  const page = Math.max(1, parseInt(params.page, 10) || 1);
  const minRating =
    params.minRating != null && Number.isFinite(Number(params.minRating)) ? Number(params.minRating) : null;
  let year = null;
  if (params.year != null && params.year !== '') {
    year = parseInt(params.year, 10);
    if (!Number.isInteger(year)) {
      // Mirror the legacy route's empty result for a non-integer year.
      return {
        took: 0, total: 0, max_score: 0, page, limit, engine: ENGINE, data: [],
        nextCursor: null, paginationMode: 'offset',
        cluster: { nodes: [], mode: shardingModelSnapshot().mode, fanout: 'all' },
      };
    }
  }

  // FAZA 17 offset cap mirror — deep pages must use the cursor (legacy path).
  if (page * limit > OFFSET_CAP) {
    return {
      error: `Offset pagination capped at ${OFFSET_CAP} rows — use cursor pagination (pass cursor param)`,
      useCursor: true,
    };
  }

  const n = shardCount();
  const hintParsed = parseInt(params.shardHint, 10);
  const shardHint = Number.isInteger(hintParsed) && hintParsed >= 0 && hintParsed < n ? hintParsed : null;

  // Single-flight key on the full normalized params (shardHint included).
  const key = JSON.stringify({
    q, type, genre, year, minRating, actor, studio, category, sort,
    fuzzy: fuzzyEnabled ? 'true' : 'false', limit, page, shardHint,
  });

  return coalesce(key, () =>
    runClusterQuery({
      q: q || null, type, genre, year, minRating, actor, studio, category, sort,
      fuzzyEnabled, limit, page, shardHint,
    }),
  );
}

/** Leader execution: FAZA 14 coalesced-logical (one merged query when every
 *  shard is main-pool-backed) or the FAZA 13 per-node fan-out (physical mode),
 *  merge, build the response. */
async function runClusterQuery(input) {
  const startedAt = Date.now();
  ops.queries += 1;

  const { q, sort, fuzzyEnabled, limit, page, shardHint } = input;
  const offset = (page - 1) * limit;
  // Filter-only (no q) with default 'score' sort → contentid ordering (legacy).
  const effectiveSort = !q && sort === 'score' ? 'contentid' : sort;

  const ids = nodeIds();
  const nodeResults = [];
  const nodeErrors = [];

  /* ------------------ FAZA 14: coalesced-logical execution ------------------ */
  if (shardingModelSnapshot().mode === 'logical') {
    // The query covers EVERY shard → every shard's stats see it (documented
    // semantics: "cluster queries covering this shard").
    for (const id of ids) byShard(id).queries += 1;
    try {
      const coalesced = await runCoalescedQuery({ ...input, offset });
      // Per-shard attribution entries (Σ total = global total; a shard with no
      // matching docs simply has no group → hits 0 in the nodes report).
      for (const group of coalesced.groups) {
        nodeResults.push({
          shardid: group.shardid,
          total: group.total,
          maxScore: group.maxScore,
          rows: [],
          tookMs: null, // no per-node execution — one merged query served all
        });
      }
      // The merged page carrier (global ORDER BY + LIMIT/OFFSET already applied).
      nodeResults.push({
        shardid: null,
        total: 0,
        maxScore: 0,
        rows: coalesced.rows,
        tookMs: coalesced.tookMs,
      });
    } catch (err) {
      ops.errors += 1;
      ops.lastError = `coalesced-logical query failed: ${err.message}`;
      for (const id of ids) byShard(id).errors += 1;
      logger.warn(`[search-cluster] coalesced-logical query failed: ${err.message}`);
      const failure = new Error(`Search cluster: coalesced-logical query failed — ${err.message}`);
      failure.status = 503;
      throw failure;
    }
  } else {
    /* -------------------- FAZA 13: per-node fan-out (physical) -------------------- */
    const runOne = async (shardId) => {
      const stats = byShard(shardId);
      stats.queries += 1;
      try {
        nodeResults.push(await runNodeQuery(shardId, { ...input, offset }));
      } catch (err) {
        stats.errors += 1;
        nodeErrors.push({ shardid: shardId, error: err.message });
        logger.warn(`[search-cluster] node ${shardId} query failed: ${err.message}`);
      }
    };

    if (shardHint != null) {
      // Targeted affinity: the hinted node runs FIRST, the remaining nodes
      // complete the result set in parallel (query-side affinity only — the
      // union is always the full cluster, so a hint never blanks results).
      await runOne(shardHint);
      await Promise.allSettled(ids.filter((id) => id !== shardHint).map(runOne));
    } else {
      await Promise.allSettled(ids.map(runOne));
    }

    // Every node failed → the cluster query fails (never fake results).
    if (nodeResults.length === 0 && nodeErrors.length > 0) {
      ops.errors += 1;
      ops.lastError = nodeErrors.map((e) => `shard ${e.shardid}: ${e.error}`).join('; ');
      const err = new Error(`Search cluster: all ${nodeErrors.length} nodes failed — ${ops.lastError}`);
      err.status = 503;
      throw err;
    }
  }

  // Merge: concat → dedupe by contentid → re-sort by the sort criterion.
  // (In coalesced-logical mode the single merged result is already the global
  // page — dedupe/sort are a harmless no-op passthrough that keeps ONE code
  // path for the response shape.)
  const seen = new Set();
  const merged = [];
  for (const node of nodeResults) {
    for (const raw of node.rows) {
      const hit = normalizeHit(raw);
      if (!hit || seen.has(hit.id)) continue;
      seen.add(hit.id);
      merged.push({
        ...hit,
        _year: raw._year == null ? null : Number(raw._year),
        _rating: raw._rating == null ? null : Number(raw._rating),
        _title: raw._title ?? null,
      });
    }
  }
  merged.sort(mergeComparator(effectiveSort));
  const pageRows = merged.slice(0, limit);

  const total = nodeResults.reduce((acc, node) => acc + node.total, 0);
  const maxScore = nodeResults.reduce((acc, node) => Math.max(acc, node.maxScore), 0);

  // Node report in execution order (hinted node first when targeted).
  const ordered = shardHint != null ? [shardHint, ...ids.filter((id) => id !== shardHint)] : ids;
  const nodes = ordered.map((shardId) => {
    const ok = nodeResults.find((r) => r.shardid === shardId);
    const failed = nodeErrors.find((e) => e.shardid === shardId);
    return {
      shardid: shardId,
      branch: shardBranchName(shardId),
      mode: nodeMode(shardId),
      hits: ok ? ok.total : 0, // per-node COUNT(*) — Σ hits = total
      tookMs: ok ? ok.tookMs : null,
      error: failed ? failed.error : null,
    };
  });

  const took = Date.now() - startedAt;
  recordLatency(took);
  ops.lastError = null;

  return {
    took,
    total,
    max_score: Number(maxScore.toFixed(6)),
    page,
    limit,
    engine: ENGINE, // FAZA 16 engine label — KEPT (same engine, fanned out)
    data: pageRows.map(({ _year, _rating, _title, ...pub }) => pub), // legacy row shape
    nextCursor: null, // cluster mode is offset-only; cursors route legacy
    paginationMode: 'offset',
    cluster: {
      nodes,
      mode: shardingModelSnapshot().mode,
      fanout: shardHint != null ? 'targeted' : 'all',
      execution: shardingModelSnapshot().mode === 'logical' ? 'coalesced-logical' : 'fanout', // FAZA 14
    },
  };
}

/* --------------------------------- indexBatch -------------------------------- */

/**
 * Upsert search docs into the cluster — each doc routed via
 * computeShardIdFromContentId(contentid) to queryOnShard with the SAME
 * 12-param-per-row multi-row upsert SQL search.js syncIndex runs (chunks of 25).
 *
 * @param {Array<{contentid, externalid, type, title, year, rating, genres,
 *   actors, studios, category, documenttext?}>} docs — documenttext overrides
 *   the default document text (title + genres, mirroring syncIndex's
 *   buildTsvText minus the overview which lives in content metadata).
 * @returns {Promise<{indexed: number, byShard: object, tookMs: number}>}
 */
async function indexBatch(docs) {
  const startedAt = Date.now();
  const list = Array.isArray(docs) ? docs : [];
  const groups = new Map(); // shardId -> docs[]
  for (const doc of list) {
    const contentid = Number(doc?.contentid);
    if (!Number.isFinite(contentid)) continue;
    const shardid = computeShardIdFromContentId(contentid);
    if (!groups.has(shardid)) groups.set(shardid, []);
    groups.get(shardid).push(doc);
  }

  let indexed = 0;
  const byShardCounts = {};
  for (const [shardid, group] of groups) {
    for (let i = 0; i < group.length; i += SYNC_CHUNK) {
      const slice = group.slice(i, i + SYNC_CHUNK);
      const values = [];
      const tuples = slice.map((doc, j) => {
        const genres = Array.isArray(doc.genres) ? doc.genres.map(String) : [];
        const tsvText =
          doc.documenttext != null
            ? String(doc.documenttext)
            : [String(doc.title || ''), genres.join(' ')].join(' ').trim();
        const base = j * 12;
        values.push(
          Number(doc.contentid),
          doc.externalid ?? null,
          doc.type ?? null,
          doc.title ?? 'untitled',
          tsvText,
          doc.year ?? null,
          doc.rating ?? null,
          genres,
          Array.isArray(doc.actors) ? doc.actors.map(String) : [],
          Array.isArray(doc.studios) ? doc.studios.map(String) : [],
          doc.category ?? doc.type ?? null,
          shardid,
        );
        const b = (k) => `$${base + k}`;
        return `(${b(1)},${b(2)},${b(3)},${b(4)},to_tsvector('simple', ${b(5)}),${b(6)},${b(7)},${b(8)}::text[],${b(9)}::text[],${b(10)}::text[],${b(11)},${b(12)},NOW())`;
      });
      // Same 12-param upsert SQL as search.js syncIndex (13-2), shard-routed.
      await queryOnShard(
        shardid,
        `INSERT INTO searchdocs
           (contentid, externalid, type, title, tsv, year, rating, genres, actors, studios, category, shardid, syncedat)
         VALUES ${tuples.join(', ')}
         ON CONFLICT (contentid) DO UPDATE SET
           externalid = EXCLUDED.externalid,
           type = EXCLUDED.type,
           title = EXCLUDED.title,
           tsv = EXCLUDED.tsv,
           year = EXCLUDED.year,
           rating = EXCLUDED.rating,
           genres = EXCLUDED.genres,
           actors = EXCLUDED.actors,
           studios = EXCLUDED.studios,
           category = EXCLUDED.category,
           shardid = EXCLUDED.shardid,
           syncedat = NOW()`,
        values,
      );
      indexed += slice.length;
      byShardCounts[String(shardid)] = (byShardCounts[String(shardid)] || 0) + slice.length;
    }
  }

  return { indexed, byShard: byShardCounts, tookMs: Date.now() - startedAt };
}

/* ----------------------------------- health ---------------------------------- */

/**
 * Per-node health: ping (SELECT 1 via queryOnShard) + doc count + latencyMs.
 * Real in logical AND physical mode.
 *
 * FAZA 14 (Task 14-1): in LOGICAL mode the probe is COALESCED — one ping +
 * one `GROUP BY shardid` COUNT covers all 30 nodes (2 queries instead of
 * 2 × SHARDCOUNT; /api/shards, /api/shards/health and every /api/metrics
 * scrape call this). Per-node entries keep the exact FAZA 13 shape; the
 * additive `execution: 'coalesced-logical'` field marks the mode.
 * PHYSICAL mode keeps the per-node probes (dedicated branch pools).
 */
async function health() {
  const mode = shardingModelSnapshot().mode;

  if (mode === 'logical') {
    const startedAt = Date.now();
    const stamp = () => new Date().toISOString();
    try {
      await queryOnShard(0, 'SELECT 1 AS ok');
      const cnt = await queryOnShard(
        0,
        'SELECT shardid, COUNT(*)::int AS n FROM searchdocs GROUP BY shardid',
      );
      const latencyMs = Date.now() - startedAt;
      const byId = new Map(
        (cnt.rows ?? []).map((r) => [Number(r.shardid), Number(r.n ?? 0)]),
      );
      const nodes = nodeIds().map((shardId) => ({
        shardid: shardId,
        branch: shardBranchName(shardId),
        mode: 'main',
        healthy: true,
        docs: byId.get(shardId) ?? 0,
        latencyMs, // single merged probe latency, reported per covered shard
        lastError: null,
      }));
      return {
        enabled: enabled(),
        mode,
        execution: 'coalesced-logical', // FAZA 14 additive field
        nodes,
        healthy: nodes.length > 0,
        generatedAt: stamp(),
      };
    } catch (err) {
      const latencyMs = Date.now() - startedAt;
      const nodes = nodeIds().map((shardId) => ({
        shardid: shardId,
        branch: shardBranchName(shardId),
        mode: 'main',
        healthy: false,
        docs: 0,
        latencyMs,
        lastError: err.message,
      }));
      return {
        enabled: enabled(),
        mode,
        execution: 'coalesced-logical',
        nodes,
        healthy: false,
        generatedAt: stamp(),
      };
    }
  }

  const nodes = await Promise.all(
    nodeIds().map(async (shardId) => {
      const startedAt = Date.now();
      try {
        await queryOnShard(shardId, 'SELECT 1 AS ok');
        const cnt = await queryOnShard(shardId, 'SELECT COUNT(*)::int AS n FROM searchdocs WHERE shardid = $1', [shardId]);
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
    mode,
    execution: 'fanout', // FAZA 14 additive field
    nodes,
    healthy: nodes.length > 0 && nodes.every((n) => n.healthy),
    generatedAt: new Date().toISOString(),
  };
}

/* ---------------------------------- exports ---------------------------------- */

export const searchCluster = { enabled, queryFTS, indexBatch, health };
export default searchCluster;
