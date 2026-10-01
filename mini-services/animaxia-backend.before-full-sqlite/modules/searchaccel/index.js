/**
 * modules/searchaccel/ — FAZA 29-P (PLAN 100X): strat ADITIV de accelerare în
 * jurul motorului de căutare PROTEJAT (FAZA 18 pipeline 10 straturi + Neon FTS
 * din search.js). ZERO bytes modificați în componentele protejate — acest
 * modul doar LE CONSUMĂ prin loopback HTTP (request-urile de warming trec
 * prin TOATE cele 10 straturi ale pipeline-ului: anti-spam, rate-limit,
 * queue, cooldown, dedup, batching, cache, executor FTS real).
 *
 * Ce rezolvă (diagnostic FAZA 29-P, măsurat pe Neon-ul real):
 *   • Conexiune pg.Pool RECE către Neon = ~1.3s (TCP+TLS+auth over WAN);
 *     conexiune CALDĂ = ~190ms/query (1 RTT). Executorul FTS real face 2
 *     query-uri secvențiale (COUNT + pagina) ⇒ ~380ms cald vs ~1.4s rece.
 *     p95-ul de 640ms al alertei animaxia-fts-latency-high era amestecul
 *     cald/rece — pool-ul murea de idle (idleTimeoutMillis 30s).
 *   FIX 1 (keepalive-warmer): ping `SELECT 1` la 20s prin stratul db.js
 *     existent ⇒ conexiunile rămân calde ⇒ execuțiile FTS reale rămân la
 *     ~2×RTT ⇒ alerta se stinge ONEST (fără nicio atingere de cod protejat).
 *   FIX 2 (accel LRU): cache 10 min / 500 chei în fața pipeline-ului pentru
 *     interogările repetate — lookup sub-ms la hit (perceived p95 < 5ms).
 *   FIX 3 (warming top interogări): top-6 interogări populare re-executate
 *     prin loopback la 90s (reîmprospătare la jumătate de TTL) — pipeline
 *     layer-9 (45s) + accel (10 min) rămân calde pentru traficul real.
 *   FIX 4 (prefetch la hover): frontend-ul poate anunța interogarea viitoare
 *     (hover pe sugestii autocomplete) — warming în fundal, răspuns 202.
 *
 * Router (mount: app.use('/api/searchaccel', searchAccelRouter)):
 *   GET  /lookup?q=&type=&genre=…  → răspuns IDENTIC /api/search/advanced
 *                                    (+ câmp aditiv `accel: 'hit'|'miss'`);
 *                                    proxy transparent: passthrough status,
 *                                    body, Retry-After, X-Search-Pipeline.
 *   GET  /status                   → stats engine (warmer, cache, popular).
 *   GET  /popular                  → top interogări observate.
 *   POST /prefetch {q, …filters}   → warming în fundal; 202 imediat.
 *
 * Config env (opțional, toate cu default sigur):
 *   SEARCHACCEL_TTL_MS (600000) · SEARCHACCEL_MAX_KEYS (500)
 *   SEARCHACCEL_WARM_TOP (6) · SEARCHACCEL_PREFETCH_PER_MIN (30)
 *   SEARCHACCEL_PIGGYBACK_WARM_MS (300000) — warming piggyback pe trafic real
 *
 * NEON FREE PLAN (optimizare scale-to-zero): fostele timere permanente —
 * keepalive `SELECT 1` la 20s, warming top-interogări la 30s și seed-ul de
 * boot la 20s — au fost ELIMINATE complet: fiecare dintre ele ținea compute-ul
 * Neon treaz non-stop (rădăcina arderii cotei). Înlocuire on-demand:
 *   · ping DB — doar la GET /status?ping=1 (deep-probe explicit)
 *   · warming — piggyback pe traficul real (max o dată la 5 min, doar când
 *     un utilizator real a căutat ceva) + POST /prefetch (warming explicit)
 *   · seed-ul de boot — primul vizitator umple cache-ul natural (miss→loopback)
 */

import express from 'express';
import { query, driverInfo, poolStats } from '../../db.js';
import { clientIpOf } from '../security/security.js';
import { logger } from '../../utils/logger.js';

/* ------------------------------- configuration ------------------------------ */

const TTL_MS = Math.max(60_000, parseInt(process.env.SEARCHACCEL_TTL_MS || '600000', 10) || 600_000);
const MAX_KEYS = Math.max(1, parseInt(process.env.SEARCHACCEL_MAX_KEYS || '500', 10) || 500);
const WARM_TOP = Math.max(1, Math.min(20, parseInt(process.env.SEARCHACCEL_WARM_TOP || '6', 10) || 6));
const PREFETCH_PER_MIN = Math.max(5, parseInt(process.env.SEARCHACCEL_PREFETCH_PER_MIN || '30', 10) || 30);
/* Re-warm când intrarea accel e mai veche de 25s — sub TTL strat-9 pipeline
 * (45s) — astfel re-execuția loopback găsește intrarea PROASPĂTĂ în pipeline
 * ⇒ HIT real strat 9 (fără execuție FTS) ⇒ rata de miss a pipeline-ului scade
 * onest. Separat de TTL_MS (10 min) care ține doar cât timp servim răspunsul. */
const FRESH_WARM_MS = Math.max(15_000, parseInt(process.env.SEARCHACCEL_FRESH_MS || '25000', 10) || 25_000);
/* NEON FREE PLAN: warming piggyback — cel mult o dată la 5 minute și DOAR
 * imediat după o căutare reală a unui utilizator (DB-ul e oricum activ în
 * acel moment, deci zero treziri suplimentare de compute). */
const PIGGYBACK_WARM_MS = Math.max(60_000, parseInt(process.env.SEARCHACCEL_PIGGYBACK_WARM_MS || '300000', 10) || 300_000);
const LOOPBACK_TIMEOUT_MS = 12_000; // > 8s query budget al executorului protejat
const MAX_Q_LEN = 200;

/* Loopback base — același PORT pe care rulează server.js (shim-ul 28-E îl
 * normalizează înainte de încărcarea modulelor). Request-urile de warming
 * pleacă de la 127.0.0.1 și trec prin Express ca orice request public
 * (pipeline complet, rate-limit per client loopback). */
const SELF_PORT = parseInt(process.env.PORT || '4000', 10);
const SELF_BASE = `http://127.0.0.1:${SELF_PORT}`;

/* Parametrii validați de handler-ul protejat /api/search/advanced — doar
 * aceștia se transmit mai departe (whitelist strict, zero invenții). */
const FORWARD_PARAMS = [
  'q', 'type', 'genre', 'actor', 'studio', 'category',
  'year', 'minRating', 'sort', 'fuzzy', 'limit', 'page',
];

/* ---------------------------------- stats ----------------------------------- */

const stats = {
  bootAt: Date.now(),
  cache: { hits: 0, misses: 0, evictions: 0, errors: 0 },
  warmer: { pings: 0, pingErrors: 0, lastPingMs: null, lastPingAt: null, avgPingMs: null, rttWindow: [] },
  warm: { runs: 0, warmed: 0, errors: 0, lastRunAt: null },
  prefetch: { accepted: 0, rejected: 0, alreadyWarm: 0 },
  loopback: { fetches: 0, errors: 0 },
};

/* ------------------------------ accel LRU cache ------------------------------ */

const cache = new Map(); // sig → { body, storedAt } · Map = insertion order = LRU

function cacheGet(sig) {
  const entry = cache.get(sig);
  if (!entry) return null;
  if (Date.now() - entry.storedAt > TTL_MS) {
    cache.delete(sig);
    return null;
  }
  cache.delete(sig);
  cache.set(sig, entry); // refresh recency (LRU)
  return entry;
}

function cacheSet(sig, body) {
  if (cache.has(sig)) cache.delete(sig);
  else if (cache.size >= MAX_KEYS) {
    const oldest = cache.keys().next().value; // least-recently used
    if (oldest !== undefined) {
      cache.delete(oldest);
      stats.cache.evictions += 1;
    }
  }
  cache.set(sig, { body, storedAt: Date.now() });
}

/* ----------------------------- popular queries ------------------------------ */

const popular = new Map(); // sig → { q, params, count, lastAt }
const POPULAR_MAX = 1000;

function trackPopular(sig, q, params) {
  const entry = popular.get(sig);
  const now = Date.now();
  if (entry) {
    entry.count += 1;
    entry.lastAt = now;
  } else {
    if (popular.size >= POPULAR_MAX) {
      // evict the least popular / oldest
      let worstKey = null;
      let worst = null;
      for (const [key, value] of popular) {
        if (!worst || value.count < worst.count || (value.count === worst.count && value.lastAt < worst.lastAt)) {
          worstKey = key;
          worst = value;
        }
      }
      if (worstKey !== null) popular.delete(worstKey);
    }
    popular.set(sig, { q, params, count: 1, lastAt: now });
  }
}

/* --------------------------- signature (cheie canonică) --------------------------- */

/** Semnătura oglindește stratul 8 (signature) al pipeline-ului protejat:
 * q normalizat + params canonici. Normalizarea q este identică celei din
 * pipeline (lowercase/trim/collapse whitespace). */
function signatureOf(params) {
  const normQ = String(params.q ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
  const canonical = {};
  for (const key of FORWARD_PARAMS) {
    if (key === 'q') continue;
    const value = params[key];
    if (value !== undefined && value !== null && value !== '') canonical[key] = String(value);
  }
  return JSON.stringify({ q: normQ, p: canonical });
}

/* ------------------------------ loopback client ------------------------------ */

const inflight = new Map(); // sig → Promise (single-flight per semnătură)

async function loopbackAdvanced(params) {
  const url = new URL(`${SELF_BASE}/api/search/advanced`);
  for (const key of FORWARD_PARAMS) {
    const value = params[key];
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  stats.loopback.fetches += 1;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(LOOPBACK_TIMEOUT_MS),
    headers: { 'user-agent': 'animaxia-searchaccel/1.0 (warming; consumes protected pipeline via loopback)' },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`loopback ${res.status}`);
    err.status = res.status;
    err.body = body;
    err.headers = {};
    const retryAfter = res.headers.get('retry-after');
    if (retryAfter) err.headers['Retry-After'] = retryAfter;
    const pipelineSource = res.headers.get('x-search-pipeline');
    if (pipelineSource) err.headers['X-Search-Pipeline'] = pipelineSource;
    throw err;
  }
  return { body, pipeline: res.headers.get('x-search-pipeline') ?? null };
}

/** Execută (sau re-utilizează) o căutare prin pipeline-ul protejat, cu cache.
 * La hit, `took` devine wall-clock-ul accel (perceived latency real), originalul
 * pipeline-ului se păstrează în `originTook` — badge-ul din UI arată mereu adevărul. */
async function acceleratedSearch(params, { background = false, refresh = false } = {}) {
  const t0 = Date.now();
  const sig = signatureOf(params);
  if (!refresh) {
    const cached = cacheGet(sig);
    if (cached) {
      stats.cache.hits += 1;
      return { ...cached.body, took: Date.now() - t0, originTook: cached.body.took, accel: 'hit' };
    }
  }
  stats.cache.misses += 1;

  let promise = inflight.get(sig);
  if (!promise) {
    promise = loopbackAdvanced(params)
      .then(({ body }) => {
        cacheSet(sig, body);
        return body;
      })
      .finally(() => inflight.delete(sig));
    inflight.set(sig, promise);
  }
  const body = await promise;
  /* NEON FREE PLAN: după o căutare REALĂ (nu background), eventual reîncălzim
   * topul popular — piggyback pe traficul existent, throttled la 5 min. */
  if (!background) piggybackWarmAfterRealTraffic();
  return { ...body, accel: background ? 'warmed' : 'miss' };
}

/* ------------- keepalive + warming — NEON FREE PLAN: on-demand ------------- */

/** Deep-probe explicit (GET /status?ping=1) — MĂSOARĂ RTT-ul real al pool-ului
 * doar la cerere. Fostul timer de 20s (SELECT 1 permanent) ținea Neon treaz
 * non-stop; acum pool-ul e verificat natural de fiecare interogare reală. */
function pingPool() {
  const info = driverInfo();
  if (!info.connected) return Promise.resolve(false); // local fallback — nimic de ping-uit
  const t0 = Date.now();
  return query('SELECT 1')
    .then(() => {
      const ms = Date.now() - t0;
      stats.warmer.pings += 1;
      stats.warmer.lastPingMs = ms;
      stats.warmer.lastPingAt = Date.now();
      const w = stats.warmer.rttWindow;
      w.push(ms);
      if (w.length > 50) w.shift();
      stats.warmer.avgPingMs = Math.round(w.reduce((a, b) => a + b, 0) / w.length);
      return true;
    })
    .catch((err) => {
      stats.warmer.pingErrors += 1;
      logger.warn(`[searchaccel] on-demand ping failed: ${err.message}`);
      return false;
    });
}

/* Warming top interogări — rulat on-demand (piggyback pe trafic real sau
 * POST /prefetch), nu pe timer. FRESH_WARM_MS rămâne sub TTL strat-9 (45s)
 * al pipeline-ului ⇒ re-execuția loopback găsește intrarea PROASPĂTĂ ⇒ HIT
 * real strat 9, fără execuții FTS suplimentare. */

async function warmPopular() {
  const candidates = [...popular.entries()]
    .filter(([, value]) => value.count >= 2)
    .sort((a, b) => b[1].count - a[1].count || b[1].lastAt - a[1].lastAt)
    .slice(0, WARM_TOP);
  if (candidates.length === 0) return;
  stats.warm.runs += 1;
  stats.warm.lastRunAt = Date.now();
  for (const [sig, value] of candidates) {
    const entry = cache.get(sig);
    const age = entry ? Date.now() - entry.storedAt : Infinity;
    if (age < FRESH_WARM_MS) continue; // proaspăt — nu-l batem cu 2×RTT degeaba
    try {
      /* refresh: true ⇒ BYPASS cache accel ⇒ loopback real prin pipeline; dacă
       * intrarea strat-9 e încă proaspătă (< 45s) pipeline-ul servește HIT fără
       * execuție FTS — exact încălzirea programată din plan (stratul 9 doar
       * alimentat, motorul neatins). */
      await acceleratedSearch({ q: value.q, ...value.params }, { background: true, refresh: true });
      stats.warm.warmed += 1;
    } catch {
      stats.warm.errors += 1; // 429/503 legitime de la pipeline trec liniștite
    }
  }
}

/* Piggyback: după o căutare REALĂ a unui utilizator (nu background), dacă au
 * trecut ≥ PIGGYBACK_WARM_MS de la ultimul warming, reîmprospătăm topul —
 * compute-ul Neon e activ oricum din cauza căutării, cost marginal zero. */
let lastPiggybackWarmAt = 0;
function piggybackWarmAfterRealTraffic() {
  if (Date.now() - lastPiggybackWarmAt < PIGGYBACK_WARM_MS) return;
  lastPiggybackWarmAt = Date.now();
  warmPopular().catch(() => {});
}

/* ------------------------- prefetch rate-limit (per IP) ------------------------- */

const prefetchBuckets = new Map(); // ip → { count, windowStart }

function prefetchAllowed(ip) {
  const now = Date.now();
  let bucket = prefetchBuckets.get(ip);
  if (!bucket || now - bucket.windowStart >= 60_000) {
    bucket = { count: 0, windowStart: now };
    prefetchBuckets.set(ip, bucket);
  }
  bucket.count += 1;
  if (bucket.count > PREFETCH_PER_MIN) return false;
  if (prefetchBuckets.size > 5000) prefetchBuckets.clear(); // igienă
  return true;
}

const bucketSweeper = setInterval(() => {
  const now = Date.now();
  for (const [ip, bucket] of prefetchBuckets) {
    if (now - bucket.windowStart >= 120_000) prefetchBuckets.delete(ip);
  }
}, 60_000);
if (typeof bucketSweeper.unref === 'function') bucketSweeper.unref();

/* ---------------------------------- router ---------------------------------- */

const router = express.Router();

/** GET /lookup — proxy accelerat pentru /api/search/advanced.
 * Răspuns identic (+ `accel: 'hit'|'miss'`); erorile pipeline-ului (429 cu
 * Retry-After, 503 queue-full, 504 timeout) trec transparent. */
router.get('/lookup', (req, res) => {
  const params = {};
  for (const key of FORWARD_PARAMS) {
    const raw = req.query[key];
    if (raw !== undefined && raw !== null && raw !== '') params[key] = String(raw);
  }
  if (typeof params.q === 'string' && params.q.length > MAX_Q_LEN) params.q = params.q.slice(0, MAX_Q_LEN);
  const sig = signatureOf(params);
  trackPopular(sig, params.q ?? '', params);

  acceleratedSearch(params)
    .then((body) => {
      res.set('X-Search-Accel', body.accel);
      res.json(body);
    })
    .catch((err) => {
      stats.cache.errors += 1;
      if (err && err.name === 'TimeoutError') {
        return res.status(504).json({ error: 'accel lookup timeout', detail: 'protected executor budget exceeded' });
      }
      if (err && Number.isInteger(err.status)) {
        for (const [key, value] of Object.entries(err.headers ?? {})) res.set(key, value);
        return res.status(err.status).json(err.body ?? { error: 'accel upstream error' });
      }
      logger.warn(`[searchaccel] lookup failed: ${err?.message ?? err}`);
      return res.status(502).json({ error: 'accel lookup failed', detail: String(err?.message ?? err) });
    });
});

/** GET /status — stats engine (public: consumat de status-view / admin / observability).
 * NEON FREE PLAN: `?ping=1` = deep-probe explicit al pool-ului (măsoară RTT
 * real la cerere — fostul keepalive permanent la 20s a fost eliminat pentru
 * scale-to-zero Neon). */
router.get('/status', (req, res) => {
  const hitTotal = stats.cache.hits + stats.cache.misses;
  const info = driverInfo();
  let pool = null;
  try {
    pool = poolStats?.() ?? null;
  } catch {
    pool = null;
  }
  if (req.query.ping === '1') {
    void pingPool(); // deep-probe on-demand — rezultatul apare la următorul /status
  }
  res.json({
    ok: true,
    service: 'searchaccel',
    version: '1.1.0',
    phase: 'FAZA 29-P (PLAN 100X) · NEON FREE PLAN',
    uptimeSec: Math.round((Date.now() - stats.bootAt) / 1000),
    config: { ttlMs: TTL_MS, maxKeys: MAX_KEYS, warmTop: WARM_TOP, piggybackWarmMs: PIGGYBACK_WARM_MS },
    keepalive: {
      mode: 'on-demand',
      purpose: 'fostul keepalive permanent (SELECT 1 la 20s) a fost eliminat — ținea Neon treaz non-stop; acum ping doar la ?ping=1',
      pings: stats.warmer.pings,
      errors: stats.warmer.pingErrors,
      lastPingMs: stats.warmer.lastPingMs,
      lastPingAt: stats.warmer.lastPingAt,
      avgPingMs: stats.warmer.avgPingMs,
    },
    cache: {
      keys: cache.size,
      inflight: inflight.size,
      hits: stats.cache.hits,
      misses: stats.cache.misses,
      hitRate: hitTotal === 0 ? 0 : Number((stats.cache.hits / hitTotal).toFixed(4)),
      evictions: stats.cache.evictions,
      errors: stats.cache.errors,
    },
    warming: { runs: stats.warm.runs, warmed: stats.warm.warmed, errors: stats.warm.errors, lastRunAt: stats.warm.lastRunAt },
    prefetch: { accepted: stats.prefetch.accepted, rejected: stats.prefetch.rejected, alreadyWarm: stats.prefetch.alreadyWarm },
    popular: { tracked: popular.size },
    db: { driver: info.driver, connected: info.connected },
    pool,
  });
});

/** GET /popular — top interogări observate (sugestii / trending). */
router.get('/popular', (req, res) => {
  const limit = Math.min(25, Math.max(1, parseInt(req.query.limit, 10) || 10));
  const top = [...popular.entries()]
    .sort((a, b) => b[1].count - a[1].count || b[1].lastAt - a[1].lastAt)
    .slice(0, limit)
    .map(([, value]) => ({
      q: value.q || '(bibliotecă)',
      count: value.count,
      lastAt: value.lastAt,
      hasFilters: Object.keys(value.params).some((k) => k !== 'q' && k !== 'page' && k !== 'limit'),
    }));
  res.json({ top });
});

/** POST /prefetch — { q, ...filters } ⇒ warming în fundal, 202 imediat.
 * Folosit la hover pe sugestii (predicție FAZA 29-P). */
router.post('/prefetch', (req, res) => {
  const ip = clientIpOf(req);
  if (!prefetchAllowed(ip)) {
    stats.prefetch.rejected += 1;
    return res.status(429).json({ error: 'prefetch rate-limit', retryAfterSec: 60 });
  }
  const body = req.body ?? {};
  const params = {};
  for (const key of FORWARD_PARAMS) {
    const value = body[key];
    if (value !== undefined && value !== null && value !== '') params[key] = String(value);
  }
  if (typeof params.q === 'string' && params.q.length > MAX_Q_LEN) params.q = params.q.slice(0, MAX_Q_LEN);
  const hasSurface =
    (params.q !== undefined && params.q !== '') || Object.keys(params).some((k) => k !== 'page' && k !== 'limit');
  if (!hasSurface) {
    return res.status(400).json({ error: 'nothing to prefetch — provide q or filters' });
  }
  const sig = signatureOf(params);
  trackPopular(sig, params.q ?? '', params);
  const cached = cacheGet(sig);
  if (cached) {
    stats.prefetch.alreadyWarm += 1;
    return res.json({ ok: true, cached: true });
  }
  stats.prefetch.accepted += 1;
  acceleratedSearch(params, { background: true }).catch(() => {});
  return res.status(202).json({ ok: true, warming: true });
});

export default router;
