/**
 * modules/platform/resilience.js — FAZA 17-a: backend resilience core.
 *
 * Real, in-process protection layers mounted in server.js BEFORE the routes:
 *   • event-loop lag monitor — 500ms sampling interval (unref'd), setTimeout
 *     drift measurement, rotating window of 200 samples, p50/p95 percentiles;
 *   • memory monitor — live rss/heap/external + configurable rss ceiling
 *     (RSSLIMITMB env, default 512MB on 64-bit);
 *   • in-flight request gauge — incremented by the middleware below;
 *   • resilienceMiddleware — per-request timeout (REQUESTTIMEOUTMS, default
 *     15000ms → 504 { error: 'Request timeout' }) + load shedding (GET-only,
 *     non-critical routes rejected with 503 + Retry-After when event-loop
 *     p95 > 300ms or rss > 90% of the limit; mutating POSTs are only shed
 *     when lag > 800ms to avoid data loss);
 *   • memory watchdog — 30s interval (unref'd): rss > 85% limit → HTTP cache
 *     purge (cache.clearPrefix('http:')) + warn log + memoryPurges counter;
 *   • stabilitySnapshot() — aggregated health used by /api/platform/stability,
 *     /api/health and the scale report.
 *
 * No new npm dependencies — plain Node/Bun APIs only.
 */

import { cache } from '../../cache.js';
import { logger } from '../../utils/logger.js';

/* --------------------------------- constants -------------------------------- */

const LAG_SAMPLE_INTERVAL_MS = 500; // event-loop sampling cadence
const LAG_WINDOW = 200; // rotating sample window
const WATCHDOG_INTERVAL_MS = 30000; // memory watchdog cadence
const DEFAULT_RSS_LIMIT_MB = 512; // 64-bit default ceiling

const REQUEST_TIMEOUT_MS = parseInt(process.env.REQUESTTIMEOUTMS || '15000', 10);
const SHED_LAG_P95_MS = 300; // GET load-shedding threshold (event-loop p95)
const SHED_LAG_EXTREME_MS = 800; // even mutating requests get shed above this
const SHED_RSS_RATIO = 0.9; // GET load-shedding threshold (rss / limit)
const WATCHDOG_RSS_RATIO = 0.85; // memory watchdog purge threshold

/** Critical paths that are NEVER load-shed (health + stability + metrics). */
const SHED_ALLOWLIST = new Set([
  '/api/health',
  '/api/platform/stability',
  '/api/metrics',
  // AR10M: fostul '/api/platform/scale/virtual' (catalog virtual 30B simulat,
  // generation-only) a fost eliminat odată cu simularea.
]);

/** RSS ceiling in bytes: RSSLIMITMB env override, else 512MB default. */
function resolveRssLimitBytes() {
  const envMb = parseInt(process.env.RSSLIMITMB || '', 10);
  if (Number.isFinite(envMb) && envMb > 0) return envMb * 1024 * 1024;
  // process.resourcesUsage is not available in Node <12.6/Bun — env or default.
  return DEFAULT_RSS_LIMIT_MB * 1024 * 1024;
}

export const RSS_LIMIT_BYTES = resolveRssLimitBytes();

/* ------------------------------ event-loop lag ------------------------------- */

const lagSamples = []; // rotating window of measured lag (ms)

function recordLagSample(ms) {
  lagSamples.push(ms);
  if (lagSamples.length > LAG_WINDOW) lagSamples.shift();
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return Number(sorted[idx].toFixed(3));
}

/** Measure one lag sample: how late a 0ms-setTimeout actually fires. */
function sampleOnce() {
  const start = process.hrtime.bigint();
  setTimeout(() => {
    const driftNs = Number(process.hrtime.bigint() - start);
    recordLagSample(driftNs / 1e6);
  }, 0).unref?.();
}

const lagTimer = setInterval(() => {
  const start = process.hrtime.bigint();
  setTimeout(() => {
    const driftMs = Number(process.hrtime.bigint() - start) / 1e6 - LAG_SAMPLE_INTERVAL_MS;
    recordLagSample(Math.max(0, driftMs));
  }, LAG_SAMPLE_INTERVAL_MS).unref?.();
}, LAG_SAMPLE_INTERVAL_MS);
if (typeof lagTimer.unref === 'function') lagTimer.unref();
// Prime the window with an immediate sample so p50/p95 are non-zero-capable ASAP.
sampleOnce();

/** Event-loop lag snapshot: { currentMs, p50Ms, p95Ms } (rolling window). */
export function eventLoopLagSnapshot() {
  const sorted = [...lagSamples].sort((a, b) => a - b);
  return {
    currentMs: sorted.length ? Number(lagSamples[lagSamples.length - 1].toFixed(3)) : 0,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
  };
}

/* ---------------------------------- memory ---------------------------------- */

/** Memory snapshot: live rss/heap/external + the configured rss ceiling. */
export function memorySnapshot() {
  const m = process.memoryUsage();
  return {
    rssBytes: m.rss,
    heapUsedBytes: m.heapUsed,
    heapTotalBytes: m.heapTotal,
    externalBytes: m.external,
    rssLimitBytes: RSS_LIMIT_BYTES,
  };
}

/* ------------------------------ in-flight gauge ------------------------------ */

const inFlightGauge = {
  current: 0,
  max: 0,
  inc() {
    this.current += 1;
    if (this.current > this.max) this.max = this.current;
  },
  dec() {
    this.current = Math.max(0, this.current - 1);
  },
  snapshot() {
    return { current: this.current, max: this.max };
  },
};

/* --------------------------------- counters --------------------------------- */

let requestTimeouts = 0;
let memoryPurges = 0;
const shed = { count: 0, lastShedAt: null, reason: null };

/* -------------------------------- middleware -------------------------------- */

/**
 * Express middleware: per-request timeout + load shedding + in-flight gauge.
 * Mounted in server.js AFTER metrics, BEFORE every route.
 */
export function resilienceMiddleware(req, res, next) {
  inFlightGauge.inc();

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    requestTimeouts += 1;
    if (!res.headersSent) {
      res.status(504).json({ error: 'Request timeout' });
    } else {
      res.end();
    }
  }, Number.isFinite(REQUEST_TIMEOUT_MS) && REQUEST_TIMEOUT_MS > 0 ? REQUEST_TIMEOUT_MS : 15000);
  if (typeof timer.unref === 'function') timer.unref();

  const cleanup = () => {
    clearTimeout(timer);
    inFlightGauge.dec();
  };
  res.on('finish', cleanup);
  res.on('close', cleanup);

  // ---- load shedding (post-gauge so shed requests also appear as in-flight) ----
  const path = String(req.originalUrl || req.url || '').split('?')[0];
  const isSubtitleVtt =
    path.startsWith("/api/player/subtitles/opensubtitles/") &&
    path.endsWith(".vtt");

  const isSubtitleListing =
    path.startsWith("/api/player/subtitles/content/") &&
    path.endsWith("/subtitles");

  if (!SHED_ALLOWLIST.has(path) && !isSubtitleVtt && !isSubtitleListing) {
    const lag = eventLoopLagSnapshot();
    const mem = memorySnapshot();
    const rssRatio = mem.rssBytes / mem.rssLimitBytes;
    const isGet = req.method === 'GET' || req.method === 'HEAD';

    let reason = null;
    if (isGet && (lag.p95Ms > SHED_LAG_P95_MS || rssRatio > SHED_RSS_RATIO)) {
      reason =
        lag.p95Ms > SHED_LAG_P95_MS && rssRatio > SHED_RSS_RATIO
          ? `event-loop p95 ${lag.p95Ms}ms > ${SHED_LAG_P95_MS}ms + rss ${(rssRatio * 100).toFixed(1)}% > ${(SHED_RSS_RATIO * 100).toFixed(0)}%`
          : lag.p95Ms > SHED_LAG_P95_MS
            ? `event-loop p95 ${lag.p95Ms}ms > ${SHED_LAG_P95_MS}ms`
            : `rss ${(rssRatio * 100).toFixed(1)}% > ${(SHED_RSS_RATIO * 100).toFixed(0)}% of limit`;
    } else if (!isGet && lag.p95Ms > SHED_LAG_EXTREME_MS) {
      // Mutating requests are only shed at extreme lag (data-loss avoidance).
      reason = `event-loop p95 ${lag.p95Ms}ms > ${SHED_LAG_EXTREME_MS}ms (extreme)`;
    }

    if (reason) {
      shed.count += 1;
      shed.lastShedAt = new Date().toISOString();
      shed.reason = reason;
      logger.warn(`[resilience] shed ${req.method} ${path} — ${reason}`);
      res.set('Retry-After', '5');
      return res.status(503).json({
        error: 'Server under pressure — try again shortly',
        shed: true,
        reason,
      });
    }
  }

  // The route handler may still complete after a timeout — guard the send path
  // so a late handler cannot overwrite the 504 (Express would throw instead).
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    if (timedOut && res.statusCode === 200) return res; // already answered 504
    return originalJson(body);
  };

  return next();
}

/* ------------------------------ memory watchdog ------------------------------ */

const watchdogTimer = setInterval(() => {
  const mem = memorySnapshot();
  if (mem.rssBytes > mem.rssLimitBytes * WATCHDOG_RSS_RATIO) {
    memoryPurges += 1;
    const before = cache.stats().keys;
    try {
      cache.clearPrefix('http:');
    } catch (err) {
      logger.warn(`[resilience] watchdog cache purge failed: ${err.message}`);
    }
    logger.warn(
      `[resilience] watchdog: rss ${(mem.rssBytes / 1024 / 1024).toFixed(1)}MB > ${(WATCHDOG_RSS_RATIO * 100).toFixed(0)}% of ` +
        `${(mem.rssLimitBytes / 1024 / 1024).toFixed(0)}MB limit — purged ${before} http cache keys (memoryPurges=${memoryPurges})`,
    );
  }
}, WATCHDOG_INTERVAL_MS);
if (typeof watchdogTimer.unref === 'function') watchdogTimer.unref();

/* ------------------------------ stability snapshot ---------------------------- */

function activeHandlesCount() {
  try {
    if (typeof process._getActiveHandles === 'function') {
      return process._getActiveHandles().length;
    }
  } catch {
    /* not available in this runtime (Bun) — report null, gracefully */
  }
  return null;
}

/** Aggregated resilience snapshot — consumed by stability, health and scale. */
export function stabilitySnapshot() {
  const gauge = inFlightGauge.snapshot();
  return {
    uptimeSec: Math.floor(process.uptime()),
    eventLoopLag: eventLoopLagSnapshot(),
    memory: memorySnapshot(),
    activeHandles: activeHandlesCount(),
    inFlight: gauge.current,
    inFlightMax: gauge.max,
    shed: { count: shed.count, lastShedAt: shed.lastShedAt, reason: shed.reason },
    timeouts: requestTimeouts,
    memoryPurges,
    config: {
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      rssLimitBytes: RSS_LIMIT_BYTES,
      shedThresholds: {
        lagP95Ms: SHED_LAG_P95_MS,
        lagExtremeMs: SHED_LAG_EXTREME_MS,
        rssRatio: SHED_RSS_RATIO,
      },
    },
  };
}
