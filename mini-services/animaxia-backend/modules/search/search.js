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
 *     one promise (coalesced counter, map cleared on settle) — FAZA 18 moved
 *     the mechanism into pipeline layer 7 (searchOpsSnapshot stays fed);
 *   • query timeout: runAdvancedQuery races an 8s budget → 504
 *     { error: 'Search query timeout' } (errors counter, loser logged);
 *   • searchOpsSnapshot() exports { coalesced, errors, offsetCapped } for the
 *     stability endpoint; runSearchLoad(q) is the stress-lab entry point.
 *
 * FAZA 18 (additive — 16/17 contracts intact): every /advanced and
 * /autocomplete execution flows through the 10-layer orchestration pipeline
 * (modules/search/pipeline.js — anti-spam, search rate-limit, cooldown,
 * bounded queue, priority, windowing, dedup, batching, LRU cache, executor).
 * Layer 10 calls the SAME executor functions below — the SQL build logic is
 * untouched. Responses gain only the X-Search-Pipeline: hit|miss|cooldown
 * header. /status keeps every legacy field and adds pipelineIntegrated +
 * pipelineStages (10 live stages) + stressTest. POST /stress (admin) runs the
 * in-process pipeline stress lab (synthetic executor bulk + 50 real FTS
 * limit=1 requests, honest { mode: 'synthetic-executor' } label).
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
 *                             latency: { p50Ms, p95Ms, samples }, capacity,
 *                             cluster, pipelineIntegrated, pipelineStages,
 *                             stressTest }                        (FAZA 18)
 *   POST /stress          → pipeline stress lab (requireAuth+requireAdmin)
 *
 * Text match: tsv @@ websearch_to_tsquery('simple', q). When that yields 0
 * hits and fuzzy !== 'false', a trigram fallback runs (title % q OR per-word
 * LIKE). Combined score: ts_rank(tsv, q) * 2 + similarity(title, q) +
 * (title LIKE 'q%' → +0.5). Empty q + filters → filter-only query (no text
 * score). Rolling p50/p95 latency over the last 50 queries feeds /status.
 */

import express from 'express';
import metadataSearchRouter from './metadata.js';
import { sqliteAdvancedSearch } from './sqlite-advanced.js';
import { countFtsRows } from './content-fts.js';
import { driverInfo } from '../../db.js';
import { rows, one, parseJsonb } from '../platform/sql.js';
import { requireAuth, requireAdmin } from '../users/auth.js';
import { events } from '../platform/events.js';
import { logger } from '../../utils/logger.js';
import { computeShardIdFromContentId, shardCount } from '../sharding/model.js'; // FAZA 13 (sharding): searchdocs.shardid = catalog range shard of the contentid
import { searchCluster } from '../../services/search-cluster/index.js'; // FAZA 13 (Task 13-3): search cluster — FTS fan-out over per-shard searchdocs nodes
import { clientIpOf } from '../security/security.js'; // FAZA 18: pipeline client identity (same helper as the security module)
import pipeline, { PipelineRejection } from './pipeline.js'; // FAZA 18: 10-layer orchestration around the executors below

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const ENGINE = 'animaxia-sqlite-fts5-hybrid';
const SYNC_DEBOUNCE_MS = 3000;
const LATENCY_WINDOW = 50;
const SYNC_CHUNK = 25; // rows per multi-row upsert

// FAZA 18: expose the indexing chunk (SYNC_CHUNK) on the batching stage stats.
pipeline.setIndexSyncBatch(SYNC_CHUNK);

/* FAZA 17-a hardening constants. */
const OFFSET_CAP = 10000; // offset pagination ceiling (rows)
const QUERY_TIMEOUT_MS = 8000; // per-query budget before a 504

/* FAZA 17-a ops counters — exported via searchOpsSnapshot(). */
const searchOps = { coalesced: 0, errors: 0, offsetCapped: 0 };

/** FAZA 17-a: { coalesced, errors, offsetCapped } for /api/platform/stability. */
export function searchOpsSnapshot() {
  // FAZA 18: coalescing lives in pipeline layer 7 now — keep the contract fed
  // with the live pipeline counter on top of the legacy searchOps one.
  return {
    ...searchOps,
    coalesced: searchOps.coalesced + pipeline.perStageCounts().coalesced,
  };
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

/* TS1 (integrity): shared searchdocs upsert builders — the EXACT doc-build of
 * syncIndex() extracted verbatim so the incremental 'content:changed:ids'
 * path below produces byte-identical rows/SQL (no semantic change). */
const SEARCHDOC_UPSERT_SET = `
       ON CONFLICT (contentid) DO UPDATE SET
         title = EXCLUDED.title,
         year = EXCLUDED.year`;

function searchdocUpsertSql(tuples) {
  return `INSERT INTO searchdocs (contentid, title, year)
          VALUES ${tuples.join(', ')}
          ${SEARCHDOC_UPSERT_SET}`;
}

function detectYear(row) {
  const direct = Number(row.year);
  if (Number.isInteger(direct) && direct >= 1000 && direct <= 9999) return direct;

  const match = String(row.title || '').match(/\b(19|20)\d{2}\b/);
  return match ? Number(match[0]) : null;
}

function buildSearchdocTuple(row, j) {
  const base = j * 3;
  const values = [
    Number(row.id),
    row.title ?? 'untitled',
    detectYear(row),
  ];

  const b = (k) => `$${base + k}`;

  return {
    values,
    tuple: `(${b(1)},${b(2)},${b(3)})`,
  };
}

async function syncIndex() {
  const raw = await rows(
    'SELECT id, title, year FROM content',
  );

  let synced = 0;
  for (let i = 0; i < raw.length; i += SYNC_CHUNK) {
    const slice = raw.slice(i, i + SYNC_CHUNK);
    const values = [];
    const tuples = slice.map((row, j) => {
      const built = buildSearchdocTuple(row, j);
      values.push(...built.values);
      return built.tuple;
    });
    await rows(searchdocUpsertSql(tuples), values);
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

/**
 * NEON FREE PLAN — boot fast-path (goal 7/10): at restart `dirty=true` forces a
 * FULL resync (18k rows × full metadata JSONB) on the first search — it blocks
 * the request >30s (504 at REQUESTTIMEOUTMS) and wakes Neon with zero real
 * traffic. But searchdocs already lives synced IN Neon: when the content and
 * searchdocs row counts match, the index is consistent and the heavy sync can
 * be skipped entirely. Any drift (counts differ) falls back to the unchanged
 * full syncIndex() path, and post-boot 'content:changed' semantics are
 * untouched (dirty set while lastSync is set → probe not used).
 */
async function bootConsistencyProbe() {
  try {
    const row = await one(`
      SELECT (SELECT COUNT(*) FROM content)   AS content_n,
             (SELECT COUNT(*) FROM searchdocs) AS docs_n
    `);
    const contentN = Number(row?.content_n ?? -1);
    const docsN = Number(row?.docs_n ?? -2);
    if (contentN > 0 && contentN === docsN) {
      lastSync = new Date().toISOString();
      dirty = false;
      logger.info(`[search] boot fast-path: searchdocs already in sync (${docsN} docs) — full resync skipped (NEON FREE PLAN)`);
      return true;
    }
    logger.info(`[search] boot probe: content=${contentN} vs docs=${docsN} — full resync required`);
  } catch (err) {
    logger.warn(`[search] boot probe failed: ${err.message} — falling back to full sync`);
  }
  return false;
}

/** Rebuild once under an async lock; concurrent callers await the same run. */
async function ensureSynced() {
  if (!dirty && lastSync) return;
  if (!syncPromise) {
    syncPromise = (async () => {
      // Boot-time only (lastSync===null): try the cheap consistency probe
      // before committing to the heavy full-table resync.
      if (!lastSync && (await bootConsistencyProbe())) return 0;
      return syncIndex();
    })().finally(() => {
      syncPromise = null;
    });
  }
  await syncPromise;
}

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
events.on('content:changed', ({ ids } = {}) => {
  // Specific-id events are handled by the incremental searchdocs listener
  // below. Avoid a redundant full-library rebuild after every JSON batch.
  if (Array.isArray(ids) && ids.length && ids.every((id) => Number.isSafeInteger(Number(id)) && Number(id) > 0)) {
    return;
  }
  dirty = true;
  if (resyncTimer) clearTimeout(resyncTimer);
  resyncTimer = setTimeout(() => {
    resyncTimer = null;
    ensureSynced().catch((err) => logger.warn(`[search] background resync failed: ${err.message}`));
  }, SYNC_DEBOUNCE_MS);
  if (typeof resyncTimer.unref === 'function') resyncTimer.unref();
});

/* TS1 (integrity): 'content:changed:ids' carries the exact touched ids
 * (POST /api/content, DELETE /api/content/:id, miner upsert in server.js) →
 * INCREMENTAL sync: deletes drop their docs, creates/updates re-index ONLY
 * those ids via the same buildSearchdocTuple/upsert as syncIndex. Ids
 * coalesce into Sets behind the same 3s debounce; on failure dirty flips to
 * true so the untouched full-resync 'content:changed' path above recovers. */
let incrementalTimer = null;
const pendingUpsertIds = new Set();
const pendingDeleteIds = new Set();
events.on('content:changed:ids', ({ ids, action } = {}) => {
  if (!Array.isArray(ids)) return;
  for (const rawId of ids) {
    const id = Number(rawId);
    if (!Number.isInteger(id) || id <= 0) continue;
    if (action === 'delete') {
      pendingDeleteIds.add(id);
      pendingUpsertIds.delete(id);
    } else {
      pendingUpsertIds.add(id);
      pendingDeleteIds.delete(id);
    }
  }
  if (incrementalTimer) clearTimeout(incrementalTimer);
  incrementalTimer = setTimeout(async () => {
    incrementalTimer = null;
    const upsertIds = [...pendingUpsertIds];
    const deleteIds = [...pendingDeleteIds];
    pendingUpsertIds.clear();
    pendingDeleteIds.clear();
    try {
      if (deleteIds.length > 0) {
        await rows('DELETE FROM searchdocs WHERE contentid IN (SELECT value FROM json_each($1))', [JSON.stringify(deleteIds)]);
      }
      if (upsertIds.length > 0) {
        const raw = await rows(
          'SELECT id, title, year FROM content WHERE id IN (SELECT value FROM json_each($1))',
          [JSON.stringify(upsertIds)],
        );
        for (let i = 0; i < raw.length; i += SYNC_CHUNK) {
          const slice = raw.slice(i, i + SYNC_CHUNK);
          const values = [];
          const tuples = slice.map((row, j) => {
            const built = buildSearchdocTuple(row, j);
            values.push(...built.values);
            return built.tuple;
          });
          await rows(searchdocUpsertSql(tuples), values);
        }
      }
      lastSync = new Date().toISOString();
      logger.info(`[search] incremental sync done — re-indexed ${upsertIds.length} id(s), removed ${deleteIds.length} doc(s)`);
    } catch (err) {
      logger.warn(`[search] incremental sync failed (dirty → full resync): ${err.message}`);
      dirty = true;
    }
  }, SYNC_DEBOUNCE_MS);
  if (typeof incrementalTimer.unref === 'function') incrementalTimer.unref();
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
    title: row.title ?? null,
    year: row.year == null ? null : Number(row.year),
    url: row.url ?? null,
    embedcode: row.embedcode ?? null,
    _score: row._score == null ? 0 : Number(row._score),
  };
}

/**
 * SQLite minimal search.
 * Searches ONLY: id, title, year.
 */
async function runAdvancedQuery(params) {
  return sqliteAdvancedSearch(params);
}

/* --------------------------- single-flight coalescing -------------------------- */

// FAZA 18: the single-flight map + coalesceAdvanced() moved into the pipeline
// (layer 7 — modules/search/pipeline.js), keyed by the full request signature.
// The FAZA 17-a contract (searchOpsSnapshot().coalesced) is preserved above.

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
router.use(metadataSearchRouter);

/** GET /api/search/advanced — Neon FTS + trigram fallback + SQL filters. Public. */
router.get('/advanced', wrap(async (req, res) => {
  const startedAt = Date.now();
  const q = req.query.q != null ? String(req.query.q).trim() : '';

  const type = req.query.type ? String(req.query.type) : null;
  const genre = req.query.genre ? String(req.query.genre) : null;
  const actor = req.query.actor ? String(req.query.actor) : null;
  const studio = req.query.studio ? String(req.query.studio) : null;
  const category = req.query.category ? String(req.query.category) : null;
  const franchise = req.query.franchise ? String(req.query.franchise) : null;
  const trilogy = req.query.trilogy ? String(req.query.trilogy) : null;
  const collection = req.query.collection ? String(req.query.collection) : null;
  const description = req.query.description ? String(req.query.description) : null;
  const posterId = req.query.posterId ? String(req.query.posterId) : null;
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
    type || genre || year != null || minRating != null || actor || studio || category ||
    franchise || trilogy || collection || description || posterId,
  );
  if (!q && !hasFilters) {
    return res.status(400).json({ error: 'Missing required query parameter: q (or at least one filter)' });
  }

  // FAZA 17-a: raw cursor param (base64url JSON) — presence enables keyset mode.
  const cursorRaw = req.query.cursor != null && req.query.cursor !== '' ? String(req.query.cursor) : null;

  // FAZA 13 (Task 13-3): search cluster path — when enabled and the request
  // has NO cursor param, fan the query out over the per-shard searchdocs
  // nodes (queryOnShard, merge + dedupe). Keyset (cursor) requests ALWAYS
  // stay on the legacy single-index path below; when the cluster is disabled
  // the legacy path runs byte-identical. The cluster response keeps the
  // legacy shape and adds only the `cluster` field (per-node report).
  //
  // FAZA 18: both paths execute through the 10-layer pipeline — layer 10
  // calls the SAME executors (searchCluster.queryFTS / runAdvancedQuery), so
  // the response contract is identical apart from the fresh wall-clock
  // `took` and the additive X-Search-Pipeline header.
  const headerRaw = req.headers['x-animaxia-shard'];
  const headerHint = parseInt(Array.isArray(headerRaw) ? headerRaw[0] : headerRaw, 10);
  const shardHint =
    Number.isInteger(headerHint) && headerHint >= 0 && headerHint < shardCount() ? headerHint : null;

  let legacyPath = true;
  const sigParams = {
    type, genre, year, minRating, actor, studio, category,
    franchise, trilogy, collection, description, posterId, sort, fuzzyEnabled, limit, page,
  };
  let executor;

  if (driverInfo().driver !== 'sqlite' && searchCluster.enabled() && !cursorRaw) {
    legacyPath = false;
    sigParams.shardHint = shardHint; // the hint changes the fan-out → part of the signature
    executor = async () => {
      await ensureSynced(); // same index-freshness guarantee as the legacy path
      const clusterResult = await searchCluster.queryFTS({
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
      });
      // FAZA 17 offset-cap mirror — pass through as 400 exactly like legacy.
      if (clusterResult && clusterResult.useCursor) {
        throw new PipelineRejection(400, { error: clusterResult.error, useCursor: true });
      }
      // The cluster body carries its own internal `took` — the per-request
      // wall-clock stamped below replaces it (request-level measurement).
      const { took: _clusterTook, ...body } = clusterResult;
      return body;
    };
  } else {
    // FAZA 17-a: offset pagination is capped — deep pages must use the cursor.
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
    sigParams.cursor = cursorRaw;
    executor = async () => {
      await ensureSynced();
      // FAZA 17-a single-flight lives in pipeline layer 7 now; the 8s query
      // timeout budget (504) and the whole SQL build are unchanged.
      const queryPromise = runAdvancedQuery({
        q: q || null,
        type,
        genre,
        year,
        minRating,
        actor,
        studio,
        category,
        franchise, trilogy, collection, description, posterId,
        sort,
        fuzzyEnabled,
        limit,
        page,
        cursor: cursorRaw,
      });
      let result;
      try {
        result = await withQueryTimeout(queryPromise, `q=${q || '(filters)'}`);
      } catch (err) {
        searchOps.errors += 1;
        throw err;
      }
      // Response body without `took` — the handler stamps a fresh wall-clock.
      return {
        total: result.total,
        max_score: result.max_score,
        page: result.page,
        limit,
        engine: ENGINE,
        data: result.data,
        // FAZA 17-a additive pagination contract:
        nextCursor: result.nextCursor ?? null,
        paginationMode: result.paginationMode ?? 'offset',
      };
    };
  }

  let out;
  try {
    // FAZA 18: kind 'search' — user tier 2, admin callers tier 1.
    out = await pipeline.execute({
      kind: 'search',
      client: clientIpOf(req),
      query: q,
      params: sigParams,
      executor,
      priority: req.user?.role === 'admin' ? 1 : 2,
    });
  } catch (err) {
    if (err && err.pipeline === true) {
      if (err.headers) {
        for (const [key, value] of Object.entries(err.headers)) res.set(key, value);
      }
      return res.status(err.status).json(err.body);
    }
    throw err; // executor errors keep the legacy Express error path
  }

  const took = Date.now() - startedAt;
  if (legacyPath) recordLatency(took); // legacy wall-clock feed (cluster records internally)

  res.set('X-Search-Pipeline', out.source); // hit | miss | cooldown (FAZA 18)
  return res.json({ took, ...out.body });
}));

/** GET /api/search/autocomplete?q= — trigram + prefix title suggestions. Public. */
router.get('/autocomplete', wrap(async (req, res) => {
  const q = req.query.q != null ? String(req.query.q).trim() : '';
  if (q.length < 1) {
    return res.status(400).json({ error: 'Missing required query parameter: q' });
  }

  // FAZA 18: autocomplete flows through the pipeline at the highest priority
  // (tier 3); layer 10 runs the exact SQL below — response shape untouched.
  const executor = async () => {
    await ensureSynced();
    const matched = await rows(
      `SELECT c.id AS contentid, c.title, c.year, c.type, c.thumbnail,
              COALESCE(json_extract(CASE WHEN json_valid(c.metadata) THEN c.metadata ELSE '{}' END, '$.rating'),
                       json_extract(CASE WHEN json_valid(c.metadata) THEN c.metadata ELSE '{}' END, '$.score')) AS rating
       FROM Content c
       WHERE c.title LIKE $1 || '%' COLLATE NOCASE
       ORDER BY c.title COLLATE NOCASE ASC, c.id ASC
       LIMIT 8`,
      [q],
    );
    return {
      suggestions: matched.map((r) => ({
        id: Number(r.contentid),
        title: r.title,
        type: r.type ?? null,
        thumbnail: r.thumbnail ?? null,
        rating: r.rating == null ? null : Number(r.rating),
      })),
    };
  };

  let out;
  try {
    out = await pipeline.execute({
      kind: 'autocomplete',
      client: clientIpOf(req),
      query: q,
      params: { q }, // raw q keeps case-variant autocompletes on distinct keys
      executor,
      priority: 3,
    });
  } catch (err) {
    if (err && err.pipeline === true) {
      if (err.headers) {
        for (const [key, value] of Object.entries(err.headers)) res.set(key, value);
      }
      return res.status(err.status).json(err.body);
    }
    throw err;
  }

  res.set('X-Search-Pipeline', out.source); // hit | miss | cooldown (FAZA 18)
  return res.json(out.body);
}));

/** GET /api/search/filters — actual SQLite facet values from persisted JSON. */
router.get('/filters', wrap(async (_req, res) => {
  // Bound each facet to prevent oversized API responses. For very large
  // catalogs these queries must eventually move to a materialized facet index.
  const [yearRows, typeRows] = await Promise.all([
    rows('SELECT DISTINCT year FROM Content WHERE year IS NOT NULL ORDER BY year DESC LIMIT 150'),
    rows("SELECT type, COUNT(*) AS n FROM Content GROUP BY type ORDER BY n DESC, type ASC LIMIT 100"),
  ]);
  const jsonFacets = async (path) => rows(`
    SELECT trim(CASE WHEN j.type = 'object'
      THEN COALESCE(json_extract(j.value, '$.name'), '')
      ELSE CAST(j.value AS TEXT) END) AS value, COUNT(*) AS n
    FROM Content c, json_each(
      CASE WHEN json_valid(c.metadata) THEN c.metadata ELSE '{}' END, '${path}'
    ) j
    WHERE j.type IN ('text', 'object')
    GROUP BY value HAVING value <> ''
    ORDER BY n DESC, value ASC LIMIT 100
  `);
  const [genres, actors, studios] = await Promise.all([
    jsonFacets('$.genres'), jsonFacets('$.actors'), jsonFacets('$.studios'),
  ]);
  return res.json({
    years: yearRows.map((r) => Number(r.year)),
    categories: typeRows.map((r) => ({ value: r.type, count: Number(r.n) })),
    types: typeRows.map((r) => ({ value: r.type, count: Number(r.n) })),
    genres: genres.map((r) => ({ value: r.value, count: Number(r.n) })),
    actors: actors.map((r) => ({ value: r.value, count: Number(r.n) })),
    studios: studios.map((r) => ({ value: r.value, count: Number(r.n) })),
    backend: 'sqlite',
  });
}));

/** POST /api/search/index — force a full resync (requireAuth + requireAdmin). */
router.post('/index', requireAuth, requireAdmin, wrap(async (req, res) => {
  const indexed = await forceResync();
  logger.info(`[search] Manual reindex by user ${req.user?.id ?? '?'} — ${indexed} docs`);
  return res.json({ ok: true, indexed });
}));

/* ----------------------- FAZA 18: pipeline stress lab ----------------------- */

const STRESS_LEVELS = [100, 1000, 5000, 10000];
const STRESS_REAL_SUBSET = 50; // real FTS requests (limit=1) per run
const stressRuns = [];         // rolling timestamps — internal limit: 2 runs/min
let lastStressResult = null;   // replayed by GET /status (stressTest field)

/**
 * POST /api/search/stress { concurrent: 100|1000|5000|10000 }
 * (requireAuth + requireAdmin) — in-process pipeline stress lab.
 *
 * Fires N simultaneous pipeline.execute() calls at priority 0 (stress tier):
 *   • the bulk runs on a FAST SYNTHETIC executor ({ mode: 'synthetic-executor' })
 *     that never touches Neon — it measures the orchestration itself;
 *   • a subset of up to 50 requests runs the REAL FTS executor (runAdvancedQuery
 *     with limit=1, real library terms) — proving the Neon protection live.
 * Every request gets an answer (a result or an honest 429/503) — lost must be
 * 0. The executor is instrumented with an atomic in-flight counter, so
 * maxConcurrentObserved must never exceed the queue's maxConcurrency.
 * Internal limit: max 2 runs per rolling minute.
 */
router.post('/stress', requireAuth, requireAdmin, wrap(async (req, res) => {
  const concurrent = Number((req.body || {}).concurrent);
  if (!STRESS_LEVELS.includes(concurrent)) {
    return res.status(400).json({ error: `concurrent must be one of: ${STRESS_LEVELS.join(', ')}` });
  }

  const nowMs = Date.now();
  while (stressRuns.length && nowMs - stressRuns[0] >= 60_000) stressRuns.shift();
  if (stressRuns.length >= 2) {
    const retryAfterSec = Math.max(1, Math.ceil((60_000 - (nowMs - stressRuns[0])) / 1000));
    res.set('Retry-After', String(retryAfterSec));
    return res.status(429).json({ error: 'stress-rate-limited', retryAfterSec });
  }
  stressRuns.push(nowMs);

  // Real library terms for the real-FTS subset (static fallback if DB is down).
  let terms = ['the', 'dune', 'star', 'wars', 'spider', 'dead', 'love', 'last', 'night', 'man'];
  try {
    const titleRows = await rows('SELECT title FROM content ORDER BY id LIMIT 120');
    const words = [
      ...new Set(
        titleRows
          .map((r) => String(r.title || '').split(/\s+/)[0].toLowerCase())
          .filter((w) => w.length >= 3),
      ),
    ];
    if (words.length >= 10) terms = words.slice(0, STRESS_REAL_SUBSET);
  } catch {
    /* keep the static fallback */
  }

  const before = pipeline.perStageCounts();

  // Atomic concurrency probe around every executor (JS single-thread → ++ is atomic).
  let executorInflight = 0;
  let maxConcurrentObserved = 0;
  const instrument = (fn) => async () => {
    executorInflight += 1;
    if (executorInflight > maxConcurrentObserved) maxConcurrentObserved = executorInflight;
    try {
      return await fn();
    } finally {
      executorInflight -= 1;
    }
  };

  const realExecutor = (term) =>
    instrument(async () => {
      await ensureSynced();
      const result = await runAdvancedQuery({
        q: term, type: null, genre: null, year: null, minRating: null, actor: null,
        studio: null, category: null, sort: 'score', fuzzyEnabled: true, limit: 1, page: 1,
      });
      return { ok: true, mode: 'neon-fts-real', term, total: result.total, returned: result.data.length };
    });
  const syntheticExecutor = (term) =>
    instrument(async () => ({ ok: true, mode: 'synthetic-executor', term }));

  const realCount = Math.min(STRESS_REAL_SUBSET, concurrent);
  const startedAt = Date.now();
  // A request that never settles would hang this handler (visible QA timeout)
  // — the settlement accounting below is what makes `lost` an honest metric.
  const settled = await Promise.all(
    Array.from({ length: concurrent }, (_, i) => {
      const isReal = i < realCount;
      const term = isReal ? terms[i % terms.length] : `stress ${concurrent} ${i % 250}`;
      return pipeline
        .execute({
          kind: 'stress', // priority tier 0
          client: `stress-${concurrent}-${i}`, // unique per request → measures the queue, not per-client limits
          query: term,
          params: { stress: concurrent, real: isReal },
          executor: isReal ? realExecutor(term) : syntheticExecutor(term),
        })
        .then(
          (out) => ({ received: true, ok: true, source: out.source }),
          (err) => ({
            received: true,
            ok: false,
            error: err?.body?.error ?? err?.message ?? 'unknown',
            layer: err?.layer ?? null,
          }),
        );
    }),
  );
  const durationMs = Date.now() - startedAt;

  // Per-stage distribution for THIS run (counter diff around the burst).
  const after = pipeline.perStageCounts();
  const perStage = {};
  for (const key of Object.keys(after)) {
    if (key === 'byPriority') continue;
    perStage[key] = after[key] - (before[key] ?? 0);
  }
  const byPriority = {};
  for (const key of new Set([...Object.keys(before.byPriority), ...Object.keys(after.byPriority)])) {
    byPriority[key] = (after.byPriority[key] || 0) - (before.byPriority[key] || 0);
  }
  perStage.byPriority = byPriority;

  const totalRequests = concurrent;
  const responsesReceived = settled.filter((r) => r.received).length;
  const lost = totalRequests - responsesReceived;
  const executed = perStage.executed ?? 0;
  const passed =
    lost === 0 && responsesReceived === totalRequests && maxConcurrentObserved <= pipeline.config.maxConcurrency;

  lastStressResult = {
    concurrent,
    passed,
    at: new Date().toISOString(),
    details: { lost, executed, maxConcurrentObserved, durationMs, perStage },
  };

  logger.info(
    `[search] pipeline stress N=${concurrent} by user ${req.user?.id ?? '?'} — ` +
      `${responsesReceived}/${totalRequests} responses, executed=${executed}, ` +
      `maxConcurrent=${maxConcurrentObserved}, ${durationMs}ms`,
  );

  return res.json({
    ok: true,
    mode: 'synthetic-executor', // honest label: the bulk runs a fast in-process synthetic executor
    concurrent,
    totalRequests,
    responsesReceived,
    lost,
    passed,
    maxConcurrentObserved,
    maxConcurrency: pipeline.config.maxConcurrency,
    durationMs,
    realFts: { requests: realCount, limit: 1, executor: 'neon-fts-real (runAdvancedQuery)' },
    perStage,
    at: lastStressResult.at,
  });
}));

/** GET /api/search/status — engine health snapshot. Public. */
router.get('/status', wrap(async (req, res) => {
  await ensureSynced().catch((err) => logger.warn(`[search] status sync failed: ${err.message}`));
  let docs = 0;
  const docRow = await one('SELECT COUNT(*) AS n FROM searchdocs').catch(() => null);
  docs = Number(docRow?.n ?? 0);
  const pgTrgm = false; // SQLite: pg_trgm extension is unavailable.
  // FAZA 13 (Task 13-3): additive cluster health field — null when the
  // cluster is disabled or its health probe fails (legacy shape untouched).
  let clusterHealth = null;
  if (driverInfo().driver !== 'sqlite' && searchCluster.enabled()) {
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
    backend: driverInfo().driver,
    extensions: { pg_trgm: pgTrgm, fts5: true },
    fullTextIndex: { indexedDocuments: countFtsRows(), engine: 'sqlite-fts5', distributed: false },
    lastSync,
    dirty,
    latency: searchLatencySnapshot(),
    capacity: { indexedDocs: docs },
    cluster: clusterHealth,
    // FAZA 18 (additive): 10-layer pipeline integration + stress lab replay.
    pipelineIntegrated: true,
    pipelineStages: pipeline.stagesSnapshot(),
    stressTest: lastStressResult ?? { concurrent: null, passed: null, at: null, details: null },
  });
}));

export default router;
