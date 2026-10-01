/**
 * modules/searchux/ — FAZA 33 (PLAN 100X · WS3): STRAT DE EXPERIENȚĂ peste
 * motorul de căutare PROTEJAT (FAZA 18 pipeline 10 straturi + Neon FTS din
 * search.js + stratul de accelerare FAZA 29-P searchaccel). ZERO bytes
 * modificați în componentele protejate — acest modul doar LE CONSUMĂ prin
 * loopback HTTP (autocomplete trece prin pipeline la prioritatea 3, lookup-urile
 * de fațete trec prin accel care la rândul lui trece prin TOATE cele 10 straturi).
 *
 * Ce aduce (KPI WS3: timp până la primul rezultat vizibil < 300ms):
 *   • /suggest — autocomplete instant: cache LRU 60s per prefix (NOTĂ ONESTĂ:
 *     planul menționa Redis, dar redis-global :4030 este un shim RESP2 PING-only
 *     protejat ⇒ folosim cache in-process cu aceleași semantici — TTL 60s/cheie,
 *     single-flight, LRU 2000 chei) + single-flight + trending + „ați vrut…?"
 *     (Levenshtein pe stratul de sugestie, NU în motor — motorul rămâne neatins).
 *   • /trending — interogări populare ANONIMIZATE (doar textul normalizat +
 *     contor; zero IP, zero identitate) — fuziune: propriul pool + /api/searchaccel/
 *     popular (loopback, stratul 29-P doar consumat).
 *   • /facets — fațete dinamice per căutare (tip / gen / an / notă / sursă),
 *     calculate prin loopback /api/searchaccel/lookup (limit 48, sort score) și
 *     agregate aici; cache 60s per semnătură de filtre.
 *   • /track — eveniment de căutare anonimizat (text normalizat + numărul de
 *     rezultate) — alimentează trending-ul; nu stochează nimic identificabil.
 *   • /status — stats onest (cache hit-rate, trending, did-you-mean) pentru
 *     status-view / smoke-uri / observabilitate.
 *
 * Router (mount: app.use('/api/searchux', searchUxRouter) — namespace NOU,
 * zero conflict cu rutele protejate):
 *   GET  /suggest?q=&limit=      → sugestii instant + didYouMean
 *   GET  /trending?limit=        → top interogări anonimize
 *   GET  /facets?q=&type=&genre=&year=&minRating= → fațete per căutare
 *   POST /track {q, results}     → 202, înregistrare anonimizată
 *   GET  /status                 → stats engine
 *
 * Config env (opțional, default sigur):
 *   SEARCHUX_TTL_MS (60000) · SEARCHUX_MAX_KEYS (2000)
 *   SEARCHUX_TREND_MAX (500) · SEARCHUX_RATE_PER_MIN (120)
 *   SEARCHUX_FACET_SAMPLE (48) · SEARCHUX_FACET_MAX_KEYS (300)
 */

import express from 'express';
import { query as dbQuery, driverInfo } from '../../db.js';
import { clientIpOf } from '../security/security.js';
import { logger } from '../../utils/logger.js';

/* ------------------------------- configuration ------------------------------ */

const TTL_MS = Math.max(10_000, parseInt(process.env.SEARCHUX_TTL_MS || '60000', 10) || 60_000);
const MAX_KEYS = Math.max(1, parseInt(process.env.SEARCHUX_MAX_KEYS || '2000', 10) || 2000);
const TREND_MAX = Math.max(10, parseInt(process.env.SEARCHUX_TREND_MAX || '500', 10) || 500);
const RATE_PER_MIN = Math.max(30, parseInt(process.env.SEARCHUX_RATE_PER_MIN || '120', 10) || 120);
const FACET_SAMPLE = Math.min(100, Math.max(12, parseInt(process.env.SEARCHUX_FACET_SAMPLE || '48', 10) || 48));
const FACET_MAX_KEYS = Math.max(1, parseInt(process.env.SEARCHUX_FACET_MAX_KEYS || '300', 10) || 300);

const LOOPBACK_TIMEOUT_MS = 12_000; // > bugetul executorului protejat (8s)
const MAX_Q_LEN = 200;
const SELF_PORT = parseInt(process.env.PORT || '4000', 10);
const SELF_BASE = `http://127.0.0.1:${SELF_PORT}`;

/* Parametri pe care /api/searchaccel/lookup (29-P) îi acceptă — whitelist
 * strict, zero invenții; fațetele se calculează pe EXACT aceeași formă de
 * interogare pe care o vede motorul protejat. */
const FACET_PARAMS = ['q', 'type', 'genre', 'year', 'minRating', 'category', 'actor', 'studio'];

/* ---------------------------------- stats ----------------------------------- */

const stats = {
  bootAt: Date.now(),
  suggest: { requests: 0, cacheHits: 0, cacheMisses: 0, inflightHits: 0, errors: 0, didYouMean: 0, tookWindow: [] },
  trending: { requests: 0, merged: 0 },
  facets: { requests: 0, cacheHits: 0, errors: 0 },
  track: { accepted: 0, rejected: 0 },
};

function pushTook(win, ms) {
  win.push(ms);
  if (win.length > 50) win.shift();
}

/* ------------------------------ generic LRU cache --------------------------- */

function makeLru(limit) {
  return {
    map: new Map(), // key → { value, storedAt } · Map = insertion order = LRU
    get(key) {
      const entry = this.map.get(key);
      if (!entry) return null;
      if (Date.now() - entry.storedAt > TTL_MS) {
        this.map.delete(key);
        return null;
      }
      this.map.delete(key);
      this.map.set(key, entry); // refresh recency
      return entry.value;
    },
    set(key, value) {
      if (this.map.has(key)) this.map.delete(key);
      else if (this.map.size >= limit) {
        const oldest = this.map.keys().next().value;
        if (oldest !== undefined) this.map.delete(oldest);
      }
      this.map.set(key, { value, storedAt: Date.now() });
    },
    size() {
      return this.map.size;
    },
  };
}

const suggestCache = makeLru(MAX_KEYS);
const facetCache = makeLru(FACET_MAX_KEYS);

/* ---------------------------- single-flight helper -------------------------- */

const inflight = new Map(); // key → Promise

async function singleFlight(key, producer) {
  const existing = inflight.get(key);
  if (existing) return existing;
  const promise = producer().finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

/* ------------------------- anonymous trending pool -------------------------- */
/* ANONIM: cheia este doar textul interogării normalizat (lowercase/trim/
 * collapse whitespace). Fără IP, fără user-agent, fără identitate — exact
 * „trending din istoric anonimizat" din planul WS3. */

const trendPool = new Map(); // normQ → { q, count, lastAt }

function normalizeQ(q) {
  return String(q ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .slice(0, MAX_Q_LEN);
}

function trackQuery(q) {
  const norm = normalizeQ(q);
  if (norm.length < 2) return;
  const entry = trendPool.get(norm);
  const now = Date.now();
  if (entry) {
    entry.count += 1;
    entry.lastAt = now;
  } else {
    if (trendPool.size >= TREND_MAX) {
      // evict cel mai puțin popular / cel mai vechi
      let worstKey = null;
      let worst = null;
      for (const [key, value] of trendPool) {
        if (!worst || value.count < worst.count || (value.count === worst.count && value.lastAt < worst.lastAt)) {
          worstKey = key;
          worst = value;
        }
      }
      if (worstKey !== null) trendPool.delete(worstKey);
    }
    trendPool.set(norm, { q: norm, count: 1, lastAt: now });
  }
}

function ownTrending(limit) {
  return [...trendPool.values()]
    .sort((a, b) => b.count - a.count || b.lastAt - a.lastAt)
    .slice(0, limit)
    .map((e) => ({ q: e.q, count: e.count, lastAt: e.lastAt }));
}

/* ---------------------- Levenshtein (strat de sugestie) --------------------- */
/* Fuzzy DOAR aici, pe stratul UX — motorul FTS protejat rămâne neatins
 * (are deja similarity trigram proprie; acest strat prinde greșelile de
 * tastare când autocomplete-ul nu produce nicio sugestie). */

function levenshtein(a, b) {
  if (a === b) return 0;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 3) return Infinity; // skip rapid — pragul e 2-3
  let prev = new Array(lb + 1);
  let curr = new Array(lb + 1);
  for (let j = 0; j <= lb; j += 1) prev[j] = j;
  for (let i = 1; i <= la; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= lb; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[lb];
}

/** „Ați vrut…?" — candidate din pool-ul trending la distanță Levenshtein mică. */
function didYouMean(q) {
  const norm = normalizeQ(q);
  if (norm.length < 3) return [];
  const maxDist = norm.length >= 8 ? 3 : 2;
  const candidates = [];
  for (const [key, value] of trendPool) {
    if (key === norm) continue; // auto-potrivirea nu e „ați vrut…?"
    if (Math.abs(key.length - norm.length) > maxDist) continue;
    const distance = levenshtein(norm, key);
    if (distance > 0 && distance <= maxDist) candidates.push({ q: value.q, count: value.count, distance });
  }
  candidates.sort((a, b) => a.distance - b.distance || b.count - a.count);
  return candidates.slice(0, 3).map(({ q: suggestion, distance, count }) => ({ q: suggestion, distance, count }));
}

/* ------------------------------ loopback client ----------------------------- */

async function loopbackJson(pathAndQuery) {
  const res = await fetch(`${SELF_BASE}${pathAndQuery}`, {
    signal: AbortSignal.timeout(LOOPBACK_TIMEOUT_MS),
    headers: { 'user-agent': 'animaxia-searchux/1.0 (FAZA 33; consumes protected search via loopback)' },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`loopback ${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

/* --------------------------- rate limit (per IP) ---------------------------- */

const buckets = new Map(); // ip → { count, windowStart }

function rateAllowed(ip) {
  const now = Date.now();
  let bucket = buckets.get(ip);
  if (!bucket || now - bucket.windowStart >= 60_000) {
    bucket = { count: 0, windowStart: now };
    buckets.set(ip, bucket);
  }
  bucket.count += 1;
  if (bucket.count > RATE_PER_MIN) return false;
  if (buckets.size > 5000) buckets.clear();
  return true;
}

const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [ip, bucket] of buckets) {
    if (now - bucket.windowStart >= 120_000) buckets.delete(ip);
  }
}, 60_000);
if (typeof sweeper.unref === 'function') sweeper.unref();

/* ---------------- in-module curator reaper (ops aditiv FAZA 33) ---------------- */
/* Mitigarea operațională a degradării cunoscute FAZA-32-B: curatorScan() din
 * hub.js (PROTEJAT FAZA 16) face cross-join trigram O(n²) pe 18.925 rânduri
 * (25–90s+), apelat de synthetics FAZA 23 (protejate, la 60s) și stability
 * FAZA 24 prin /api/ai/hub/status; resilience timeout-ul (30s) abandonează
 * clientul DAR query-ul continuă pe Neon și saturează CPU-ul — blochează
 * boot-uri (ALTER TABLE) și motorul de căutare protejat.
 *
 * Acest reaper rulează ÎN procesul backend (supraviețuiește, pornit la import
 * — înainte de main()) și termină SESIUNILE DB (zero cod protejat atins) cu
 * cross-join similarity mai vechi de REAP_AFTER_SEC. Fix-ul definitiv (1 linie
 * în hub.js, operator % indexabil) rămâne la poarta de aprobare ⚠️ PLAN-100X.
 *
 * NEON FREE PLAN (scale-to-zero): fostul timer la 10s interoga pg_stat_activity
 * NON-STOP (24/7), ținând compute-ul Neon permanent treaz chiar și cu zero
 * utilizatori — unul din rădăcinile arderii cotei pe vechea bază. Acum reaper-ul
 * este EVENIMENT-DRIVEN: rulează ONE-SHOT, doar după ce o cerere reală a putut
 * lăsa un cross-join orfan (middleware „curator-watch” în server.js apelează
 * scheduleCuratorReap() pentru /api/ai/hub/status și /api/ai/hub/curator/scan).
 * Zero trafic DB de fundal când nimeni nu folosește curator-ul. */
const REAP_AFTER_SEC = Math.max(20, parseInt(process.env.SEARCHUX_REAP_AFTER_SEC || '25', 10) || 25);
const reaperStats = { runs: 0, reaped: 0, errors: 0, lastRunAt: null, scheduled: false, lastScheduledAt: null };

async function reapOrphanCuratorScans() {
  reaperStats.runs += 1;
  reaperStats.lastRunAt = Date.now();
  const info = driverInfo();
  if (info.driver === 'sqlite') return;
  if (!info.connected) return; // fallback local — nimic de reaped
  try {
    const result = await dbQuery(
      `SELECT pid, pg_terminate_backend(pid) AS terminated
       FROM pg_stat_activity
       WHERE datname IS NOT NULL AND pid <> pg_backend_pid()
         AND state = 'active'
         AND query LIKE '%similarity(a.title, b.title)%'
         AND CURRENT_TIMESTAMP - query_start > $1::interval`,
      [`${REAP_AFTER_SEC} seconds`],
    );
    for (const row of result.rows) {
      if (row.terminated) {
        reaperStats.reaped += 1;
        logger.info(
          `[searchux] curator-reaper: terminated orphan similarity cross-join PID ${row.pid} (> ${REAP_AFTER_SEC}s, abandonată client-side — continua să satureze Neon)`,
        );
      }
    }
  } catch (err) {
    reaperStats.errors += 1;
    logger.warn(`[searchux] curator-reaper probe failed (non-fatal): ${err.message}`);
  }
}

/** One-shot reap programat DE LA CERERE (event-driven): după ce un apel real
 * de curator a putut lansa cross-join-ul similarity, așteptăm REAP_AFTER_SEC +
 * 10s (garantat după pragul de abandon) și terminăm sesiunile orfane.
 * Coalesced: maxim UN sweep pending, indiferent câte cereri sosesc. */
export function scheduleCuratorReap() {
  if (reaperStats.scheduled) return; // deja programat — coalescing
  reaperStats.scheduled = true;
  reaperStats.lastScheduledAt = Date.now();
  const delayMs = (REAP_AFTER_SEC + 10) * 1000;
  const t = setTimeout(() => {
    reaperStats.scheduled = false;
    reapOrphanCuratorScans().catch(() => {});
  }, delayMs);
  if (typeof t.unref === 'function') t.unref();
}

// NEON FREE PLAN: primul sweep la import RĂMÂNE (protejează boot-ul după un
// crash cu cross-join orfan) — dar e UNA singură, nu timer permanent.
reapOrphanCuratorScans();

/* ------------------------------- suggestions -------------------------------- */

async function produceSuggestions(q, limit) {
  const url = new URL('/api/search/autocomplete', SELF_BASE);
  url.searchParams.set('q', q);
  const body = await loopbackJson(url.pathname + url.search); // PROTEJAT FAZA 18 — doar consumat
  const suggestions = Array.isArray(body.suggestions) ? body.suggestions.slice(0, limit) : [];
  return { suggestions };
}

/* ---------------------------------- router ---------------------------------- */

const router = express.Router();

/** GET /suggest — autocomplete instant (cache 60s per prefix + single-flight
 * + trending + did-you-mean). Debouncing-ul de 150ms rămâne în frontend. */
router.get('/suggest', (req, res) => {
  const ip = clientIpOf(req);
  if (!rateAllowed(ip)) {
    return res.status(429).json({ error: 'searchux rate-limit', retryAfterSec: 60 });
  }
  const t0 = Date.now();
  const raw = String(req.query.q ?? '').trim();
  const limit = Math.min(12, Math.max(1, parseInt(req.query.limit, 10) || 8));
  if (raw.length < 1 || raw.length > MAX_Q_LEN) {
    return res.status(400).json({ error: 'q trebuie să aibă între 1 și 200 de caractere' });
  }
  stats.suggest.requests += 1;

  const norm = normalizeQ(raw);
  const key = `${norm}#${limit}`;

  trackQuery(raw); // trending anonimizat

  const cached = suggestCache.get(key);
  if (cached) {
    stats.suggest.cacheHits += 1;
    const took = Date.now() - t0;
    pushTook(stats.suggest.tookWindow, took);
    return res.json({ ...cached, took, cache: 'hit', engine: 'animaxia-searchux' });
  }
  stats.suggest.cacheMisses += 1;

  singleFlight(key, () => produceSuggestions(raw, limit))
    .then((produced) => {
      suggestCache.set(key, produced);
      // „Ați vrut…?" doar când motorul nu are nicio potrivire — strat UX, nu motor
      const dym = produced.suggestions.length === 0 ? didYouMean(raw) : [];
      if (dym.length > 0) stats.suggest.didYouMean += 1;
      const took = Date.now() - t0;
      pushTook(stats.suggest.tookWindow, took);
      res.json({ ...produced, didYouMean: dym, took, cache: 'miss', engine: 'animaxia-searchux' });
    })
    .catch((err) => {
      stats.suggest.errors += 1;
      if (err && err.name === 'TimeoutError') {
        return res.status(504).json({ error: 'searchux suggest timeout' });
      }
      if (err && Number.isInteger(err.status)) {
        // 429/503/504 legitime de la pipeline-ul protejat trec transparent
        return res.status(err.status).json(err.body ?? { error: 'searchux upstream error' });
      }
      logger.warn(`[searchux] suggest failed: ${err?.message ?? err}`);
      return res.status(502).json({ error: 'searchux suggest failed', detail: String(err?.message ?? err) });
    });
});

/** GET /trending — top interogări anonimize (propriul pool + searchaccel
 * popular, consumat prin loopback — FAZA 29-P doar citită). */
router.get('/trending', (req, res) => {
  const limit = Math.min(25, Math.max(1, parseInt(req.query.limit, 10) || 10));
  stats.trending.requests += 1;

  const mine = ownTrending(limit * 2);
  loopbackJson(`/api/searchaccel/popular?limit=${limit * 2}`)
    .then((accel) => {
      const merged = new Map(); // normQ → { q, count, lastAt, source }
      for (const item of mine) merged.set(item.q, { ...item, source: 'searchux' });
      const theirs = Array.isArray(accel?.top) ? accel.top : [];
      for (const item of theirs) {
        const norm = normalizeQ(item.q === '(bibliotecă)' ? '' : item.q);
        if (!norm) continue;
        const existing = merged.get(norm);
        if (existing) {
          existing.count += item.count;
          existing.source = 'searchux+accel';
        } else {
          merged.set(norm, { q: norm, count: item.count, lastAt: item.lastAt ?? Date.now(), source: 'accel' });
        }
      }
      const top = [...merged.values()]
        .sort((a, b) => b.count - a.count || b.lastAt - a.lastAt)
        .slice(0, limit)
        .map(({ q, count, lastAt, source }) => ({ q, count, lastAt, source }));
      stats.trending.merged = top.length;
      res.json({ top, pool: trendPool.size, anonymized: true });
    })
    .catch(() => {
      // accel indisponibil (restart etc.) — propriul pool rămâne onest
      const top = mine.slice(0, limit).map(({ q, count, lastAt }) => ({ q, count, lastAt, source: 'searchux' }));
      res.json({ top, pool: trendPool.size, anonymized: true });
    });
});

/** GET /facets — fațete dinamice per căutare: tip / gen / an / notă / sursă.
 * Calculate prin loopback /api/searchaccel/lookup (limit 48, sort score) —
 * accel-ul (29-P) trece prin pipeline-ul protejat complet; rezultatul e
 * agregat AICI, motorul neatins. Cache 60s per semnătură. */
router.get('/facets', (req, res) => {
  const t0 = Date.now();
  const filters = {};
  for (const key of FACET_PARAMS) {
    const value = req.query[key];
    if (value !== undefined && value !== null && value !== '') filters[key] = String(value).slice(0, MAX_Q_LEN);
  }
  stats.facets.requests += 1;

  const key = JSON.stringify(filters);
  const cached = facetCache.get(key);
  if (cached) {
    stats.facets.cacheHits += 1;
    return res.json({ ...cached, took: Date.now() - t0, cache: 'hit' });
  }

  const url = new URL('/api/searchaccel/lookup', SELF_BASE);
  url.searchParams.set('sort', 'score');
  url.searchParams.set('limit', String(FACET_SAMPLE));
  url.searchParams.set('page', '1');
  for (const [k, v] of Object.entries(filters)) url.searchParams.set(k, v);

  loopbackJson(url.pathname + url.search)
    .then((body) => {
      const items = Array.isArray(body?.data) ? body.data : [];
      const types = new Map();
      const genres = new Map();
      const years = new Map();
      const ratings = new Map();
      const sources = new Map();
      for (const item of items) {
        if (item?.type) types.set(item.type, (types.get(item.type) ?? 0) + 1);
        const meta = item?.metadata ?? {};
        for (const genre of Array.isArray(meta.genres) ? meta.genres.slice(0, 4) : []) {
          genres.set(genre, (genres.get(genre) ?? 0) + 1);
        }
        if (meta.year) years.set(String(meta.year), (years.get(String(meta.year)) ?? 0) + 1);
        if (typeof meta.rating === 'number' && meta.rating > 0) {
          const bucket = meta.rating >= 8 ? '8+' : meta.rating >= 7 ? '7-8' : meta.rating >= 6 ? '6-7' : '<6';
          ratings.set(bucket, (ratings.get(bucket) ?? 0) + 1);
        }
        if (meta.source) sources.set(meta.source, (sources.get(meta.source) ?? 0) + 1);
      }
      const sortCount = (m) =>
        [...m.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count);
      const facets = {
        types: sortCount(types),
        genres: sortCount(genres).slice(0, 12),
        years: sortCount(years).slice(0, 12),
        ratings: sortCount(ratings),
        sources: sortCount(sources).slice(0, 8),
      };
      const payload = {
        facets,
        sampled: items.length,
        total: typeof body?.total === 'number' ? body.total : items.length,
        engine: body?.engine ?? 'animaxia-neon-fts',
      };
      facetCache.set(key, payload);
      res.json({ ...payload, took: Date.now() - t0, cache: 'miss' });
    })
    .catch((err) => {
      stats.facets.errors += 1;
      if (err && Number.isInteger(err.status)) {
        return res.status(err.status).json(err.body ?? { error: 'searchux facets upstream error' });
      }
      logger.warn(`[searchux] facets failed: ${err?.message ?? err}`);
      return res.status(502).json({ error: 'searchux facets failed', detail: String(err?.message ?? err) });
    });
});

/** POST /track — eveniment de căutare anonimizat: { q, results }.
 * Stochează DOAR textul normalizat + contorul (fără IP / identitate). */
router.post('/track', (req, res) => {
  const body = req.body ?? {};
  const q = String(body.q ?? '').trim();
  if (!q || q.length > MAX_Q_LEN) {
    stats.track.rejected += 1;
    return res.status(400).json({ error: 'q invalid' });
  }
  trackQuery(q);
  stats.track.accepted += 1;
  return res.status(202).json({ ok: true, anonymized: true });
});

/** GET /status — stats onest pentru status-view / smoke / observabilitate. */
router.get('/status', (req, res) => {
  const tookWin = stats.suggest.tookWindow;
  const p = (pct) => {
    if (tookWin.length === 0) return null;
    const sorted = [...tookWin].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor((pct / 100) * sorted.length))];
  };
  res.json({
    ok: true,
    service: 'searchux',
    version: '1.0.0',
    phase: 'FAZA 33 (PLAN 100X · WS3)',
    uptimeSec: Math.round((Date.now() - stats.bootAt) / 1000),
    config: {
      ttlMs: TTL_MS,
      maxKeys: MAX_KEYS,
      trendMax: TREND_MAX,
      ratePerMin: RATE_PER_MIN,
      facetSample: FACET_SAMPLE,
      cacheBackend: 'in-process LRU (redis-global :4030 este shim PING-only protejat — documentat onest)',
    },
    suggest: {
      requests: stats.suggest.requests,
      cacheHits: stats.suggest.cacheHits,
      cacheMisses: stats.suggest.cacheMisses,
      inflightHits: stats.suggest.inflightHits,
      errors: stats.suggest.errors,
      didYouMean: stats.suggest.didYouMean,
      p50Ms: p(50),
      p95Ms: p(95),
      hitRate:
        stats.suggest.cacheHits + stats.suggest.cacheMisses === 0
          ? 0
          : Number((stats.suggest.cacheHits / (stats.suggest.cacheHits + stats.suggest.cacheMisses)).toFixed(4)),
    },
    trending: { requests: stats.trending.requests, pool: trendPool.size, merged: stats.trending.merged, anonymized: true },
    facets: {
      requests: stats.facets.requests,
      cacheHits: stats.facets.cacheHits,
      errors: stats.facets.errors,
      cachedKeys: facetCache.size(),
    },
    track: { accepted: stats.track.accepted, rejected: stats.track.rejected },
    reaper: {
      purpose: 'mitigare aditivă degradare curatorScan FAZA-32-B (query-uri orfane abandonate client-side care saturează Neon)',
      mode: 'event-driven one-shot (NEON FREE PLAN — fost timer 10s permanent eliminat)',
      reapAfterSec: REAP_AFTER_SEC,
      trigger: 'scheduleCuratorReap() din middleware curator-watch (server.js) la /api/ai/hub/status și /api/ai/hub/curator/scan',
      ...reaperStats,
    },
    caches: { suggestKeys: suggestCache.size(), facetKeys: facetCache.size(), inflight: inflight.size },
  });
});

export default router;
