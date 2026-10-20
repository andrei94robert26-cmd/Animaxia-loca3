/**
 * Single-instance opt-in polling for explicitly installed JSON metadata APIs.
 * Uses durable SQLite cadence state and the existing idempotent ingestion queue.
 * The original TMDB/Jikan miner scheduler is a separate pipeline.
 */
import crypto from 'node:crypto';
import { localDb } from '../local/sqlite.js';
import { DRIVER_IDS, providerReadiness } from './catalog.js';
import { fetchProviderMetadata } from './fetch.js';
import { recordProviderFetch } from './health.js';
import { enqueueMetadataBatch } from '../ingest/queue.js';
import { logger } from '../../utils/logger.js';

const ALLOWED = new Set(DRIVER_IDS);
let timer = null;
let ticking = false;
let schemaReady = false;
const intervalMinutes = () => Math.max(15, Math.min(1440,
  Number.parseInt(process.env.ANIMAXIA_PROVIDER_AUTO_SYNC_MINUTES, 10) || 180));
const configured = () => [...new Set(
  (process.env.ANIMAXIA_PROVIDER_AUTO_SYNC_PROVIDERS || 'kitsu,tvmaze,rickmorty,swapi,freetogame')
    .split(',').map((s) => s.trim().toLowerCase()).filter((id) => ALLOWED.has(id))
)].slice(0,12);
function queries() {
  try {
    const parsed = JSON.parse(process.env.ANIMAXIA_PROVIDER_AUTO_SYNC_QUERIES_JSON || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed;
  } catch { return {}; }
}
export function ensureProviderPollSchema() {
  if (schemaReady) return;
  localDb.exec(`
    CREATE TABLE IF NOT EXISTS provider_poll_state (
      providerid TEXT PRIMARY KEY,
      attempts INTEGER NOT NULL DEFAULT 0,
      lastattempt TEXT,
      lastsuccess TEXT,
      nextafter TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      failures INTEGER NOT NULL DEFAULT 0,
      laststatus TEXT NOT NULL DEFAULT 'never-checked',
      lastjob TEXT,
      lasterror TEXT
    );
  `);
  schemaReady = true;
}
export function providerAutoSyncStatus() {
  ensureProviderPollSchema();
  const states = localDb.prepare('SELECT * FROM provider_poll_state ORDER BY providerid').all();
  return {
    enabled: process.env.ANIMAXIA_PROVIDER_AUTO_SYNC_ENABLED === 'true',
    workerEnabled: process.env.ANIMAXIA_METADATA_QUEUE_WORKER === 'true',
    timerActive: timer !== null, intervalMinutes: intervalMinutes(),
    providers: configured(), storage: 'sqlite', distributed: false,
    states: states.map((s) => ({
      id: s.providerid, attempts: Number(s.attempts), failures: Number(s.failures),
      lastAttemptAt: s.lastattempt, lastSuccessAt: s.lastsuccess,
      nextAttemptAt: s.nextafter, lastStatus: s.laststatus,
      lastJobId: s.lastjob, lastError: s.lasterror,
    })),
  };
}
export async function pollProviderTick(fetchImpl = globalThis.fetch) {
  if (ticking) return { skipped: 'already-running' };
  if (process.env.ANIMAXIA_PROVIDER_AUTO_SYNC_ENABLED !== 'true') return { skipped: 'disabled' };
  if (process.env.ANIMAXIA_METADATA_QUEUE_WORKER !== 'true') {
    return { skipped: 'metadata-worker-disabled' };
  }
  ensureProviderPollSchema();
  ticking = true;
  try {
    const qById = queries();
    const interval = intervalMinutes();
    for (const id of configured()) {
      const ready = providerReadiness(id);
      if (!ready?.readyForSync) continue;
      const last = localDb.prepare('SELECT * FROM provider_poll_state WHERE providerid=?').get(id);
      if (last && Date.parse(last.nextafter || '') > Date.now()) continue;
      const rawQuery = qById[id];
      const query = typeof rawQuery === 'string' && rawQuery.length <= 120 ? rawQuery.trim() : '';
      // APIs that only support search must receive an explicit configured term.
      if (['omdb','itunes','cheapshark','gdelt','scryfall'].includes(id) && query.length < 2) {
        continue;
      }
      if (id === 'freetogame' && query) continue;
      const stamp = new Date().toISOString();
      const next = new Date(Date.now() + interval * 60_000).toISOString();
      localDb.prepare(`
        INSERT INTO provider_poll_state(providerid,attempts,lastattempt,nextafter,laststatus)
        VALUES(?,1,?,?,'fetching')
        ON CONFLICT(providerid) DO UPDATE SET
          attempts=attempts+1,lastattempt=excluded.lastattempt,
          nextafter=excluded.nextafter,laststatus=excluded.laststatus
      `).run(id, stamp, next);
      try {
        const batch = await fetchProviderMetadata(id, { q: query, page: 1 }, fetchImpl);
        recordProviderFetch(id, { ok: true, count: batch.count });
        let job = null;
        if (batch.count > 0) {
          const digest = crypto.createHash('sha256')
            .update(JSON.stringify({ q: batch.query, page: batch.page, items: batch.items }))
            .digest('hex').slice(0,36);
          job = enqueueMetadataBatch({
            source: batch.source, items: batch.items,
            idempotencyKey: 'provider:' + id + ':' + digest,
          });
        }
        localDb.prepare(`
          UPDATE provider_poll_state SET
            lastsuccess=?,failures=0,laststatus=?,lastjob=?,lasterror=NULL
          WHERE providerid=?
        `).run(stamp, job ? (job.queued ? 'queued' : 'duplicate') : 'no-results', job?.id || null, id);
        return { provider: id, fetched: batch.count, queued: Boolean(job?.queued),
          jobId: job?.id || null, status: 'success' };
      } catch (error) {
        recordProviderFetch(id, { ok: false, error: error?.message });
        const prior = Number(last?.failures || 0);
        const failures = prior + 1;
        const cooldown = Math.min(24 * 60, interval * Math.min(2 ** Math.min(failures, 4), 16));
        const following = new Date(Date.now() + cooldown * 60_000).toISOString();
        localDb.prepare(`
          UPDATE provider_poll_state SET
            failures=?,nextafter=?,laststatus='error',lasterror=?
          WHERE providerid=?
        `).run(failures, following, String(error?.message || error).slice(0,200),id);
        logger.warn('[provider-auto-sync] ' + id + ': ' + String(error?.message || error).slice(0,160));
        return { provider: id, status: 'error', failures };
      }
    }
    return { skipped: 'no-ready-provider-due' };
  } finally { ticking = false; }
}
export function startProviderAutoSync() {
  if (timer || process.env.ANIMAXIA_PROVIDER_AUTO_SYNC_ENABLED !== 'true') return false;
  if (process.env.ANIMAXIA_METADATA_QUEUE_WORKER !== 'true') {
    logger.warn('[provider-auto-sync] metadata worker disabled; scheduler not started');
    return false;
  }
  ensureProviderPollSchema();
  const tick = () => pollProviderTick().catch((error) =>
    logger.warn('[provider-auto-sync] unexpected tick error: ' + error.message));
  const boot = setTimeout(tick, 8_000);
  boot.unref?.();
  timer = setInterval(tick, 60_000);
  timer.unref?.();
  logger.info('[provider-auto-sync] enabled for ' + configured().join(','));
  return true;
}
export function stopProviderAutoSync() {
  if (timer) clearInterval(timer);
  timer = null;
}
