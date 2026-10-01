/**
 * modules/platform/stress.js — FAZA 17-a: stress laboratory + virtual 30B
 * catalog + live stability snapshot (mounted at /api/platform in server.js).
 * FAZA 14 (Task 14-2): the GLOBAL 30B FEED — /api/platform/feed/global —
 * the merged real+virtual feed over the logical 30B address space.
 *
 * Routes (all additive, no collision with existing mounts — /api/platform was
 * free before FAZA 17):
 *   GET  /api/platform/stability   → { ok, ...stabilitySnapshot(), pool,
 *                                      search: { coalesced, errors, offsetCapped } }
 *                                     (public, uncached — real-time numbers)
 *   GET  /api/platform/scale/virtual?cursor=&limit=&seed=
 *                                → deterministic virtual catalog page over a
 *                                  30,000,000,000-item address space. O(1)
 *                                  deep jumps (pure generation, zero scans).
 *   GET  /api/platform/feed/global?cursor=&limit=&shard=&seed= (FAZA 14)
 *                                → the GLOBAL 30B FEED: keyset window over the
 *                                  logical address space with a REAL overlay —
 *                                  real Neon content rows surface at their own
 *                                  ids inside the window (one indexed PK range
 *                                  scan), every other slot is a deterministic
 *                                  virtual item. O(1) at ANY depth (page
 *                                  1,500,000,000 costs the same as page 1).
 *   POST /api/platform/stress/run  → REAL in-process load test (no HTTP
 *                                  self-calls): suites search | ingest |
 *                                  virtual30b | mixed; global lock (409),
 *                                  caps 1..30s × 1..32 workers, 2/min per IP.
 *
 * The virtual catalog uses a hand-written PRNG (mulberry32 over a
 * seed+index hash) — deterministic titles/types/years/ratings/genres per
 * (seed, index) pair, so item #29,999,999,980 generates as fast as item #0.
 * This is the PROOF that keyset pagination scales to the 30B address space:
 * the paging layer never scans, it only computes.
 */

import express from 'express';
import { stabilitySnapshot } from './resilience.js';
import { poolStats, query } from '../../db.js';
import { searchOpsSnapshot, runSearchLoad } from '../search/search.js';
import { registerSource } from '../ingest/dedup.js';
import { clientIpOf } from '../security/security.js';
import { logger } from '../../utils/logger.js';
import {
  shardCount,
  SHARD_SPAN_IDS,
  logicalAddressSpace,
  computeShardIdFromContentId,
} from '../sharding/model.js';
import { parseJsonb } from './sql.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* ------------------------------ virtual catalog ------------------------------ */

const ADDRESS_SPACE = 30000000000; // 30B items

const TITLE_PREFIXES = [
  'Umbra', 'Codrul', 'Ultimul', 'Călătoria', 'Neon', 'Furtuna', 'Aritmetica',
  'Marea', 'Cerul', 'Orașul', 'Legea', 'Semnătura', 'Carnavalul', 'Vânătorul',
  'Grădina', 'Muntele', 'Ecoul', 'Prisma', 'Zorii', 'Amprenta',
];
const TITLE_NOUNS = [
  'Fără Sfârșit', 'de Cleștar', 'Tăcută', 'din Azur', 'Digitală', 'Uitătoarei',
  'de Aur', 'Nemuritoare', 'de Foc', 'din Umbră', 'Pierdută', 'de Iarnă',
  'Infinită', 'din Adânc', 'Strălucitoare', 'de Bronz', 'Sacredă', 'din Amurg',
];
const TITLE_SUFFIXES = [
  '', ' I', ' II', ' III', ' IV', ' V', ' X', ' XII', ' XX', ' XL',
  ': Reînvierea', ': Ultimul Capitol', ': Originea', ': Moștenirea', ': Răscumpărarea',
];
const CONTENT_TYPES = ['movie', 'tv', 'anime'];
const GENRES = [
  'Acțiune', 'Aventură', 'Dramă', 'SF', 'Fantasy', 'Thriller', 'Comedie',
  'Romance', 'Mister', 'Animație', 'Crimă', 'Documentar',
];
const OVERVIEW_TEMPLATES = [
  'Un {type} despre {prefix} {noun} — o poveste despre alegeri și consecințe într-o lume care nu iartă.',
  'În căutarea {prefix} {noun}, un grup de străini descoperă că trecutul nu rămâne niciodată îngropat.',
  '{prefix} {noun} ascunde un secret pe care nimeni nu a îndrăznit să-l rostească — până acum.',
  'O epopee generatională despre {prefix} {noun} și prețul libertății într-un secol al schimbării.',
  'Când {prefix} {noun} dispare, un detectiv obsedat reconstruiește piesă cu piesă adevărul fragmentat.',
  '{prefix} {noun} — o meditație tăcută despre timp, memorie și tot ce pierdem pe drum.',
];

/** Deterministic 32-bit string hash (FNV-1a variant, hand-written). */
function fnv1a(text) {
  let h = 0x811c9dc5;
  const s = String(text);
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    // 32-bit FNV prime multiplication via shifts (avoid BigInt/precision loss).
    h = (h + ((h << 1) >>> 0) + ((h << 4) >>> 0) + ((h << 7) >>> 0) + ((h << 8) >>> 0) + ((h << 24) >>> 0)) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32 PRNG — hand-written, deterministic per (seed, index). */
function mulberry32(a) {
  let t = a >>> 0;
  return function next() {
    t = (t + 0x6d2b79f5) >>> 0;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic item generation — pure computation, O(1) at ANY depth. */
function generateVirtualItem(index, seed) {
  const rand = mulberry32(fnv1a(`${seed}:${index}`));
  const prefix = TITLE_PREFIXES[Math.floor(rand() * TITLE_PREFIXES.length)];
  const noun = TITLE_NOUNS[Math.floor(rand() * TITLE_NOUNS.length)];
  const suffix = TITLE_SUFFIXES[Math.floor(rand() * TITLE_SUFFIXES.length)];
  const type = CONTENT_TYPES[Math.floor(rand() * CONTENT_TYPES.length)];
  const year = 1950 + Math.floor(rand() * 76); // 1950..2025
  const rating = Number((5.0 + rand() * 4.9).toFixed(1)); // 5.0..9.9
  const genreCount = 1 + Math.floor(rand() * 3); // 1..3 genres
  const genres = [];
  const usedIdx = new Set();
  while (genres.length < genreCount) {
    const gi = Math.floor(rand() * GENRES.length);
    if (!usedIdx.has(gi)) {
      usedIdx.add(gi);
      genres.push(GENRES[gi]);
    }
  }
  const template = OVERVIEW_TEMPLATES[Math.floor(rand() * OVERVIEW_TEMPLATES.length)];
  const overview = template
    .replaceAll('{type}', type === 'tv' ? 'serial' : type === 'anime' ? 'anime' : 'film')
    .replaceAll('{prefix}', prefix)
    .replaceAll('{noun}', noun.toLowerCase());
  const title = `${prefix} ${noun}${suffix}`;
  return {
    index,
    title,
    type,
    year,
    rating,
    genres,
    overview,
    thumbnail: null,
  };
}

/* base64url helpers (same encoding as the search cursor). */
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

/* -------------------------------- stress lab -------------------------------- */

/** In-memory 2/min per-IP limiter for /stress/run (spec: simple counter). */
const stressHits = new Map(); // ip → { count, resetAt }
const STRESS_RATE_MAX = 2;
const STRESS_RATE_WINDOW_MS = 60000;

function stressRateCheck(ip) {
  const now = Date.now();
  let entry = stressHits.get(ip);
  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + STRESS_RATE_WINDOW_MS };
    stressHits.set(ip, entry);
  }
  entry.count += 1;
  // Opportunistic sweep so the map cannot grow unbounded.
  if (stressHits.size > 1000) {
    for (const [key, e] of stressHits) if (e.resetAt <= now) stressHits.delete(key);
  }
  return entry.count <= STRESS_RATE_MAX;
}

/** Global single-run lock for the stress suite. */
let stressLock = false;
let stressLast = null; // last completed report (for the response of a 409)

const SEARCH_TERMS = ['dune', 'the', 'star', 'anime'];

function percentileOf(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return Number(sorted[idx].toFixed(2));
}

/** Worker: search suite — full engine queries with rotating terms. */
async function workerSearch(state, deadline, q) {
  const terms = [...SEARCH_TERMS, String(q || 'dune')];
  let i = 0;
  while (Date.now() < deadline) {
    const term = terms[i % terms.length];
    i += 1;
    const t0 = Date.now();
    try {
      const r = await runSearchLoad(term);
      state.requests += 1;
      state.okCount += 1;
      state.latencies.push(Date.now() - t0);
      state.extra.search.queries += 1;
      if (r.total > 0) state.extra.search.hitQueries += 1;
    } catch (err) {
      state.requests += 1;
      state.errorCount += 1;
      state.errors.push(String(err?.message || err));
      state.extra.search.errors += 1;
    }
  }
}

/** Worker: ingest suite — same 50 URLs repeatedly, proving dedup. */
async function workerIngest(state, deadline) {
  let i = 0;
  while (Date.now() < deadline) {
    const url = `https://stress.test/item-${i % 50}`;
    i += 1;
    const t0 = Date.now();
    try {
      const r = await registerSource({ url, addedBy: 'stress-lab' });
      state.requests += 1;
      if (r.ok) {
        state.okCount += 1;
        if (r.duplicate) state.extra.ingest.duplicates += 1;
        else state.extra.ingest.unique += 1;
      } else {
        state.errorCount += 1;
        state.errors.push(String(r.error || 'register failed'));
      }
      state.latencies.push(Date.now() - t0);
    } catch (err) {
      state.requests += 1;
      state.errorCount += 1;
      state.errors.push(String(err?.message || err));
    }
  }
}

/** Worker: virtual30b suite — deep pages near the 30B boundary, O(1). */
async function workerVirtual30b(state, deadline) {
  while (Date.now() < deadline) {
    // Random deep index in the top 0.1% of the address space (~top 30M slots).
    const i = Math.floor(ADDRESS_SPACE - Math.random() * 30000000);
    const t0 = Date.now();
    try {
      const limit = 20;
      const items = [];
      for (let k = 0; k < limit && i + k < ADDRESS_SPACE; k += 1) {
        items.push(generateVirtualItem(i + k, 'animaxia'));
      }
      const took = Date.now() - t0;
      state.requests += 1;
      state.okCount += 1;
      state.latencies.push(took);
      if (i > state.extra.virtual30b.deepestPage) state.extra.virtual30b.deepestPage = i;
      if (took > state.extra.virtual30b.maxPageMs) state.extra.virtual30b.maxPageMs = took;
      // A partial page is VALID at the very end of the 30B address space
      // (i + k >= ADDRESS_SPACE stops generation). Only flag as an error when
      // the page is short while the address space still has room for a full
      // one — that would be a real generator bug.
      if (items.length !== limit && i + limit <= ADDRESS_SPACE) {
        state.errorCount += 1;
        state.errors.push(`virtual page returned ${items.length}/${limit} items at i=${i}`);
      }
    } catch (err) {
      state.requests += 1;
      state.errorCount += 1;
      state.errors.push(String(err?.message || err));
    }
  }
}

/**
 * Run one stress suite in-process. Workers call the real functions directly
 * (no HTTP self-calls), each measuring real latency per execution.
 */
async function runStressSuite({ suite, durationSec, concurrency, q }) {
  const deadline = Date.now() + durationSec * 1000;
  const startedAt = Date.now();
  const memBefore = process.memoryUsage().rss;
  const shedBefore = stabilitySnapshot().shed.count;
  const lagBefore = stabilitySnapshot().eventLoopLag.p95Ms;

  const state = {
    requests: 0,
    okCount: 0,
    errorCount: 0,
    latencies: [],
    errors: [],
    extra: {
      search: { queries: 0, hitQueries: 0, errors: 0 },
      ingest: { unique: 0, duplicates: 0 },
      virtual30b: { deepestPage: 0, maxPageMs: 0 },
    },
  };

  const suites = suite === 'mixed' ? ['search', 'ingest', 'virtual30b'] : [suite];
  const workers = [];
  for (let w = 0; w < concurrency; w += 1) {
    const mySuite = suites[w % suites.length];
    workers.push(
      (async () => {
        if (mySuite === 'search') return workerSearch(state, deadline, q);
        if (mySuite === 'ingest') return workerIngest(state, deadline);
        return workerVirtual30b(state, deadline);
      })(),
    );
  }
  await Promise.all(workers);

  const durationMs = Date.now() - startedAt;
  const sorted = [...state.latencies].sort((a, b) => a - b);
  const snap = stabilitySnapshot();

  const extra = suite === 'mixed' ? state.extra : state.extra[suite];

  return {
    ok: true,
    suite,
    durationMs,
    requests: state.requests,
    okCount: state.okCount,
    errorCount: state.errorCount,
    rps: Number((state.requests / (durationMs / 1000)).toFixed(2)),
    latency: {
      p50Ms: percentileOf(sorted, 0.5),
      p95Ms: percentileOf(sorted, 0.95),
      p99Ms: percentileOf(sorted, 0.99),
      maxMs: sorted.length ? sorted[sorted.length - 1] : 0,
    },
    maxEventLoopLagMs: Number(
      Math.max(snap.eventLoopLag.p95Ms, lagBefore).toFixed(3),
    ),
    memory: {
      beforeRssBytes: memBefore,
      afterRssBytes: process.memoryUsage().rss,
      deltaBytes: process.memoryUsage().rss - memBefore,
    },
    shed: snap.shed.count - shedBefore,
    errors: state.errors.slice(0, 5),
    extra,
  };
}

/* ---------------------------------- router ----------------------------------- */

const router = express.Router();

/* --------------------- FAZA 14: the GLOBAL 30B FEED --------------------- */

/**
 * content.id is SERIAL (int4) — no real row can exist above the int4 max, so
 * the real-overlay PK range scan is clamped to the int4 range (documented
 * assumption; if the column ever becomes bigint only this bound moves).
 */
const INT4_MAX = 2_147_483_647;

/** Cached real-content stats for the global feed (perShard + realCount).
 * 15s TTL in memory — one cheap GROUP BY per window, never per request. */
const globalFeedStats = { at: 0, data: null };
const GLOBAL_FEED_STATS_TTL_MS = 15_000;

async function globalFeedRealStats() {
  if (globalFeedStats.data && Date.now() - globalFeedStats.at < GLOBAL_FEED_STATS_TTL_MS) {
    return globalFeedStats.data;
  }
  const n = shardCount();
  const perShard = Array.from({ length: n }, (_, s) => ({ shardid: s, real: 0 }));
  let realCount = 0;
  try {
    const res = await query('SELECT shardid, COUNT(*)::int AS c FROM content GROUP BY shardid');
    for (const row of res.rows ?? []) {
      const sid = Number(row.shardid);
      const c = Number(row.c ?? 0);
      realCount += c;
      if (sid >= 0 && sid < n) perShard[sid].real = c;
    }
  } catch (err) {
    logger.warn(`[global-feed] real stats unavailable: ${err.message}`);
  }
  const data = { realCount, perShard };
  globalFeedStats.data = data;
  globalFeedStats.at = Date.now();
  return data;
}

/** Map a real content row to the global feed item shape (100% real data —
 *  year/rating/genres/overview read best-effort from the JSONB metadata). */
function realItemOf(row) {
  const meta = parseJsonb(row.metadata, {});
  const id = Number(row.id);
  return {
    id,
    shardid: Number.isInteger(Number(row.shardid)) ? Number(row.shardid) : computeShardIdFromContentId(id),
    virtual: false,
    real: true, // real row from Neon — the opposite of the simulated slots
    title: row.title ?? null,
    type: row.type ?? null,
    year: meta.year ?? null,
    rating: meta.rating ?? null,
    genres: Array.isArray(meta.genres) ? meta.genres : [],
    overview: meta.overview ?? '',
    thumbnail: row.thumbnail ?? null,
    externalid: row.externalid ?? null,
  };
}

/**
 * GET /api/platform/feed/global — THE GLOBAL 30B FEED (FAZA 14 definitive
 * spec): the platform behaves as if it holds logicalAddressSpace() (30B)
 * content items. Paging is a pure keyset WINDOW [i, i+limit) over the logical
 * id space — O(1) at any depth: one indexed PK range scan for the real rows
 * inside the window (clamped to the int4 id range) + O(limit) deterministic
 * virtual generation for the remaining slots. Real Neon rows are REAL
 * (metadata, thumbnails, playable sources — all real); virtual slots are the
 * simulated volume. ?shard=n narrows the window to shard n's 1B-id range.
 */
router.get('/feed/global', wrap(async (req, res) => {
  const startedAt = Date.now();
  const n = shardCount();
  const span = SHARD_SPAN_IDS;
  const addressSpace = logicalAddressSpace(); // 30 × 1B = 30B with the pinned config

  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
  let seed = 'animaxia';

  // Optional shard filter: window clamped into shard n's [n×1B, (n+1)×1B).
  let shard = null;
  if (req.query.shard !== undefined && req.query.shard !== '') {
    const s = parseInt(req.query.shard, 10);
    if (!Number.isInteger(s) || s < 0 || s >= n) {
      return res.status(400).json({ error: `Invalid shard — expected an integer in 0..${n - 1}` });
    }
    shard = s;
  }

  // Keyset cursor {i: startIndex, s: seed} — same encoding as the virtual catalog.
  let index = null;
  if (req.query.cursor) {
    const payload = b64urlDecode(req.query.cursor);
    if (!payload || !Number.isFinite(Number(payload.i))) {
      return res.status(400).json({ error: 'Invalid cursor (expected base64url {"i":<index>,"s":<seed>})' });
    }
    index = Math.floor(Number(payload.i));
    if (typeof payload.s === 'string' && payload.s) seed = payload.s.slice(0, 64);
  }
  if (req.query.seed) seed = String(req.query.seed).slice(0, 64);

  // Window bounds: the shard range when filtered, the whole space otherwise.
  const lo = shard === null ? 0 : shard * span;
  const hi = shard === null ? addressSpace : Math.min((shard + 1) * span, addressSpace);
  if (index === null) index = lo;
  if (index < 0 || index >= hi) {
    return res.status(400).json({ error: `Index out of bounds — the ${shard === null ? 'address space' : `shard ${shard} range`} is [${lo}, ${hi})` });
  }
  const start = Math.max(lo, index);
  const end = Math.min(start + limit, hi);

  // REAL OVERLAY — one indexed PK range scan for the real rows in the window
  // (clamped to the int4 id range; above it no real row can exist).
  const realById = new Map();
  if (start <= INT4_MAX) {
    try {
      const maxReal = Math.min(end - 1, INT4_MAX);
      const res = await query(
        'SELECT id, externalid, type, title, metadata, thumbnail, createdat, shardid FROM content WHERE id >= $1::int AND id <= $2::int ORDER BY id',
        [start, maxReal],
      );
      for (const row of res.rows ?? []) realById.set(Number(row.id), row);
    } catch (err) {
      logger.warn(`[global-feed] real overlay scan failed: ${err.message}`);
    }
  }

  // Merge: real rows at their own ids; deterministic virtual slots elsewhere.
  const items = [];
  let realInPage = 0;
  for (let k = start; k < end; k += 1) {
    const realRow = realById.get(k);
    if (realRow) {
      items.push(realItemOf(realRow));
      realInPage += 1;
    } else {
      const virtual = generateVirtualItem(k, seed);
      items.push({
        id: k,
        shardid: computeShardIdFromContentId(k),
        virtual: true, // simulated logical volume — NOT a stored row
        real: false,
        title: virtual.title,
        type: virtual.type,
        year: virtual.year,
        rating: virtual.rating,
        genres: virtual.genres,
        overview: virtual.overview,
        thumbnail: virtual.thumbnail,
      });
    }
  }

  const nextIndex = end;
  const nextCursor = nextIndex < hi ? b64urlEncode({ i: nextIndex, s: seed }) : null;
  if (items.length > 0) items[items.length - 1].cursor = nextCursor;

  const stats = await globalFeedRealStats();
  // Shard observability: the gateway/ops contract sees the page's home shard.
  res.set('X-Animaxia-Shard', String(computeShardIdFromContentId(start)));

  return res.json({
    ok: true,
    engine: 'animaxia-global-30b',
    addressSpace,
    shardcount: n,
    shardSpan: span,
    shard: shard, // null = whole space
    mode: 'logical', // the 30B volume is logical; real rows are real
    page: Math.floor((start - lo) / limit) + 1,
    totalPages: Math.ceil((hi - lo) / limit),
    items,
    nextCursor,
    stats: {
      addressSpace,
      shardcount: n,
      shardSpan: span,
      realCount: stats.realCount,
      realInPage,
      virtualInPage: items.length - realInPage,
      perShard: stats.perShard,
    },
    tookMs: Date.now() - startedAt,
    simulated: true, // the VOLUME is simulated; real items are flagged real:true
  });
}));



/** GET /api/platform/stability — live resilience + pool + search ops. Public, uncached. */
router.get('/stability', wrap(async (req, res) => {
  res.json({
    ok: true,
    ...stabilitySnapshot(),
    pool: poolStats(),
    search: searchOpsSnapshot(),
  });
}));

/** GET /api/platform/scale/virtual — deterministic 30B virtual catalog. Public. */
router.get('/scale/virtual', wrap(async (req, res) => {
  const startedAt = Date.now();
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
  // Seed precedence: ?seed= query param > cursor payload `s` > 'animaxia'.
  let seed = 'animaxia';

  let index = 0;
  if (req.query.cursor) {
    const payload = b64urlDecode(req.query.cursor);
    if (!payload || !Number.isFinite(Number(payload.i))) {
      return res.status(400).json({ error: 'Invalid cursor (expected base64url {"i":<index>,"s":<seed>})' });
    }
    index = Math.max(0, Math.min(ADDRESS_SPACE - 1, Math.floor(Number(payload.i))));
    if (typeof payload.s === 'string' && payload.s) seed = payload.s.slice(0, 64);
  }
  if (req.query.seed) seed = String(req.query.seed).slice(0, 64);

  if (index >= ADDRESS_SPACE) {
    return res.status(400).json({ error: `Index out of bounds — address space is ${ADDRESS_SPACE}` });
  }

  const items = [];
  for (let k = 0; k < limit && index + k < ADDRESS_SPACE; k += 1) {
    const item = generateVirtualItem(index + k, seed);
    item.cursor = null; // filled below for the last item of the page
    items.push(item);
  }
  const nextIndex = index + items.length;
  const nextCursor = nextIndex < ADDRESS_SPACE ? b64urlEncode({ i: nextIndex, s: seed }) : null;
  if (items.length > 0) items[items.length - 1].cursor = nextCursor;

  return res.json({
    ok: true,
    engine: 'animaxia-virtual-keyset',
    addressSpace: ADDRESS_SPACE,
    page: Math.floor(index / limit) + 1,
    items,
    nextCursor,
    tookMs: Date.now() - startedAt,
    simulated: true,
  });
}));

/** POST /api/platform/stress/run — REAL in-process load test. Public, 2/min per IP. */
router.post('/stress/run', wrap(async (req, res) => {
  const ip = clientIpOf(req);
  if (!stressRateCheck(ip)) {
    res.set('Retry-After', '60');
    return res.status(429).json({ error: 'Prea multe cereri de stress — maxim 2/minut per IP' });
  }

  const body = req.body || {};
  const suite = ['search', 'ingest', 'virtual30b', 'mixed'].includes(body.suite) ? body.suite : null;
  if (!suite) {
    return res.status(400).json({ error: "Invalid suite — expected 'search'|'ingest'|'virtual30b'|'mixed'" });
  }
  const durationSec = Math.min(30, Math.max(1, parseInt(body.durationSec, 10) || 10));
  const concurrency = Math.min(32, Math.max(1, parseInt(body.concurrency, 10) || 16));
  const q = body.q != null ? String(body.q).slice(0, 120) : 'dune';

  if (stressLock) {
    return res.status(409).json({
      error: 'Un test de stres rulează deja',
      last: stressLast ? { suite: stressLast.suite, durationMs: stressLast.durationMs } : null,
    });
  }

  stressLock = true;
  logger.info(`[stress] suite=${suite} duration=${durationSec}s concurrency=${concurrency} q="${q}" ip=${ip}`);
  try {
    const report = await runStressSuite({ suite, durationSec, concurrency, q });
    stressLast = report;
    logger.info(
      `[stress] done: ${report.requests} requests, ${report.rps} rps, p95 ${report.latency.p95Ms}ms, ` +
      `errors ${report.errorCount}, shed ${report.shed}, rssΔ ${(report.memory.deltaBytes / 1024 / 1024).toFixed(1)}MB`,
    );
    return res.json(report);
  } catch (err) {
    logger.error(`[stress] suite failed: ${err.message}`);
    return res.status(500).json({ error: `Stress suite failed: ${err.message}` });
  } finally {
    stressLock = false;
  }
}));

export default router;
