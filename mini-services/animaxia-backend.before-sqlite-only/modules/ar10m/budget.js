/**
 * modules/ar10m/budget.js — Neon free-budget module (Task AR10M-2-BE).
 * HONEST by design: every number is either MEASURED in-process, manually
 * supplied via env, or marked 'indisponibil'. NO DB polling, NO Neon API
 * calls, NO invented values.
 *
 * Measured in memory (zero polling):
 *   • queriesTotal + queriesPerMin — rolling 60s window of ar10m search
 *     queries (recordSearchQuery, capped 10k timestamps).
 *   • cacheHits/cacheHitRate — recorded by the search gateway.
 *   • activeShards/activePools — live gauges from the shard router (lazy
 *     pools actually open right now).
 *   • storageBytes — pg_database_size() of the primary as measured by the
 *     last refreshShardMetrics()/stats piggyback (null until measured).
 *
 * Manually supplied (env, documented — no API):
 *   • NEON_CU_HOURS_USED / NEON_CU_HOURS_LIMIT → cuHours pct (else the
 *     snapshot reports cuHours: 'indisponibil').
 *   • NEON_TRANSFER_BYTES_USED → transferBytes override (else 'indisponibil').
 *
 * Level (pctUsed = max of the AVAILABLE pcts): <70 normal, >=70 warning,
 * >=85 economic (economicMode AUTO-ENABLED, logged), >=95 critical (search
 * limit max 10, autocomplete disabled), >=100 max (search-only survival).
 * Thresholds are evaluated on each budgetSnapshot() call — no timers, no
 * crash ever. economicGate(feature) blocks ['ai','miner','reindex',
 * 'analytics','admin-heavy'] while economic mode is on.
 */

import { logger } from '../../utils/logger.js';
import { poolGauges, activeShardCount, primaryStorageBytes } from './shard-router.js';

/** Neon free tier storage limit (512 MB) — real, measurable against pg_database_size(). */
export const NEON_FREE_STORAGE_BYTES = 512 * 1024 * 1024;

/** Soft search budget: 100 ar10m searches/min. */
export const SOFT_QPM_LIMIT = 100;

const THRESHOLDS = { warn: 70, economy: 85, critical: 95, max: 100 };
const GATED_FEATURES = ['ai', 'miner', 'reindex', 'analytics', 'admin-heavy'];

const state = {
  queriesTotal: 0,
  qTimestamps: [], // rolling 60s window, capped 10k
  cacheHits: 0,
  cacheMisses: 0,
  economicMode: false,
  lastLevel: 'normal',
  lastLevelAt: null,
};

function numEnv(name) {
  const v = process.env[name];
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/* ------------------------------ counters (push) ------------------------------- */

/** Called by the search gateway on every search/autocomplete invocation. */
export function recordSearchQuery() {
  const now = Date.now();
  state.queriesTotal += 1;
  state.qTimestamps.push(now);
  if (state.qTimestamps.length > 10_000) state.qTimestamps.splice(0, state.qTimestamps.length - 10_000);
}

export function recordCacheHit() {
  state.cacheHits += 1;
}

export function recordCacheMiss() {
  state.cacheMisses += 1;
}

function pruneQpm(now = Date.now()) {
  const cutoff = now - 60_000;
  let i = 0;
  while (i < state.qTimestamps.length && state.qTimestamps[i] < cutoff) i += 1;
  if (i > 0) state.qTimestamps.splice(0, i);
}

function cacheHitRate() {
  const total = state.cacheHits + state.cacheMisses;
  return total > 0 ? Math.round((state.cacheHits * 10000) / total) / 100 : 0;
}

/* --------------------------------- level math --------------------------------- */

function computeLevel() {
  pruneQpm();
  const storageBytes = primaryStorageBytes();
  const cuUsed = numEnv('NEON_CU_HOURS_USED');
  const cuLimit = numEnv('NEON_CU_HOURS_LIMIT');
  const transferBytes = numEnv('NEON_TRANSFER_BYTES_USED');

  const storagePct = storageBytes !== null && storageBytes > 0 ? (storageBytes / NEON_FREE_STORAGE_BYTES) * 100 : null;
  const cuPct = cuUsed !== null && cuLimit !== null && cuLimit > 0 ? (cuUsed / cuLimit) * 100 : null;
  const qpmPct = (state.qTimestamps.length / SOFT_QPM_LIMIT) * 100;

  const pcts = [storagePct, cuPct, qpmPct].filter((v) => v !== null && Number.isFinite(v));
  const pctUsed = pcts.length > 0 ? Math.max(...pcts) : 0;

  let level = 'normal';
  if (pctUsed >= THRESHOLDS.max) level = 'max';
  else if (pctUsed >= THRESHOLDS.critical) level = 'critical';
  else if (pctUsed >= THRESHOLDS.economy) level = 'economic';
  else if (pctUsed >= THRESHOLDS.warn) level = 'warning';

  const r1 = (v) => (v === null ? null : Math.round(v * 10) / 10);
  return {
    level,
    pctUsed,
    storageBytes,
    transferBytes,
    cuUsed,
    cuLimit,
    qpm: state.qTimestamps.length,
    sources: {
      storage: { pct: r1(storagePct), limitBytes: NEON_FREE_STORAGE_BYTES, basis: 'pg_database_size(primary) / 512MB Neon free — măsurat la ultima rulare refresh-metrics/stats' },
      cuHours: { pct: r1(cuPct), basis: 'NEON_CU_HOURS_USED / NEON_CU_HOURS_LIMIT din env (manual, fără polling API Neon)' },
      qpm: { pct: r1(qpmPct), softLimitPerMin: SOFT_QPM_LIMIT, basis: 'căutări ar10m/min în memoria procesului' },
    },
  };
}

/** Current honest budget level (no side effects) — used by the search gateway. */
export function budgetLevel() {
  return computeLevel().level;
}

/* --------------------------------- snapshot ----------------------------------- */

/**
 * Full budget snapshot (evaluated on call — each /budget or /stats request
 * piggybacks the evaluation; zero timers). Level transitions are logged once
 * per change and >=85 auto-enables economic mode. Never throws.
 */
export function budgetSnapshot() {
  let m;
  try {
    m = computeLevel();
  } catch (err) {
    logger.warn(`[ar10m/budget] computeLevel failed (honest fallback normal): ${err?.message ?? err}`);
    m = { level: 'normal', pctUsed: 0, storageBytes: null, transferBytes: null, cuUsed: null, cuLimit: null, qpm: 0, sources: {} };
  }

  if (m.level !== state.lastLevel) {
    logger.info(`[ar10m/budget] level ${state.lastLevel} → ${m.level} (pctUsed ${Math.round(m.pctUsed * 10) / 10})`);
    state.lastLevel = m.level;
    state.lastLevelAt = Date.now();
  }
  const idx = ['normal', 'warning', 'economic', 'critical', 'max'].indexOf(m.level);
  if (idx >= 2 && !state.economicMode) {
    state.economicMode = true;
    logger.warn('[ar10m/budget] economicMode AUTO-ENABLED (>= 85% din buget) — ai/miner/reindex/analytics blocate cu 503');
  }
  // Recovery back to normal never auto-disables economic mode — an admin
  // decides (POST /admin/economic { on:false }); honest and predictable.

  const gauges = poolGauges();
  return {
    usage: {
      cuHours: m.cuUsed !== null ? m.cuUsed : 'indisponibil', // no Neon API polling — manual env only
      transferBytes: m.transferBytes !== null ? m.transferBytes : 'indisponibil', // no real telemetry
      storageBytes: m.storageBytes, // null until actually measured
      queriesPerMin: m.qpm,
      queriesTotal: state.queriesTotal,
      cacheHitRate: cacheHitRate(),
      activeShards: activeShardCount(),
      activePools: gauges.poolsActive,
      openConnections: gauges.totalConnections,
    },
    thresholds: THRESHOLDS,
    level: m.level,
    pctUsed: Math.round(m.pctUsed * 10) / 10,
    economicMode: state.economicMode,
    sources: m.sources,
    asOf: new Date().toISOString(),
  };
}

/* ------------------------------- economic mode --------------------------------- */

/** Enable/disable economic mode (admin). Returns the new state. */
export function setEconomicMode(on) {
  const next = !!on;
  if (next !== state.economicMode) {
    state.economicMode = next;
    logger.warn(`[ar10m/budget] economicMode ${next ? 'ACTIVAT' : 'DEZACTIVAT'} (manual, admin)`);
  }
  return state.economicMode;
}

export function isEconomicMode() {
  return state.economicMode;
}

/**
 * Middleware helper: while economic mode is on, the gated features
 * ['ai','miner','reindex','analytics','admin-heavy'] are blocked with 503.
 * Returns { blocked:false } or { blocked:true, status, payload }.
 */
export function economicGate(feature) {
  if (!state.economicMode) return { blocked: false };
  if (GATED_FEATURES.includes(feature)) {
    return {
      blocked: true,
      status: 503,
      payload: { ok: false, reason: 'economic-mode', feature, message: 'Funcționalitate suspendată temporar pentru protejarea bugetului Neon free.' },
    };
  }
  return { blocked: false };
}
