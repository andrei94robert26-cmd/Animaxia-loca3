/**
 * Single-node durable SQLite queue for JSON metadata ingestion.
 * Opt-in worker: ANIMAXIA_METADATA_QUEUE_WORKER=true.
 *
 * Persists payloads, handles interrupted jobs, at-least-once replay,
 * exponential retry and per-provider status. NOT distributed locking.
 */
import crypto from 'node:crypto';
import { localDb } from '../local/sqlite.js';
import { validMetadataBatch, persistMetadataBatch } from './metadata.js';
import { logger } from '../../utils/logger.js';

let initialized = false;
let running = false;
let timer = null;
const MAX_BYTES = 1_500_000;
const MAX_ATTEMPTS = 3;
const safeInt = (v, fallback = 20) => Math.max(1, Math.min(100, Number.parseInt(v, 10) || fallback));

export function ensureMetadataQueueSchema() {
  localDb.exec(`
    CREATE TABLE IF NOT EXISTS metadata_sync_jobs (
      id TEXT PRIMARY KEY,
      sourcetype TEXT NOT NULL,
      sourceid TEXT NOT NULL,
      idempotencykey TEXT,
      payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      attempts INTEGER NOT NULL DEFAULT 0,
      nextattemptat TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      createdat TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      startedat TEXT,
      finishedat TEXT,
      result TEXT,
      error TEXT,
      UNIQUE (sourcetype, sourceid, idempotencykey)
    );
    CREATE INDEX IF NOT EXISTS idx_metadata_sync_ready
      ON metadata_sync_jobs(status,nextattemptat,createdat);
    CREATE INDEX IF NOT EXISTS idx_metadata_sync_source
      ON metadata_sync_jobs(sourcetype,sourceid,createdat);
  `);
  initialized = true;
  return { storage: 'sqlite', durable: true, distributed: false };
}
function ready() { if (!initialized) ensureMetadataQueueSchema(); }
function summary(row) {
  if (!row) return null;
  let result = null;
  try { result = JSON.parse(row.result || 'null'); } catch { /* legacy job */ }
  return {
    id: row.id,
    source: { type: row.sourcetype, id: row.sourceid },
    status: row.status, attempts: Number(row.attempts),
    nextAttemptAt: row.nextattemptat, createdAt: row.createdat,
    startedAt: row.startedat, finishedAt: row.finishedat,
    result: result ? {
      accepted: result.accepted, created: result.created, updated: result.updated,
      rejected: result.rejected,
    } : null,
    error: row.error,
  };
}
export function enqueueMetadataBatch({ source, items, idempotencyKey = null }) {
  ready();
  if (!validMetadataBatch(source, items)) {
    throw Object.assign(new Error('Invalid JSON metadata batch'), { status: 400 });
  }
  const payload = JSON.stringify({ source, items });
  if (Buffer.byteLength(payload, 'utf8') > MAX_BYTES) {
    throw Object.assign(new Error('Metadata batch exceeds 1.5MB'), { status: 413 });
  }
  if (idempotencyKey != null &&
      (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(idempotencyKey))) {
    throw Object.assign(new Error('Invalid idempotencyKey'), { status: 400 });
  }
  // The database is persistent but local disk is finite. Reject new work
  // when the pending queue has reached its configured capacity. Replays with
  // a matching idempotency key still return the existing job.
  if (idempotencyKey) {
    const previous = localDb.prepare(`
      SELECT * FROM metadata_sync_jobs
      WHERE sourcetype=? AND sourceid=? AND idempotencykey=?
    `).get(source.type, source.id, idempotencyKey);
    if (previous) return { ...summary(previous), queued: false, duplicate: true };
  }
  const queueCap = Math.max(100, Math.min(20_000,
    Number.parseInt(process.env.ANIMAXIA_METADATA_QUEUE_CAP, 10) || 2000));
  const pending = localDb.prepare(`
    SELECT COUNT(*) AS n FROM metadata_sync_jobs WHERE status IN ('queued','running')
  `).get();
  if (Number(pending.n) >= queueCap) {
    throw Object.assign(new Error('Metadata queue capacity reached; retry later'), { status: 429 });
  }

  const id = crypto.randomUUID();
  const result = localDb.prepare(`
    INSERT INTO metadata_sync_jobs(id,sourcetype,sourceid,idempotencykey,payload)
    VALUES(?,?,?,?,?)
    ON CONFLICT(sourcetype,sourceid,idempotencykey) DO NOTHING
  `).run(id, source.type, source.id, idempotencyKey, payload);
  const created = Number(result.changes) === 1;
  const row = created
    ? localDb.prepare('SELECT * FROM metadata_sync_jobs WHERE id=?').get(id)
    : localDb.prepare(`
        SELECT * FROM metadata_sync_jobs
        WHERE sourcetype=? AND sourceid=? AND idempotencykey=?
      `).get(source.type, source.id, idempotencyKey);
  if (!row) throw new Error('Unable to read persisted ingestion job');
  return { ...summary(row), queued: created, duplicate: !created };
}
export function getMetadataJob(id) {
  ready();
  return summary(localDb.prepare('SELECT * FROM metadata_sync_jobs WHERE id=?').get(String(id)));
}
export function listMetadataJobs({ limit = 20, sourceType, sourceId } = {}) {
  ready();
  const clauses = [], args = [];
  if (sourceType) { clauses.push('sourcetype=?'); args.push(String(sourceType)); }
  if (sourceId) { clauses.push('sourceid=?'); args.push(String(sourceId)); }
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  return localDb.prepare(`
    SELECT * FROM metadata_sync_jobs ${where}
    ORDER BY createdat DESC,id DESC LIMIT ?
  `).all(...args, safeInt(limit)).map(summary);
}
export function metadataSourceStatus() {
  ready();
  const providers = localDb.prepare(`
    SELECT sourcetype, sourceid, COUNT(*) AS total,
      SUM(CASE WHEN status='queued' THEN 1 ELSE 0 END) AS queued,
      SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) AS running,
      SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) AS done,
      SUM(CASE WHEN status='partial' THEN 1 ELSE 0 END) AS partial,
      SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
      MAX(CASE WHEN status IN ('done','partial') THEN finishedat END) AS lastsuccess,
      MAX(CASE WHEN status='failed' THEN finishedat END) AS lastfailure
    FROM metadata_sync_jobs GROUP BY sourcetype,sourceid
    ORDER BY sourcetype,sourceid LIMIT 100
  `).all();
  return {
    queue: { storage: 'sqlite', distributed: false, workerActive: timer !== null },
    sources: providers.map((row) => ({
      type: row.sourcetype, id: row.sourceid, total: Number(row.total),
      queued: Number(row.queued), running: Number(row.running),
      done: Number(row.done), partial: Number(row.partial),
      failed: Number(row.failed),
      lastSuccess: row.lastsuccess, lastFailure: row.lastfailure,
    })),
  };
}
export function recoverMetadataJobs() {
  ready();
  const result = localDb.prepare(`
    UPDATE metadata_sync_jobs
    SET status=CASE WHEN attempts >= 3 THEN 'failed' ELSE 'queued' END,
        nextattemptat=CURRENT_TIMESTAMP, startedat=NULL,
        finishedat=CASE WHEN attempts >= 3 THEN CURRENT_TIMESTAMP ELSE NULL END,
        error=CASE WHEN attempts >= 3 THEN 'retry limit reached after restart'
                   ELSE 'requeued after worker restart' END
    WHERE status='running'
  `).run();
  return Number(result.changes);
}
/**
 * Process at most ONE due batch. Safe to call from CI without a running server.
 * At-least-once: retry only catastrophic errors; individual bad JSON items are
 * reported as partial results and never poison the entire queue.
 */
export async function processNextMetadataJob() {
  ready();
  if (running) return null;
  running = true;
  try {
    const job = localDb.prepare(`
      UPDATE metadata_sync_jobs
      SET status='running', attempts=attempts+1, startedat=CURRENT_TIMESTAMP
      WHERE id=(SELECT id FROM metadata_sync_jobs
        WHERE status='queued' AND nextattemptat <= CURRENT_TIMESTAMP
        ORDER BY nextattemptat ASC,createdat ASC LIMIT 1)
      RETURNING *
    `).get();
    if (!job) return null;
    try {
      const { source, items } = JSON.parse(job.payload);
      const result = await persistMetadataBatch(source, items);
      const status = result.rejected > 0 ? (result.accepted > 0 ? 'partial' : 'failed') : 'done';
      localDb.prepare(`
        UPDATE metadata_sync_jobs SET status=?,result=?,error=NULL,finishedat=CURRENT_TIMESTAMP
        WHERE id=?
      `).run(status, JSON.stringify(result), job.id);
    } catch (error) {
      const attempts = Number(job.attempts);
      const retryable = attempts < MAX_ATTEMPTS;
      const delaySeconds = Math.min(120, 5 * (2 ** (attempts - 1)));
      localDb.prepare(`
        UPDATE metadata_sync_jobs SET status=?,error=?,finishedat=?,
          nextattemptat=datetime('now', ? || ' seconds')
        WHERE id=?
      `).run(
        retryable ? 'queued' : 'failed',
        String(error?.message || error).slice(0, 500),
        retryable ? null : new Date().toISOString(),
        String(delaySeconds),
        job.id,
      );
      logger.warn('[metadata-queue] batch failed (attempt ' + attempts + '/' + MAX_ATTEMPTS + ')');
    }
    return getMetadataJob(job.id);
  } finally { running = false; }
}
export function startMetadataQueueWorker() {
  ready();
  if (timer) return false;
  if (process.env.ANIMAXIA_METADATA_QUEUE_WORKER !== 'true') return false;
  recoverMetadataJobs();
  const intervalMs = Math.max(1000, Math.min(60_000,
    Number.parseInt(process.env.ANIMAXIA_METADATA_QUEUE_INTERVAL_MS, 10) || 5000));
  timer = setInterval(() => {
    processNextMetadataJob().catch((err) => {
      logger.warn('[metadata-queue] worker tick failed: ' + err.message);
    });
  }, intervalMs);
  timer.unref?.();
  logger.info('[metadata-queue] local durable worker enabled, interval=' + intervalMs + 'ms');
  return true;
}
export function stopMetadataQueueWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}
