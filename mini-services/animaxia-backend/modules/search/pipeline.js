/**
 * modules/search/pipeline.js — FAZA 18: 10-layer search orchestration pipeline.
 *
 * A request submitted through pipeline.execute() passes, in order, through:
 *
 *   1. anti-spam   — query abuse detection (>256 chars, control chars
 *                    \x00-\x1F, >30 identical repeats/min per client, >8
 *                    identical repeated words) → 429 {error:'anti-spam', layer:1}
 *   2. rate-limit  — search-specific token bucket per client (capacity 30,
 *                    refill 0.5/s — SEPARATE from the global 120/min limiter)
 *                    → 429 {error:'rate-limit', layer:2} + Retry-After
 *   3. cooldown    — same client + same normalized query within 10s → served
 *                    instantly from the layer-9 cache (servedFromCooldown);
 *                    if not cached yet it passes deprioritized (UX never blocked)
 *   4. queue       — bounded admission: maxConcurrency executions + 500
 *                    waiting → 503 {error:'queue-full', layer:4} + Retry-After
 *                    (honest admission control — every request gets an answer)
 *   5. priority    — priority queue: autocomplete=3 > user search=2 >
 *                    admin/batch=1 > stress=0; FIFO within a tier
 *   6. windowing   — sliding 1s window, max SEARCHPIPELINEMAXRATE (default 50)
 *                    executions/s — bursts are smoothed, never silently dropped
 *   7. dedup       — single-flight: concurrent requests with the same signature
 *                    (normalized query + filters + sort + page + kind) share ONE
 *                    promise (mechanism moved from search.js FAZA 17-a)
 *   8. batching    — micro-batches formed in a ~15ms window execute in
 *                    priority-ordered sequential rounds of max 4; the indexing
 *                    SYNC_CHUNK (25) is exposed as indexSyncBatch for observability
 *   9. cache       — LRU (500 keys, 45s TTL) keyed by the full signature;
 *                    invalidated on the 'content:changed' platform event
 *  10. neon-fts    — the REAL executor closures from search.js (runAdvancedQuery
 *                    / autocomplete SQL — untouched); rolling p50/p95 over the
 *                    last 50 executions (same LATENCY_WINDOW model)
 *
 * The pipeline contains ZERO search semantics: every layer only orchestrates
 * around the executor passed by search.js, so /advanced and /autocomplete
 * responses keep their exact JSON shape and content.
 *
 * Env: SEARCHPIPELINEMAXCONCURRENCY (default 8), SEARCHPIPELINEMAXQUEUELENGTH
 * (default 500), SEARCHPIPELINEMAXRATE (default 50). All state is in-process
 * (no Redis, no new dependencies).
 */

import { events } from '../platform/events.js';

/* ---------------------------------- config ---------------------------------- */

const MAX_CONCURRENCY = Math.max(1, parseInt(process.env.SEARCHPIPELINEMAXCONCURRENCY || '8', 10) || 8);
const MAX_QUEUE_LENGTH = Math.max(1, parseInt(process.env.SEARCHPIPELINEMAXQUEUELENGTH || '500', 10) || 500);
const MAX_RATE_PER_SEC = Math.max(1, parseInt(process.env.SEARCHPIPELINEMAXRATE || '50', 10) || 50);

const ANTISPAM_MAX_QUERY_LEN = 256; // query too long → reject
const ANTISPAM_REPEAT_LIMIT = 30;   // identical queries per client per 60s
const ANTISPAM_WORD_REPEAT = 8;     // max occurrences of a single word
const CONTROL_CHARS_RE = /[\x00-\x1F\x7F]/;

const RL_CAPACITY = 30;       // search token bucket capacity
const RL_REFILL_PER_SEC = 0.5;

const COOLDOWN_MS = 10_000;
const BATCH_WINDOW_MS = 15;
const BATCH_ROUND = 4;
const CACHE_MAX_KEYS = 500;
const CACHE_TTL_MS = 45_000;
const LATENCY_WINDOW = 50; // rolling executor latency samples (search.js model)

/** Layer 5 priority tiers — higher value runs first. */
const PRIORITY_BY_KIND = { autocomplete: 3, search: 2, stress: 0 };

/* ------------------------------- rejections --------------------------------- */

/**
 * Structured pipeline rejection — search.js maps it 1:1 onto the HTTP response
 * (status + body + optional headers such as Retry-After). Anything else thrown
 * by an executor propagates untouched to the Express error handler.
 */
class PipelineRejection extends Error {
  constructor(status, body, headers = {}) {
    super(body?.error || `pipeline rejection ${status}`);
    this.name = 'PipelineRejection';
    this.pipeline = true;
    this.status = status;
    this.body = body;
    this.layer = body?.layer ?? null;
    this.headers = headers;
  }
}

/* --------------------------------- stats ------------------------------------ */

const stats = {
  antispam: { rejected: 0, reasons: { tooLong: 0, controlChars: 0, repeated: 0, wordFlood: 0 } },
  ratelimit: { limited: 0 },
  cooldown: { servedFromCooldown: 0, deprioritized: 0 },
  queue: { enqueued: 0, rejected: 0, dispatched: 0 },
  priority: {}, // executor executions per priority tier: { '0': n, '1': n, ... }
  window: { deferred: 0 },
  dedup: { coalesced: 0 },
  batch: { batches: 0, batchedQueries: 0, indexSyncBatch: null },
  cache: { hits: 0, misses: 0, invalidations: 0 },
  executor: { executions: 0, errors: 0 },
};

/* ------------------------------ layer 1: anti-spam --------------------------- */

const spamRepeat = new Map(); // `${client}|${query}` → { count, windowStart }

/** @returns {null|string} rejection reason, or null when the query is clean. */
function antiSpamCheck(client, rawQuery, normQuery) {
  if (!rawQuery) return null; // filter-only requests have no text surface
  if (rawQuery.length > ANTISPAM_MAX_QUERY_LEN) return 'tooLong';
  if (CONTROL_CHARS_RE.test(rawQuery)) return 'controlChars';
  // Abnormal word ratio — the same word repeated more than 8 times.
  const counts = new Map();
  let maxWord = 0;
  for (const word of normQuery.split(' ').filter(Boolean)) {
    const n = (counts.get(word) || 0) + 1;
    counts.set(word, n);
    if (n > maxWord) maxWord = n;
  }
  if (maxWord > ANTISPAM_WORD_REPEAT) return 'wordFlood';
  // Identical query repeated too often from the same client (>30/min).
  const key = `${client}|${normQuery}`;
  const now = Date.now();
  const entry = spamRepeat.get(key);
  if (!entry || now - entry.windowStart >= 60_000) {
    spamRepeat.set(key, { count: 1, windowStart: now });
  } else {
    entry.count += 1;
    if (entry.count > ANTISPAM_REPEAT_LIMIT) return 'repeated';
  }
  return null;
}

/* ---------------------------- layer 2: rate-limit ---------------------------- */

const buckets = new Map(); // client → { tokens, last }

/** Search-specific token bucket — independent of the global 120/min limiter. */
function consumeToken(client) {
  const now = Date.now();
  let bucket = buckets.get(client);
  if (!bucket) {
    bucket = { tokens: RL_CAPACITY, last: now };
    buckets.set(client, bucket);
  }
  const elapsedSec = (now - bucket.last) / 1000;
  bucket.tokens = Math.min(RL_CAPACITY, bucket.tokens + elapsedSec * RL_REFILL_PER_SEC);
  bucket.last = now;
  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return { ok: true };
  }
  return { ok: false, retryAfterSec: Math.max(1, Math.ceil((1 - bucket.tokens) / RL_REFILL_PER_SEC)) };
}

/* ----------------------------- layer 3: cooldown ----------------------------- */

const cooldown = new Map(); // `${client}|${kind}|${query}` → last seen (ms)

/* -------------------------- layer 9: LRU result cache ------------------------ */

const resultCache = new Map(); // signature → { body, expiresAt } (Map order = LRU)

function cacheGet(key) {
  const entry = resultCache.get(key);
  if (!entry) {
    stats.cache.misses += 1;
    return undefined;
  }
  if (entry.expiresAt <= Date.now()) {
    resultCache.delete(key);
    stats.cache.misses += 1;
    return undefined;
  }
  // LRU: refresh recency.
  resultCache.delete(key);
  resultCache.set(key, entry);
  stats.cache.hits += 1;
  return entry.body;
}

function cacheSet(key, body) {
  if (resultCache.has(key)) resultCache.delete(key);
  resultCache.set(key, { body, expiresAt: Date.now() + CACHE_TTL_MS });
  while (resultCache.size > CACHE_MAX_KEYS) {
    resultCache.delete(resultCache.keys().next().value); // oldest insertion
  }
}

// content:changed → drop every cached result (same pattern as advancedCache.js).
events.on('content:changed', () => {
  if (resultCache.size > 0) stats.cache.invalidations += 1;
  resultCache.clear();
});

/* --------------------- layers 4-6: queue / priority / window ----------------- */

const pending = []; // priority-sorted jobs (priority desc, seq asc = FIFO per tier)
let running = 0;    // jobs admitted into a concurrency slot
let seqCounter = 0;

const windowDispatches = []; // dispatch timestamps (ms) inside the last 1000ms
let windowRetryTimer = null;

/** a before b when negative: higher priority first, then FIFO by seq. */
function jobBefore(a, b) {
  return b.priority - a.priority || a.seq - b.seq;
}

function insertPending(job) {
  let i = pending.length;
  while (i > 0 && jobBefore(job, pending[i - 1]) < 0) i -= 1;
  pending.splice(i, 0, job);
}

function windowHasRoom(now) {
  while (windowDispatches.length && now - windowDispatches[0] >= 1000) windowDispatches.shift();
  return windowDispatches.length < MAX_RATE_PER_SEC;
}

/** One retry timer per window-full episode (debounced, unref'd). */
function scheduleWindowRetry(now) {
  if (windowRetryTimer) return;
  const waitMs = Math.max(5, 1000 - (now - windowDispatches[0]) + 5);
  windowRetryTimer = setTimeout(() => {
    windowRetryTimer = null;
    pump();
  }, waitMs);
  if (typeof windowRetryTimer.unref === 'function') windowRetryTimer.unref();
}

/** Scheduler: admits the highest-priority job into a free slot + window slot. */
function pump() {
  for (;;) {
    if (pending.length === 0 || running >= MAX_CONCURRENCY) return;
    const now = Date.now();
    if (!windowHasRoom(now)) {
      // Layer 6 — no room in the 1s window: the head job waits (deferred).
      const head = pending[0];
      if (!head.windowDeferred) {
        head.windowDeferred = true;
        stats.window.deferred += 1;
      }
      scheduleWindowRetry(now);
      return;
    }
    const job = pending.shift();
    windowDispatches.push(now);
    running += 1;
    stats.queue.dispatched += 1;
    dispatchJob(job); // async — always releases its slot (finally below)
  }
}

async function dispatchJob(job) {
  try {
    // Layer 7 — dedup (single-flight): identical in-flight signature shares ONE promise.
    const leader = inflight.get(job.signature);
    if (leader) {
      stats.dedup.coalesced += 1;
      job.resolve(await leader);
      return;
    }
    const flight = runThroughBatch(job); // layers 8 → 9 → 10
    inflight.set(job.signature, flight);
    try {
      job.resolve(await flight);
    } finally {
      inflight.delete(job.signature);
    }
  } catch (err) {
    job.reject(err);
  } finally {
    running -= 1;
    pump();
  }
}

/* ------------------------- layer 8: micro-batching --------------------------- */

const inflight = new Map(); // signature → promise (layer 7 single-flight map)
let formingBatch = null;    // { items: [{job, resolve, reject}], timer }

/** Join the micro-batch forming in the current ~15ms window. */
function runThroughBatch(job) {
  return new Promise((resolve, reject) => {
    if (!formingBatch) {
      formingBatch = { items: [], timer: null };
      formingBatch.timer = setTimeout(() => {
        const batch = formingBatch;
        formingBatch = null;
        runBatch(batch.items);
      }, BATCH_WINDOW_MS);
      if (typeof formingBatch.timer.unref === 'function') formingBatch.timer.unref();
    }
    formingBatch.items.push({ job, resolve, reject });
  });
}

/** Execute a formed batch: priority-ordered, sequential rounds of max 4. */
async function runBatch(items) {
  stats.batch.batches += 1;
  stats.batch.batchedQueries += items.length;
  items.sort((a, b) => b.job.priority - a.job.priority || a.job.seq - b.job.seq);
  for (let i = 0; i < items.length; i += BATCH_ROUND) {
    // Identical signatures were already collapsed at layer 7; the distinct
    // jobs of this batch run sequentially in rounds of max BATCH_ROUND.
    await Promise.all(items.slice(i, i + BATCH_ROUND).map((it) => runBatchItem(it.job).then(it.resolve, it.reject)));
  }
}

async function runBatchItem(job) {
  // Layer 9 — result cache (after batching, per the layer order).
  const cached = cacheGet(job.signature);
  if (cached !== undefined) {
    return { body: cached, source: 'hit' };
  }

  // Layer 10 — the REAL executor (Neon FTS closures from search.js).
  const startedAt = Date.now();
  stats.executor.executions += 1;
  stats.priority[String(job.priority)] = (stats.priority[String(job.priority)] || 0) + 1;
  executorInflight += 1;
  if (executorInflight > maxExecutorInflight) maxExecutorInflight = executorInflight;
  try {
    const body = await job.executor();
    cacheSet(job.signature, body); // only successful results are cached
    return { body, source: 'miss' };
  } catch (err) {
    stats.executor.errors += 1;
    throw err;
  } finally {
    executorInflight -= 1;
    recordExecutorLatency(Date.now() - startedAt);
  }
}

/* ------------------------- layer 10: latency tracking ------------------------ */

let executorInflight = 0;
let maxExecutorInflight = 0;
const executorLatencies = []; // ms of the last 50 executor runs

function recordExecutorLatency(ms) {
  executorLatencies.push(ms);
  if (executorLatencies.length > LATENCY_WINDOW) executorLatencies.shift();
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return Number(sorted[idx].toFixed(2));
}

/* --------------------------------- helpers ---------------------------------- */

/** Query normalization shared by cooldown + signatures: lowercase/trim/collapse. */
function normalizeQuery(q) {
  return String(q ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/* ------------------------------ housekeeping -------------------------------- */

const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of spamRepeat) {
    if (now - entry.windowStart >= 60_000) spamRepeat.delete(key);
  }
  for (const [key, bucket] of buckets) {
    if (now - bucket.last >= 120_000) buckets.delete(key);
  }
  for (const [key, ts] of cooldown) {
    if (now - ts >= COOLDOWN_MS) cooldown.delete(key);
  }
}, 60_000);
if (typeof sweeper.unref === 'function') sweeper.unref();

/* --------------------------------- execute ---------------------------------- */

/**
 * Run one request through the 10 layers. Resolves with
 *   { body, source }   source ∈ 'miss' (executed) | 'hit' (cache) | 'cooldown'
 * or rejects with a PipelineRejection (429/503) / the executor's own error.
 *
 * @param {object} job
 *   kind       'search' | 'autocomplete' | 'stress'
 *   client     client id (clientIpOf(req) — or a synthetic id for stress)
 *   query      raw query text (anti-spam + cooldown surface)
 *   params     plain object included in the signature (filters/sort/page/…)
 *   executor   async () => response body  (layer 10 — real FTS or stress-lab)
 *   priority   optional explicit tier override (default: by kind)
 */
function execute({ kind = 'search', client = 'unknown', query = '', params = {}, executor, priority }) {
  if (typeof executor !== 'function') {
    return Promise.reject(new Error('pipeline.execute requires an executor function'));
  }
  const prio = Number.isInteger(priority)
    ? Math.max(0, Math.min(3, priority))
    : PRIORITY_BY_KIND[kind] ?? 2;
  const rawQuery = String(query ?? '');
  const normQuery = normalizeQuery(rawQuery);
  const signature = JSON.stringify({ kind, q: normQuery, p: params });

  /* Layer 1 — anti-spam. */
  const spamReason = antiSpamCheck(client, rawQuery, normQuery);
  if (spamReason) {
    stats.antispam.rejected += 1;
    stats.antispam.reasons[spamReason] += 1;
    return Promise.reject(new PipelineRejection(429, { error: 'anti-spam', layer: 1, reason: spamReason }));
  }

  /* Layer 2 — search-specific rate limit (token bucket per client). */
  const rl = consumeToken(client);
  if (!rl.ok) {
    stats.ratelimit.limited += 1;
    return Promise.reject(
      new PipelineRejection(
        429,
        { error: 'rate-limit', layer: 2, retryAfterSec: rl.retryAfterSec },
        { 'Retry-After': String(rl.retryAfterSec) },
      ),
    );
  }

  /* Layer 3 — cooldown per (client, kind, normalized query). */
  const now = Date.now();
  const cooldownKey = `${client}|${kind}|${normQuery}`;
  const lastSeen = cooldown.get(cooldownKey);
  const inCooldown = lastSeen != null && now - lastSeen < COOLDOWN_MS;
  cooldown.set(cooldownKey, now);
  let effectivePriority = prio;
  if (inCooldown) {
    // Same client asked the same thing within 10s → serve from the layer-9
    // cache instantly when possible; otherwise let it through deprioritized.
    const cached = cacheGet(signature);
    if (cached !== undefined) {
      stats.cooldown.servedFromCooldown += 1;
      return Promise.resolve({ body: cached, source: 'cooldown' });
    }
    effectivePriority = Math.max(0, prio - 1); // low priority — UX not blocked
    stats.cooldown.deprioritized += 1;
  }

  /* Layer 4 — bounded admission (honest 503 when the queue is full). */
  if (pending.length >= MAX_QUEUE_LENGTH) {
    stats.queue.rejected += 1;
    const retryAfterSec = Math.max(1, Math.ceil((pending.length + MAX_CONCURRENCY) / MAX_RATE_PER_SEC));
    return Promise.reject(
      new PipelineRejection(
        503,
        { error: 'queue-full', layer: 4, retryAfterSec },
        { 'Retry-After': String(retryAfterSec) },
      ),
    );
  }
  stats.queue.enqueued += 1;

  return new Promise((resolve, reject) => {
    insertPending({
      kind,
      signature,
      priority: effectivePriority,
      seq: seqCounter++,
      executor,
      resolve,
      reject,
      windowDeferred: false,
    });
    pump();
  });
}

/* -------------------------------- snapshots --------------------------------- */

/** Flat per-stage counters — diffable around a stress run (perStage report). */
function perStageCounts() {
  return {
    antiSpamRejected: stats.antispam.rejected,
    rateLimited: stats.ratelimit.limited,
    cooldownServed: stats.cooldown.servedFromCooldown,
    cooldownDeprioritized: stats.cooldown.deprioritized,
    queueRejected: stats.queue.rejected,
    enqueued: stats.queue.enqueued,
    dispatched: stats.queue.dispatched,
    coalesced: stats.dedup.coalesced,
    cacheHits: stats.cache.hits,
    cacheMisses: stats.cache.misses,
    executed: stats.executor.executions,
    executorErrors: stats.executor.errors,
    batches: stats.batch.batches,
    batchedQueries: stats.batch.batchedQueries,
    windowDeferred: stats.window.deferred,
    byPriority: { ...stats.priority },
  };
}

/** Live 10-stage snapshot for GET /api/search status (pipelineStages field). */
function stagesSnapshot() {
  const sorted = [...executorLatencies].sort((a, b) => a - b);
  const hitTotal = stats.cache.hits + stats.cache.misses;
  const now = Date.now();
  while (windowDispatches.length && now - windowDispatches[0] >= 1000) windowDispatches.shift();
  return [
    {
      order: 1,
      name: 'anti-spam',
      stats: {
        rejected: stats.antispam.rejected,
        reasons: { ...stats.antispam.reasons },
        maxQueryLength: ANTISPAM_MAX_QUERY_LEN,
        repeatLimitPerMin: ANTISPAM_REPEAT_LIMIT,
        wordRepeatLimit: ANTISPAM_WORD_REPEAT,
        trackedQueries: spamRepeat.size,
      },
    },
    {
      order: 2,
      name: 'rate-limit',
      stats: {
        limited: stats.ratelimit.limited,
        trackedClients: buckets.size,
        capacity: RL_CAPACITY,
        refillPerSec: RL_REFILL_PER_SEC,
      },
    },
    {
      order: 3,
      name: 'cooldown',
      stats: {
        servedFromCooldown: stats.cooldown.servedFromCooldown,
        deprioritized: stats.cooldown.deprioritized,
        trackedKeys: cooldown.size,
        windowMs: COOLDOWN_MS,
      },
    },
    {
      order: 4,
      name: 'queue',
      stats: {
        enqueued: stats.queue.enqueued,
        rejected: stats.queue.rejected,
        dispatched: stats.queue.dispatched,
        queueDepth: pending.length,
        inflight: running,
        maxConcurrency: MAX_CONCURRENCY,
        maxQueueLength: MAX_QUEUE_LENGTH,
      },
    },
    {
      order: 5,
      name: 'priority',
      stats: {
        executionsByPriority: { ...stats.priority },
        tiers: { autocomplete: 3, 'user search': 2, 'admin/batch': 1, stress: 0 },
      },
    },
    {
      order: 6,
      name: 'windowing',
      stats: {
        deferred: stats.window.deferred,
        executionsPerSec: windowDispatches.length,
        maxRatePerSec: MAX_RATE_PER_SEC,
      },
    },
    {
      order: 7,
      name: 'dedup',
      stats: { coalesced: stats.dedup.coalesced, inflight: inflight.size },
    },
    {
      order: 8,
      name: 'batching',
      stats: {
        batches: stats.batch.batches,
        batchedQueries: stats.batch.batchedQueries,
        batchWindowMs: BATCH_WINDOW_MS,
        roundSize: BATCH_ROUND,
        indexSyncBatch: stats.batch.indexSyncBatch, // indexing SYNC_CHUNK (25)
      },
    },
    {
      order: 9,
      name: 'cache',
      stats: {
        hits: stats.cache.hits,
        misses: stats.cache.misses,
        hitRate: hitTotal === 0 ? 0 : Number((stats.cache.hits / hitTotal).toFixed(4)),
        keys: resultCache.size,
        invalidations: stats.cache.invalidations,
        ttlMs: CACHE_TTL_MS,
        maxKeys: CACHE_MAX_KEYS,
      },
    },
    {
      order: 10,
      name: 'neon-fts',
      stats: {
        executions: stats.executor.executions,
        errors: stats.executor.errors,
        p50Ms: percentile(sorted, 0.5),
        p95Ms: percentile(sorted, 0.95),
        samples: executorLatencies.length,
        inflight: executorInflight,
        maxInflight: maxExecutorInflight,
      },
    },
  ];
}

/** Expose the indexing chunk (SYNC_CHUNK = 25) on the batching stage stats. */
function setIndexSyncBatch(n) {
  stats.batch.indexSyncBatch = Number.isFinite(Number(n)) ? Number(n) : null;
}

/* ---------------------------------- export ---------------------------------- */

export const pipeline = {
  execute,
  stagesSnapshot,
  perStageCounts,
  setIndexSyncBatch,
  config: {
    maxConcurrency: MAX_CONCURRENCY,
    maxQueueLength: MAX_QUEUE_LENGTH,
    maxRatePerSec: MAX_RATE_PER_SEC,
    cooldownMs: COOLDOWN_MS,
    rlCapacity: RL_CAPACITY,
    rlRefillPerSec: RL_REFILL_PER_SEC,
    cacheTtlMs: CACHE_TTL_MS,
    cacheMaxKeys: CACHE_MAX_KEYS,
    batchWindowMs: BATCH_WINDOW_MS,
    batchRoundSize: BATCH_ROUND,
  },
};

export { PipelineRejection };
export default pipeline;
