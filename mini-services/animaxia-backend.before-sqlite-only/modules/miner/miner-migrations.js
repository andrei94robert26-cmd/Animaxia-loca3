/**
 * modules/miner/miner-migrations.js — FAZA 12 (additive) miner DDL.
 *
 * Idempotent CREATE TABLE IF NOT EXISTS statements, house style (lowercase,
 * no underscores) matching platform/tenant migrations. Runs at boot after
 * ensureTenantSchema(); safe to re-run on Neon PostgreSQL and a no-op on the
 * local fallback driver (rows() swallows errors there).
 *
 * New tables (miner-owned; the `content` library itself is untouched —
 * isolation happens through these rows + vectorembeddings.tenantid):
 *   miner_jobs      — persistent job queue (survives restarts, unlike the
 *                     in-memory workers pool): queued|running|done|failed
 *   miner_sources   — provider ↔ content mapping per tenant (provenance +
 *                     lastSync bookkeeping for incremental syncs)
 *   miner_logs      — structured per-job log lines (level + message)
 *   miner_manifests — HLS manifest inventory (contentId + url + host +
 *                     lastChecked), filled by the manifest-sweep job
 *
 * All tenant-scoped tables default tenantid to 'global' so pre-FAZA-12
 * callers and the implicit platform tenant keep working unchanged.
 */

import { logger } from '../../utils/logger.js';
import { rows } from '../platform/sql.js';

const DDL_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS miner_jobs (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    tenantid TEXT NOT NULL DEFAULT 'global',
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    result JSONB,
    error TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    createdby INTEGER,
    queuedat TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    startedat TIMESTAMPTZ,
    finishedat TIMESTAMPTZ
  )`,
  `CREATE INDEX IF NOT EXISTS idx_miner_jobs_status ON miner_jobs (status, queuedat DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_miner_jobs_tenant ON miner_jobs (tenantid, queuedat DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_miner_jobs_type ON miner_jobs (type)`,
  `CREATE TABLE IF NOT EXISTS miner_sources (
    id SERIAL PRIMARY KEY,
    provider TEXT NOT NULL,
    externalid TEXT NOT NULL,
    contentid INTEGER NOT NULL,
    tenantid TEXT NOT NULL DEFAULT 'global',
    meta JSONB,
    lastsync TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (provider, externalid, tenantid)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_miner_sources_tenant ON miner_sources (tenantid, provider)`,
  `CREATE INDEX IF NOT EXISTS idx_miner_sources_content ON miner_sources (contentid)`,
  `CREATE TABLE IF NOT EXISTS miner_logs (
    id SERIAL PRIMARY KEY,
    jobid TEXT NOT NULL,
    level TEXT NOT NULL DEFAULT 'info',
    message TEXT NOT NULL,
    ts TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_miner_logs_job ON miner_logs (jobid, ts DESC)`,
  `CREATE TABLE IF NOT EXISTS miner_manifests (
    id SERIAL PRIMARY KEY,
    contentid INTEGER NOT NULL,
    manifesturl TEXT NOT NULL,
    host TEXT,
    tenantid TEXT NOT NULL DEFAULT 'global',
    status TEXT NOT NULL DEFAULT 'unknown',
    lastchecked TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (contentid, manifesturl, tenantid)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_miner_manifests_tenant ON miner_manifests (tenantid, lastchecked DESC)`,
];

/**
 * Ensure all FAZA 12 miner tables exist. Idempotent. Returns the applied
 * statement count. Throws on the first failing statement on Neon (boot then
 * logs the degradation loudly — miner routes answer 503, rest unaffected).
 */
export async function ensureMinerSchema() {
  let applied = 0;
  for (const statement of DDL_STATEMENTS) {
    try {
      await rows(statement);
      applied += 1;
    } catch (err) {
      logger.error(`[miner] Migration statement failed: ${err.message}`);
      throw err;
    }
  }
  logger.info(
    `[miner] Schema verified — ${applied}/${DDL_STATEMENTS.length} statements OK (miner_jobs, miner_sources, miner_logs, miner_manifests)`,
  );
  return { applied, total: DDL_STATEMENTS.length };
}

export default ensureMinerSchema;
