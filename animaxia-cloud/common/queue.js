/**
 * common/queue.js — Durable PostgreSQL-backed job queue for Animaxia Cloud
 * (no Redis dependency): table `jobs` with `FOR UPDATE SKIP LOCKED` claiming,
 * per-job leases (stale reclaim), priority ordering, retry with quadratic
 * backoff and dead-letter status. Used by queue-service for async miner,
 * prefetch, AI/analytics/indexing batches, provider refresh and maintenance
 * cron jobs (BLUEPRINT §10).
 *
 * Metrics: animaxia_queue_depth{type,status} gauge,
 *          animaxia_queue_job_duration_seconds{type} histogram.
 */

import { query } from './db.js';
import { logger } from './logger.js';
import { Gauge, Histogram, registerMetric } from './metrics.js';

const QUEUE_DDL = `
CREATE TABLE IF NOT EXISTS jobs (
  id BIGSERIAL PRIMARY KEY,
  type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending',
  priority INT NOT NULL DEFAULT 0,
  attempts INT NOT NULL DEFAULT 0,
  maxattempts INT NOT NULL DEFAULT 3,
  runat TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lockedby TEXT,
  lockedat TIMESTAMPTZ,
  leaseexpiresat TIMESTAMPTZ,
  lasterror TEXT,
  result JSONB,
  createdat TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updatedat TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finishedat TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_jobs_status_runat ON jobs (status, priority DESC, runat);
CREATE INDEX IF NOT EXISTS idx_jobs_type_status ON jobs (type, status);
`;

const VALID_STATUSES = ['pending', 'running', 'done', 'failed', 'dead'];

const queueDepthGauge = registerMetric(
  new Gauge({ name: 'animaxia_queue_depth', help: 'Queue job count by type and status', labelNames: ['type', 'status'] }),
);

const queueDuration = registerMetric(
  new Histogram({ name: 'animaxia_queue_job_duration_seconds', help: 'Job execution duration by type', labelNames: ['type'] }),
);

const RETENTION_DAYS = parseInt(process.env.QUEUERETENTIONDAYS || '7', 10);
const LEASE_SEC = parseInt(process.env.QUEUEWORKERTTLSEC || '180', 10);

export const JOB_TYPES = [
  'miner.mine',
  'miner.prefetch',
  'ai.batch',
  'analytics.batch',
  'indexing.batch',
  'providers.refresh',
  'thumbnails.generate',
  'maintenance.cleanup-logs',
  'maintenance.cleanup-audit',
  'maintenance.cleanup-sessions',
  'maintenance.reindex',
];

function serializeJob(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    type: row.type,
    payload: row.payload && typeof row.payload === 'object' ? row.payload : {},
    status: row.status,
    priority: Number(row.priority || 0),
    attempts: Number(row.attempts || 0),
    maxattempts: Number(row.maxattempts || 3),
    runat: row.runat instanceof Date ? row.runat.toISOString() : String(row.runat),
    lockedby: row.lockedby || null,
    lockedat: row.lockedat instanceof Date ? row.lockedat.toISOString() : row.lockedat || null,
    lasterror: row.lasterror || null,
    result: row.result && typeof row.result === 'object' ? row.result : null,
    createdat: row.createdat instanceof Date ? row.createdat.toISOString() : String(row.createdat),
    updatedat: row.updatedat instanceof Date ? row.updatedat.toISOString() : String(row.updatedat),
    finishedat: row.finishedat instanceof Date ? row.finishedat.toISOString() : row.finishedat || null,
  };
}

/** Idempotent schema bootstrap (call at queue-service boot; harmless elsewhere). */
export async function ensureQueueSchema() {
  await query(QUEUE_DDL);
}

/** Enqueue a job. Returns the serialized job row. */
export async function enqueue({ type, payload = {}, priority = 0, runAt = null, maxAttempts = 3 } = {}) {
  if (!type || typeof type !== 'string' || type.length > 100) {
    const err = new Error('Job type required (string, max 100 chars)');
    err.status = 400;
    throw err;
  }
  const res = await query(
    `INSERT INTO jobs (type, payload, priority, runat, maxattempts)
     VALUES ($1, $2::jsonb, $3, COALESCE($4::timestamptz, NOW()), $5)
     RETURNING *`,
    [type, JSON.stringify(payload ?? {}), Math.trunc(priority) || 0, runAt ? new Date(runAt).toISOString() : null, Math.max(1, Math.trunc(maxAttempts) || 3)],
  );
  const job = serializeJob(res.rows[0]);
  logger.info(`[queue] enqueued #${job.id} ${job.type} (priority ${job.priority})`, { jobId: job.id, type: job.type });
  return job;
}

/**
 * Atomically claim up to `limit` runnable jobs for a worker.
 * SELECT ... FOR UPDATE SKIP LOCKED keeps multiple consumers safe.
 */
export async function claimJobs({ worker = 'worker-1', limit = 1, types = null } = {}) {
  const typeFilter = Array.isArray(types) && types.length ? 'AND type = ANY($3::text[])' : '';
  const params = [worker, Math.max(1, Math.min(10, limit))];
  if (typeFilter) params.push(types);
  const res = await query(
    `UPDATE jobs SET
       status = 'running',
       lockedby = $1,
       lockedat = NOW(),
       leaseexpiresat = NOW() + (${LEASE_SEC} * INTERVAL '1 second'),
       attempts = attempts + 1,
       updatedat = NOW()
     WHERE id IN (
       SELECT id FROM jobs
       WHERE status = 'pending' AND runat <= NOW() ${typeFilter}
       ORDER BY priority DESC, runat ASC, id ASC
       LIMIT $2
       FOR UPDATE SKIP LOCKED
     )
     RETURNING *`,
    params,
  );
  return res.rows.map(serializeJob);
}

/** Mark done (records duration metric). */
export async function completeJob(id, result = null, { startedAtMs = null } = {}) {
  const res = await query(
    `UPDATE jobs SET status = 'done', result = $2::jsonb, finishedat = NOW(), updatedat = NOW(),
       lockedby = NULL, lockedat = NULL, leaseexpiresat = NULL
     WHERE id = $1 RETURNING *`,
    [Number(id), JSON.stringify(result ?? { ok: true })],
  );
  const job = serializeJob(res.rows[0]);
  if (job && startedAtMs) {
    queueDuration.observe({ type: job.type }, (Date.now() - startedAtMs) / 1000);
  }
  return job;
}

/** Fail a job: retry with quadratic backoff or dead-letter after maxattempts. */
export async function failJob(id, errorMessage, { startedAtMs = null } = {}) {
  const res = await query(
    `UPDATE jobs SET
       status = CASE WHEN attempts >= maxattempts THEN 'dead' ELSE 'pending' END,
       runat = CASE WHEN attempts >= maxattempts THEN runat ELSE NOW() + ((POWER(attempts, 2) * 5) * INTERVAL '1 second') END,
       lasterror = $2,
       updatedat = NOW(),
       finishedat = CASE WHEN attempts >= maxattempts THEN NOW() ELSE finishedat END,
       lockedby = NULL, lockedat = NULL, leaseexpiresat = NULL
     WHERE id = $1
     RETURNING *`,
    [Number(id), String(errorMessage || 'unknown error').slice(0, 1000)],
  );
  const job = serializeJob(res.rows[0]);
  if (job && startedAtMs) {
    queueDuration.observe({ type: job.type }, (Date.now() - startedAtMs) / 1000);
  }
  return job;
}

/** Reclaim jobs whose lease expired (crashed workers). Returns reclaimed count. */
export async function requeueStale() {
  const res = await query(
    `UPDATE jobs SET status = 'pending', lockedby = NULL, lockedat = NULL, leaseexpiresat = NULL,
       lasterror = COALESCE(lasterror, 'lease expired — reclaimed'), updatedat = NOW()
     WHERE status = 'running' AND leaseexpiresat < NOW()
     RETURNING id`,
  );
  if (res.rows.length) {
    logger.warn(`[queue] reclaimed ${res.rows.length} stale job(s)`);
  }
  return res.rows.length;
}

/** Retry a dead/failed job manually. */
export async function retryJob(id) {
  const res = await query(
    `UPDATE jobs SET status = 'pending', attempts = 0, runat = NOW(), lasterror = NULL,
       finishedat = NULL, updatedat = NOW(), lockedby = NULL, lockedat = NULL, leaseexpiresat = NULL
     WHERE id = $1 AND status IN ('dead', 'failed') RETURNING *`,
    [Number(id)],
  );
  return serializeJob(res.rows[0]);
}

export async function deleteJob(id) {
  const res = await query('DELETE FROM jobs WHERE id = $1 RETURNING id', [Number(id)]);
  return res.rows.length > 0;
}

/** Delete finished jobs older than the retention window. Returns deleted count. */
export async function purgeFinished({ olderThanDays = RETENTION_DAYS } = {}) {
  const res = await query(
    `DELETE FROM jobs
     WHERE status IN ('done', 'failed', 'dead')
       AND COALESCE(finishedat, updatedat) < NOW() - ($1 * INTERVAL '1 day')
     RETURNING id`,
    [Math.max(0, olderThanDays)],
  );
  return res.rows.length;
}

export async function getJob(id) {
  const res = await query('SELECT * FROM jobs WHERE id = $1', [Number(id)]);
  return serializeJob(res.rows[0]);
}

export async function listJobs({ status = null, type = null, limit = 50, offset = 0 } = {}) {
  const clauses = [];
  const params = [];
  if (status) {
    if (!VALID_STATUSES.includes(status)) {
      const err = new Error(`Invalid status filter (one of ${VALID_STATUSES.join(', ')})`);
      err.status = 400;
      throw err;
    }
    params.push(status);
    clauses.push(`status = $${params.length}`);
  }
  if (type) {
    params.push(type);
    clauses.push(`type = $${params.length}`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const safeLimit = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
  const safeOffset = Math.max(0, parseInt(offset, 10) || 0);
  params.push(safeLimit, safeOffset);
  const res = await query(
    `SELECT * FROM jobs ${where} ORDER BY id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return res.rows.map(serializeJob);
}

/** Aggregated stats + refresh of the queue depth gauge. */
export async function queueStats() {
  const byStatus = await query(
    `SELECT status, COUNT(*)::int AS count, MIN(runat) AS oldest FROM jobs GROUP BY status`,
  );
  const byType = await query(
    `SELECT type, status, COUNT(*)::int AS count FROM jobs GROUP BY type, status`,
  );

  const statusMap = {};
  for (const row of byStatus.rows) {
    statusMap[row.status] = {
      count: row.count,
      oldest: row.oldest instanceof Date ? row.oldest.toISOString() : row.oldest,
    };
  }

  const typeMap = {};
  for (const row of byType.rows) {
    if (!typeMap[row.type]) typeMap[row.type] = { pending: 0, running: 0, done: 0, failed: 0, dead: 0 };
    typeMap[row.type][row.status] = row.count;
    queueDepthGauge.set({ type: row.type, status: row.status }, row.count);
  }

  const pendingAgeRes = await query(
    `SELECT COALESCE(EXTRACT(EPOCH FROM (NOW() - MIN(runat))), 0)::int AS age FROM jobs WHERE status = 'pending'`,
  );

  return {
    byStatus: statusMap,
    byType: typeMap,
    oldestPendingAgeSec: pendingAgeRes.rows[0]?.age ?? 0,
    deadLetters: statusMap.dead?.count ?? 0,
    leaseSec: LEASE_SEC,
    retentionDays: RETENTION_DAYS,
  };
}

export default { ensureQueueSchema, enqueue, claimJobs, completeJob, failJob, requeueStale, retryJob, deleteJob, purgeFinished, getJob, listJobs, queueStats, JOB_TYPES };
