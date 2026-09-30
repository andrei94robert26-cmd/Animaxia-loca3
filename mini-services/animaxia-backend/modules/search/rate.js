/**
 * modules/search/rate.js — FAZA 16 (Task 16-1): Search Rate Management —
 * the per-user PACING layer that sits in front of the FAZA 15 search flow
 * queue (modules/search/flow.js) and the Neon FTS engine.
 *
 * WHAT IT IS (pinned spec, "FAZA 16 — Search Rate Management"):
 *   • SEARCH RATE LIMIT — one search request per user every `perUserMs`
 *     (default 500 ms). Faster repeats are answered with an explicit
 *     429 { error: 'rate_limited', code: 'SEARCH_RATE_LIMITED', retryInMs }
 *     — never silently dropped, never a fake result. Pacing is PER KIND:
 *     /advanced and /autocomplete keep separate admission lanes, so typing
 *     (autocomplete) never blocks the ENTER search and vice-versa.
 *   • SEARCH COOLDOWN — after a user RECEIVES an /advanced result, their
 *     next /advanced search is rejected for `cooldownMs` (default 1200 ms)
 *     with 429 { error: 'cooldown_active', code: 'SEARCH_COOLDOWN_ACTIVE',
 *     retryInMs } (the exact pinned shape). The cooldown is synchronized
 *     with the rate limit: the effective next-allowed moment is
 *     max(lastAdmitted + perUserMs, lastCompleted + cooldownMs).
 *   • ANTI-SPAM ENTER — flood detection independent of pacing: when a user
 *     fires `spamThreshold` (default 3) search arrivals of ANY kind within
 *     `spamWindowMs` (default 200 ms), the flood is blocked — every further
 *     request gets 429 { error: 'spam_blocked', code: 'SEARCH_SPAM_BLOCKED',
 *     retryInMs } and the identity is auto-blocked for `spamBlockMs`
 *     (default 1000 ms). Arrivals are counted whether admitted or rejected
 *     (an ENTER flood is exactly what this catches).
 *   • SEARCH BURST CONTROL — global micro-spike detection: search arrivals
 *     are counted in 100 ms buckets over a sliding `burstWindowMs` (default
 *     1000 ms). Crossing `burstThreshold` (default 1000) marks a burst event
 *     (animaxia_search_burst_events) — the requests themselves are absorbed
 *     by the FAZA 15 queue + windowing (rate limit is per USER, so 1000
 *     DISTINCT users searching simultaneously are ALL admitted and all get
 *     real answers; Neon still sees only the windowed stream).
 *
 * WHAT IT IS NOT: it does NOT touch the FTS queries. Requests that pass the
 * gate flow into the FAZA 15 search flow queue unchanged — the executions
 * are the byte-identical FAZA 14 code paths, results stay 100% real. The
 * gate only decides WHO may search HOW OFTEN; it never fabricates, caches
 * or alters a search result.
 *
 * SHARD-AWARENESS: every admission/block is attributed to the shard resolved
 * from the request (X-Animaxia-Shard header > tenant hash > shard 0, via
 * resolveSearchShard — same affinity as the FAZA 15 queue), exposed in the
 * per-shard table and the animaxia_search_rate_*_by_shard series.
 *
 * IDENTITY: authenticated users key on `u:{id}`; anonymous callers key on
 * `ip:{clientIp}` (X-Forwarded-For first value — the same trust model as
 * security.js / the FAZA 15 QA bursts with unique XFFs).
 *
 * CONFIG (env, overridable at runtime by POST /api/search/rate/settings):
 *   SEARCHRATEENABLED         default true    — false bypasses the whole layer
 *   SEARCHRATEPERUSERMS       default 500     — min interval between admitted
 *                                               searches, per user, per kind
 *   SEARCHRATECOOLDOWNMS      default 1200    — post-result /advanced cooldown
 *   SEARCHRATESPAMWINDOWMS    default 200     — flood window
 *   SEARCHRATESPAMTHRESHOLD   default 3       — arrivals within the window
 *                                               that constitute a flood
 *   SEARCHRATESPAMBLOCKMS     default 1000    — auto-block after a flood
 *   SEARCHRATEBURSTWINDOWMS   default 1000    — global burst detection window
 *   SEARCHRATEBURSTTHRESHOLD  default 1000    — arrivals/window → burst event
 *
 * OBSERVABILITY (pinned in animaxia-ops/metrics/METRICS.md §9):
 *   animaxia_search_rate_limit_hits / animaxia_search_cooldown_active /
 *   animaxia_search_spam_blocked / animaxia_search_burst_events (the four
 *   spec-pinned series) + enabled/per_user_ms/cooldown_ms/admitted_total/
 *   completed_total/tracked_users/burst_* gauges and sparse *_by_shard
 *   counters — via the 'searchrate' pull collector wired in server.js and
 *   rendered by modules/ops/metrics.js. GET /api/search/rate serves the full
 *   console (config + counters + 180×1s history + 30-row perShard table);
 *   /api/search/status gains the pinned `rateLimit` and `burstControl`
 *   blocks. Every admitted /advanced response carries the additive
 *   `rate: { perUserMs, cooldownMs }` field so the UI can enforce its own
 *   cooldown affordance.
 *
 * This module is PURE admission pacing: it imports nothing from db.js or the
 * search engine — only the flow queue's shard resolver (pure computation),
 * the security layer's clientIpOf and the logger.
 */

import { resolveSearchShard } from './flow.js';
import { shardCount } from '../sharding/model.js';
import { clientIpOf } from '../security/security.js';
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
    enabled: String(process.env.SEARCHRATEENABLED ?? 'true') !== 'false',
    perUserMs: clampInt(process.env.SEARCHRATEPERUSERMS, 500, 100, 5000),
    cooldownMs: clampInt(process.env.SEARCHRATECOOLDOWNMS, 1200, 250, 10000),
    spamWindowMs: clampInt(process.env.SEARCHRATESPAMWINDOWMS, 200, 50, 2000),
    spamThreshold: clampInt(process.env.SEARCHRATESPAMTHRESHOLD, 3, 2, 10),
    spamBlockMs: clampInt(process.env.SEARCHRATESPAMBLOCKMS, 1000, 100, 10000),
    burstWindowMs: clampInt(process.env.SEARCHRATEBURSTWINDOWMS, 1000, 250, 5000),
    burstThreshold: clampInt(process.env.SEARCHRATEBURSTTHRESHOLD, 1000, 10, 100000),
  };
}

/** Live config — env at boot, adjustable at runtime via the admin endpoint. */
const config = envConfig();

/* --------------------------------- counters --------------------------------- */

const stats = {
  arrivals: 0, // search requests that reached the gate (any disposition)
  admitted: 0, // passed the gate (advanced + autocomplete)
  admittedAdvanced: 0,
  admittedAutocomplete: 0,
  completed: 0, // /advanced executions that returned a result (cooldown hook)
  rateLimitHits: 0, // blocked by per-user pacing → 429 rate_limited
  cooldownBlocks: 0, // blocked by the post-result cooldown → 429 cooldown_active
  spamBlocked: 0, // blocked by flood detection → 429 spam_blocked
  burstEvents: 0, // global burst windows crossed the threshold
  burstPeak: 0, // max arrivals ever observed inside one burst window
  trackedUsersHighWater: 0,
  lastRateLimitAt: null,
  lastCooldownAt: null,
  lastSpamAt: null,
  lastBurstAt: null,
};

/* Per-shard attribution (shard id → { admitted, rateLimited, cooldownActive, spamBlocked }). */
function blankShardStats() {
  return { admitted: 0, rateLimited: 0, cooldownActive: 0, spamBlocked: 0 };
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

/* ------------------------------ identity state ------------------------------ */

/**
 * Per-identity pacing state. `lastAdmitted` keeps ONE timestamp per kind
 * (advanced / autocomplete — separate lanes, typing never blocks ENTER);
 * `arrivals` is the anti-spam ring of recent arrival timestamps (any kind,
 * admitted or rejected); `blockedUntil` is the auto-block set on flood.
 */
function blankUser() {
  return {
    lastAdmitted: { advanced: 0, autocomplete: 0 },
    lastCompletedAdvanced: 0,
    arrivals: [],
    blockedUntil: 0,
    lastSeen: 0,
  };
}

const users = new Map();
const ARRIVALS_RING = 12; // per-user arrival timestamps kept for flood math
const USER_IDLE_TTL_MS = 300000; // forget identities idle for 5 minutes
const TRACKED_USERS_CAP = 100000; // hard memory bound (10M target: LRU-ish sweep)
let trackedUsersHighWater = 0;

function userState(identity) {
  let entry = users.get(identity);
  if (!entry) {
    if (users.size >= TRACKED_USERS_CAP) {
      sweepIdleUsers(Date.now(), true);
    }
    if (users.size >= TRACKED_USERS_CAP) {
      // Cap still reached (all identities active) — refuse to grow unbounded:
      // pace this identity through a shared overflow slot rather than OOM.
      entry = users.get('__overflow__') ?? blankUser();
      users.set('__overflow__', entry);
      return entry;
    }
    entry = blankUser();
    users.set(identity, entry);
    if (users.size > trackedUsersHighWater) trackedUsersHighWater = users.size;
  }
  return entry;
}

/** Drop identities idle past USER_IDLE_TTL_MS (forced=true → drop the oldest half). */
function sweepIdleUsers(now, forced = false) {
  for (const [identity, entry] of users) {
    if (identity === '__overflow__') continue;
    if (now - entry.lastSeen > USER_IDLE_TTL_MS) users.delete(identity);
  }
  if (forced && users.size >= TRACKED_USERS_CAP) {
    // Still full — evict the least recently seen quarter (bounded, best effort).
    const sorted = [...users.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen);
    const evict = Math.floor(sorted.length / 4);
    for (let i = 0; i < evict && i < sorted.length; i += 1) {
      if (sorted[i][0] !== '__overflow__') users.delete(sorted[i][0]);
    }
  }
}

/* ------------------------------ burst detector ------------------------------ */

/**
 * Global arrival counting in fixed `BURST_BUCKET_MS` buckets over the sliding
 * burst window — O(1) memory per bucket, O(buckets) per arrival, no per-event
 * allocations: at 10M users the detector costs the same as at 10.
 */
const BURST_BUCKET_MS = 100;
let burstBuckets = []; // [{ startAt, count }] — newest last
let burstActive = false; // a burst is being observed right now

function bucketStart(now) {
  return Math.floor(now / BURST_BUCKET_MS) * BURST_BUCKET_MS;
}

/** Record one arrival; returns the window arrival count including it. */
function recordBurstArrival(now) {
  const startAt = bucketStart(now);
  const last = burstBuckets[burstBuckets.length - 1];
  if (!last || last.startAt !== startAt) {
    burstBuckets.push({ startAt, count: 1 });
    // Prune buckets older than the window (timestamps are monotonic).
    const minStart = now - config.burstWindowMs;
    while (burstBuckets.length > 0 && burstBuckets[0].startAt < minStart) burstBuckets.shift();
  } else {
    last.count += 1;
  }
  let total = 0;
  for (const bucket of burstBuckets) total += bucket.count;
  if (total > stats.burstPeak) stats.burstPeak = total;
  return total;
}

/** Current arrivals inside the sliding burst window (no new arrival). */
function burstWindowCount(now = Date.now()) {
  const minStart = now - config.burstWindowMs;
  let total = 0;
  for (const bucket of burstBuckets) {
    if (bucket.startAt >= minStart) total += bucket.count;
  }
  return total;
}

/** Burst state machine: crossing the threshold opens an event; falling under
 *  half of it closes the observation (hysteresis — one burst = one event).
 *  Purely passive detection — it never blocks a request; when the FAZA 16
 *  layer is disabled at runtime the detector idles (no events fire, arrivals
 *  stay counted for the arrivals/s gauge). */
function updateBurstState(count, now) {
  if (!config.enabled) {
    burstActive = false;
    return;
  }
  if (!burstActive && count >= config.burstThreshold) {
    burstActive = true;
    stats.burstEvents += 1;
    stats.lastBurstAt = new Date(now).toISOString();
    logger.warn(
      `[search-rate] BURST — ${count} arrivals in the last ${config.burstWindowMs}ms ≥ threshold ${config.burstThreshold} (event #${stats.burstEvents}) — FAZA 15 queue + windowing absorb the spike, per-user limits stay active`,
    );
  } else if (burstActive && count < Math.ceil(config.burstThreshold / 2)) {
    burstActive = false;
  }
}

/* ------------------------------- history sampler ---------------------------- */

/* Rolling console history — 1s samples of arrivals / admitted / blocked. */
const HISTORY_LIMIT = 180;
const history = [];
let historyTimer = null;

function startHistorySampler() {
  if (historyTimer) return;
  historyTimer = setInterval(() => {
    try {
      const now = Date.now();
      const sample = {
        t: new Date(now).toISOString(),
        arrivals: arrivalSamples,
        admitted: admittedSamples,
        blocked: blockedSamples,
        tracked: users.size,
      };
      history.push(sample);
      if (history.length > HISTORY_LIMIT) history.shift();
      arrivalSamples = 0;
      admittedSamples = 0;
      blockedSamples = 0;
      // Burst hysteresis + idle eviction ride the same 1s tick.
      updateBurstState(burstWindowCount(now), now);
      sweepIdleUsers(now);
    } catch (err) {
      logger.error(`[search-rate] history sampler failed: ${err?.message ?? err}`);
    }
  }, 1000);
  if (typeof historyTimer.unref === 'function') historyTimer.unref();
}

let arrivalSamples = 0;
let admittedSamples = 0;
let blockedSamples = 0;

/* ---------------------------------- gate ------------------------------------ */

/** Resolve the pacing identity of a search request: authenticated user id
 *  wins; anonymous callers key on their client IP (XFF-aware). */
export function searchRateIdentity(req) {
  if (req?.user?.id != null) return `u:${req.user.id}`;
  return `ip:${clientIpOf(req)}`;
}

/**
 * FAZA 16 admission gate — called by the /advanced and /autocomplete routes
 * BEFORE the FAZA 15 flow queue. Pure pacing decision; never touches the
 * query itself.
 *
 * Order of checks (each rejection is an explicit 429 with retryInMs):
 *   1. auto-block active (flood)        → spam_blocked
 *   2. flood detection (≥ threshold arrivals in the window) → spam_blocked
 *      — arrivals are recorded for EVERY request, admitted or rejected
 *   3. post-result cooldown (advanced)  → cooldown_active
 *   4. per-user pacing (per kind)       → rate_limited
 *
 * @param {import('express').Request} req
 * @param {'advanced'|'autocomplete'} kind
 * @returns {{ ok: true, identity: string, shardId: number }
 *          |{ ok: false, kind: string, error: string, code: string, retryInMs: number,
 *             status: 429, body: object }}
 */
export function searchRateGate(req, kind = 'advanced') {
  const now = Date.now();
  const identity = searchRateIdentity(req);
  const shardId = resolveSearchShard(req);
  stats.arrivals += 1;
  arrivalSamples += 1;
  recordBurstArrival(now);

  // Bypass path: the whole FAZA 16 layer disabled → FAZA 15 behavior.
  if (!config.enabled) {
    return { ok: true, identity, shardId, bypassed: true };
  }

  const user = userState(identity);
  user.lastSeen = now;

  /* 1. auto-block active (a flood was already detected) */
  if (user.blockedUntil > now) {
    stats.spamBlocked += 1;
    blockedSamples += 1;
    shardStats(shardId).spamBlocked += 1;
    stats.lastSpamAt = new Date(now).toISOString();
    const retryInMs = user.blockedUntil - now;
    logger.warn(
      `[search-rate] SPAM BLOCKED — ${kind} from ${identity} (auto-block active, ${Math.ceil(retryInMs)}ms left, shard=${shardId})`,
    );
    return {
      ok: false,
      kind,
      identity,
      shardId,
      status: 429,
      body: {
        error: 'spam_blocked',
        code: 'SEARCH_SPAM_BLOCKED',
        retryInMs: Math.max(1, Math.ceil(retryInMs)),
        spamBlockMs: config.spamBlockMs,
        message: 'Așteaptă un moment…',
      },
    };
  }

  /* 2. flood detection — count arrivals (any kind) inside the spam window */
  const windowStart = now - config.spamWindowMs;
  while (user.arrivals.length > 0 && user.arrivals[0] <= windowStart) user.arrivals.shift();
  user.arrivals.push(now);
  if (user.arrivals.length > ARRIVALS_RING) user.arrivals.shift();
  if (user.arrivals.length >= config.spamThreshold) {
    user.blockedUntil = now + config.spamBlockMs;
    stats.spamBlocked += 1;
    blockedSamples += 1;
    shardStats(shardId).spamBlocked += 1;
    stats.lastSpamAt = new Date(now).toISOString();
    logger.warn(
      `[search-rate] SPAM BLOCKED — ${kind} from ${identity}: ${user.arrivals.length} arrivals in ${config.spamWindowMs}ms ≥ ${config.spamThreshold} → auto-block ${config.spamBlockMs}ms (shard=${shardId})`,
    );
    return {
      ok: false,
      kind,
      identity,
      shardId,
      status: 429,
      body: {
        error: 'spam_blocked',
        code: 'SEARCH_SPAM_BLOCKED',
        retryInMs: config.spamBlockMs,
        spamBlockMs: config.spamBlockMs,
        message: 'Așteaptă un moment…',
      },
    };
  }

  /* 3. post-result cooldown — /advanced only (the user just got results) */
  if (kind === 'advanced' && user.lastCompletedAdvanced > 0) {
    const cooldownUntil = user.lastCompletedAdvanced + config.cooldownMs;
    if (now < cooldownUntil) {
      stats.cooldownBlocks += 1;
      blockedSamples += 1;
      shardStats(shardId).cooldownActive += 1;
      stats.lastCooldownAt = new Date(now).toISOString();
      const retryInMs = cooldownUntil - now;
      logger.warn(
        `[search-rate] COOLDOWN — advanced from ${identity} blocked, ${Math.ceil(retryInMs)}ms of ${config.cooldownMs}ms left (shard=${shardId})`,
      );
      return {
        ok: false,
        kind,
        identity,
        shardId,
        status: 429,
        body: {
          error: 'cooldown_active',
          code: 'SEARCH_COOLDOWN_ACTIVE',
          retryInMs: Math.max(1, Math.ceil(retryInMs)),
          cooldownMs: config.cooldownMs,
          message: `Cooldown activ — poți căuta din nou peste ${Math.ceil(retryInMs / 100) / 10}s`,
        },
      };
    }
  }

  /* 4. per-user pacing — one admitted search per kind every perUserMs */
  const lastAdmitted = user.lastAdmitted[kind] ?? 0;
  const paceUntil = lastAdmitted + config.perUserMs;
  if (lastAdmitted > 0 && now < paceUntil) {
    stats.rateLimitHits += 1;
    blockedSamples += 1;
    shardStats(shardId).rateLimited += 1;
    stats.lastRateLimitAt = new Date(now).toISOString();
    const retryInMs = paceUntil - now;
    logger.warn(
      `[search-rate] RATE LIMITED — ${kind} from ${identity} needs ${Math.ceil(retryInMs)}ms more (perUserMs=${config.perUserMs}, shard=${shardId})`,
    );
    return {
      ok: false,
      kind,
      identity,
      shardId,
      status: 429,
      body: {
        error: 'rate_limited',
        code: 'SEARCH_RATE_LIMITED',
        retryInMs: Math.max(1, Math.ceil(retryInMs)),
        perUserMs: config.perUserMs,
        message: `Prea multe căutări — o căutare la fiecare ${config.perUserMs}ms`,
      },
    };
  }

  /* Admitted — burn this identity's pacing slot for the kind. */
  user.lastAdmitted[kind] = now;
  stats.admitted += 1;
  admittedSamples += 1;
  if (kind === 'advanced') stats.admittedAdvanced += 1;
  else stats.admittedAutocomplete += 1;
  shardStats(shardId).admitted += 1;
  updateBurstState(burstWindowCount(now), now);
  return { ok: true, identity, shardId };
}

/**
 * FAZA 16 completion hook — the /advanced route calls this after the FAZA 15
 * flow queue resolved with a REAL result: the post-result cooldown starts
 * now (the user has results in hand). Failures never start a cooldown — a
 * user whose search errored may retry immediately (pacing still applies).
 */
export function searchRateComplete(req, kind = 'advanced') {
  if (kind !== 'advanced') return;
  const identity = searchRateIdentity(req);
  const user = userState(identity);
  user.lastCompletedAdvanced = Date.now();
  user.lastSeen = Date.now();
  stats.completed += 1;
}

/* --------------------------------- snapshots --------------------------------- */

/** rateLimit block for /api/search/status — the pinned FAZA 16 contract:
 *  { perUserMs, enforced: true } + the live pacing/cooldown/spam state. */
export function searchRateStatusSnapshot() {
  return {
    enabled: config.enabled,
    enforced: config.enabled,
    perUserMs: config.perUserMs,
    cooldownMs: config.cooldownMs,
    cooldownEnforced: config.enabled,
    spamProtection: {
      windowMs: config.spamWindowMs,
      threshold: config.spamThreshold,
      blockMs: config.spamBlockMs,
    },
    hits: stats.rateLimitHits,
    cooldownBlocks: stats.cooldownBlocks,
    spamBlocked: stats.spamBlocked,
    trackedUsers: users.size,
    lastRateLimitAt: stats.lastRateLimitAt,
    lastCooldownAt: stats.lastCooldownAt,
    lastSpamAt: stats.lastSpamAt,
  };
}

/** burstControl block for /api/search/status — the pinned FAZA 16 contract:
 *  { active: true, maxBurstPerWindow: N } + live detection state. */
export function searchRateBurstSnapshot() {
  const now = Date.now();
  const count = burstWindowCount(now);
  return {
    active: config.enabled,
    burstActive,
    maxBurstPerWindow: config.burstThreshold,
    windowMs: config.burstWindowMs,
    events: stats.burstEvents,
    lastBurstAt: stats.lastBurstAt,
    arrivalsInWindow: count,
    arrivalsPerS: Number((count / (config.burstWindowMs / 1000)).toFixed(2)),
    peak: stats.burstPeak,
  };
}

/** Per-shard attribution table — one row per shard of the logical topology. */
function perShardSnapshot() {
  const out = [];
  const n = shardCount();
  for (let i = 0; i < n; i += 1) {
    const entry = byShard.get(i) ?? blankShardStats();
    out.push({ shardid: i, ...entry });
  }
  return out;
}

/** Full console snapshot for GET /api/search/rate (config + counters +
 *  rolling history + per-shard attribution). Public read-only (like /flow). */
export function searchRateConsoleSnapshot() {
  return {
    rateLimit: searchRateStatusSnapshot(),
    burstControl: searchRateBurstSnapshot(),
    config: { ...config },
    counters: {
      arrivals: stats.arrivals,
      admitted: stats.admitted,
      admittedAdvanced: stats.admittedAdvanced,
      admittedAutocomplete: stats.admittedAutocomplete,
      completed: stats.completed,
      rateLimitHits: stats.rateLimitHits,
      cooldownBlocks: stats.cooldownBlocks,
      spamBlocked: stats.spamBlocked,
      burstEvents: stats.burstEvents,
      burstPeak: stats.burstPeak,
      trackedUsersHighWater,
    },
    history: history.slice(),
    perShard: perShardSnapshot(),
  };
}

/**
 * Flat metrics shape for the 'searchrate' pull collector — consumed by
 * modules/ops/metrics.js renderPrometheus (animaxia_search_rate_*,
 * animaxia_search_cooldown_active, animaxia_search_spam_blocked,
 * animaxia_search_burst_events series) and available as
 * collectors.searchrate in the ?format=json snapshot.
 */
export function searchRateMetricsSnapshot() {
  const burst = searchRateBurstSnapshot();
  return {
    enabled: config.enabled,
    perUserMs: config.perUserMs,
    cooldownMs: config.cooldownMs,
    spamWindowMs: config.spamWindowMs,
    spamThreshold: config.spamThreshold,
    spamBlockMs: config.spamBlockMs,
    admitted: stats.admitted,
    admittedAdvanced: stats.admittedAdvanced,
    admittedAutocomplete: stats.admittedAutocomplete,
    completed: stats.completed,
    rateLimitHits: stats.rateLimitHits,
    cooldownBlocks: stats.cooldownBlocks,
    spamBlocked: stats.spamBlocked,
    burstEvents: burst.events,
    burstActive: burst.burstActive,
    burstWindowMs: burst.windowMs,
    burstMaxPerWindow: burst.maxBurstPerWindow,
    burstArrivalsPerS: burst.arrivalsPerS,
    trackedUsers: users.size,
    perShard: perShardSnapshot(),
  };
}

/**
 * Runtime reconfiguration (POST /api/search/rate/settings, admin only).
 * Validates and clamps every knob. Disabling the layer never strands anyone:
 * pacing state is kept but ignored (FAZA 15 admission behavior).
 */
export function updateSearchRateConfig(patch = {}) {
  const before = { ...config };
  if (patch.enabled !== undefined) config.enabled = Boolean(patch.enabled);
  if (patch.perUserMs !== undefined) {
    config.perUserMs = clampInt(patch.perUserMs, config.perUserMs, 100, 5000);
  }
  if (patch.cooldownMs !== undefined) {
    config.cooldownMs = clampInt(patch.cooldownMs, config.cooldownMs, 250, 10000);
  }
  if (patch.spamWindowMs !== undefined) {
    config.spamWindowMs = clampInt(patch.spamWindowMs, config.spamWindowMs, 50, 2000);
  }
  if (patch.spamThreshold !== undefined) {
    config.spamThreshold = clampInt(patch.spamThreshold, config.spamThreshold, 2, 10);
  }
  if (patch.spamBlockMs !== undefined) {
    config.spamBlockMs = clampInt(patch.spamBlockMs, config.spamBlockMs, 100, 10000);
  }
  if (patch.burstWindowMs !== undefined) {
    config.burstWindowMs = clampInt(patch.burstWindowMs, config.burstWindowMs, 250, 5000);
    burstBuckets = []; // window changed → rebuild the bucket ring cleanly
  }
  if (patch.burstThreshold !== undefined) {
    config.burstThreshold = clampInt(patch.burstThreshold, config.burstThreshold, 10, 100000);
  }

  logger.info(
    `[search-rate] config updated${config.enabled ? '' : ' (DISABLED)'} — perUserMs=${config.perUserMs} cooldownMs=${config.cooldownMs} spam=${config.spamThreshold}/${config.spamWindowMs}ms+${config.spamBlockMs}ms burst=${config.burstThreshold}/${config.burstWindowMs}ms (was: perUserMs=${before.perUserMs} cooldownMs=${before.cooldownMs})`,
  );
  return { ...config };
}

/* Boot: the 1s history sampler runs from module load (a tick over empty
 * state is a no-op). bun --watch restarts re-import the module and the
 * sampler re-arms. */
startHistorySampler();

logger.info(
  `[search-rate] FAZA 16 Search Rate Management ready — ${config.enabled ? 'ENABLED' : 'disabled'} · perUserMs=${config.perUserMs} · cooldown=${config.cooldownMs}ms · spam=${config.spamThreshold} arrivals/${config.spamWindowMs}ms → block ${config.spamBlockMs}ms · burst=${config.burstThreshold}/${config.burstWindowMs}ms`,
);

/* FAZA 16 delivery: QA final pass (clean boot). */
