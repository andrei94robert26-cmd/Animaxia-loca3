/**
 * modules/platform/stress.js — FAZA 17-a → AR10M: stability snapshot + REAL
 * stress laboratory (mounted at /api/platform in server.js).
 *
 * AR10M: fostul catalog virtual 30B simulat (/api/platform/scale/virtual),
 * feed-ul global 30B (/api/platform/feed/global) și suita de stres
 * „virtual30b" au fost ELIMINATE complet (fost 30B simulat — eliminat).
 * Capacitatea reală se declară onest în /api/ar10m/stats (proiectată 10M /
 * testată / demonstrată prin benchmark). Aici rămân DOAR suite-urile REALE,
 * in-proces, pe nodul live.
 *
 * Routes (all additive, no collision with existing mounts — /api/platform was
 * free before FAZA 17):
 *   GET  /api/platform/stability   → { ok, ...stabilitySnapshot(), pool,
 *                                      search: { coalesced, errors, offsetCapped } }
 *                                     (public, uncached — real-time numbers)
 *   POST /api/platform/stress/run  → REAL in-process load test (no HTTP
 *                                  self-calls): suites search | ingest |
 *                                  mixed (= search + ingest); global lock
 *                                  (409), caps 1..30s × 1..32 workers,
 *                                  2/min per IP.
 *
 * The workers call the REAL engine functions directly (Neon FTS search load,
 * ingest dedup registry) and measure real per-execution latency — nothing is
 * generated or simulated.
 */

import express from 'express';
import { stabilitySnapshot } from './resilience.js';
import { poolStats } from '../../db.js';
import { searchOpsSnapshot, runSearchLoad } from '../search/search.js';
import { registerSource } from '../ingest/dedup.js';
import { clientIpOf } from '../security/security.js';
import { logger } from '../../utils/logger.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

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
    },
  };

  // 'mixed' = the real suites together (AR10M: fost „mixed" cu virtual30b —
  // eliminat; acum search + ingest, ambele reale).
  const suites = suite === 'mixed' ? ['search', 'ingest'] : [suite];
  const workers = [];
  for (let w = 0; w < concurrency; w += 1) {
    const mySuite = suites[w % suites.length];
    workers.push(
      (async () => {
        if (mySuite === 'search') return workerSearch(state, deadline, q);
        return workerIngest(state, deadline);
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

/** GET /api/platform/stability — live resilience + pool + search ops. Public, uncached. */
router.get('/stability', wrap(async (req, res) => {
  res.json({
    ok: true,
    ...stabilitySnapshot(),
    pool: poolStats(),
    search: searchOpsSnapshot(),
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
  const suite = ['search', 'ingest', 'mixed'].includes(body.suite) ? body.suite : null;
  if (!suite) {
    return res.status(400).json({ error: "Invalid suite — expected 'search'|'ingest'|'mixed'" });
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
