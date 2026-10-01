/**
 * modules/workers/workers.js — Background job system on node:worker_threads
 * (supported by bun — verified). Each task type maps to an ESM file under
 * modules/workers/tasks/*.mjs spawned as `new Worker(new URL('./tasks/<type>.mjs',
 * import.meta.url), { workerData })` (absolute file URL — required for bun).
 *
 * WorkerPool:
 *   • max concurrency min(4, os.cpus().length), FIFO job queue
 *   • jobs Map(id → { id, type, status, payload, result, error, queuedat,
 *     startedat, finishedat }) with crypto.randomUUID ids
 *   • main-thread completion side effects:
 *       mine | refresh → clear http: cache + emitPlatform('content:changed') + audit
 *       prefetch      → advancedCache.set(`player:${id}`, …, 120s, tags ['content'])
 *       thumbnail     → audit
 *
 * Router (mount: app.use('/api/workers', workersRouter)):
 *   POST /mine       { url, type?, externalId? } → { ok, jobId }        (requireAuth)
 *   POST /prefetch   { contentId }               → { ok, jobId }        (requireAuth)
 *   POST /thumbnails { contentId?, missing? }    → { ok, jobId }        (requireAdmin)
 *   POST /refresh    { source: 'tmdb'|'jikan' }  → { ok, jobId }        (requireAdmin)
 *   GET  /jobs       → { data: latest 20 (payload stripped) }           (public)
 *   GET  /jobs/:id   → job | 404                                       (public)
 *   GET  /status     → { pool, jobs, schedules }                       (public)
 *   GET  /thumbnails/:file → SVG poster (sanitised basename only)      (public)
 *
 * Scheduler: WORKERSREFRESHMS (default 30 min, 0 disables) auto-enqueues an
 * alternating tmdb/jikan refresh, plus one thumbnail pass (missing=true)
 * 30s after boot. Both timers are unref'd so they never hold the process.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Worker } from 'node:worker_threads';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { getContentById } from '../../db.js';
import { cache } from '../../cache.js';
import { rows, one } from '../platform/sql.js';
import { emitPlatform } from '../platform/events.js';
import { requireAuth, requireAdmin } from '../users/auth.js';
import { auditLog, clientIpOf } from '../security/security.js';
import { advancedCache } from '../cache/advancedCache.js';
import { logger } from '../../utils/logger.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// modules/workers → up two levels = backend root → data/thumbnails.
const THUMBNAILS_DIR = path.resolve(__dirname, '../../data/thumbnails');

/** Task type → task file (resolved lazily so a missing file fails its job only). */
const TASK_FILES = {
  mine: 'mine.mjs',
  prefetch: 'prefetch.mjs',
  thumbnail: 'thumbnail.mjs',
  refresh: 'refresh.mjs',
};

/* -------------------------------- worker pool -------------------------------- */

class WorkerPool {
  /** @param {number} maxConcurrency */
  constructor(maxConcurrency) {
    this.maxConcurrency = maxConcurrency;
    this.queue = []; // jobIds, FIFO
    /** @type {Map<string, object>} */
    this.jobs = new Map();
    this.runningCount = 0;
  }

  get queueLength() {
    return this.queue.length;
  }

  /** Queue a job and start pumping workers. @returns {{ jobId: string }} */
  enqueue(type, payload) {
    const id = crypto.randomUUID();
    const job = {
      id,
      type,
      status: 'queued',
      payload,
      result: null,
      error: null,
      queuedat: new Date().toISOString(),
      startedat: null,
      finishedat: null,
    };
    this.jobs.set(id, job);
    this.queue.push(id);
    this.pump();
    return { jobId: id };
  }

  /** Spawn workers while below max concurrency and the queue is non-empty. */
  pump() {
    while (this.runningCount < this.maxConcurrency && this.queue.length > 0) {
      const jobId = this.queue.shift();
      const job = this.jobs.get(jobId);
      if (!job) continue;
      this.run(job);
    }
  }

  /** Run one job in a fresh worker thread. */
  run(job) {
    const taskFile = TASK_FILES[job.type];
    if (!taskFile) {
      job.status = 'failed';
      job.error = `Unknown task type: ${job.type}`;
      job.finishedat = new Date().toISOString();
      return;
    }

    job.status = 'running';
    job.startedat = new Date().toISOString();
    this.runningCount += 1;

    let worker;
    try {
      // Absolute file URL — bun worker_threads requires it for ESM task files.
      worker = new Worker(new URL(`./tasks/${taskFile}`, import.meta.url), { workerData: job.payload });
    } catch (err) {
      this.runningCount -= 1;
      job.status = 'failed';
      job.error = `Failed to spawn worker: ${err?.message || err}`;
      job.finishedat = new Date().toISOString();
      logger.error(`[workers] Spawn failed for ${job.type} job ${job.id}: ${job.error}`);
      this.pump();
      return;
    }

    let settled = false;
    worker.on('message', (result) => {
      if (settled) return;
      settled = true;
      job.finishedat = new Date().toISOString();
      if (result && result.ok === false) {
        job.status = 'failed';
        job.error = result.error || 'Task failed';
        this.onFailure(job).catch((err) => logger.warn(`[workers] onFailure side effect failed: ${err.message}`));
        logger.warn(`[workers] Job ${job.id} (${job.type}) failed: ${job.error}`);
      } else {
        job.status = 'done';
        job.result = result;
        this.onSuccess(job).catch((err) => logger.warn(`[workers] onSuccess side effect failed: ${err.message}`));
      }
    });
    worker.on('error', (err) => {
      if (settled) return;
      settled = true;
      job.status = 'failed';
      job.error = err?.message || String(err);
      job.finishedat = new Date().toISOString();
      this.onFailure(job).catch(() => {});
      logger.warn(`[workers] Job ${job.id} (${job.type}) worker error: ${job.error}`);
    });
    worker.on('exit', (code) => {
      this.runningCount -= 1;
      if (!settled) {
        settled = true;
        job.status = 'failed';
        job.error = `Worker exited with code ${code} before reporting a result`;
        job.finishedat = new Date().toISOString();
        this.onFailure(job).catch(() => {});
        logger.warn(`[workers] Job ${job.id} (${job.type}) ${job.error}`);
      }
      this.pump();
    });
  }

  /** Main-thread side effects after a successful job. */
  async onSuccess(job) {
    const result = job.result || {};
    if (job.type === 'mine' || job.type === 'refresh') {
      cache.clearPrefix('http:');
      emitPlatform('content:changed');
      const meta =
        job.type === 'mine'
          ? {
              id: result.record?.id ?? null,
              title: result.record?.title ?? null,
              externalid: result.record?.externalid ?? null,
            }
          : { source: result.source ?? job.payload?.source, upserted: result.upserted ?? 0 };
      await auditLog({
        userid: job.payload?.userid ?? null,
        action: `workers.${job.type}.done`,
        meta,
      });
      logger.info(`[workers] ${job.type} job ${job.id} done: ${JSON.stringify(meta)}`);
      return;
    }
    if (job.type === 'prefetch') {
      const contentId = job.payload?.content?.id;
      if (contentId != null && result.player) {
        advancedCache.set(`player:${contentId}`, result.player, { ttlMs: 120000, tags: ['content'] });
      }
      await auditLog({
        userid: job.payload?.userid ?? null,
        action: 'workers.prefetch.done',
        meta: { contentid: contentId ?? null, mode: result.player?.mode ?? null, sources: result.player?.sources?.length ?? 0 },
      });
      logger.info(`[workers] prefetch job ${job.id} done: content ${contentId} → mode ${result.player?.mode}`);
      return;
    }
    if (job.type === 'thumbnail') {
      await auditLog({
        userid: job.payload?.userid ?? null,
        action: 'workers.thumbnail.done',
        meta: { generated: result.generated ?? 0, files: result.files ?? [] },
      });
      logger.info(`[workers] thumbnail job ${job.id} done: generated ${result.generated ?? 0} files`);
    }
  }

  /** Main-thread side effects after a failed job (audit only). */
  async onFailure(job) {
    await auditLog({
      userid: job.payload?.userid ?? null,
      action: `workers.${job.type}.failed`,
      meta: { error: job.error },
    });
  }

  /** Aggregated counters for GET /status. */
  stats() {
    let done = 0;
    let failed = 0;
    let running = 0;
    let queued = 0;
    for (const job of this.jobs.values()) {
      if (job.status === 'done') done += 1;
      else if (job.status === 'failed') failed += 1;
      else if (job.status === 'running') running += 1;
      else queued += 1;
    }
    return { total: this.jobs.size, done, failed, running, queued };
  }
}

const pool = new WorkerPool(Math.min(4, os.cpus().length || 1));

/* ------------------------------ refresh scheduler ---------------------------- */

/* NEON FREE PLAN (scale-to-zero): auto-refresh-ul periodic (default 30 min)
 * era un job permanent care ținea compute-ul Neon treaz non-stop și ardea
 * cota lunară. Acum DEFAULT OPRIT — refresh DOAR on-demand:
 *   · POST /api/workers/refresh/{source} (butonul „Refresh" din admin)
 *   · programare opțională doar dacă WORKERSREFRESHMS e setat explicit */
const REFRESH_INTERVAL_MS = parseInt(process.env.WORKERSREFRESHMS || '0', 10) || 0;
const scheduleState = {
  name: 'periodic-refresh',
  intervalMs: REFRESH_INTERVAL_MS,
  lastRunAt: null,
  nextRunAt: REFRESH_INTERVAL_MS > 0 ? new Date(Date.now() + REFRESH_INTERVAL_MS).toISOString() : null,
  lastSource: null,
  enabled: REFRESH_INTERVAL_MS > 0,
};
let lastAutoSource = 'tmdb';

if (REFRESH_INTERVAL_MS > 0) {
  const timer = setInterval(() => {
    lastAutoSource = lastAutoSource === 'tmdb' ? 'jikan' : 'tmdb';
    const now = new Date();
    scheduleState.lastSource = lastAutoSource;
    scheduleState.lastRunAt = now.toISOString();
    scheduleState.nextRunAt = new Date(now.getTime() + REFRESH_INTERVAL_MS).toISOString();
    const { jobId } = pool.enqueue('refresh', { source: lastAutoSource, auto: true });
    logger.info(`[workers] Scheduled auto-refresh (${lastAutoSource}) queued as job ${jobId}`);
  }, REFRESH_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

// Boot thumbnail sweep (backfill SVG posters for artwork-less rows) — DEFAULT
// OPRIT (NEON FREE PLAN): fiecare restart îl re-rula pe DB fără utilizatori.
// On-demand: POST /api/workers/thumbnails sau WORKERSBOOTSWEEP=1.
if ((process.env.WORKERSBOOTSWEEP ?? '0') === '1') {
  const bootThumbnails = setTimeout(() => {
    const { jobId } = pool.enqueue('thumbnail', { missing: true, auto: true });
    logger.info(`[workers] Boot thumbnail sweep queued as job ${jobId}`);
  }, 30000);
  if (typeof bootThumbnails.unref === 'function') bootThumbnails.unref();
}

/* FAZA 16-a: SVG thumbnails now live in the Neon `thumbnailcache` table.
 * Migration path: if the table is empty at boot and data/thumbnails/ still
 * has .svg files on disk (e.g. the pre-existing 1385.svg), import them once. */
async function migrateThumbnailFilesToNeon() {
  try {
    const countRow = await one('SELECT COUNT(*) AS n FROM thumbnailcache');
    if (Number(countRow?.n ?? 0) > 0) return 0;
    if (!fs.existsSync(THUMBNAILS_DIR)) return 0;
    const files = fs.readdirSync(THUMBNAILS_DIR).filter((f) => f.endsWith('.svg'));
    let migrated = 0;
    for (const file of files) {
      const svg = fs.readFileSync(path.join(THUMBNAILS_DIR, file), 'utf8');
      const contentid = parseInt(file, 10);
      await rows(
        `INSERT INTO thumbnailcache (file, svg, contentid) VALUES ($1, $2, $3)
         ON CONFLICT (file) DO NOTHING`,
        [file, svg, Number.isInteger(contentid) ? contentid : null],
      );
      migrated += 1;
    }
    if (migrated > 0) {
      logger.info(`[workers] Migrated ${migrated} SVG thumbnail file(s) from disk into Neon thumbnailcache`);
    }
    return migrated;
  } catch (err) {
    logger.warn(`[workers] Thumbnail file migration skipped: ${err.message}`);
    return 0;
  }
}
const bootThumbnailMigration = setTimeout(() => {
  migrateThumbnailFilesToNeon().catch(() => {});
}, 10000); // before the 30s sweep, after ensurePlatformSchema at boot
if (typeof bootThumbnailMigration.unref === 'function') bootThumbnailMigration.unref();

/* ---------------------------------- router ----------------------------------- */

const router = express.Router();

/**
 * POST /api/workers/mine — queue a URL mining job (requireAuth).
 * Body: { url, type?, externalId? } → { ok, jobId }
 */
router.post('/mine', requireAuth, wrap(async (req, res) => {
  const { url, type, externalId } = req.body || {};
  if (!url || typeof url !== 'string' || !url.trim()) {
    return res.status(400).json({ error: 'Missing required field: url' });
  }
  const { jobId } = pool.enqueue('mine', { url: url.trim(), type, externalId, userid: req.user.id });
  await auditLog({
    userid: req.user.id,
    action: 'workers.mine.queued',
    ip: clientIpOf(req),
    meta: { url: url.trim(), jobId },
  });
  logger.info(`[workers] Mine job ${jobId} queued by user ${req.user.id}: ${url.trim()}`);
  return res.json({ ok: true, jobId });
}));

/**
 * POST /api/workers/prefetch — pre-resolve the player for a content row
 * (requireAuth). Body: { contentId } → { ok, jobId }
 */
router.post('/prefetch', requireAuth, wrap(async (req, res) => {
  const contentId = Number(req.body?.contentId);
  if (!Number.isInteger(contentId) || contentId <= 0) {
    return res.status(400).json({ error: 'Missing or invalid contentId' });
  }
  const content = await getContentById(contentId);
  if (!content) return res.status(404).json({ error: 'Content not found' });
  const { jobId } = pool.enqueue('prefetch', { content, userid: req.user.id });
  return res.json({ ok: true, jobId });
}));

/**
 * POST /api/workers/thumbnails — generate SVG posters (requireAdmin).
 * Body: { contentId? , missing?: true } → { ok, jobId }
 */
router.post('/thumbnails', requireAuth, requireAdmin, wrap(async (req, res) => {
  const { contentId, missing } = req.body || {};
  if (contentId == null && missing !== true) {
    return res.status(400).json({ error: 'Provide contentId or missing=true' });
  }
  const payload = { missing: missing === true, userid: req.user.id };
  if (contentId != null) {
    if (!Number.isInteger(Number(contentId)) || Number(contentId) <= 0) {
      return res.status(400).json({ error: 'Invalid contentId' });
    }
    payload.contentId = Number(contentId);
  }
  const { jobId } = pool.enqueue('thumbnail', payload);
  return res.json({ ok: true, jobId });
}));

/**
 * POST /api/workers/refresh — pull fresh TMDB/Jikan data (requireAdmin).
 * Body: { source: 'tmdb'|'jikan' } → { ok, jobId }
 */
router.post('/refresh', requireAuth, requireAdmin, wrap(async (req, res) => {
  const { source } = req.body || {};
  if (source !== 'tmdb' && source !== 'jikan') {
    return res.status(400).json({ error: 'source must be "tmdb" or "jikan"' });
  }
  const { jobId } = pool.enqueue('refresh', { source, userid: req.user.id });
  await auditLog({
    userid: req.user.id,
    action: 'workers.refresh.queued',
    ip: clientIpOf(req),
    meta: { source, jobId },
  });
  return res.json({ ok: true, jobId });
}));

/** GET /api/workers/jobs — latest 20 jobs (payload stripped). Public. */
router.get('/jobs', (req, res) => {
  const latest = [...pool.jobs.values()]
    .sort((a, b) => String(b.queuedat).localeCompare(String(a.queuedat)))
    .slice(0, 20)
    .map(({ payload, ...job }) => job);
  return res.json({ data: latest });
});

/** GET /api/workers/jobs/:id — full job record. Public. */
router.get('/jobs/:id', (req, res) => {
  const job = pool.jobs.get(String(req.params.id));
  if (!job) return res.status(404).json({ error: 'Job not found' });
  return res.json(job);
});

/** GET /api/workers/status — pool + job counters + scheduler state. Public. */
router.get('/status', (req, res) => {
  const stats = pool.stats();
  return res.json({
    pool: { size: pool.maxConcurrency, busy: pool.runningCount, queued: pool.queueLength },
    jobs: { total: stats.total, done: stats.done, failed: stats.failed, running: stats.running },
    schedules: [scheduleState],
  });
});

/**
 * GET /api/workers/thumbnails/:file — serve a generated SVG poster.
 * FAZA 16-a: reads from the Neon `thumbnailcache` table first; falls back to
 * the disk file on a table miss (migration path). Strictly sanitised:
 * basename only, /^[a-zA-Z0-9._-]+$/, .svg extension.
 */
router.get('/thumbnails/:file', wrap(async (req, res) => {
  const file = path.basename(String(req.params.file || ''));
  if (!/^[a-zA-Z0-9._-]+$/.test(file) || !file.endsWith('.svg')) {
    return res.status(400).json({ error: 'Invalid thumbnail file name' });
  }
  // Neon first.
  try {
    const row = await one('SELECT svg FROM thumbnailcache WHERE file = $1', [file]);
    if (row?.svg) {
      res.set('Cache-Control', 'public, max-age=3600');
      res.type('image/svg+xml');
      return res.send(row.svg);
    }
  } catch (err) {
    logger.debug(`[workers] thumbnailcache read failed for ${file}: ${err.message}`);
  }
  // Disk fallback (pre-FAZA-16 files not yet migrated).
  const fullPath = path.join(THUMBNAILS_DIR, file);
  fs.readFile(fullPath, 'utf8', (err, data) => {
    if (err) return res.status(404).json({ error: 'Thumbnail not found' });
    res.set('Cache-Control', 'public, max-age=3600');
    res.type('image/svg+xml');
    return res.send(data);
  });
}));

export default router;

// Phase-4 extension (aicloud tools layer): expose the pool so the
// `enqueueQueueJob` tool can queue jobs without an HTTP round-trip.
export { pool as workerPool };
