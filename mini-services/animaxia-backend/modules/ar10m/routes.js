/**
 * modules/ar10m/routes.js — the AR10M Express router (Task AR10M-2-BE).
 * Mounted by the orchestrator as `app.use('/api/ar10m', ar10mRouter)` plus
 * `registerThumbRoute(app)` for the absolute GET /thumb/:id.
 *
 * Routes (all JSON, honest errors, no secrets, no CORS — same origin via
 * gateway; every number is MEASURED or marked null/'indisponibil'):
 *   GET  /stats                — real counters only (30s cache; users/legacy
 *                                counts 60s), capacity {designed: 10M,
 *                                tested/benchmarked from the bench state}.
 *   GET  /shards               — shardStatus() + distributionSnapshot()
 *                                (2s timeouts, graceful errors, manual only).
 *   GET  /search?q&year&limit&cursor — the real search (rate 30/min/IP).
 *   GET  /suggest?q            — autocomplete (rate 60/min/IP; 503 in
 *                                economic mode).
 *   GET  /budget               — budgetSnapshot() + search cache/latency
 *                                (30s cache).
 *   POST /thumb/import         — on-demand thumbnail import (rate 10/min/IP).
 *   POST /admin/refresh-metrics— X-Admin-Token; manual refreshShardMetrics().
 *   POST /admin/economic       — X-Admin-Token; setEconomicMode(on).
 *   POST /admin/bench          — X-Admin-Token; rows ∈ {10k,100k,1M} —
 *                                SYNTHETIC inserts into ar10m.bench_catalog
 *                                (synthetic=TRUE, batch 'synthetic-…'), never
 *                                in /stats titles and never in search.
 *   POST /admin/bench/resume   — X-Admin-Token; resume from checkpoint.
 *   GET  /bench/status         — checkpoint + live bench_catalog count.
 *   GET  /healthz              — { ok: true, ar10m: 'real' } — zero DB.
 *
 * ZERO setInterval/cron/background timers: the bench insert runner uses
 * one-shot 250ms pauses only.
 */

import express from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../../utils/logger.js';
import { normalizeTitle, normalizeYear, computeShardId } from './normalize.js';
import {
  shardStatus,
  distributionSnapshot,
  primaryQuery,
  recordPrimaryMetrics,
  getLastWriteAt,
  refreshShardMetrics,
} from './shard-router.js';
import { ar10mSearch, ar10mAutocomplete, searchCacheStats, searchLatency } from './search-gateway.js';
import { budgetSnapshot, setEconomicMode, isEconomicMode, budgetLevel } from './budget.js';
import { importThumbnail, registerThumbRoute } from './thumbs.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const router = express.Router();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', '..', 'data');
const BENCH_STATE_FILE = path.join(DATA_DIR, 'ar10m-bench-state.json');

const CAPACITY_DESIGNED = 10_000_000;
const STATS_MESSAGE = 'Catalog real, distribuit și extensibil gradual până la 10 milioane de titluri.';
const BENCH_BATCH_ROWS = 5_000;
const BENCH_PAUSE_MS = 250;
const BENCH_ALLOWED_ROWS = [10_000, 100_000, 1_000_000];

/* --------------------------------- rate limit --------------------------------- */

const rateBuckets = new Map(); // key → { count, resetAt }

function rateLimit(bucket, max, windowMs = 60_000) {
  return (req, res, next) => {
    const key = `${bucket}:${req.ip || req.socket?.remoteAddress || '?'}`;
    const now = Date.now();
    let b = rateBuckets.get(key);
    if (!b || now >= b.resetAt) {
      b = { count: 0, resetAt: now + windowMs };
      rateBuckets.set(key, b);
    }
    if (rateBuckets.size > 5_000) {
      for (const [k, v] of rateBuckets) if (now >= v.resetAt) rateBuckets.delete(k);
    }
    b.count += 1;
    if (b.count > max) {
      const retryAfterSec = Math.max(1, Math.ceil((b.resetAt - now) / 1000));
      res.set('Retry-After', String(retryAfterSec));
      return res.status(429).json({ ok: false, error: 'rate-limited', retryAfterSec });
    }
    return next();
  };
}

/* ---------------------------------- admin auth --------------------------------- */

function sha256(s) {
  return createHash('sha256').update(String(s), 'utf8').digest();
}

function requireAdmin(req, res) {
  const token = process.env.AR10M_ADMIN_TOKEN;
  if (!token) {
    res.status(503).json({ ok: false, error: 'admin-token-not-configured' });
    return false;
  }
  const given = req.get('x-admin-token') ?? '';
  const ok = given.length > 0 && timingSafeEqual(sha256(given), sha256(token));
  if (!ok) {
    res.status(401).json({ ok: false, error: 'admin-token-invalid' });
    return false;
  }
  return true;
}

/* --------------------------------- tiny caches ---------------------------------- */

const ttlCache = new Map(); // key → { value, at }

function cacheGet(key, ttlMs) {
  const e = ttlCache.get(key);
  if (!e) return null;
  if (Date.now() - e.at > ttlMs) {
    ttlCache.delete(key);
    return null;
  }
  return e.value;
}

function cacheSet(key, value) {
  if (ttlCache.size > 200) ttlCache.clear();
  ttlCache.set(key, { value, at: Date.now() });
}

/* --------------------------------- bench state ---------------------------------- */

function readBenchState() {
  try {
    return JSON.parse(fs.readFileSync(BENCH_STATE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function writeBenchState(state) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(BENCH_STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
  } catch (err) {
    logger.warn(`[ar10m/bench] nu am putut scrie starea: ${err?.message ?? err}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); // one-shot pause

/**
 * Synthetic insert runner (async, fire-and-forget from the admin endpoint):
 * batches of 5000 with 250ms Neon-friendly pauses, checkpoint after every
 * batch, honest phase transitions. ZERO background timers beyond the pauses.
 */
async function runBenchInserts(state) {
  const batchId = state.batchId;
  logger.info(`[ar10m/bench] START batch ${batchId} — target ${state.rowsTarget} synthetic rows`);
  try {
    let done = state.rowsDone || 0;
    while (done < state.rowsTarget) {
      const n = Math.min(BENCH_BATCH_ROWS, state.rowsTarget - done);
      const params = [];
      const values = [];
      for (let i = 0; i < n; i += 1) {
        const idx = done + i;
        const title = `synthetic title ${idx}`;
        const year = 1950 + (idx % 81); // deterministic 1950..2030
        params.push(batchId, normalizeTitle(title), year, computeShardId(title, year));
        const base = i * 4;
        values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`);
      }
      // eslint-disable-next-line no-await-in-loop -- batches are intentionally sequential
      await primaryQuery(
        `INSERT INTO ar10m.bench_catalog (batch_id, normalized_title, year, shard_id) VALUES ${values.join(',')}`,
        params,
        { timeoutMs: 20_000 },
      );
      done += n;
      state.rowsDone = done;
      state.updatedAt = new Date().toISOString();
      writeBenchState(state);
      if (done < state.rowsTarget) await sleep(BENCH_PAUSE_MS);
    }
    state.phase = 'done';
    state.updatedAt = new Date().toISOString();
    writeBenchState(state);
    logger.info(`[ar10m/bench] DONE batch ${batchId} — ${state.rowsDone} synthetic rows in ar10m.bench_catalog`);
  } catch (err) {
    state.phase = 'failed';
    state.error = String(err?.message ?? err).slice(0, 300);
    state.updatedAt = new Date().toISOString();
    writeBenchState(state);
    logger.warn(`[ar10m/bench] FAIL batch ${batchId}: ${state.error}`);
  }
}

/* ------------------------------------ stats ------------------------------------- */

function shardsConfiguredCount() {
  let dedicated = 0;
  for (let s = 2; s <= 15; s += 1) {
    if (process.env[`ANIMAXIA_DB_${String(s).padStart(2, '0')}`]) dedicated += 1;
  }
  const primaryConfigured = !!(process.env.ANIMAXIA_DB_01 || process.env.DATABASEURL);
  return (primaryConfigured ? 1 : 0) + dedicated;
}

async function buildStatsPayload() {
  // Heavy/stable counts get a 60s cache; catalog counters are live (30s cache
  // at response level). All queries on the PRIMARY with a 2s timeout.
  const count = async (sql, key) => {
    const c = cacheGet(key, 60_000);
    if (c !== null) return c;
    try {
      const r = await primaryQuery(sql, [], { timeoutMs: 2_000 });
      const v = Number(r.rows[0]?.n ?? 0);
      cacheSet(key, v);
      return v;
    } catch {
      return null; // honest: ar10m schema may not exist yet / DB unreachable
    }
  };

  let titles = null;
  let sources = null;
  let playableTitles = null;
  let dbSizeBytes = null;
  try {
    const r = await primaryQuery(
      `SELECT (SELECT COUNT(*) FROM ar10m.content)::int AS titles,
              (SELECT COUNT(*) FROM ar10m.content_sources)::int AS sources,
              (SELECT COUNT(*) FROM ar10m.content WHERE source_id IS NOT NULL)::int AS playable,
              pg_database_size(current_database())::bigint AS db_size`,
      [],
      { timeoutMs: 2_000 },
    );
    titles = Number(r.rows[0]?.titles ?? 0);
    sources = Number(r.rows[0]?.sources ?? 0);
    playableTitles = Number(r.rows[0]?.playable ?? 0);
    dbSizeBytes = Number(r.rows[0]?.db_size ?? 0);
    // Piggyback: record the REAL measured size for the budget module.
    recordPrimaryMetrics({ rowCount: titles, spaceBytes: dbSizeBytes });
  } catch {
    // schema not created yet — every value stays null (honest)
  }

  const users = await count('SELECT COUNT(*)::int AS n FROM public.users', 'stats:users');
  const legacyTitles = await count('SELECT COUNT(*)::int AS n FROM public.content', 'stats:legacy');

  const status = shardStatus();
  const physicalOnline = (report) => report.poolActive && report.state !== 'open';
  const shardsOnline =
    (physicalOnline(status.primary) ? 1 : 0) +
    status.slots.filter((s) => s.dedicated && !s.isPrimary && physicalOnline(s)).length;

  const benchState = readBenchState();
  /* Capacitate testată = cel mai mare milestone atins VREODDATĂ (bestAchieved,
  * înregistrat de bench runner / păstrat la cleanup — onest: rândurile sintetice
  * pot fi curățate fără a pierde dovada măsurătorii). */
  const testedRows = benchState?.bestAchieved ?? (benchState?.phase === 'done' ? benchState.rowsDone ?? benchState.rowsTarget : null) ?? null;

  return {
    ok: true,
    real: {
      titles,
      sources,
      users,
      legacyTitles,
      playableTitles,
      shardsConfigured: shardsConfiguredCount(),
      shardsOnline,
      dbSizeBytes,
      lastSyncAt: getLastWriteAt() ? new Date(getLastWriteAt()).toISOString() : null,
      economicMode: isEconomicMode(),
      budgetLevel: budgetLevel(),
    },
    capacity: {
      designed: CAPACITY_DESIGNED,
      tested: testedRows,
      benchmarked: testedRows,
    },
    message: STATS_MESSAGE,
    asOf: new Date().toISOString(),
  };
}

router.get('/stats', wrap(async (req, res) => {
  const cached = cacheGet('stats:response', 30_000);
  if (cached) {
    return res.json({ ...cached, cached: true });
  }
  const payload = await buildStatsPayload();
  cacheSet('stats:response', payload);
  return res.json(payload);
}));

/* ----------------------------------- shards ------------------------------------- */

router.get('/shards', wrap(async (req, res) => {
  const status = shardStatus();
  let distribution = [];
  let distributionError = null;
  try {
    distribution = await distributionSnapshot(); // 2s timeout, 60s cache inside
  } catch (err) {
    distributionError = String(err?.message ?? err).slice(0, 200);
  }
  return res.json({
    ok: distributionError === null,
    shards: [status.primary, ...status.slots],
    distribution,
    ...(distributionError ? { distributionError } : {}),
  });
}));

/* ----------------------------------- search ------------------------------------- */

router.get('/search', rateLimit('ar10m:search', 30), wrap(async (req, res) => {
  const q = req.query.q;
  if (q === undefined || q === null || String(q).trim() === '') {
    return res.status(400).json({ ok: false, error: 'q-required' });
  }
  const year = req.query.year !== undefined && String(req.query.year).trim() !== '' ? normalizeYear(req.query.year) : undefined;
  const result = await ar10mSearch({
    q: String(q),
    year,
    limit: req.query.limit,
    cursor: req.query.cursor ? String(req.query.cursor) : null,
  });
  return res.json(result);
}));

/* ---------------------------------- suggest -------------------------------------- */

router.get('/suggest', rateLimit('ar10m:suggest', 60), wrap(async (req, res) => {
  if (isEconomicMode()) {
    return res.status(503).json({ ok: false, reason: 'economic-mode' });
  }
  const q = String(req.query.q ?? '');
  if (!q.trim()) return res.json({ ok: true, suggestions: [] });
  const limit = Math.min(10, Math.max(1, parseInt(req.query.limit, 10) || 8));
  const out = await ar10mAutocomplete(q, limit);
  if (out.disabled) {
    return res.status(503).json({ ok: false, reason: 'economic-mode' });
  }
  return res.json({ ok: true, suggestions: out.suggestions, cached: out.cached ?? false, elapsedMs: out.elapsedMs ?? null });
}));

/* ----------------------------------- budget -------------------------------------- */

router.get('/budget', wrap(async (req, res) => {
  const cached = cacheGet('budget:response', 30_000);
  if (cached) return res.json(cached);
  const snapshot = budgetSnapshot();
  const payload = {
    ...snapshot,
    search: { cache: searchCacheStats(), latency: searchLatency() },
  };
  cacheSet('budget:response', payload);
  return res.json(payload);
}));

/* -------------------------------- thumb import ------------------------------------ */

router.post('/thumb/import', rateLimit('ar10m:thumb-import', 10), wrap(async (req, res) => {
  const { url, contentId } = req.body ?? {};
  const result = await importThumbnail({ url, contentId });
  return res.status(result.ok ? 200 : 422).json(result);
}));

/* ------------------------------- admin endpoints ----------------------------------- */

router.post('/admin/refresh-metrics', wrap(async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const result = await refreshShardMetrics();
  return res.json({ ok: result.ok, refreshed: result });
}));

router.post('/admin/economic', wrap(async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const on = !!(req.body && (req.body.on === true || req.body.on === 'true' || req.body.on === 1));
  setEconomicMode(on);
  return res.json({ ok: true, economicMode: isEconomicMode(), level: budgetLevel() });
}));

router.post('/admin/bench', wrap(async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const rows = Number(req.body?.rows);
  if (!BENCH_ALLOWED_ROWS.includes(rows)) {
    return res.status(400).json({ ok: false, error: 'rows-invalid', allowed: BENCH_ALLOWED_ROWS });
  }
  const current = readBenchState();
  if (current && current.phase === 'running') {
    return res.status(409).json({ ok: false, error: 'bench-already-running', state: current });
  }
  const state = {
    rowsTarget: rows,
    rowsDone: 0,
    batchId: `synthetic-${Date.now()}`,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    phase: 'running',
    lastRun: current?.lastRun ?? null,
  };
  writeBenchState(state);
  runBenchInserts(state); // async, checkpointed — response returns immediately
  return res.status(202).json({ ok: true, started: true, rows, batchId: state.batchId, note: 'date sintetice, marcate synthetic=TRUE, doar în ar10m.bench_catalog' });
}));

router.post('/admin/bench/resume', wrap(async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const state = readBenchState();
  if (!state || !state.rowsTarget) {
    return res.status(404).json({ ok: false, error: 'no-bench-state' });
  }
  if (state.phase === 'running') {
    return res.status(409).json({ ok: false, error: 'bench-already-running', state });
  }
  if ((state.rowsDone ?? 0) >= state.rowsTarget) {
    return res.json({ ok: true, resumed: false, reason: 'already-complete', state });
  }
  state.phase = 'running';
  state.updatedAt = new Date().toISOString();
  writeBenchState(state);
  runBenchInserts(state);
  return res.status(202).json({ ok: true, resumed: true, batchId: state.batchId, rowsDone: state.rowsDone, rowsTarget: state.rowsTarget });
}));

router.get('/bench/status', wrap(async (req, res) => {
  const state = readBenchState();
  let rowsInDb = null;
  try {
    const r = await primaryQuery('SELECT COUNT(*)::int AS n FROM ar10m.bench_catalog', [], { timeoutMs: 2_000 });
    rowsInDb = Number(r.rows[0]?.n ?? 0);
  } catch {
    rowsInDb = null; // schema may not exist yet — honest
  }
  return res.json({
    ok: true,
    running: state?.phase === 'running',
    state: state ? { ...state, rowsInDb } : null,
    note: 'rândurile din ar10m.bench_catalog sunt sintetice (synthetic=TRUE) — nu apar în /stats și nu sunt căutate',
  });
}));

/* ----------------------------------- healthz -------------------------------------- */

router.get('/healthz', (req, res) => {
  res.json({ ok: true, ar10m: 'real' });
});

export { registerThumbRoute };
export default router;
