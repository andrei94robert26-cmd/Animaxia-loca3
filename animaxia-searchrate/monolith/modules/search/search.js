/**
 * modules/search/search.js — FAZA 16-a: Neon PostgreSQL full-text search
 * engine over the `searchdocs` denormalized index table (synced from
 * `content`). Engine label: 'animaxia-neon-fts'.
 *
 * FAZA 17-a hardening (all additive — FAZA 16 contracts intact):
 *   • OFFSET pagination capped at 10000 rows: page*limit > 10000 without a
 *     cursor → 400 { error, useCursor: true } (offsetCapped counter);
 *   • keyset (cursor) pagination: ?cursor=base64url({sort-specific payload +
 *     p: pageNumber}) — per-sort WHERE continuations (score/year/rating/title,
 *     tie-break on contentid; filter-only + no q → contentid keyset);
 *     responses gain nextCursor (string|null) + paginationMode 'offset'|'cursor';
 *   • single-flight coalescing: identical concurrent /advanced requests share
 *     one promise (coalesced counter, map cleared on settle);
 *   • query timeout: runAdvancedQuery races an 8s budget → 504
 *     { error: 'Search query timeout' } (errors counter, loser logged);
 *   • searchOpsSnapshot() exports { coalesced, errors, offsetCapped } for the
 *     stability endpoint; runSearchLoad(q) is the stress-lab entry point.
 *
 * Index: syncIndex() upserts every content row into searchdocs with a
 * to_tsvector('simple', …) document (title + genres + first 500 chars of the
 * overview) plus year / rating / genres[] / actors[] / studios[] / category
 * extracted from the JSONB metadata. Boot is lazy — the first query triggers
 * ensureSynced(); 'content:changed' debounces a background resync (3s, async
 * lock coalescing).
 *
 * Router (mount: app.use('/api/search', searchRouter)):
 *   GET  /advanced?q=&type=&genre=&year=&minRating=&actor=&studio=&category=
 *        &sort=score|year|rating|title&fuzzy=true&limit=20&page=1&cursor=
 *        → { took, total, max_score, page, limit, engine, data: [...],
 *             nextCursor, paginationMode }
 *   GET  /autocomplete?q= → { suggestions: [{ id, title, type, thumbnail, rating }] }
 *   GET  /filters         → { genres, actors, years, categories, studios }
 *   POST /index           → { ok, indexed }                       (requireAuth+requireAdmin)
 *   GET  /status          → { docs, engine, backend, extensions, lastSync, dirty,
 *                             latency: { p50Ms, p95Ms, samples }, capacity }
 *
 * FAZA 15 (Search Flow Control — Task 15-1, additive): /advanced and
 * /autocomplete executions now go through the search flow queue
 * (modules/search/flow.js) — priority lanes (admin/ops/QA high, logged-in
 * normal, anonymous low, with anti-starvation aging), maxConcurrent
 * simultaneous executions and windowed dispatch (intervalMs × batchSize).
 * The queue controls ONLY admission + scheduling: the FTS executions below
 * (cluster queryFTS AND legacy runAdvancedQuery, incl. single-flight
 * coalescing and the 8s budget) are byte-identical to FAZA 14, so results
 * stay 100% real. Responses gain the additive `flow` field
 * ({ priority, shardid, queuedMs }); /status gains `flowControl` +
 * `windowing`; new console endpoints:
 *   GET  /flow            → full console snapshot (config, history, perShard)
 *   POST /flow/settings   → runtime reconfiguration (requireAuth+requireAdmin)
 *
 * FAZA 16 (Search Rate Management — Task 16-2, additive): the same two
 * routes are now PACED by modules/search/rate.js BEFORE entering the flow
 * queue — per-user rate limit (one admitted search per kind every
 * perUserMs, ENTER spam answered with 429 rate_limited), post-result
 * cooldown (advanced only, 429 cooldown_active with retryInMs) and
 * anti-spam flood detection (≥ spamThreshold arrivals in spamWindowMs →
 * auto-block, 429 spam_blocked „Așteaptă un moment…”). The gate decides
 * WHO may search HOW OFTEN — it never touches the queries, so admitted
 * searches stay byte-identical (FAZA 14 semantics, FAZA 15 scheduling).
 * /status gains the pinned `rateLimit` + `burstControl` blocks; every
 * admitted /advanced response carries `rate: { perUserMs, cooldownMs }`;
 * new console endpoints (same policy as /flow):
 *   GET  /rate            → full rate console (config, counters, history, perShard)
 *   POST /rate/settings   → runtime reconfiguration (requireAuth+requireAdmin)
 *
 * FAZA 17 (Search Optimization Layer — Task 17-2, additive): the executions
 * INSIDE the flow queue now go through modules/search/opt.js (dedup +
 * batching + micro-cache) AFTER the window dispatch and BEFORE the FTS —
 * 1000 identical concurrent requests share ONE real Neon query (batch),
 * repeats within cacheTtlMs (1000–5000ms) are served from the micro-cache,
 * and every response keeps the exact object the real execution produced
 * (nothing fabricated). Every /advanced + /autocomplete response gains the
 * additive `opt: { source, queryHash, cached, batched }` provenance block
 * (source 'neon' | 'batch' | 'cache' | 'bypass'); /status gains the pinned
 * `batching` / `cache` / `dedup` / `pipeline` blocks; new console endpoints:
 *   GET  /opt             → full optimization console (counters, active batches, history, perShard)
 *   POST /opt/settings    → runtime reconfiguration (requireAuth+requireAdmin)
 *
 * FAZA 18 (Full Integration + Stress Test) — additive on top of FAZA 15–17:
 *   • every /advanced + /autocomplete request traverses the FULL integrated
 *     10-stage pipeline (antiSpam → rateLimit → cooldown → queue → priority →
 *     windowing → dedup → batching → cache → fts) — wired once at module load
 *     via initSearchStress({ ensureSynced, queryFTS });
 *   • /status gains pipelineIntegrated + pipelineStages + stressTest (the
 *     last 10,000-simultaneous-searches run verdict, pinned
 *     { concurrent: 10000, passed: true });
 *   • new console endpoints (same policy as /flow, /rate, /opt):
 *     GET  /stress         → full stress console (last run + runs history)
 *     POST /stress         → start a full run (requireAuth+requireAdmin,
 *                            202 + poll — 409 while one is executing)
 *
 * Text match: tsv @@ websearch_to_tsquery('simple', q). When that yields 0
 * hits and fuzzy !== 'false', a trigram fallback runs (title % q OR per-word
 * ILIKE). Combined score: ts_rank(tsv, q) * 2 + similarity(title, q) +
 * (title ILIKE 'q%' → +0.5). Empty q + filters → filter-only query (no text
 * score). Rolling p50/p95 latency over the last 50 queries feeds /status.
 */

import express from 'express';
import { rows, one, parseJsonb } from '../platform/sql.js';
import { requireAuth, requireAdmin } from '../users/auth.js';
import { events } from '../platform/events.js';
import { logger } from '../../utils/logger.js';
import { computeShardIdFromContentId, shardCount, logicalAddressSpace, SHARD_SPAN_IDS } from '../sharding/model.js'; // FAZA 13 (sharding): searchdocs.shardid = catalog range shard of the contentid; FAZA 14: logical 30B address space
import { searchCluster } from '../../services/search-cluster/index.js'; // FAZA 13 (Task 13-3): search cluster — FTS fan-out over per-shard searchdocs nodes
import {
  searchFlowExecute,
  resolveSearchPriority,
  resolveSearchShard,
  searchFlowStatusSnapshot,
  searchWindowingSnapshot,
  searchFlowConsoleSnapshot,
  updateSearchFlowConfig,
} from './flow.js'; // FAZA 15: search flow control (queue + priority + windowing)
import {
  searchRateGate,
  searchRateComplete,
  searchRateStatusSnapshot,
  searchRateBurstSnapshot,
  searchRateConsoleSnapshot,
  updateSearchRateConfig,
} from './rate.js'; // FAZA 16: search rate management (rate-limit + cooldown + anti-spam + burst)
import {
  searchOptExecute,
  searchOptEnabled,
  searchOptBatchingSnapshot,
  searchOptCacheSnapshot,
  searchOptDedupSnapshot,
  searchOptPipelineSnapshot,
  searchOptConsoleSnapshot,
  updateSearchOptConfig,
} from './opt.js'; // FAZA 17: search optimization layer (dedup + batching + cache)
import {
  initSearchStress,
  runSearchStress,
  searchStressRunning,
  searchStressStatusSnapshot,
  searchStressConsoleSnapshot,
  searchStressPipelineIntegrated,
  searchStressPipelineStages,
} from './stress.js'; // FAZA 18: full pipeline integration + the 10,000-search stress engine

/**
 * FAZA 16 admission helper — runs the rate gate for one search request.
 * Returns true when the request was REJECTED (the 429 + Retry-After are
 * already sent — the caller just returns). Blocked requests never reach the
 * FAZA 15 flow queue, never touch Neon and always get an explicit answer
 * with retryInMs (nothing is dropped silently).
 */
function rejectIfRateLimited(req, res, kind, describe) {
  const gate = searchRateGate(req, kind);
  if (gate.ok) return false;
  const retryAfterSec = Math.max(1, Math.ceil(gate.body.retryInMs / 1000));
  res.set('Retry-After', String(retryAfterSec));
  logger.warn(
    `[search] FAZA 16 gate rejected ${kind} ${describe} → ${gate.body.error} (retryInMs=${gate.body.retryInMs}, identity=${gate.identity}, shard=${gate.shardId})`,
  );
  res.status(429).json(gate.body);
  return true;
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const ENGINE = 'animaxia-neon-fts';
const SYNC_DEBOUNCE_MS = 3000;
const LATENCY_WINDOW = 50;
const SYNC_CHUNK = 25; // rows per multi-row upsert

/* FAZA 17-a hardening constants. */
const OFFSET_CAP = 10000; // offset pagination ceiling (rows)
const QUERY_TIMEOUT_MS = 8000; // per-query budget before a 504

/* FAZA 17-a ops counters — exported via searchOpsSnapshot(). */
const searchOps = { coalesced: 0, errors: 0, offsetCapped: 0 };

/** FAZA 17-a: { coalesced, errors, offsetCapped } for /api/platform/stability. */
export function searchOpsSnapshot() {
  return { ...searchOps };
}

/* --------------------------------- cursor utils ------------------------------- */

/** base64url encode/decode (no padding issues, URL-safe). */
function b64urlEncode(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function b64urlDecode(text) {
  try {
    const padded = String(text).replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * Build the next cursor from the LAST row of the current page, per sort.
 * Filter-only + no q → effective sort is contentid (see effectiveSort).
 */
function buildNextCursor({ sort, lastRow, pageNumber }) {
  if (!lastRow) return null;
  const id = Number(lastRow.id);
  if (!Number.isFinite(id)) return null;
  let payload = null;
  if (sort === 'year') payload = { y: lastRow._year ?? null, id };
  else if (sort === 'rating') payload = { r: lastRow._rating ?? null, id };
  else if (sort === 'title') payload = { t: lastRow._title ?? null, id };
  else if (sort === 'score') payload = { s: Number(lastRow._score ?? 0), id };
  else payload = { id }; // contentid keyset (filter-only)
  payload.p = pageNumber; // page estimate — incremented on each cursor hop
  return b64urlEncode(payload);
}

/**
 * Decode + validate the cursor payload for a given effective sort.
 * @returns {{ payload: object, where: string, params: any[] } | { error: string }}
 */
function cursorContinuation(effectiveSort, cursorText) {
  const payload = b64urlDecode(cursorText);
  if (!payload || typeof payload !== 'object' || !Number.isFinite(Number(payload.id))) {
    return { error: 'Invalid cursor' };
  }
  const id = Number(payload.id);
  const params = [];
  const P = (v) => {
    params.push(v);
    return `$${params.length}`;
  };

  if (effectiveSort === 'score') {
    const s = Number(payload.s);
    if (!Number.isFinite(s)) return { error: 'Invalid cursor (missing s)' };
    const sp = P(s);
    const ip = P(id);
    return { payload, where: `(t.score < ${sp} OR (t.score = ${sp} AND t.contentid > ${ip}))`, params };
  }
  if (effectiveSort === 'year') {
    const y = Number(payload.y);
    if (!Number.isFinite(y)) return { error: 'Invalid cursor (missing y)' };
    const yp = P(y);
    const ip = P(id);
    return { payload, where: `(t.year < ${yp} OR (t.year = ${yp} AND t.contentid > ${ip}))`, params };
  }
  if (effectiveSort === 'rating') {
    const r = Number(payload.r);
    if (!Number.isFinite(r)) return { error: 'Invalid cursor (missing r)' };
    const rp = P(r);
    const ip = P(id);
    return { payload, where: `(t.rating < ${rp} OR (t.rating = ${rp} AND t.contentid > ${ip}))`, params };
  }
  if (effectiveSort === 'title') {
    const t = payload.t;
    if (typeof t !== 'string') return { error: 'Invalid cursor (missing t)' };
    const tp = P(t);
    const ip = P(id);
    return { payload, where: `(t.title > ${tp} OR (t.title = ${tp} AND t.contentid > ${ip}))`, params };
  }
  // contentid keyset (filter-only / no q)
  const ip = P(id);
  return { payload, where: `t.contentid > ${ip}`, params };
}

/* ------------------------------ metadata helpers ----------------------------- */

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

/** Build the FTS document text: title + genres + first 500 chars of overview. */
function buildTsvText(title, genres, meta) {
  const overview = String(meta.overview || meta.synopsis || meta.description || '');
  return [String(title || ''), genres.join(' '), overview.slice(0, 500)].join(' ').trim();
}

/* --------------------------------- index sync -------------------------------- */

let syncPromise = null; // async lock — concurrent ensureSynced() calls coalesce
let lastSync = null; // ISO timestamp of the last successful sync
let dirty = true; // set at boot and on every content:changed

async function syncIndex() {
  const raw = await rows(
    'SELECT id, externalid, type, title, metadata, thumbnail, createdat FROM content',
  );

  let synced = 0;
  for (let i = 0; i < raw.length; i += SYNC_CHUNK) {
    const slice = raw.slice(i, i + SYNC_CHUNK);
    const values = [];
    const tuples = slice.map((row, j) => {
      const meta = parseJsonb(row.metadata, {});
      const genres = toNameArray(meta.genres);
      const actors = toNameArray(meta.actors ?? meta.cast);
      const studios = toNameArray(meta.studios ?? meta.studio);
      const tsvText = buildTsvText(row.title, genres, meta);
      // FAZA 13 (sharding): searchdocs carries its shard id = the catalog
      // RANGE shard of the contentid it indexes (ids < 1B → 0, legacy-safe).
      const shardid = computeShardIdFromContentId(row.id);
      const base = j * 12;
      values.push(
        Number(row.id),
        row.externalid ?? null,
        row.type ?? null,
        row.title ?? 'untitled',
        tsvText,
        toIntOrNull(meta.year),
        toFloatOrNull(meta.rating ?? meta.score),
        genres,
        actors,
        studios,
        row.type ?? null,
        shardid,
      );
      const b = (k) => `$${base + k}`;
      return `(${b(1)},${b(2)},${b(3)},${b(4)},to_tsvector('simple', ${b(5)}),${b(6)},${b(7)},${b(8)}::text[],${b(9)}::text[],${b(10)}::text[],${b(11)},${b(12)},NOW())`;
    });
    await rows(
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
    synced += slice.length;
  }

  // Drop stale docs (content rows deleted since the last sync).
  try {
    await rows('DELETE FROM searchdocs WHERE contentid NOT IN (SELECT id FROM content)');
  } catch (err) {
    logger.warn(`[search] stale-doc cleanup skipped: ${err.message}`);
  }

  lastSync = new Date().toISOString();
  dirty = false;
  return synced;
}

/** Rebuild once under an async lock; concurrent callers await the same run.
 *  FAZA 18: exported additively — the stress engine (modules/search/stress.js)
 *  receives it via dependency injection so the FAZA 18 run guarantees the
 *  same index-freshness as the /advanced route. */
export async function ensureSynced() {
  if (!dirty && lastSync) return;
  if (!syncPromise) {
    syncPromise = syncIndex().finally(() => {
      syncPromise = null;
    });
  }
  await syncPromise;
}

/* FAZA 18 (Task 18-2): wire the integrated pipeline into the stress engine —
 * the REAL FTS entry points (this module's ensureSynced + the search
 * cluster's queryFTS) are handed over once at module load. After this call
 * /api/search/status → pipelineIntegrated reports true (every one of the 10
 * pinned stages is structurally mounted in this process). */
initSearchStress({ ensureSynced, queryFTS: searchCluster.queryFTS });

/** Forced full resync (POST /index): waits for any in-flight sync, then runs one. */
async function forceResync() {
  while (syncPromise) {
    await syncPromise.catch(() => {});
  }
  syncPromise = syncIndex().finally(() => {
    syncPromise = null;
  });
  return syncPromise;
}

// content:changed → dirty immediately; debounced background resync (3s).
let resyncTimer = null;
events.on('content:changed', () => {
  dirty = true;
  if (resyncTimer) clearTimeout(resyncTimer);
  resyncTimer = setTimeout(() => {
    resyncTimer = null;
    ensureSynced().catch((err) => logger.warn(`[search] background resync failed: ${err.message}`));
  }, SYNC_DEBOUNCE_MS);
  if (typeof resyncTimer.unref === 'function') resyncTimer.unref();
});

/* ------------------------------ latency tracking ----------------------------- */

const latencies = []; // took ms of the last 50 /advanced queries

function recordLatency(ms) {
  latencies.push(ms);
  if (latencies.length > LATENCY_WINDOW) latencies.shift();
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return Number(sorted[idx].toFixed(2));
}

/** Rolling p50/p95 snapshot — consumed by /status and the scale report. */
export function searchLatencySnapshot() {
  const sorted = [...latencies].sort((a, b) => a - b);
  return {
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    samples: latencies.length,
  };
}

/* ----------------------------- query construction ---------------------------- */

const SORTS = new Set(['score', 'year', 'rating', 'title']);

/** Normalize a joined row to the canonical content shape + _score. */
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
 * Run one advanced query against searchdocs (joined back to content).
 * Filter fragments are built once and shared by the count + data statements.
 * FAZA 17-a: `cursor` (base64url payload) switches to keyset pagination —
 * the ORDER BY becomes the cursor continuation WHERE and OFFSET is dropped;
 * `effectiveSort` is what actually orders the result (contentid keyset when
 * there is no text query and the caller asked for the default 'score' sort,
 * because score would be constant 0 for every row).
 */
async function runAdvancedQuery({
  q,
  type,
  genre,
  year,
  minRating,
  actor,
  studio,
  category,
  sort,
  fuzzyEnabled,
  limit,
  page,
  cursor = null,
}) {
  const params = [];
  const P = (v) => {
    params.push(v);
    return `$${params.length}`;
  };

  // Effective sort: filter-only (no q) with default 'score' → contentid keyset.
  const effectiveSort = !q && sort === 'score' ? 'contentid' : sort;

  // Keyset continuation (cursor present) — validated per effective sort.
  let cursorPayload = null;
  let cursorWhere = null;
  let cursorParams = [];
  if (cursor) {
    const decoded = cursorContinuation(effectiveSort, cursor);
    if (decoded.error) {
      const err = new Error(decoded.error);
      err.status = 400;
      throw err;
    }
    cursorPayload = decoded.payload;
    cursorWhere = decoded.where;
    cursorParams = decoded.params;
  }

  // Field filters (SQL-side, case-insensitive where array containment).
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

  // 1. FTS pass (or filter-only when q is empty).
  let matchSql = textMatch;
  let countRow = await one(
    `SELECT COUNT(*)::int AS total, COALESCE(MAX(${scoreExpr}), 0) AS maxscore FROM searchdocs s ${whereFor(matchSql)}`,
    params,
  );

  // 2. Trigram fuzzy fallback when the FTS pass matched nothing.
  //    `title % q` (pg_trgm, default 0.3 threshold) plus a looser
  //    similarity() > 0.1 guard so short typo'd queries still reach long
  //    titles (e.g. 'dunee' → 'Dune: Part Two - Wikipedia', sim ≈ 0.15).
  if (q && fuzzyEnabled && Number(countRow?.total ?? 0) === 0) {
    const words = q.split(/\s+/).filter(Boolean);
    const trigramClauses = [];
    for (const candidate of [q, ...words]) {
      const ph = P(`%${candidate}%`);
      trigramClauses.push(`s.title ILIKE ${ph}`);
    }
    const qSim = P(q);
    trigramClauses.push(`(s.title % ${qSim} OR similarity(s.title, ${qSim}) > 0.1)`);
    matchSql = `(${trigramClauses.join(' OR ')})`;
    countRow = await one(
      `SELECT COUNT(*)::int AS total, COALESCE(MAX(${scoreExpr}), 0) AS maxscore FROM searchdocs s ${whereFor(matchSql)}`,
      params,
    );
  }

  const total = Number(countRow?.total ?? 0);
  const maxScore = Number(Number(countRow?.maxscore ?? 0).toFixed(6));

  // 3. Data page — subquery keeps the score expression, then joins content.
  //    FAZA 17-a: expose year/rating/title to JS for nextCursor construction;
  //    cursor mode replaces OFFSET with the keyset continuation predicate.
  const orderExpr =
    effectiveSort === 'year'
      ? 't.year DESC NULLS LAST, t.contentid ASC'
      : effectiveSort === 'rating'
        ? 't.rating DESC NULLS LAST, t.score DESC, t.contentid ASC'
        : effectiveSort === 'title'
          ? 't.title ASC, t.contentid ASC'
          : effectiveSort === 'contentid'
            ? 't.contentid ASC'
            : 't.score DESC, t.contentid ASC';

  const limitPh = P(limit);
  const offsetPh = P((page - 1) * limit);
  // Cursor mode: continuation params come FIRST ($1..$n), then LIMIT; the
  // filter/score params are re-bound only inside the subquery — so build a
  // dedicated statement for each mode instead of renumbering dynamically.
  let dataSql;
  let dataParams;
  if (cursorWhere) {
    // Rebuild the subquery with a fresh parameter namespace for the cursor run
    // (filters + score expression are re-parameterized after the cursor slots).
    const subParams = [...cursorParams, limit];
    const sub = (v) => {
      subParams.push(v);
      return `$${subParams.length}`;
    };
    const cFilters = [];
    if (type) cFilters.push(`s.type = ${sub(type)}`);
    if (genre) cFilters.push(`EXISTS (SELECT 1 FROM unnest(s.genres) g WHERE g ILIKE ${sub(genre)})`);
    if (year != null) cFilters.push(`s.year = ${sub(year)}`);
    if (actor) cFilters.push(`EXISTS (SELECT 1 FROM unnest(s.actors) a WHERE a ILIKE '%' || ${sub(actor)} || '%')`);
    if (studio) cFilters.push(`EXISTS (SELECT 1 FROM unnest(s.studios) st WHERE st ILIKE '%' || ${sub(studio)} || '%')`);
    if (category) cFilters.push(`s.category = ${sub(category)}`);
    if (minRating != null) cFilters.push(`s.rating >= ${sub(minRating)}`);
    const cFilterSql = cFilters.length ? ` AND ${cFilters.join(' AND ')}` : '';

    let cScoreExpr = '0';
    let cMatch = 'TRUE';
    // Single q slot, bound LAST (after cursor params + LIMIT) so every
    // placeholder references a parameter that exists in the bind array.
    let qParam = null;
    if (q) {
      qParam = sub(String(q));
      cScoreExpr =
        `ts_rank(s.tsv, websearch_to_tsquery('simple', ${qParam})) * 2` +
        ` + similarity(s.title, ${qParam})` +
        ` + CASE WHEN s.title ILIKE ${qParam} || '%' THEN 0.5 ELSE 0 END`;
      cMatch = `s.tsv @@ websearch_to_tsquery('simple', ${qParam})`;
    }
    // Fuzzy fallback consistency: when the FTS pass matched nothing the offset
    // run switched matchSql — mirror that for the cursor run using `total`.
    if (q && fuzzyEnabled && total === 0) {
      const words = q.split(/\s+/).filter(Boolean);
      const clauses = [q, ...words].map((candidate) => `s.title ILIKE ${sub(`%${candidate}%`)}`);
      clauses.push(`(s.title % ${qParam} OR similarity(s.title, ${qParam}) > 0.1)`);
      cMatch = `(${clauses.join(' OR ')})`;
    }

    dataSql =
      `SELECT c.id, c.externalid, c.type, c.title, c.metadata, c.thumbnail, c.createdat,
              t.score AS _score, t.year AS _year, t.rating AS _rating, t.title AS _title
       FROM (
         SELECT s.contentid, s.year, s.rating, s.title, ${cScoreExpr} AS score
         FROM searchdocs s
         WHERE (${cMatch})${cFilterSql}
       ) t
       JOIN content c ON c.id = t.contentid
       WHERE ${cursorWhere}
       ORDER BY ${orderExpr}
       LIMIT $${cursorParams.length + 1}::int`;
    // LIMIT is the placeholder right after the cursor params (::int — a bare
    // parameter in LIMIT cannot be type-inferred by Postgres); the q/filter
    // slots follow it so every bound parameter is referenced by the statement.
    dataParams = subParams;
  } else {
    dataSql =
      `SELECT c.id, c.externalid, c.type, c.title, c.metadata, c.thumbnail, c.createdat,
              t.score AS _score, t.year AS _year, t.rating AS _rating, t.title AS _title
       FROM (
         SELECT s.contentid, s.year, s.rating, s.title, ${scoreExpr} AS score
         FROM searchdocs s
         ${whereFor(matchSql)}
       ) t
       JOIN content c ON c.id = t.contentid
       ORDER BY ${orderExpr}
       LIMIT ${limitPh} OFFSET ${offsetPh}`;
    dataParams = params;
  }
  const dataRows = await rows(dataSql, dataParams);

  // Keyset paging estimates the page number by incrementing the cursor's `p`.
  const resultPage = cursor ? (Number(cursorPayload?.p) || 1) + 1 : page;
  const normalized = dataRows.map(normalizeHit).filter(Boolean);
  const lastRaw = dataRows.length ? dataRows[dataRows.length - 1] : null;

  return {
    total,
    max_score: maxScore,
    data: normalized,
    page: resultPage,
    nextCursor: buildNextCursor({ sort: effectiveSort, lastRow: lastRaw, pageNumber: resultPage }),
    paginationMode: cursor ? 'cursor' : 'offset',
  };
}

/* --------------------------- single-flight coalescing -------------------------- */

/**
 * FAZA 17-a: identical concurrent /advanced requests share one promise.
 * Key = normalized query params; the map entry is removed on settle.
 */
const inflightSearch = new Map();

function coalesceAdvanced(normalizedKey, run) {
  const existing = inflightSearch.get(normalizedKey);
  if (existing) {
    searchOps.coalesced += 1;
    return existing;
  }
  const promise = run().finally(() => {
    inflightSearch.delete(normalizedKey);
  });
  inflightSearch.set(normalizedKey, promise);
  return promise;
}

/** Race a query promise against the 8s budget (loser is logged, not awaited). */
function withQueryTimeout(promise, describe) {
  let timer = null;
  const budget = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error('Search query timeout');
      err.status = 504;
      reject(err);
    }, QUERY_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return promise.then(
    (value) => {
      clearTimeout(timer);
      return value;
    },
    (err) => {
      clearTimeout(timer);
      throw err;
    },
  ).finally(() => {
    clearTimeout(timer);
    promise.catch((loser) => {
      // The lost race (if it also failed) must not become an unhandledRejection.
      logger.warn(`[search] query lost the timeout race (${describe}): ${loser?.message ?? loser}`);
    });
  });
}

/**
 * FAZA 17-a stress-lab entry: one full /advanced query with small random
 * variations of q (deterministic latency measurement, no HTTP self-call).
 * @returns {{ tookMs: number, total: number, returned: number }}
 */
export async function runSearchLoad(q) {
  const startedAt = Date.now();
  const result = await runAdvancedQuery({
    q: String(q || 'dune'),
    type: null,
    genre: null,
    year: null,
    minRating: null,
    actor: null,
    studio: null,
    category: null,
    sort: 'score',
    fuzzyEnabled: true,
    limit: 20,
    page: 1,
  });
  await ensureSynced().catch(() => {});
  return {
    tookMs: Date.now() - startedAt,
    total: result.total,
    returned: result.data.length,
  };
}

/* ---------------------------------- router ----------------------------------- */

const router = express.Router();

/** GET /api/search/advanced — Neon FTS + trigram fallback + SQL filters. Public. */
router.get('/advanced', wrap(async (req, res) => {
  const startedAt = Date.now();
  const q = req.query.q != null ? String(req.query.q).trim() : '';

  const type = req.query.type ? String(req.query.type) : null;
  const genre = req.query.genre ? String(req.query.genre) : null;
  const actor = req.query.actor ? String(req.query.actor) : null;
  const studio = req.query.studio ? String(req.query.studio) : null;
  const category = req.query.category ? String(req.query.category) : null;
  const yearRaw = req.query.year != null && req.query.year !== '' ? String(req.query.year) : null;
  const minRatingRaw =
    req.query.minRating != null && req.query.minRating !== '' ? String(req.query.minRating) : null;

  const sortRaw = req.query.sort ? String(req.query.sort) : 'score';
  const sort = SORTS.has(sortRaw) ? sortRaw : 'score';
  const fuzzy = req.query.fuzzy != null ? String(req.query.fuzzy) : 'true';
  const fuzzyEnabled = fuzzy !== 'false'; // default on
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);

  // year: integer equality; a non-integer year matches nothing (old semantics).
  let year = null;
  if (yearRaw != null) {
    year = parseInt(yearRaw, 10);
    if (!Number.isInteger(year)) {
      return res.json({ took: 0, total: 0, max_score: 0, page, limit, engine: ENGINE, data: [] });
    }
  }
  const minRating = minRatingRaw != null && Number.isFinite(Number(minRatingRaw)) ? Number(minRatingRaw) : null;

  const hasFilters = Boolean(
    type || genre || year != null || minRating != null || actor || studio || category,
  );
  if (!q && !hasFilters) {
    return res.status(400).json({ error: 'Missing required query parameter: q (or at least one filter)' });
  }

  // FAZA 17-a: raw cursor param (base64url JSON) — presence enables keyset mode.
  const cursorRaw = req.query.cursor != null && req.query.cursor !== '' ? String(req.query.cursor) : null;

  // FAZA 17-a: offset pagination is capped — deep pages must use the cursor.
  // FAZA 15: the cap check is HOISTED above the flow queue — it is pure param
  // validation (identical expression in the legacy path and the cluster
  // service's queryFTS mirror: page*limit > OFFSET_CAP), so capped requests
  // fast-fail without being admitted to the search queue.
  if (!cursorRaw) {
    const offset = (page - 1) * limit;
    if (offset + limit > OFFSET_CAP) {
      searchOps.offsetCapped += 1;
      return res.status(400).json({
        error: `Offset pagination capped at ${OFFSET_CAP} rows — use cursor pagination (pass cursor param)`,
        useCursor: true,
      });
    }
  }

  // FAZA 16 (Search Rate Management): the per-user pacing gate runs AFTER
  // pure param validation (missing q / offset cap already answered above —
  // they never burn a pacing slot) and BEFORE the FAZA 15 flow queue: ENTER
  // spam → 429 rate_limited, search-during-cooldown → 429 cooldown_active,
  // flood (≥ spamThreshold arrivals in spamWindowMs) → 429 spam_blocked.
  // Every rejection is explicit, carries retryInMs and never touches Neon.
  if (rejectIfRateLimited(req, res, 'advanced', `q=${q || '(filters)'}`)) {
    return; // 429 already sent — nothing queued, nothing executed
  }

  // FAZA 15 (Search Flow Control): the execution (cluster fan-out OR legacy
  // single-index path — including ensureSynced) goes through the search flow
  // queue: priority lane (admin/ops/QA high, logged-in normal, anonymous
  // low), maxConcurrent bound and windowed dispatch (intervalMs × batchSize).
  // The queue ONLY schedules admission — the FTS executions inside run() are
  // the byte-identical FAZA 14 code paths, so results stay 100% real.
  const flowPriority = resolveSearchPriority(req);
  const flowShardId = resolveSearchShard(req);
  const useClusterPath = searchCluster.enabled() && !cursorRaw;

  const { result: body, waitedMs: flowWaitedMs } = await searchFlowExecute({
    priority: flowPriority,
    shardId: flowShardId,
    kind: 'advanced',
    describe: `q=${q || '(filters)'}`,
    run: async () => {
      // FAZA 13 (Task 13-3): search cluster path — when enabled and the request
      // has NO cursor param, fan the query out over the per-shard searchdocs
      // nodes (queryOnShard, merge + dedupe). Keyset (cursor) requests ALWAYS
      // stay on the legacy single-index path; when the cluster is disabled
      // the legacy path runs byte-identical. The cluster response keeps the
      // legacy shape and adds only the `cluster` field (per-node report).
      //
      // FAZA 17 (Search Optimization Layer): the cluster fan-out goes through
      // the dedup + batching + cache executor — 1000 identical concurrent
      // requests share ONE real fan-out (batch) and repeats within cacheTtlMs
      // are served from the micro-cache; the result object is the EXACT output
      // of the real execution (nothing fabricated), with the additive `opt`
      // block documenting the provenance. The queryKey includes every semantic
      // param + the shardHint (it orders the cluster node report — hinted and
      // unhinted variants never share a cache entry, responses stay
      // byte-identical per variant).
      if (useClusterPath) {
        await ensureSynced(); // same index-freshness guarantee as the legacy path
        const headerRaw = req.headers['x-animaxia-shard'];
        const headerHint = parseInt(Array.isArray(headerRaw) ? headerRaw[0] : headerRaw, 10);
        const shardHint =
          Number.isInteger(headerHint) && headerHint >= 0 && headerHint < shardCount() ? headerHint : null;
        const optQueryKey = JSON.stringify({
          p: 'cluster',
          q: q || null,
          type,
          genre,
          year,
          minRating,
          actor,
          studio,
          category,
          sort,
          fuzzy: fuzzyEnabled,
          limit,
          page,
          shardHint,
        });
        const optOutcome = await searchOptExecute({
          queryKey: optQueryKey,
          kind: 'advanced',
          shardId: flowShardId,
          describe: `q=${q || '(filters)'}`,
          run: () =>
            searchCluster.queryFTS({
              q: q || null,
              type,
              genre,
              year,
              minRating,
              actor,
              studio,
              category,
              sort,
              fuzzy: fuzzyEnabled ? 'true' : 'false',
              limit,
              page,
              shardHint,
            }),
        });
        // FAZA 14: the cluster serves the whole LOGICAL 30B space (30 shards × 1B
        // ids); results stay 100% real (real searchdocs rows) — only the served
        // address space is logical. Additive field, only present when the cluster
        // serves (the pure legacy path below stays byte-identical).
        return {
          ...optOutcome.result,
          logical: {
            addressSpace: logicalAddressSpace(),
            shardcount: shardCount(),
            shardSpan: SHARD_SPAN_IDS,
            mode: 'logical',
          },
          opt: {
            source: optOutcome.source,
            queryHash: optOutcome.queryHash,
            cached: optOutcome.cached,
            batched: optOutcome.batched,
          },
        };
      }

      // Legacy path (cluster disabled OR keyset cursor request).
      await ensureSynced();

      // FAZA 17-a: single-flight — identical concurrent requests share one query.
      const normalizedKey = JSON.stringify({
        q, type, genre, year, minRating, actor, studio, category, sort, fuzzyEnabled, limit, page, cursor: cursorRaw,
      });

      // The raw FTS execution (+ 8s budget + error counter) — handed to the
      // FAZA 17 optimization executor when the layer is enabled (its batch IS
      // a superset of the single-flight: identical in-flight requests attach,
      // PLUS repeats within cacheTtlMs are served from the micro-cache), and
      // to the legacy single-flight when disabled (byte-identical bypass).
      const runFts = async () => {
        const queryPromise = runAdvancedQuery({
          q: q || null,
          type,
          genre,
          year,
          minRating,
          actor,
          studio,
          category,
          sort,
          fuzzyEnabled,
          limit,
          page,
          cursor: cursorRaw,
        });
        try {
          return await withQueryTimeout(queryPromise, `q=${q || '(filters)'}`);
        } catch (err) {
          searchOps.errors += 1;
          throw err;
        }
      };

      const optOutcome = searchOptEnabled()
        ? await searchOptExecute({
            queryKey: normalizedKey,
            kind: 'advanced',
            shardId: flowShardId,
            describe: `q=${q || '(filters)'}`,
            run: runFts,
          })
        : {
            result: await coalesceAdvanced(normalizedKey, runFts),
            source: 'bypass',
            queryHash: null,
            cached: false,
            batched: false,
          };
      const result = optOutcome.result;

      const took = Date.now() - startedAt;
      recordLatency(took);

      return {
        took,
        total: result.total,
        max_score: result.max_score,
        page: result.page,
        limit,
        engine: ENGINE,
        data: result.data,
        // FAZA 17-a additive pagination contract:
        nextCursor: result.nextCursor ?? null,
        paginationMode: result.paginationMode ?? 'offset',
        // FAZA 17: additive optimization provenance — 'neon' = this request
        // ran the real FTS, 'batch' = shared an in-flight identical execution,
        // 'cache' = served the stored REAL result (≤ cacheTtlMs old),
        // 'bypass' = layer disabled (legacy single-flight path).
        opt: {
          source: optOutcome.source,
          queryHash: optOutcome.queryHash,
          cached: optOutcome.cached,
          batched: optOutcome.batched,
        },
      };
    },
  });

  // FAZA 16: the user RECEIVED a real result → the post-result cooldown
  // starts now (their next /advanced within cooldownMs gets 429
  // cooldown_active with retryInMs). Failures never start a cooldown.
  searchRateComplete(req, 'advanced');

  // FAZA 15: additive flow attribution on every /advanced response — the
  // search stayed 100% real; the field documents how the request was scheduled.
  // FAZA 16: additive `rate` block so the UI can enforce its own cooldown
  // affordance (disable ENTER + countdown) without a second round-trip.
  const rateSnapshot = searchRateStatusSnapshot();
  return res.json({
    ...body,
    flow: {
      priority: flowPriority,
      shardid: flowShardId,
      queuedMs: flowWaitedMs,
    },
    rate: {
      perUserMs: rateSnapshot.perUserMs,
      cooldownMs: rateSnapshot.cooldownMs,
    },
  });
}));

/** GET /api/search/autocomplete?q= — trigram + prefix title suggestions. Public. */
router.get('/autocomplete', wrap(async (req, res) => {
  const q = req.query.q != null ? String(req.query.q).trim() : '';
  if (q.length < 1) {
    return res.status(400).json({ error: 'Missing required query parameter: q' });
  }

  // FAZA 16: autocomplete is paced in its OWN lane (typing never blocks the
  // ENTER search and vice-versa) and shares the anti-spam flood window — a
  // typeahead flood is spam exactly like an ENTER flood.
  if (rejectIfRateLimited(req, res, 'autocomplete', `q=${q}`)) {
    return; // 429 already sent — nothing queued, nothing executed
  }

  // FAZA 15: autocomplete is a real Neon FTS probe — it goes through the same
  // search flow queue as /advanced (priority lane + windowed dispatch). The
  // query itself is untouched.
  // FAZA 17: the probe goes through the optimization executor too — a
  // typeahead flood (many users typing the same prefix) shares ONE real
  // probe (batch) and repeats within cacheTtlMs are served from the cache.
  const flowPriority = resolveSearchPriority(req);
  const flowShardId = resolveSearchShard(req);
  const { result: body, waitedMs: flowWaitedMs } = await searchFlowExecute({
    priority: flowPriority,
    shardId: flowShardId,
    kind: 'autocomplete',
    describe: `q=${q}`,
    run: async () => {
      await ensureSynced();

      const runAcFts = () =>
        rows(
          `SELECT s.contentid, s.title, s.type, s.rating, c.thumbnail,
                similarity(s.title, $1) AS sim
         FROM searchdocs s
         JOIN content c ON c.id = s.contentid
         WHERE s.title %> $1 OR s.title ILIKE $1 || '%'
         ORDER BY sim DESC, s.rating DESC NULLS LAST, s.contentid ASC
         LIMIT 8`,
          [q],
        );

      const optOutcome = searchOptEnabled()
        ? await searchOptExecute({
            queryKey: JSON.stringify({ p: 'autocomplete', q }),
            kind: 'autocomplete',
            shardId: flowShardId,
            describe: `q=${q}`,
            run: runAcFts,
          })
        : { result: await runAcFts(), source: 'bypass', queryHash: null, cached: false, batched: false };
      const matched = optOutcome.result;

      return {
        suggestions: matched.map((r) => ({
          id: Number(r.contentid),
          title: r.title,
          type: r.type ?? null,
          thumbnail: r.thumbnail ?? null,
          rating: r.rating == null ? null : Number(r.rating),
        })),
        opt: {
          source: optOutcome.source,
          queryHash: optOutcome.queryHash,
          cached: optOutcome.cached,
          batched: optOutcome.batched,
        },
      };
    },
  });

  return res.json({
    ...body,
    flow: {
      priority: flowPriority,
      shardid: flowShardId,
      queuedMs: flowWaitedMs,
    },
  });
}));

/** GET /api/search/filters — distinct filter values for UI dropdowns. Public. */
router.get('/filters', wrap(async (req, res) => {
  await ensureSynced();
  const [genres, actors, years, categories, studios] = await Promise.all([
    rows(
      `SELECT value, COUNT(*)::int AS count FROM (SELECT unnest(genres) AS value FROM searchdocs) t
       WHERE value <> '' GROUP BY value ORDER BY count DESC, value ASC`,
    ),
    rows(
      `SELECT value, COUNT(*)::int AS count FROM (SELECT unnest(actors) AS value FROM searchdocs) t
       WHERE value <> '' GROUP BY value ORDER BY count DESC, value ASC LIMIT 50`,
    ),
    rows(`SELECT DISTINCT year FROM searchdocs WHERE year IS NOT NULL ORDER BY year DESC`),
    rows(
      `SELECT category AS value, COUNT(*)::int AS count FROM searchdocs
       WHERE category IS NOT NULL GROUP BY category ORDER BY count DESC, value ASC`,
    ),
    rows(
      `SELECT value, COUNT(*)::int AS count FROM (SELECT unnest(studios) AS value FROM searchdocs) t
       WHERE value <> '' GROUP BY value ORDER BY count DESC, value ASC LIMIT 50`,
    ),
  ]);
  return res.json({
    genres,
    actors,
    years: years.map((r) => Number(r.year)),
    categories,
    studios,
  });
}));

/** POST /api/search/index — force a full resync (requireAuth + requireAdmin). */
router.post('/index', requireAuth, requireAdmin, wrap(async (req, res) => {
  const indexed = await forceResync();
  logger.info(`[search] Manual reindex by user ${req.user?.id ?? '?'} — ${indexed} docs`);
  return res.json({ ok: true, indexed });
}));

/** GET /api/search/status — engine health snapshot. Public. */
router.get('/status', wrap(async (req, res) => {
  await ensureSynced().catch((err) => logger.warn(`[search] status sync failed: ${err.message}`));
  let docs = 0;
  let pgTrgm = false;
  try {
    const [docRow, extRow] = await Promise.all([
      one('SELECT COUNT(*)::int AS n FROM searchdocs'),
      one(`SELECT COUNT(*)::int AS n FROM pg_extension WHERE extname = 'pg_trgm'`),
    ]);
    docs = Number(docRow?.n ?? 0);
    pgTrgm = Number(extRow?.n ?? 0) > 0;
  } catch (err) {
    logger.warn(`[search] status counts failed: ${err.message}`);
  }
  // FAZA 13 (Task 13-3): additive cluster health field — null when the
  // cluster is disabled or its health probe fails (legacy shape untouched).
  let clusterHealth = null;
  if (searchCluster.enabled()) {
    try {
      clusterHealth = await searchCluster.health();
    } catch (err) {
      logger.warn(`[search] cluster health probe failed: ${err.message}`);
      clusterHealth = null;
    }
  }
  return res.json({
    docs,
    engine: ENGINE,
    backend: 'neon-postgresql',
    extensions: { pg_trgm: pgTrgm },
    lastSync,
    dirty,
    latency: searchLatencySnapshot(),
    capacity: { indexedDocs: docs },
    cluster: clusterHealth,
    // FAZA 14: the LOGICAL 30B address space the search cluster covers —
    // 30 shards × 1B ids (volume simulated logically; search results are
    // always REAL rows from searchdocs/content).
    logical: {
      addressSpace: logicalAddressSpace(),
      shardcount: shardCount(),
      shardSpan: SHARD_SPAN_IDS,
      mode: 'logical',
    },
    // FAZA 15 (Search Flow Control): the admission layer sitting between the
    // search routes and Neon — queue + priority lanes + windowed dispatch.
    // Pinned contract: queueEnabled / maxConcurrent / priorities + live
    // gauges (queueLength, inflight, dropped — target 0, timedOut — target 0,
    // processingRate, wait percentiles).
    flowControl: searchFlowStatusSnapshot(),
    windowing: searchWindowingSnapshot(),
    // FAZA 16 (Search Rate Management): the per-user pacing layer in front of
    // the flow queue. Pinned contract: rateLimit { perUserMs, enforced } and
    // burstControl { active, maxBurstPerWindow } + live counters.
    rateLimit: searchRateStatusSnapshot(),
    burstControl: searchRateBurstSnapshot(),
    // FAZA 17 (Search Optimization Layer): dedup + batching + micro-cache
    // between the window dispatcher and the real FTS. Pinned contracts:
    // batching { enabled, activeBatches }, cache { ttlMs, hits, misses },
    // dedup { active, deduplicatedRequests } and the deterministic pipeline
    // order (antiSpam → … → cache → fts).
    batching: searchOptBatchingSnapshot(),
    cache: searchOptCacheSnapshot(),
    dedup: searchOptDedupSnapshot(),
    pipeline: searchOptPipelineSnapshot(),
    // FAZA 18 (Full Integration + Stress Test): the integrated-pipeline
    // contract — pipelineIntegrated is true when every one of the 10 pinned
    // stages is structurally mounted (the stress engine received the REAL
    // FTS entry points from this router), pipelineStages is the exact stage
    // order every /advanced and /autocomplete request traverses, and
    // stressTest carries the last 10,000-simultaneous-searches run verdict
    // (pinned shape: { concurrent: 10000, passed: true }).
    pipelineIntegrated: searchStressPipelineIntegrated(),
    pipelineStages: searchStressPipelineStages(),
    stressTest: searchStressStatusSnapshot(),
  });
}));

/** GET /api/search/flow — FAZA 15 Search Flow Control console snapshot:
 *  full config, the rolling history (180 × 1s samples of queueLength /
 *  inflight / rate) and the per-shard attribution table (queue, inflight,
 *  processed, dropped). Public read-only (same policy as /status). */
router.get('/flow', wrap(async (req, res) => {
  return res.json(searchFlowConsoleSnapshot());
}));

/** POST /api/search/flow/settings — FAZA 15 runtime reconfiguration of the
 *  flow control knobs (maxConcurrent, intervalMs, batchSize, queueCap,
 *  maxWaitMs, aging thresholds, enabled). requireAuth + requireAdmin —
 *  operational surface, not end-user. Unknown fields are ignored; every
 *  value is clamped to its safe range (modules/search/flow.js). */
router.post('/flow/settings', requireAuth, requireAdmin, wrap(async (req, res) => {
  const patch = req.body || {};
  const allowed = [
    'enabled', 'maxConcurrent', 'intervalMs', 'batchSize',
    'queueCap', 'maxWaitMs', 'lowPromoteMs', 'normalPromoteMs',
  ];
  const filtered = {};
  for (const key of allowed) {
    if (patch[key] !== undefined) filtered[key] = patch[key];
  }
  const config = updateSearchFlowConfig(filtered);
  await auditLogFlowSettings(req, filtered);
  return res.json({ ok: true, config });
}));

/** GET /api/search/rate — FAZA 16 Search Rate Management console snapshot:
 *  full config, live counters (rate-limit hits, cooldown blocks, spam blocks,
 *  burst events), the rolling history (180 x 1s samples of arrivals /
 *  admitted / blocked) and the per-shard attribution table. Public read-only
 *  (same policy as /flow). */
router.get('/rate', wrap(async (req, res) => {
  return res.json(searchRateConsoleSnapshot());
}));

/** POST /api/search/rate/settings — FAZA 16 runtime reconfiguration of the
 *  pacing knobs (perUserMs, cooldownMs, spam window/threshold/block,
 *  burst window/threshold, enabled). requireAuth + requireAdmin —
 *  operational surface, not end-user. Unknown fields are ignored; every
 *  value is clamped to its safe range (modules/search/rate.js). */
router.post('/rate/settings', requireAuth, requireAdmin, wrap(async (req, res) => {
  const patch = req.body || {};
  const allowed = [
    'enabled', 'perUserMs', 'cooldownMs',
    'spamWindowMs', 'spamThreshold', 'spamBlockMs',
    'burstWindowMs', 'burstThreshold',
  ];
  const filtered = {};
  for (const key of allowed) {
    if (patch[key] !== undefined) filtered[key] = patch[key];
  }
  const config = updateSearchRateConfig(filtered);
  await auditLogRateSettings(req, filtered);
  return res.json({ ok: true, config });
}));

/** GET /api/search/opt — FAZA 17 Search Optimization Layer console snapshot:
 *  the pinned batching / cache / dedup / pipeline blocks, full config, live
 *  counters (cache hits/misses, batch fan-out, REAL Neon FTS executions,
 *  reduction factor), the in-flight batch list (top 50 by fan-out), the
 *  rolling history (180 × 1s samples of requests vs fts) and the per-shard
 *  attribution table. Public read-only (same policy as /flow and /rate). */
router.get('/opt', wrap(async (req, res) => {
  return res.json(searchOptConsoleSnapshot());
}));

/** POST /api/search/opt/settings — FAZA 17 runtime reconfiguration of the
 *  optimization knobs (enabled, cacheTtlMs, cacheMax, batchMax).
 *  requireAuth + requireAdmin — operational surface, not end-user. Unknown
 *  fields are ignored; every value is clamped to its safe range
 *  (modules/search/opt.js — ttlMs pinned to the 1000–5000ms range). */
router.post('/opt/settings', requireAuth, requireAdmin, wrap(async (req, res) => {
  const patch = req.body || {};
  const allowed = ['enabled', 'cacheTtlMs', 'cacheMax', 'batchMax'];
  const filtered = {};
  for (const key of allowed) {
    if (patch[key] !== undefined) filtered[key] = patch[key];
  }
  const config = updateSearchOptConfig(filtered);
  await auditLogOptSettings(req, filtered);
  return res.json({ ok: true, config });
}));

/** GET /api/search/stress — FAZA 18 Full Integration + Stress Test console
 *  snapshot: the integrated-pipeline contract, the section composition, the
 *  last full run report (all assertions + the 10M projection), and the runs
 *  history. Public read-only (same policy as /flow, /rate and /opt). */
router.get('/stress', wrap(async (req, res) => {
  return res.json(searchStressConsoleSnapshot());
}));

/** POST /api/search/stress — FAZA 18: start a FULL stress run (10,000
 *  simultaneous searches through the REAL integrated pipeline + the 10M
 *  projection sample). requireAuth + requireAdmin — operational surface.
 *  Returns 202 { started: true } immediately; the run continues in the
 *  background and the UI/QA polls GET /stress until running flips back to
 *  false (no long-held HTTP connections through proxies). 409 while a run
 *  is already executing. */
router.post('/stress', requireAuth, requireAdmin, wrap(async (req, res) => {
  if (searchStressRunning()) {
    return res.status(409).json({
      error: 'stress_test_running',
      code: 'SEARCH_STRESS_RUNNING',
      message: 'Un stress test rulează deja — urmărește-l în consola #/admin/search-full',
    });
  }
  try {
    auditLogStressRun(req).catch(() => {});
    // Fire-and-forget: the engine resolves on its own; errors land in the
    // console snapshot (lastRun.failures) and the log, never in this reply.
    runSearchStress().catch((err) => {
      logger.error(`[search] FAZA 18 stress run crashed: ${err?.message ?? err}`);
    });
    return res.status(202).json({
      ok: true,
      started: true,
      concurrency: 10000,
      message: 'Stress test pornit — 10.000 căutări simultane prin pipeline-ul integrat',
    });
  } catch (err) {
    return res.status(err?.status ?? 500).json({ error: err?.message ?? 'Failed to start' });
  }
}));

/** Audit trail for stress-run starts (best effort). */
async function auditLogStressRun(req) {
  const { auditLog, clientIpOf } = await import('../security/security.js');
  await auditLog({
    userid: req.user?.id ?? null,
    action: 'searchstress.run',
    ip: clientIpOf(req),
    meta: { concurrency: 10000 },
  });
}

/** Audit trail for optimization reconfiguration (best effort). */
async function auditLogOptSettings(req, patch) {
  try {
    const { auditLog, clientIpOf } = await import('../security/security.js');
    await auditLog({
      userid: req.user?.id ?? null,
      action: 'searchopt.settings',
      ip: clientIpOf(req),
      meta: { patch },
    });
  } catch {
    /* audit is best-effort — never block the operational response */
  }
}

/** Audit trail for rate-management reconfiguration (best effort). */
async function auditLogRateSettings(req, patch) {
  try {
    const { auditLog, clientIpOf } = await import('../security/security.js');
    await auditLog({
      userid: req.user?.id ?? null,
      action: 'searchrate.settings',
      ip: clientIpOf(req),
      meta: { patch },
    });
  } catch {
    /* audit is best-effort — never block the operational response */
  }
}

/** Audit trail for flow-control reconfiguration (best effort). */
async function auditLogFlowSettings(req, patch) {
  try {
    const { auditLog, clientIpOf } = await import('../security/security.js');
    await auditLog({
      userid: req.user?.id ?? null,
      action: 'searchflow.settings',
      ip: clientIpOf(req),
      meta: { patch },
    });
  } catch {
    /* audit is best-effort — never block the operational response */
  }
}

export default router;
