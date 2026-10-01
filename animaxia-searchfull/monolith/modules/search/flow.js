/**
 * modules/search/flow.js — FAZA 15 (Task 15-1): Search Flow Control —
 * the admission layer that sits between the HTTP search routes and Neon.
 *
 * WHAT IT IS (pinned spec, worklog "Task ID: 15-0 (FAZA 15)"):
 *   • SEARCH QUEUE — every /api/search/advanced and /api/search/autocomplete
 *     request is ENQUEUED here instead of hitting Neon directly. Only
 *     `maxConcurrent` searches execute at any moment; everything else waits
 *     in the queue (user-visible as a short loader). The queue is:
 *       - SHARD-AWARE: entries carry the shard resolved from the request
 *         (X-Animaxia-Shard header > tenant hash > shard 0, via
 *         resolveShardFromRequest) — attribution + per-shard fairness +
 *         per-shard metrics, in logical AND physical mode alike;
 *       - SAFE: nothing is ever discarded silently. Overflow past queueCap
 *         → explicit 503 { error, code: 'SEARCH_QUEUE_FULL' } (dropped
 *         counter); waiting past maxWaitMs → explicit 504 { error, code:
 *         'SEARCH_QUEUE_TIMEOUT' } (timedOut counter). QA target: both 0.
 *   • SEARCH PRIORITY — three lanes:
 *       high   = admins (req.user.role === 'admin') + ops/QA via the trusted
 *                X-Animaxia-Priority: high header (same trust model as
 *                X-Animaxia-Shard — the edge gateway may set/strip it);
 *       normal = authenticated users (req.user set);
 *       low    = anonymous requests.
 *     Dispatch order is high → normal → low WITHOUT starving the low lane:
 *     aging promotes a queued low entry to normal after lowPromoteMs and a
 *     normal entry to high after normalPromoteMs (defaults 2s / 5s).
 *   • SEARCH WINDOWING — the dispatcher ONLY runs on a timer tick every
 *     `intervalMs` and releases at most `batchSize` queued requests per
 *     window (bounded additionally by maxConcurrent). A burst of 1000
 *     simultaneous requests is therefore served in ~10–20 successive
 *     windows: Neon observes a controlled stream, never a spike.
 *
 * WHAT IT IS NOT: it does NOT touch the FTS queries. The `run` closures
 * handed to searchFlowExecute() are the EXACT FAZA 14 code paths
 * (searchCluster.queryFTS / runAdvancedQuery + ensureSynced, single-flight
 * coalescing and the 8s query budget untouched) — search results stay
 * 100% real and byte-identical; only the admission + scheduling changed.
 * Note: maxConcurrent bounds scheduler-level concurrency; the physical
 * connection ceiling beneath it stays the pg pool (PGPOOLMAX, default 10).
 *
 * PRIORITY within a lane: per-shard fairness — when a window picks the next
 * entry it scans up to FAIRNESS_SCAN entries of the lane and chooses the one
 * whose shard currently has the LEAST in-flight executions (tie → FIFO by
 * sequence number), so one shard's burst cannot monopolise the window at
 * equal priority.
 *
 * CONFIG (env, overridable at runtime by POST /api/search/flow/settings):
 *   SEARCHFLOWENABLED        default true   — false bypasses the queue entirely
 *   SEARCHFLOWMAXCONCURRENT  default 250    — simultaneous executions (200–300)
 *   SEARCHFLOWWINDOWMS       default 80     — window interval ms (50–100)
 *   SEARCHFLOWBATCHSIZE      default 80     — max dispatches per window (50–100)
 *   SEARCHFLOWQUEUECAP       default 10000  — hard queue capacity (overflow → 503)
 *   SEARCHFLOWMAXWAITMS      default 30000  — max queue wait (exceeded → 504)
 *   SEARCHFLOWLOWPROMOTEMS   default 2000   — low → normal aging threshold
 *   SEARCHFLOWNORMALPROMOTEMS default 5000  — normal → high aging threshold
 *
 * OBSERVABILITY (pinned in animaxia-ops/metrics/METRICS.md §8):
 *   animaxia_search_flow_enabled / _queue_length (+ by_priority, by_shard) /
 *   _inflight (+ by_shard) / _window_interval / _window_batch_size /
 *   _dropped_requests / _timedout_requests / _processed_total (+ by_priority) /
 *   _wait_ms_p50 / _wait_ms_p95 / _processing_rate / _queue_high_water /
 *   _queue_capacity / _max_concurrent — via the 'searchflow' pull collector
 *   wired in server.js and rendered by modules/ops/metrics.js.
 *   GET /api/search/flow additionally serves the rolling history (180 × 1s
 *   samples of queueLength/inflight/rate) and the full perShard table.
 *
 * This module is PURE scheduling: it imports nothing from db.js or the
 * search engine — only the sharding model helpers (pure computation).
 */

import { resolveShardFromRequest, shardCount } from '../sharding/model.js';
import { logger } from '../../utils/logger.js';

/* --------------------------------- config ----------------------------------- */

/** Clamp an int with a floor/ceiling; NaN → fallback. */
function clampInt(raw, fallback, min, max) {
  const n = parseInt(raw, 10);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function envConfig() {
  return {
    enabled: String(process.env.SEARCHFLOWENABLED ?? 'true') !== 'false',
    maxConcurrent: clampInt(process.env.SEARCHFLOWMAXCONCURRENT, 250, 1, 2000),
    intervalMs: clampInt(process.env.SEARCHFLOWWINDOWMS, 80, 10, 2000),
    batchSize: clampInt(process.env.SEARCHFLOWBATCHSIZE, 80, 1, 1000),
    queueCap: clampInt(process.env.SEARCHFLOWQUEUECAP, 10000, 100, 500000),
    maxWaitMs: clampInt(process.env.SEARCHFLOWMAXWAITMS, 30000, 1000, 300000),
    lowPromoteMs: clampInt(process.env.SEARCHFLOWLOWPROMOTEMS, 2000, 100, 600000),
    normalPromoteMs: clampInt(process.env.SEARCHFLOWNORMALPROMOTEMS, 5000, 100, 600000),
  };
}

/**
 * FAZA 15 request-budget awareness: the global resilience middleware
 * (modules/platform/resilience.js, FAZA 17-a) answers any request that
 * exceeds REQUESTTIMEOUTMS (default 15000ms) with a 504. A queued search
 * must fail FAST with its own definitive SEARCH_QUEUE_TIMEOUT before that
 * ambiguous collision — so every queue entry carries a deadline of
 * arrival + budget − execution margin. Same env, same default, read
 * independently (pure scheduling stays decoupled from the middleware).
 */
const REQUEST_BUDGET_MS = (() => {
  const n = parseInt(process.env.REQUESTTIMEOUTMS || '15000', 10);
  return Number.isFinite(n) && n > 0 ? n : 15000;
})();
const EXEC_MARGIN_MS = 2500; // reserve for the actual Neon execution

/* FAZA 18 (additive): per-entry long-budget lane. The default deadline
 * (REQUEST_BUDGET_MS − EXEC_MARGIN_MS, before the global resilience 504) is
 * UNTOUCHED for every normal request. Callers that manage their own request
 * lifecycle — the FAZA 18 stress engine's 10,000-simultaneous burst, which
 * drains at the platform's honest execution capacity over tens of seconds —
 * may pass an explicit budgetMs (trusted ops/QA affordance, same model as
 * the X-Animaxia-Priority header). The entry still fails fast with its own
 * honest 504 SEARCH_QUEUE_TIMEOUT if IT exceeds ITS budget. */
function deadlineFor(enqueuedAt, budgetMs) {
  const parsed = Number(budgetMs);
  const budget =
    Number.isFinite(parsed) && parsed >= 2000
      ? parsed
      : REQUEST_BUDGET_MS - EXEC_MARGIN_MS;
  return enqueuedAt + Math.max(budget, 2000);
}

/** Live config — env at boot, adjustable at runtime via the admin endpoint. */
const config = envConfig();

/* --------------------------------- counters --------------------------------- */

const PRIORITIES = ['high', 'normal', 'low'];

const stats = {
  admitted: 0, // requests accepted into the queue (or executed when disabled)
  processed: 0, // executed to completion (success OR query error — Neon saw it)
  errors: 0, // executions whose run() rejected
  dropped: 0, // queueCap overflows → 503 SEARCH_QUEUE_FULL (target 0)
  timedOut: 0, // maxWaitMs exceeded → 504 SEARCH_QUEUE_TIMEOUT (target 0)
  windowsFired: 0, // dispatcher ticks since boot
  windowDispatches: 0, // total entries released by windows (for avgBatchSize)
  queueHighWater: 0, // max queue length observed since boot
  inflightHighWater: 0, // max concurrent executions observed since boot
  lastDroppedAt: null,
  lastTimedOutAt: null,
};

const processedByPriority = { high: 0, normal: 0, low: 0 };
const droppedByPriority = { high: 0, normal: 0, low: 0 };

/* Per-shard attribution (shard id → { queueLength, inflight, processed, dropped }). */
function blankShardStats() {
  return { queueLength: 0, inflight: 0, processed: 0, dropped: 0 };
}
const byShard = new Map();
function shardStats(shardId) {
  let entry = byShard.get(shardId);
  if (!entry) {
    entry = blankShardStats();
    byShard.set(shardId, entry);
  }
  return entry;
}

/* Rolling wait-time samples (ms) for p50/p95 — last 200 completions. */
const waitSamples = [];
const WAIT_WINDOW = 200;
const waitSamplesByPriority = { high: [], normal: [], low: [] };

/* Throughput ring — completion timestamps, pruned to a 10s window. */
const processedAt = [];
const RATE_WINDOW_MS = 10000;

/* Rolling history for the console chart — 1s sampler, last 180 points. */
const HISTORY_LIMIT = 180;
const history = [];

/* ---------------------------------- queue ----------------------------------- */

let seq = 0; // FIFO tie-breaker
const lanes = { high: [], normal: [], low: [] }; // queued entries per priority
let inflight = 0; // currently executing (against Neon)

/** How many queued entries are waiting, across all lanes. */
function queueLength() {
  return lanes.high.length + lanes.normal.length + lanes.low.length;
}

/** FAZA 15 anti-starvation: the effective lane of an entry given its age. */
function effectivePriority(entry, now) {
  const waited = now - entry.enqueuedAt;
  if (entry.priority === 'low' && waited >= config.lowPromoteMs) return 'normal';
  if (waited >= config.normalPromoteMs) return 'high'; // low AND normal both age to high
  return entry.priority;
}

/** Per-shard fairness scan width — how deep into each lane the dispatcher
 *  looks for the least-loaded shard (FIFO beyond this window). */
const FAIRNESS_SCAN = 64;

/**
 * The next entry to dispatch: effective lane order high → normal → low.
 * Entries that have AGED into a higher lane are picked when that lane is
 * served (aging → anti-starvation), with per-shard fairness inside the group
 * (least in-flight shard first, FIFO tie-break). The winner is spliced out
 * of its SOURCE lane.
 */
function pickNext() {
  const now = Date.now();
  let best = null;
  let bestLane = null;
  let bestInflight = Infinity;
  for (const eff of PRIORITIES) {
    best = null;
    bestLane = null;
    bestInflight = Infinity;
    for (const src of PRIORITIES) {
      const lane = lanes[src];
      const scan = Math.min(lane.length, FAIRNESS_SCAN);
      for (let i = 0; i < scan; i += 1) {
        const candidate = lane[i];
        if (effectivePriority(candidate, now) !== eff) continue;
        const candInflight = shardStats(candidate.shardId).inflight;
        if (candInflight < bestInflight) {
          best = candidate;
          bestLane = lane;
          bestInflight = candInflight;
          if (candInflight === 0) break; // cannot do better within this lane
        }
      }
      if (best && bestInflight === 0) break; // cannot do better at this priority
    }
    if (best) {
      const idx = bestLane.indexOf(best);
      if (idx >= 0) bestLane.splice(idx, 1);
      return best;
    }
  }
  return null;
}

/* ------------------------------- dispatcher --------------------------------- */

let windowTimer = null;

/** Start one queued execution (called ONLY from a window tick or a drain). */
function startEntry(entry) {
  inflight += 1;
  if (inflight > stats.inflightHighWater) stats.inflightHighWater = inflight;
  shardStats(entry.shardId).inflight += 1;
  entry.settleQueueSlot(); // the entry left the queue — release its per-shard slot
  stats.windowDispatches += 1;

  const waitedMs = Date.now() - entry.enqueuedAt;
  const settled = () => {
    inflight -= 1;
    shardStats(entry.shardId).inflight = Math.max(0, shardStats(entry.shardId).inflight - 1);
  };
  const completed = (hadError) => {
    stats.processed += 1;
    processedByPriority[entry.priority] += 1;
    shardStats(entry.shardId).processed += 1;
    waitSamples.push(waitedMs);
    if (waitSamples.length > WAIT_WINDOW) waitSamples.shift();
    waitSamplesByPriority[entry.priority].push(waitedMs);
    if (waitSamplesByPriority[entry.priority].length > WAIT_WINDOW) {
      waitSamplesByPriority[entry.priority].shift();
    }
    processedAt.push(Date.now());
    if (hadError) stats.errors += 1;
  };

  // The run() closure is the untouched FAZA 14 execution path.
  Promise.resolve()
    .then(() => entry.run())
    .then(
      (value) => {
        settled();
        completed(false);
        entry.resolve({ result: value, waitedMs });
      },
      (err) => {
        settled();
        completed(true);
        entry.reject(err);
      },
    );
}

/** Reject a queued entry whose request budget expired (definitive 504 —
 *  never a silent drop, never a collision with the resilience middleware). */
function failExpired(entry) {
  entry.settleQueueSlot();
  stats.timedOut += 1;
  droppedByPriority[entry.priority] += 1;
  stats.lastTimedOutAt = new Date().toISOString();
  logger.warn(
    `[search-flow] QUEUE TIMEOUT — ${entry.kind} ${entry.describe} exceeded the request budget (waited > ${Date.now() - entry.enqueuedAt}ms, priority=${entry.priority}, shard=${entry.shardId})`,
  );
  const err = new Error('Search queue timeout — request waited too long in the flow queue');
  err.status = 504;
  err.code = 'SEARCH_QUEUE_TIMEOUT';
  entry.reject(err);
}

/** One windowing tick: release at most `batchSize` queued entries, bounded by
 *  maxConcurrent. This is the ONLY place executions are started (windowing
 *  discipline — Neon never sees off-window arrivals). Entries whose request
 *  budget expired while queued are failed fast instead of dispatched. */
function dispatchWindow() {
  stats.windowsFired += 1;
  let dispatched = 0;
  let budget = config.batchSize;
  const now = Date.now();
  while (budget > 0 && inflight < config.maxConcurrent) {
    const entry = pickNext();
    if (!entry) break;
    if (entry.deadlineAt && now > entry.deadlineAt) {
      failExpired(entry);
      continue; // expiry does not consume window budget
    }
    startEntry(entry);
    dispatched += 1;
    budget -= 1;
  }
  return dispatched;
}

function startWindowTimer() {
  if (windowTimer) return;
  windowTimer = setInterval(() => {
    try {
      dispatchWindow();
    } catch (err) {
      logger.error(`[search-flow] window dispatch failed: ${err?.message ?? err}`);
    }
  }, config.intervalMs);
  if (typeof windowTimer.unref === 'function') windowTimer.unref();
}

function stopWindowTimer() {
  if (windowTimer) {
    clearInterval(windowTimer);
    windowTimer = null;
  }
}

/** Drain every queued entry immediately (used when flow control is disabled
 *  at runtime — admitted requests are never left hanging). */
function drainQueue() {
  let drained = 0;
  let entry = pickNext();
  while (entry) {
    startEntry(entry);
    drained += 1;
    entry = pickNext();
  }
  return drained;
}

/* --------------------------- wait-timeout sweeper ---------------------------- */

/**
 * Queue-wait budget: a sweeper (piggybacked on the 1s history sampler) fails
 * entries that waited past maxWaitMs with an explicit 504 — never a silent
 * drop. The client always receives a definitive answer.
 */
function sweepTimeouts() {
  const now = Date.now();
  const expired = [];
  for (const lane of PRIORITIES) {
    const keep = [];
    for (const entry of lanes[lane]) {
      /* FAZA 18: an entry carrying an EXPLICIT per-entry budget (budgetMs —
       * the stress lane) is governed ONLY by its own deadline; the generic
       * maxWaitMs sweep applies to default-budget entries (their deadlineAt
       * is the REQUESTTIMEOUTMS-derived one, which is already the stricter
       * bound — behavior unchanged for all normal traffic). */
      const expiredByOwnBudget = entry.deadlineAt && now > entry.deadlineAt;
      const expiredByDefaultWait =
        !entry.deadlineAt && now - entry.enqueuedAt > config.maxWaitMs;
      if (expiredByOwnBudget || expiredByDefaultWait) expired.push(entry);
      else keep.push(entry);
    }
    lanes[lane] = keep;
  }
  for (const entry of expired) {
    failExpired(entry);
  }
}

/* ------------------------------ history sampler ------------------------------ */

let historyTimer = null;
function startHistorySampler() {
  if (historyTimer) return;
  historyTimer = setInterval(() => {
    try {
      const now = Date.now();
      while (processedAt.length > 0 && now - processedAt[0] > RATE_WINDOW_MS) processedAt.shift();
      history.push({
        t: new Date(now).toISOString(),
        queueLength: queueLength(),
        inflight,
        rate: Number((processedAt.length / (RATE_WINDOW_MS / 1000)).toFixed(2)),
        dropped: stats.dropped,
      });
      if (history.length > HISTORY_LIMIT) history.shift();
      sweepTimeouts();
    } catch (err) {
      logger.error(`[search-flow] history sampler failed: ${err?.message ?? err}`);
    }
  }, 1000);
  if (typeof historyTimer.unref === 'function') historyTimer.unref();
}

/* --------------------------------- public ------------------------------------ */

/** Resolve the FAZA 15 priority of an incoming search request.
 *  1. X-Animaxia-Priority header (trusted gateway/ops/QA affordance);
 *  2. admin role → high;
 *  3. authenticated → normal;
 *  4. anonymous → low. */
export function resolveSearchPriority(req) {
  const headerRaw = req?.headers?.['x-animaxia-priority'];
  const header = String(Array.isArray(headerRaw) ? headerRaw[0] : headerRaw || '').toLowerCase();
  if (header === 'high' || header === 'normal' || header === 'low') return header;
  if (req?.user?.role === 'admin') return 'high';
  if (req?.user) return 'normal';
  return 'low';
}

/** Resolve the shard a search request is attributed to (queue affinity):
 *  X-Animaxia-Shard header > tenant hash > shard 0 — the pinned search rule. */
export function resolveSearchShard(req) {
  return resolveShardFromRequest({
    header: req?.headers?.['x-animaxia-shard'],
    tenant: req?.user?.tenant && req.user.tenant !== 'global' ? req.user.tenant : null,
  });
}

function percentileFrom(samples, p) {
  if (!samples || samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return Number(sorted[idx].toFixed(1));
}

/**
 * Enqueue one search execution. Resolves with { result, waitedMs } once a
 * window dispatches it — `result` is the 100% real FAZA 14 query outcome.
 *
 * @param {{
 *   priority: 'high'|'normal'|'low',
 *   shardId: number,
 *   kind?: 'advanced'|'autocomplete',
 *   describe?: string,
 *   budgetMs?: number,            — FAZA 18 additive: optional per-entry
 *                                    queue-wait budget (default: the global
 *                                    REQUESTTIMEOUTMS-derived deadline)
 *   run: () => Promise<any>,
 * }} input
 * @returns {Promise<{ result: any, waitedMs: number }>}
 */
export function searchFlowExecute({ priority, shardId, kind = 'advanced', describe = '', budgetMs, run }) {
  if (typeof run !== 'function') {
    return Promise.reject(new Error('searchFlowExecute: run() is required'));
  }
  if (!PRIORITIES.includes(priority)) {
    return Promise.reject(new Error(`searchFlowExecute: invalid priority '${priority}'`));
  }
  const shard = shardStats(shardId);

  // Bypass path: flow control disabled → execute immediately (FAZA 14 behavior).
  if (!config.enabled) {
    return Promise.resolve()
      .then(() => run())
      .then((result) => ({ result, waitedMs: 0 }));
  }

  return new Promise((resolve, reject) => {
    if (queueLength() >= config.queueCap) {
      stats.dropped += 1;
      droppedByPriority[priority] += 1;
      shard.dropped += 1;
      stats.lastDroppedAt = new Date().toISOString();
      logger.warn(
        `[search-flow] QUEUE FULL — dropped ${kind} ${describe} (priority=${priority}, shard=${shardId}, cap=${config.queueCap})`,
      );
      const err = new Error('Search queue is full — try again shortly');
      err.status = 503;
      err.code = 'SEARCH_QUEUE_FULL';
      reject(err);
      return;
    }

    const entry = {
      seq: (seq += 1),
      priority,
      shardId,
      kind,
      describe,
      enqueuedAt: Date.now(),
      deadlineAt: deadlineFor(Date.now(), budgetMs), // request-budget deadline (per-entry override — FAZA 18)
      run,
      resolve,
      reject,
      settleQueueSlot: () => {
        shard.queueLength = Math.max(0, shard.queueLength - 1);
      },
    };
    lanes[priority].push(entry);
    shard.queueLength += 1;
    stats.admitted += 1;
    const qlen = queueLength();
    if (qlen > stats.queueHighWater) stats.queueHighWater = qlen;
    // Every dispatch happens on the next window tick (≤ intervalMs away) —
    // the idle timer keeps ticking, so even an empty queue is served within
    // one window. No off-window execution is ever started by design.
  });
}

/* --------------------------------- snapshots --------------------------------- */

/** Compact flowControl block for /api/search/status (pinned contract). */
export function searchFlowStatusSnapshot() {
  const now = Date.now();
  while (processedAt.length > 0 && now - processedAt[0] > RATE_WINDOW_MS) processedAt.shift();
  return {
    queueEnabled: config.enabled,
    maxConcurrent: config.maxConcurrent,
    queueCap: config.queueCap,
    maxWaitMs: config.maxWaitMs,
    queueLength: queueLength(),
    inflight,
    maxInflightSeen: stats.inflightHighWater,
    queueHighWater: stats.queueHighWater,
    admitted: stats.admitted,
    processed: stats.processed,
    errors: stats.errors,
    dropped: stats.dropped,
    timedOut: stats.timedOut,
    lastDroppedAt: stats.lastDroppedAt,
    lastTimedOutAt: stats.lastTimedOutAt,
    processingRate: Number((processedAt.length / (RATE_WINDOW_MS / 1000)).toFixed(2)),
    waitP50Ms: percentileFrom(waitSamples, 0.5),
    waitP95Ms: percentileFrom(waitSamples, 0.95),
    priorities: {
      high: lanes.high.length,
      normal: lanes.normal.length,
      low: lanes.low.length,
    },
    priorityPolicy: {
      high: 'admin / ops / QA (X-Animaxia-Priority: high)',
      normal: 'authenticated users',
      low: 'anonymous requests',
      aging: `low→normal after ${config.lowPromoteMs}ms, normal→high after ${config.normalPromoteMs}ms (anti-starvation)`,
    },
    processedByPriority: { ...processedByPriority },
    droppedByPriority: { ...droppedByPriority },
    waitP50ByPriority: {
      high: percentileFrom(waitSamplesByPriority.high, 0.5),
      normal: percentileFrom(waitSamplesByPriority.normal, 0.5),
      low: percentileFrom(waitSamplesByPriority.low, 0.5),
    },
  };
}

/** windowing block for /api/search/status (pinned contract). */
export function searchWindowingSnapshot() {
  return {
    intervalMs: config.intervalMs,
    batchSize: config.batchSize,
    windowsFired: stats.windowsFired,
    windowDispatches: stats.windowDispatches,
    avgBatchSize:
      stats.windowsFired > 0 ? Number((stats.windowDispatches / stats.windowsFired).toFixed(2)) : 0,
    maxDispatchPerWindow: config.batchSize,
  };
}

/** Full console snapshot for GET /api/search/flow (history + per-shard). */
export function searchFlowConsoleSnapshot() {
  return {
    flowControl: searchFlowStatusSnapshot(),
    windowing: searchWindowingSnapshot(),
    config: { ...config },
    history: history.slice(),
    perShard: perShardSnapshot(),
  };
}

/** Per-shard attribution table — one row per shard of the 30×1B logical topology. */
function perShardSnapshot() {
  const n = shardCount();
  const perShard = [];
  for (let i = 0; i < n; i += 1) {
    const entry = byShard.get(i) ?? blankShardStats();
    perShard.push({ shardid: i, ...entry });
  }
  return perShard;
}

/**
 * Flat metrics shape for the 'searchflow' pull collector — consumed by
 * modules/ops/metrics.js renderPrometheus (animaxia_search_* series) and
 * available as collectors.searchflow in the ?format=json snapshot.
 */
export function searchFlowMetricsSnapshot() {
  const windowing = searchWindowingSnapshot();
  return {
    ...searchFlowStatusSnapshot(),
    windowIntervalMs: windowing.intervalMs,
    windowBatchSize: windowing.batchSize,
    perShard: perShardSnapshot(),
  };
}

/**
 * Runtime reconfiguration (POST /api/search/flow/settings, admin only).
 * Validates and clamps every knob; the windowing timer restarts on interval
 * change and disabling the flow drains the queue (admitted requests are
 * never left hanging).
 */
export function updateSearchFlowConfig(patch = {}) {
  const before = { ...config };
  if (patch.enabled !== undefined) config.enabled = Boolean(patch.enabled);
  if (patch.maxConcurrent !== undefined) {
    config.maxConcurrent = clampInt(patch.maxConcurrent, config.maxConcurrent, 1, 2000);
  }
  if (patch.intervalMs !== undefined) {
    config.intervalMs = clampInt(patch.intervalMs, config.intervalMs, 10, 2000);
  }
  if (patch.batchSize !== undefined) {
    config.batchSize = clampInt(patch.batchSize, config.batchSize, 1, 1000);
  }
  if (patch.queueCap !== undefined) {
    config.queueCap = clampInt(patch.queueCap, config.queueCap, 100, 500000);
  }
  if (patch.maxWaitMs !== undefined) {
    config.maxWaitMs = clampInt(patch.maxWaitMs, config.maxWaitMs, 1000, 300000);
  }
  if (patch.lowPromoteMs !== undefined) {
    config.lowPromoteMs = clampInt(patch.lowPromoteMs, config.lowPromoteMs, 100, 600000);
  }
  if (patch.normalPromoteMs !== undefined) {
    config.normalPromoteMs = clampInt(patch.normalPromoteMs, config.normalPromoteMs, 100, 600000);
  }

  stopWindowTimer();
  if (config.enabled) {
    startWindowTimer();
  } else {
    const drained = drainQueue();
    if (drained > 0) {
      logger.info(`[search-flow] flow control disabled — drained ${drained} queued requests`);
    }
  }

  logger.info(
    `[search-flow] config updated${config.enabled ? '' : ' (DISABLED)'} — maxConcurrent=${config.maxConcurrent} intervalMs=${config.intervalMs} batchSize=${config.batchSize} (was: maxConcurrent=${before.maxConcurrent} intervalMs=${before.intervalMs} batchSize=${before.batchSize})`,
  );
  return { ...config };
}

/* Boot: the windowing timer and history sampler run from module load (cheap —
 * a tick over an empty queue is a no-op). bun --watch restarts re-import the
 * module and the timers re-arm. */
startWindowTimer();
startHistorySampler();

logger.info(
  `[search-flow] FAZA 15 Search Flow Control ready — queue ${config.enabled ? 'ENABLED' : 'disabled'} · maxConcurrent=${config.maxConcurrent} · window=${config.intervalMs}ms × batch=${config.batchSize} · cap=${config.queueCap} · maxWait=${config.maxWaitMs}ms`,
);
