/**
 * Opt-in automatic scheduling for existing persistent miner provider jobs.
 *
 * TMDB and Jikan are the only provider fetchers currently wired end-to-end
 * in this backend. Jobs are stored in miner_jobs; worker retries/availability
 * follow the existing miner pipeline. No fake "88 active API" claims.
 */
import { one, rows } from '../platform/sql.js';
import { scheduleJob } from './core.js';
import { logger } from '../../utils/logger.js';

const SUPPORTED = Object.freeze({
  tmdb: { type: 'tmdb-sync', payload: { page: 1, mode: 'trending' } },
  jikan: { type: 'jikan-sync', payload: { page: 1 } },
});
let timer = null;
let ticking = false;
let lastRun = null;
const minutes = () => Math.min(1440, Math.max(15,
  Number.parseInt(process.env.ANIMAXIA_AUTO_SYNC_MINUTES, 10) || 180));
const configuredProviders = () => {
  const raw = (process.env.ANIMAXIA_AUTO_SYNC_PROVIDERS || 'tmdb,jikan').split(',');
  return [...new Set(raw.map((x) => x.trim().toLowerCase()))]
    .filter((name) => Object.hasOwn(SUPPORTED, name));
};
export function autoSyncConfig() {
  return {
    enabled: process.env.ANIMAXIA_AUTO_SYNC_ENABLED === 'true',
    providers: configuredProviders(), intervalMinutes: minutes(),
    timerActive: timer !== null, lastRun,
    storage: 'miner_jobs (SQLite)', distributed: false,
  };
}
export async function autoSyncTick() {
  if (ticking) return { skipped: 'already-running' };
  const config = autoSyncConfig();
  if (!config.enabled) return { skipped: 'disabled' };
  ticking = true;
  const results = [];
  try {
    for (const provider of config.providers) {
      if (provider === 'tmdb' && !process.env.TMDBAPIKEY) {
        results.push({ provider, status: 'not-configured' });
        continue;
      }
      const spec = SUPPORTED[provider];
      // Reuse the existing persisted miner_jobs log as the schedule ledger.
      // In-flight/recent jobs keep the scheduler from flooding providers.
      const recent = await one(`
        SELECT COUNT(*) AS n FROM miner_jobs
        WHERE type=? AND tenantid='global'
          AND (status IN ('queued','running')
          OR queuedat >= datetime('now',?))
      `, [spec.type, '-' + config.intervalMinutes + ' minutes']);
      if (Number(recent?.n || 0) > 0) {
        results.push({ provider, status: 'recent-or-inflight' });
        continue;
      }
      try {
        const job = await scheduleJob(spec.type, 'global', spec.payload);
        results.push({ provider, status: 'queued', jobId: job.id });
      } catch (error) {
        results.push({ provider, status: 'error', reason: String(error?.message || error).slice(0, 150) });
      }
    }
    lastRun = { at: new Date().toISOString(), results };
    return lastRun;
  } finally { ticking = false; }
}
export async function autoSyncProviderStatus() {
  const last = await rows(`
    SELECT type, status, attempts, queuedat, finishedat, error
    FROM miner_jobs WHERE type IN ('tmdb-sync','jikan-sync')
    ORDER BY queuedat DESC LIMIT 40
  `);
  const recent = {};
  for (const job of last) {
    const provider = job.type === 'tmdb-sync' ? 'tmdb' : 'jikan';
    if (!recent[provider]) recent[provider] = {
      status: job.status, attempts: Number(job.attempts),
      queuedAt: job.queuedat, finishedAt: job.finishedat,
      error: job.error ? String(job.error).slice(0, 200) : null,
    };
  }
  return { ...autoSyncConfig(), sources: recent };
}
export function startMinerAutoSync() {
  if (timer || process.env.ANIMAXIA_AUTO_SYNC_ENABLED !== 'true') return false;
  // Schedule immediately after boot, then periodically check a durable ledger.
  const launch = () => autoSyncTick().catch((err) =>
    logger.warn('[miner-auto-sync] tick failed: ' + err.message));
  const first = setTimeout(launch, 2000);
  first.unref?.();
  timer = setInterval(launch, 60_000);
  timer.unref?.();
  logger.info('[miner-auto-sync] enabled providers=' + configuredProviders().join(',') +
    ', intervalMinutes=' + minutes());
  return true;
}
export function stopMinerAutoSync() {
  if (timer) clearInterval(timer);
  timer = null;
}
