/**
 * modules/ar10m/shard-router.js — THE real AR10M shard router (Task
 * AR10M-2-BE). Implements the user-pinned physical shard topology:
 *
 *   • 15 slots: ANIMAXIA_DB_01 .. ANIMAXIA_DB_15 (env connection strings).
 *     PRIMARY = ANIMAXIA_DB_01 if set, else process.env.DATABASEURL
 *     (backward compat — current reality: no ANIMAXIA_DB_* vars set, so all
 *     logical shards physically live on the primary Neon branch).
 *   • LOGICAL shards 0..AR10M_SHARD_COUNT-1 (default 15). Logical shard s →
 *     dedicated env ANIMAXIA_DB_(s+1) if set, else → PRIMARY. shard_id stored
 *     on rows = computeShardId() — stable forever; physical placement changes
 *     only via scripts/ar10m-rebalance.mjs when dedicated DBs appear.
 *   • LAZY POOLS: a pg.Pool is created ONLY on first query to a physical DB
 *     (never at boot — no connections to all 15 projects at startup). Pool:
 *     max 3, idleTimeoutMillis 30s, connectionTimeoutMillis 8s. Idle pools
 *     (no in-flight queries, idle > 120s) are closed opportunistically after
 *     each routed query via a ONE-SHOT unref'd setTimeout (no setInterval).
 *   • Circuit breaker per physical DB: 3 consecutive failures within 60s →
 *     'open' for 30s → 'half-open' (next query is a probe; success →
 *     'closed', failure → 'open' again).
 *   • shardQuery(): per-shard timeout (default 5s), ONE controlled retry on
 *     timeout/connection error when the breaker permits, SHARD_UNAVAILABLE
 *     error object when the physical DB is unavailable (callers continue
 *     with other shards); optional transparent primary fallback for writes
 *     during bootstrap (opts.allowPrimaryFallback + opts.fallback !== false).
 *
 * SECURITY: connection strings are NEVER logged or exposed — only masked
 * hosts ('ep-****.eu-central-1.aws.neon.tech' style) appear in logs/reports.
 */

import pg from 'pg';
import { logger } from '../../utils/logger.js';
import { AR10M_SHARD_COUNT } from './normalize.js';

/* --------------------------------- constants -------------------------------- */

export const SLOT_COUNT = 15;

const POOL_MAX = 3;
const POOL_IDLE_MS = 30_000;
const POOL_CONNECT_TIMEOUT_MS = 8_000;
const DEFAULT_QUERY_TIMEOUT_MS = 5_000;
export const IDLE_CLOSE_MS = 120_000;

const BREAKER_FAILURES = 3; // consecutive failures …
const BREAKER_WINDOW_MS = 60_000; // … within this window …
const BREAKER_OPEN_MS = 30_000; // … → open for this long → half-open

const WRITE_RE = /^\s*(insert|update|delete|create|drop|alter|truncate|copy|merge)\b/i;

/* ------------------------------ slot definitions ----------------------------- */

const envNameForSlot = (slot) => `ANIMAXIA_DB_${String(slot).padStart(2, '0')}`;

const connForSlot = (slot) => (process.env[envNameForSlot(slot)] || '').trim() || null;

/** Primary connection string: ANIMAXIA_DB_01 if set, else DATABASEURL. */
function primaryConnStr() {
  return connForSlot(1) || (process.env.DATABASEURL || '').trim() || null;
}

/** Slot 1 always hosts the PRIMARY physical pool. */
const PRIMARY_SLOT = 1;

/**
 * Mask a connection string's host for safe reporting:
 * 'ep-cool-123.eu-central-1.aws.neon.tech' → 'ep-****.eu-central-1.aws.neon.tech'.
 * Never returns user/password/db/port — host label prefix only.
 */
function maskHost(connStr) {
  try {
    const host = new URL(connStr).hostname.toLowerCase();
    const labels = host.split('.');
    if (labels.length < 2) return '****';
    const first = labels[0];
    const prefix = first.includes('-') ? first.slice(0, first.indexOf('-') + 1) : '';
    return `${prefix}****.${labels.slice(1).join('.')}`;
  } catch {
    return 'necunoscut';
  }
}

/** Mask an error message: strip connection strings and passwords. */
function maskError(err) {
  let msg = String(err?.message ?? err ?? 'unknown');
  msg = msg.replace(/postgres(ql)?:\/\/[^\s'"]+/gi, 'postgres://***');
  msg = msg.replace(/(password[=:]\s*)[^\s;]+/gi, '$1***');
  return msg.slice(0, 300);
}

/* ------------------------------ physical registry ---------------------------- */
/*
 * slots[0..14] = ANIMAXIA_DB_01..15. `entry` (pool + health state) is created
 * LAZILY — only for slots that actually receive traffic as physical targets.
 */
const slots = Array.from({ length: SLOT_COUNT }, (_, i) => ({
  slot: i + 1,
  name: envNameForSlot(i + 1),
  dedicatedConn: connForSlot(i + 1), // set when env var present (slot 1 may be set AND primary)
  entry: null,
}));

function connStrForSlot(slot) {
  return slot === PRIMARY_SLOT ? primaryConnStr() : connForSlot(slot);
}

/** Get (or create, WITHOUT opening a pool) the health entry for a physical slot. */
function getEntry(slot) {
  const s = slots[slot - 1];
  if (!s) return null;
  if (s.entry) return s.entry;
  const connStr = connStrForSlot(slot);
  if (!connStr) return null;
  s.entry = {
    slot,
    connStr, // NEVER exposed outside this module
    hostMasked: maskHost(connStr),
    pool: null, // lazy — created on first query
    state: {
      breaker: 'closed', // 'closed' | 'open' | 'half-open'
      failures: 0,
      windowStart: null,
      lastError: null,
      lastErrorAt: null,
      openedAt: null, // breaker opened at
      lastLatencyMs: null,
      lastUsedAt: null,
      poolOpenedAt: null,
      inFlight: 0,
      totalQueries: 0, // counts real DB round-trips (incl. retries)
      lastRowCount: null,
      lastSpaceBytes: null,
    },
    idleCloseTimer: null,
  };
  return s.entry;
}

/** Lazily create the pg.Pool for an entry (first query only — never at boot). */
function getPool(entry) {
  if (entry.pool) return entry.pool;
  const pool = new pg.Pool({
    connectionString: entry.connStr,
    max: POOL_MAX,
    idleTimeoutMillis: POOL_IDLE_MS,
    connectionTimeoutMillis: POOL_CONNECT_TIMEOUT_MS,
    // House style (db.js): explicit SSL when PGSSL=true — Neon requires it.
    ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined,
  });
  // Idle-client errors must not crash the process.
  pool.on('error', (err) => {
    logger.warn(`[ar10m/shard] pool error slot ${entry.slot} (${entry.hostMasked}): ${maskError(err).slice(0, 160)}`);
  });
  entry.pool = pool;
  entry.state.poolOpenedAt = Date.now();
  logger.info(`[ar10m/shard] pool OPENED slot ${entry.slot} (${entry.hostMasked}, max ${POOL_MAX}) — lazy, on first query`);
  return pool;
}

/* ------------------------------ circuit breaker ------------------------------ */

/** True when the breaker lets a query through ('closed' or 'half-open' probe). */
function breakerAllows(entry, now = Date.now()) {
  const st = entry.state;
  if (st.breaker === 'open') {
    if (now - st.openedAt >= BREAKER_OPEN_MS) {
      st.breaker = 'half-open'; // next query is the probe
      return true;
    }
    return false;
  }
  return true; // 'closed' | 'half-open'
}

function recordSuccess(entry) {
  const st = entry.state;
  st.breaker = 'closed';
  st.failures = 0;
  st.windowStart = null;
  st.lastError = null;
}

function recordFailure(entry, err) {
  const st = entry.state;
  const now = Date.now();
  st.lastError = maskError(err);
  st.lastErrorAt = now;
  if (st.breaker === 'half-open') {
    // failed probe → open again immediately
    st.breaker = 'open';
    st.openedAt = now;
    st.failures += 1;
    return;
  }
  if (st.windowStart === null || now - st.windowStart > BREAKER_WINDOW_MS) {
    st.windowStart = now;
    st.failures = 1;
  } else {
    st.failures += 1;
  }
  if (st.failures >= BREAKER_FAILURES) {
    st.breaker = 'open';
    st.openedAt = now;
    logger.warn(`[ar10m/shard] breaker OPEN slot ${entry.slot} (${entry.hostMasked}) — ${st.failures} consecutive failures`);
  }
}

/** Transient = timeout / connection-level error → eligible for one retry. */
function isTransient(err) {
  const code = String(err?.code ?? '');
  const msg = String(err?.message ?? '');
  if (code === 'AR10M_QUERY_TIMEOUT') return true;
  if (/^(ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|EHOSTUNREACH|ENETUNREACH)/.test(code)) return true;
  if (/connection terminated|connection error|timeout|server closed the connection unexpectedly/i.test(msg)) return true;
  return false;
}

/* ---------------------------- query execution core --------------------------- */

/**
 * Run one statement on an entry's pool with a hard per-query timeout.
 * Uses the callback form so the in-flight statement can be cancelled; the
 * client is ALWAYS released exactly once (late completion after a timeout is
 * discarded so the pool is never leaked).
 */
function runPooledQuery(entry, text, params, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let client = null;
    let released = false;
    let hardTimer = null;

    const releaseClient = (discard) => {
      if (!client || released) return;
      released = true;
      try {
        client.release(!!discard);
      } catch {
        /* already gone */
      }
    };

    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      reject(err);
    };

    getPool(entry)
      .connect()
      .then(
        (c) => {
          client = c;
          const query = client.query(text, params, (err, result) => {
            clearTimeout(hardTimer);
            releaseClient(settled ? true : !!err);
            if (settled) return; // timeout already rejected; statement ended late
            settled = true;
            if (err) {
              reject(err);
            } else {
              resolve(result);
            }
          });
          hardTimer = setTimeout(() => {
            if (settled) return;
            settled = true;
            try {
              query.cancel(); // best-effort statement cancel
            } catch {
              /* connection may already be dead */
            }
            // If the cancel never lands, force-discard the client after a
            // 5s grace so the pool is not leaked (one-shot, unref'd).
            setTimeout(() => releaseClient(true), 5_000).unref?.();
            const err = Object.assign(new Error(`shard query timeout after ${timeoutMs}ms`), { code: 'AR10M_QUERY_TIMEOUT' });
            reject(err);
          }, timeoutMs);
          hardTimer.unref?.();
        },
        (connErr) => fail(connErr),
      );
  });
}

/* -------------------- write tracking + distribution snapshot cache ----------- */

let lastWriteAt = null; // last write op routed (any slot) — /stats lastSyncAt

let distCache = { at: 0, data: null }; // 60s TTL, invalidated on writes

/** Invalidate the cached shard distribution (called on routed writes). */
export function invalidateDistributionCache() {
  distCache = { at: 0, data: null };
}

function trackWrite(text) {
  if (typeof text === 'string' && WRITE_RE.test(text)) {
    lastWriteAt = Date.now();
    invalidateDistributionCache();
  }
}

/** Last write op timestamp (ms epoch) or null — used by /stats lastSyncAt. */
export function getLastWriteAt() {
  return lastWriteAt;
}

/* ------------------------------ idle pool closing ---------------------------- */

function closeEntryIfIdle(entry, maxIdleMs) {
  const st = entry.state;
  const idleMs = st.lastUsedAt ? Date.now() - st.lastUsedAt : Infinity;
  if (!entry.pool || st.inFlight > 0 || idleMs < maxIdleMs) return false;
  const pool = entry.pool;
  entry.pool = null;
  st.poolOpenedAt = null;
  if (entry.idleCloseTimer) {
    clearTimeout(entry.idleCloseTimer);
    entry.idleCloseTimer = null;
  }
  pool.end().catch(() => {});
  logger.info(`[ar10m/shard] pool CLOSED slot ${entry.slot} (${entry.hostMasked}) — idle ${Math.round(idleMs)}ms, 0 in-flight`);
  return true;
}

/**
 * Opportunistic idle close: after each routed query, schedule a ONE-SHOT
 * unref'd check (no setInterval anywhere). Only closes when 0 in-flight and
 * idle > IDLE_CLOSE_MS.
 */
function scheduleIdleClose(entry) {
  if (entry.idleCloseTimer || !entry.pool) return;
  entry.idleCloseTimer = setTimeout(() => {
    entry.idleCloseTimer = null;
    closeEntryIfIdle(entry, IDLE_CLOSE_MS);
  }, IDLE_CLOSE_MS);
  entry.idleCloseTimer.unref?.();
}

/** Manually close every idle pool (idle > maxIdleMs, 0 in-flight). */
export function closeIdlePools(maxIdleMs = IDLE_CLOSE_MS) {
  let closed = 0;
  for (const s of slots) {
    if (s.entry && closeEntryIfIdle(s.entry, maxIdleMs)) closed += 1;
  }
  return closed;
}

/* ------------------------------ routing + retry ------------------------------ */

/**
 * Resolve the physical slot for a logical shard id: dedicated
 * ANIMAXIA_DB_(s+1) when configured, else the PRIMARY slot.
 */
export function resolvePhysicalSlot(logicalShardId) {
  const sid = Number(logicalShardId);
  if (!Number.isInteger(sid) || sid < 0 || sid >= AR10M_SHARD_COUNT) {
    throw new Error(`invalid logical shard id: ${logicalShardId} (valid: 0..${AR10M_SHARD_COUNT - 1})`);
  }
  return connForSlot(sid + 1) ? sid + 1 : PRIMARY_SLOT;
}

/**
 * Execute on a physical slot with breaker, timeout and ONE controlled retry
 * on transient (timeout/connection) errors. Throws { code: 'SHARD_UNAVAILABLE',
 * shardId, slot } when the physical DB is unavailable.
 */
async function executeOnSlot(slot, text, params, opts = {}) {
  const entry = getEntry(slot);
  if (!entry) {
    throw Object.assign(new Error(`physical slot ${slot} has no connection string configured`), {
      code: 'SHARD_UNAVAILABLE',
      shardId: opts.logicalShardId ?? null,
      slot,
    });
  }
  if (!breakerAllows(entry)) {
    throw Object.assign(new Error(`physical slot ${slot} (${entry.hostMasked}) unavailable — circuit breaker open`), {
      code: 'SHARD_UNAVAILABLE',
      shardId: opts.logicalShardId ?? null,
      slot,
    });
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;
  const st = entry.state;
  const t0 = Date.now();
  st.inFlight += 1;
  let attempt = 0;
  try {
    for (;;) {
      attempt += 1;
      st.totalQueries += 1; // counts real DB round-trips (incl. retries)
      try {
        const result = await runPooledQuery(entry, text, params, timeoutMs);
        const latency = Date.now() - t0;
        st.lastLatencyMs = latency;
        recordSuccess(entry);
        st.lastRowCount = result?.rowCount ?? result?.rows?.length ?? null;
        trackWrite(text);
        return result;
      } catch (err) {
        recordFailure(entry, err);
        const mayRetry = attempt === 1 && isTransient(err) && breakerAllows(entry);
        if (mayRetry) {
          logger.warn(
            `[ar10m/shard] slot ${slot} (${entry.hostMasked}) transient error (${err?.code ?? 'n/a'}) — ONE controlled retry: ${maskError(err).slice(0, 140)}`,
          );
          continue;
        }
        throw err;
      }
    }
  } finally {
    st.inFlight -= 1;
    st.lastUsedAt = Date.now();
    scheduleIdleClose(entry);
  }
}

/**
 * Route a query to the physical DB owning the logical shard. Options:
 *   • timeoutMs (default 5000)
 *   • fallback: false → never fall back to primary (fail-fast reads)
 *   • allowPrimaryFallback: true → when a DEDICATED target is unavailable,
 *     transparently re-run on PRIMARY (writes during bootstrap)
 */
export async function shardQuery(logicalShardId, text, params = [], opts = {}) {
  const targetSlot = resolvePhysicalSlot(logicalShardId);
  if (targetSlot === PRIMARY_SLOT) {
    return executeOnSlot(PRIMARY_SLOT, text, params, { ...opts, logicalShardId });
  }
  const entry = getEntry(targetSlot);
  const unavailable = !entry || !breakerAllows(entry);
  if (unavailable && opts.fallback !== false && opts.allowPrimaryFallback) {
    logger.warn(
      `[ar10m/shard] slot ${targetSlot} unavailable for logical shard ${logicalShardId} — transparent fallback to PRIMARY (bootstrap write)`,
    );
    return executeOnSlot(PRIMARY_SLOT, text, params, { ...opts, logicalShardId });
  }
  return executeOnSlot(targetSlot, text, params, { ...opts, logicalShardId });
}

/** Always the primary physical DB (migrations, counts, legacy joins). */
export async function primaryQuery(text, params = [], opts = {}) {
  return executeOnSlot(PRIMARY_SLOT, text, params, opts);
}

/* --------------------------------- reporting --------------------------------- */

function reportForSlot(s) {
  const isPrimary = s.slot === PRIMARY_SLOT;
  const connStr = connStrForSlot(s.slot);
  const dedicated = !!s.dedicatedConn;
  const e = s.entry;
  const mode = isPrimary ? 'primary' : dedicated ? 'dedicated' : 'inactive';
  return {
    slot: s.slot,
    name: s.name,
    configured: isPrimary ? !!connStr : dedicated,
    mode, // 'primary' | 'dedicated' | 'inactive' (inactive = logical shards route to primary)
    isPrimary,
    dedicated,
    hostMasked: connStr ? (e ? e.hostMasked : maskHost(connStr)) : null,
    poolActive: !!(e && e.pool),
    openConnections: e?.pool?.totalCount ?? 0,
    inFlight: e?.state.inFlight ?? 0,
    state: e ? e.state.breaker : 'inactive', // 'closed' | 'open' | 'half-open' | 'inactive' (niciodată null — consumatorii UI afișează sigur)
    failures: e?.state.failures ?? 0,
    lastLatencyMs: e?.state.lastLatencyMs ?? null,
    lastError: e?.state.lastError ?? null, // masked
    lastUsedAt: e?.state.lastUsedAt ?? null,
    lastRowCount: e?.state.lastRowCount ?? null,
    lastSpaceBytes: e?.state.lastSpaceBytes ?? null,
    totalQueries: e?.state.totalQueries ?? 0,
    routesTo: mode === 'inactive' ? PRIMARY_SLOT : null,
  };
}

/**
 * Per-slot health report: { primary: <slot-1 report>, slots: <15 reports> }.
 * NO secrets — hosts are masked, connection strings never leave this module.
 */
export function shardStatus() {
  return {
    primary: reportForSlot(slots[PRIMARY_SLOT - 1]),
    slots: slots.map(reportForSlot),
    shardCount: AR10M_SHARD_COUNT,
  };
}

/**
 * MANUAL metrics refresh (admin endpoint only — zero polling): for each
 * physical pool that is actually open, one real query measuring ar10m.content
 * row count + pg_database_size(). Updates in-memory state; per-slot results
 * (with latency) are returned honestly, errors included.
 */
export async function refreshShardMetrics() {
  const results = [];
  let ok = true;
  for (const s of slots) {
    if (!s.entry || !s.entry.pool) {
      results.push({ slot: s.slot, skipped: true, reason: s.entry ? 'pool-inactiv' : 'neconfigurat' });
      continue;
    }
    const t0 = Date.now();
    try {
      const r = await executeOnSlot(s.slot, 'SELECT (SELECT COUNT(*) FROM ar10m.content)::int AS rows, pg_database_size(current_database())::bigint AS bytes', [], {
        timeoutMs: DEFAULT_QUERY_TIMEOUT_MS,
      });
      const rows = Number(r.rows[0]?.rows ?? 0);
      const bytes = Number(r.rows[0]?.bytes ?? 0);
      s.entry.state.lastRowCount = rows;
      s.entry.state.lastSpaceBytes = bytes;
      results.push({ slot: s.slot, skipped: false, rows, spaceBytes: bytes, latencyMs: Date.now() - t0 });
    } catch (err) {
      ok = false;
      results.push({ slot: s.slot, skipped: false, error: maskError(err) });
    }
  }
  return { ok, results, refreshedAt: new Date().toISOString() };
}

/**
 * Shard distribution on the primary (SELECT shard_id, COUNT(*) GROUP BY),
 * 2s timeout, cached 60s in memory — invalidated on routed writes. Returns
 * an entry for EVERY logical shard 0..AR10M_SHARD_COUNT-1 (0 when absent).
 */
export async function distributionSnapshot() {
  if (distCache.data && Date.now() - distCache.at < 60_000) return distCache.data;
  const r = await primaryQuery(
    'SELECT shard_id, COUNT(*)::int AS rows FROM ar10m.content GROUP BY shard_id',
    [],
    { timeoutMs: 2_000 },
  );
  const byShard = new Map(r.rows.map((row) => [Number(row.shard_id), Number(row.rows)]));
  const total = [...byShard.values()].reduce((a, b) => a + b, 0);
  const data = Array.from({ length: AR10M_SHARD_COUNT }, (_, shardId) => {
    const rows = byShard.get(shardId) ?? 0;
    return { shardId, rows, pct: total > 0 ? Math.round((rows * 10000) / total) / 100 : 0 };
  });
  distCache = { at: Date.now(), data };
  return data;
}

/** Distinct physical DBs with a live pool (lazy-opened on first query). */
export function activeShardCount() {
  let n = 0;
  for (const s of slots) if (s.entry && s.entry.pool) n += 1;
  return n;
}

/** Pool gauges for the budget module (no secrets). */
export function poolGauges() {
  let poolsActive = 0;
  let totalConnections = 0;
  let inFlight = 0;
  for (const s of slots) {
    if (s.entry && s.entry.pool) {
      poolsActive += 1;
      totalConnections += s.entry.pool.totalCount ?? 0;
      inFlight += s.entry.state.inFlight;
    }
  }
  return { poolsActive, totalConnections, inFlight };
}

/**
 * Honest storage metric for the budget module: pg_database_size() of the
 * primary, as measured by the last refreshShardMetrics()/stats piggyback —
 * null until someone actually measured it (no invented values).
 */
export function primaryStorageBytes() {
  const e = slots[PRIMARY_SLOT - 1].entry;
  return e?.state.lastSpaceBytes ?? null;
}

/**
 * Piggyback hook: record primary row-count/space measured by /stats so the
 * budget module sees REAL numbers without extra DB traffic.
 */
export function recordPrimaryMetrics({ rowCount = null, spaceBytes = null } = {}) {
  const entry = getEntry(PRIMARY_SLOT);
  if (!entry) return;
  if (rowCount !== null) entry.state.lastRowCount = rowCount;
  if (spaceBytes !== null) entry.state.lastSpaceBytes = spaceBytes;
}
