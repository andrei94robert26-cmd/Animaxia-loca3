/**
 * modules/ar10m/search-gateway.js — THE real AR10M search engine (Task
 * AR10M-2-BE). Implements the user-pinned search pipeline EXACTLY:
 *
 *   1. Normalize the query (normalizeTitle). Empty → empty negative result.
 *   2. limit default 20, max 50 (10 in critical budget mode). Keyset
 *      pagination: cursor = base64url({ t: normalized_title, i: id }),
 *      `WHERE (normalized_title, id) > ($1,$2)` — trailing-% LIKE ONLY
 *      (leading-wildcard LIKE is forbidden; prefix LIKE rides the
 *      text_pattern_ops index via per-execution custom plans).
 *   3. Fan-out over ACTIVE physical shards (logical 0..14 deduped to
 *      physical slots — today 15 logical → 1 physical = 1 query), max
 *      AR10M_MAX_PARALLEL (3..5) concurrent, batched; STOP after a batch
 *      once deduped results >= limit (never auto-queries everything).
 *   4. Per-shard query (3s timeout): ar10m.content LEFT JOIN content_sources.
 *   5. ALSO search the LEGACY real catalog (public.content, metadata-only,
 *      no FTS) on the primary via its normalized_title column (added by the
 *      orchestrator); if the column is missing the gateway skips legacy
 *      gracefully for 60s. Results marked catalog:'legacy'.
 *   6. Dedupe by normalized title+year across shards AND ar10m/legacy
 *      (ar10m preferred — it carries the real playable source).
 *   7. Sort: exact match first, then (normalized_title, id) alphabetical.
 *   8. A failing shard NEVER fails the search — failedShards are reported.
 *   9. In-memory cache: positive TTL 120s (max 500 entries, LRU-ish),
 *      negative TTL 60s, cache key q|year|limit|cursor.
 *  10. NO reindex on insert — indexes maintain themselves (zero reindex calls).
 *
 * Exports: ar10mSearch, ar10mAutocomplete, searchCacheStats, searchLatency.
 */

import { normalizeTitle, normalizeYear, AR10M_SHARD_COUNT } from './normalize.js';
import { shardQuery, resolvePhysicalSlot } from './shard-router.js';
import { recordSearchQuery, recordCacheHit, recordCacheMiss, budgetLevel } from './budget.js';
import { logger } from '../../utils/logger.js';

/* --------------------------------- constants -------------------------------- */

/** Max concurrent physical shard queries: env AR10M_MAX_PARALLEL, clamp 3..5. */
const MAX_PARALLEL = (() => {
  const n = parseInt(process.env.AR10M_MAX_PARALLEL || '5', 10);
  if (!Number.isFinite(n)) return 5;
  return Math.min(5, Math.max(3, Math.floor(n)));
})();

const SEARCH_TIMEOUT_MS = 3_000;
const AUTOCOMPLETE_TIMEOUT_MS = 2_000;
const CACHE_MAX_ENTRIES = 500;
const POSITIVE_TTL_MS = 120_000;
const NEGATIVE_TTL_MS = 60_000;
const LEGACY_SKIP_MS = 60_000; // skip legacy for this long when its column is missing
const LATENCY_SAMPLES = 100;

/* ---------------------------------- caching ---------------------------------- */

const cache = new Map(); // key → { value, at, negative }
const cacheStats = { hits: 0, misses: 0, negativeHits: 0 };

function cacheGet(key) {
  const e = cache.get(key);
  if (!e) {
    cacheStats.misses += 1;
    recordCacheMiss();
    return null;
  }
  const ttl = e.negative ? NEGATIVE_TTL_MS : POSITIVE_TTL_MS;
  if (Date.now() - e.at > ttl) {
    cache.delete(key);
    cacheStats.misses += 1;
    recordCacheMiss();
    return null;
  }
  // LRU-ish: refresh insertion order on hit
  cache.delete(key);
  cache.set(key, e);
  cacheStats.hits += 1;
  if (e.negative) cacheStats.negativeHits += 1;
  recordCacheHit();
  return e;
}

function cacheSet(key, value, negative) {
  while (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  cache.set(key, { value, at: Date.now(), negative: !!negative });
}

/** { hits, misses, keys, negativeKeys, hitRate } — honest counters. */
export function searchCacheStats() {
  let negativeKeys = 0;
  for (const e of cache.values()) if (e.negative) negativeKeys += 1;
  const total = cacheStats.hits + cacheStats.misses;
  return {
    hits: cacheStats.hits,
    misses: cacheStats.misses,
    keys: cache.size,
    negativeKeys,
    hitRate: total > 0 ? Math.round((cacheStats.hits * 10000) / total) / 100 : 0,
  };
}

/* --------------------------------- latency ----------------------------------- */

const latencySamples = [];

function recordLatency(ms) {
  latencySamples.push(ms);
  if (latencySamples.length > LATENCY_SAMPLES) latencySamples.shift();
}

/** Rolling p50/p95 (last 100 real pipeline executions — cache hits excluded). */
export function searchLatency() {
  if (latencySamples.length === 0) return { samples: 0, p50Ms: null, p95Ms: null, p99Ms: null };
  const sorted = [...latencySamples].sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor((p * sorted.length) / 100))];
  return {
    samples: sorted.length,
    p50Ms: at(50),
    p95Ms: at(95),
    p99Ms: at(99),
  };
}

/* ---------------------------------- cursors ---------------------------------- */

const encodeCursor = (t, i) => Buffer.from(JSON.stringify({ t, i }), 'utf8').toString('base64url');

function decodeCursor(raw) {
  try {
    const o = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8'));
    if (typeof o?.t === 'string' && Number.isInteger(o?.i)) return { t: o.t, i: o.i };
  } catch {
    /* fallthrough */
  }
  return null;
}

/* ------------------------------- legacy search -------------------------------- */

const legacyState = { skipUntil: 0 };

function buildLegacySql(nq, yr, cursorObj, lim) {
  const where = ["normalized_title LIKE $1 || '%'"];
  const params = [nq];
  if (yr !== null) {
    params.push(String(yr));
    where.push(`substring(metadata->>'year' from '^[0-9]{4}') = $${params.length}`);
  }
  if (cursorObj) {
    params.push(cursorObj.t, cursorObj.id);
    where.push(`(normalized_title, id) > ($${params.length - 1}, $${params.length})`);
  }
  params.push(lim + 1);
  const sql = `SELECT id, title, normalized_title, substring(metadata->>'year' from '^[0-9]{4}') AS year
FROM public.content
WHERE ${where.join(' AND ')}
ORDER BY normalized_title ASC, id ASC
LIMIT $${params.length}`;
  return { sql, params };
}

/**
 * Search the legacy real catalog (public.content). Returns { rows, skipped?,
 * error? }. If the orchestrator's normalized_title column is not there yet,
 * legacy is skipped gracefully for 60s (never crashes the search).
 */
async function searchLegacy(nq, yr, cursorObj, lim, timeoutMs) {
  if (Date.now() < legacyState.skipUntil) return { rows: [], skipped: 'coloana-normalized-title-lipsa' };
  const { sql, params } = buildLegacySql(nq, yr, cursorObj, lim);
  try {
    const r = await shardQuery(0, sql, params, { timeoutMs }); // logical 0 → primary today
    return { rows: r.rows ?? [] };
  } catch (err) {
    const msg = String(err?.message ?? err);
    if (/does not exist|undefined column|column .* not exist/i.test(msg)) {
      legacyState.skipUntil = Date.now() + LEGACY_SKIP_MS;
      logger.info('[ar10m/search] legacy public.content lacks normalized_title — legacy results skipped for 60s');
      return { rows: [], skipped: 'coloana-normalized-title-lipsa' };
    }
    return { rows: [], error: msg.slice(0, 200) };
  }
}

/* ------------------------------ ar10m shard search ---------------------------- */

function buildAr10mSql(nq, yr, cursorObj, lim) {
  const where = ["c.normalized_title LIKE $1 || '%'"];
  const params = [nq];
  if (yr !== null) {
    params.push(yr);
    where.push(`c.year = $${params.length}`);
  }
  if (cursorObj) {
    params.push(cursorObj.t, cursorObj.id);
    where.push(`(c.normalized_title, c.id) > ($${params.length - 1}, $${params.length})`);
  }
  params.push(lim + 1); // +1 over the page size → honest hasMore detection
  const sql = `SELECT c.id, c.title, c.normalized_title, c.year, c.shard_id,
       s.source_type AS source_type, s.source_url AS source_url, s.embed_code AS embed_code
FROM ar10m.content c
LEFT JOIN ar10m.content_sources s ON s.id = c.source_id
WHERE ${where.join(' AND ')}
ORDER BY c.normalized_title ASC, c.id ASC
LIMIT $${params.length}`;
  return { sql, params };
}

/* --------------------------------- the pipeline ------------------------------- */

/**
 * The shared search pipeline (search + autocomplete). Physical fan-out with
 * dedupe, batched concurrency, early stop, legacy merge, dedupe by
 * normalized title+year (ar10m preferred), exact-first sort.
 */
async function runSearch({ q, year, limit, cursorObj, timeoutMs, includeLegacy }) {
  const nq = normalizeTitle(q);
  const yr = year === undefined ? null : normalizeYear(year);
  const maxLimit = (budgetLevel() === 'critical' || budgetLevel() === 'max') ? 10 : 50;
  const lim = Math.min(maxLimit, Math.max(1, parseInt(limit, 10) || 20));

  if (!nq) {
    return {
      nq,
      yr,
      lim,
      rows: [],
      nextCursor: null,
      negative: true,
      queried: [],
      failed: [],
      fullBatchSeen: false,
    };
  }

  // Physical fan-out: logical shards 0..N-1 deduped to physical slots.
  const targets = new Map(); // physicalSlot → [logicalShardIds]
  for (let s = 0; s < AR10M_SHARD_COUNT; s += 1) {
    const slot = resolvePhysicalSlot(s);
    if (!targets.has(slot)) targets.set(slot, []);
    targets.get(slot).push(s);
  }
  const slotList = [...targets.keys()].sort((a, b) => a - b);
  const batches = [];
  for (let i = 0; i < slotList.length; i += MAX_PARALLEL) batches.push(slotList.slice(i, i + MAX_PARALLEL));

  const { sql, params } = buildAr10mSql(nq, yr, cursorObj, lim);
  const merged = new Map(); // dedupe key → row (ar10m preferred)
  const queried = [];
  const failed = [];
  let fullBatchSeen = false;

  const runSlot = async (slot) => {
    const logicalForSlot = targets.get(slot);
    queried.push(...logicalForSlot);
    try {
      // Route via the first logical shard of this physical slot — same pool.
      const r = await shardQuery(logicalForSlot[0], sql, params, { timeoutMs });
      const rows = r.rows ?? [];
      if (rows.length > lim) fullBatchSeen = true;
      for (const row of rows) {
        const item = {
          id: Number(row.id),
          title: row.title,
          normalizedTitle: row.normalized_title,
          year: row.year === null || row.year === undefined ? null : Number(row.year),
          sourceType: row.source_type ?? null,
          sourceUrl: row.source_url ?? null,
          embedCode: row.embed_code ?? null,
          shardId: row.shard_id === null || row.shard_id === undefined ? null : Number(row.shard_id),
          catalog: 'ar10m',
        };
        merged.set(`${item.normalizedTitle}|${item.year ?? ''}`, item);
      }
    } catch (err) {
      failed.push({
        slot,
        shardIds: logicalForSlot,
        error: String(err?.code === 'SHARD_UNAVAILABLE' ? 'shard-unavailable' : err?.message ?? err).slice(0, 200),
      });
    }
  };

  // Legacy runs once, in parallel with the first ar10m batch.
  const legacyPromise = includeLegacy ? searchLegacy(nq, yr, cursorObj, lim, timeoutMs) : Promise.resolve({ rows: [] });

  for (const batch of batches) {
    // eslint-disable-next-line no-await-in-loop -- batches are intentionally sequential
    await Promise.all(batch.map(runSlot));
    if (merged.size >= lim) break; // enough results after dedupe → STOP
  }

  const legacy = await legacyPromise;
  if (legacy.error) failed.push({ catalog: 'legacy', error: legacy.error });
  for (const row of legacy.rows ?? []) {
    const item = {
      id: Number(row.id),
      title: row.title,
      normalizedTitle: row.normalized_title,
      year: row.year === null || row.year === undefined ? null : Number(row.year),
      sourceType: null,
      sourceUrl: null,
      embedCode: null,
      shardId: null,
      catalog: 'legacy',
    };
    const key = `${item.normalizedTitle}|${item.year ?? ''}`;
    if (!merged.has(key)) merged.set(key, item); // ar10m preferred on dedupe
  }

  // Sort: exact match first, then (normalized_title, id) alphabetical.
  const sorted = [...merged.values()].sort((a, b) => {
    const aExact = a.normalizedTitle === nq ? 0 : 1;
    const bExact = b.normalizedTitle === nq ? 0 : 1;
    if (aExact !== bExact) return aExact - bExact;
    if (a.normalizedTitle !== b.normalizedTitle) return a.normalizedTitle < b.normalizedTitle ? -1 : 1;
    return a.id - b.id;
  });

  const hasMore = sorted.length > lim || fullBatchSeen;
  const page = sorted.slice(0, lim);
  const nextCursor = hasMore && page.length > 0 ? encodeCursor(page[page.length - 1].normalizedTitle, page[page.length - 1].id) : null;

  return { nq, yr, lim, rows: page, nextCursor, negative: page.length === 0, queried, failed, fullBatchSeen };
}

/* ---------------------------------- public API -------------------------------- */

/**
 * The real AR10M search. Response shape (frozen contract):
 * { ok, q, year, results: [{ id, title, year, sourceType, sourceUrl,
 *   embedCode, shardId, thumbnailId, catalog }], nextCursor, cached,
 *   negative, elapsedMs, shards: { queried, failed } }
 */
export async function ar10mSearch({ q, year, limit, cursor } = {}) {
  const t0 = Date.now();
  recordSearchQuery();

  const cursorObj = cursor ? decodeCursor(cursor) : null;
  const cacheKey = `search|${normalizeTitle(q)}|${normalizeYear(year) ?? ''}|${limit ?? 20}|${cursor ?? ''}`;
  const cached = cacheGet(cacheKey);
  if (cached) {
    return { ...cached.value, cached: true, elapsedMs: Date.now() - t0 };
  }

  const out = await runSearch({ q, year, limit, cursorObj, timeoutMs: SEARCH_TIMEOUT_MS, includeLegacy: true });
  const response = {
    ok: true,
    q: String(q ?? ''),
    year: out.yr,
    results: out.rows.map((r) => ({
      id: r.id,
      title: r.title,
      year: r.year,
      sourceType: r.sourceType,
      sourceUrl: r.sourceUrl,
      embedCode: r.embedCode,
      shardId: r.shardId,
      thumbnailId: String(r.id), // /thumb/:id serves real thumb or placeholder
      catalog: r.catalog,
    })),
    nextCursor: out.nextCursor,
    cached: false,
    negative: out.negative,
    elapsedMs: Date.now() - t0,
    shards: { queried: out.queried, failed: out.failed },
  };
  recordLatency(Date.now() - t0);
  cacheSet(cacheKey, response, response.negative);
  return response;
}

/**
 * Autocomplete: same pipeline, 2s timeout, minimal fields { id, title, year }.
 * Disabled (honest) in critical/max budget mode.
 */
export async function ar10mAutocomplete(q, limit = 8) {
  const level = budgetLevel();
  if (level === 'critical' || level === 'max') {
    return { ok: false, disabled: true, reason: 'economic-mode', suggestions: [] };
  }
  const t0 = Date.now();
  recordSearchQuery();
  const lim = Math.min(10, Math.max(1, parseInt(limit, 10) || 8));
  const cacheKey = `ac|${normalizeTitle(q)}|${lim}`;
  const cached = cacheGet(cacheKey);
  if (cached) return { ...cached.value, cached: true };

  const out = await runSearch({ q, year: undefined, limit: lim, cursorObj: null, timeoutMs: AUTOCOMPLETE_TIMEOUT_MS, includeLegacy: true });
  const response = {
    ok: true,
    suggestions: out.rows.map((r) => ({ id: r.id, title: r.title, year: r.year })),
    negative: out.negative,
    elapsedMs: Date.now() - t0,
    shards: { queried: out.queried, failed: out.failed },
  };
  recordLatency(Date.now() - t0);
  cacheSet(cacheKey, response, response.negative);
  return response;
}
