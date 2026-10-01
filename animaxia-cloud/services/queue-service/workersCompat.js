/**
 * services/queue-service/workersCompat.js — Monolith-compatible /api/workers
 * surface (modules/workers/workers.js) mapped onto the PG queue.
 *
 *   POST /mine       {url, type?, externalId?}  (requireAuth)  → enqueue miner.mine        → {ok, jobId}
 *   POST /prefetch   {contentId}                (requireAuth)  → enqueue miner.prefetch    → {ok, jobId}
 *   POST /thumbnails {contentId?, missing?}     (requireAdmin) → enqueue thumbnails.generate → {ok, jobId}
 *   POST /refresh    {source:'tmdb'|'jikan'}    (requireAdmin) → enqueue providers.refresh → {ok, jobId}
 *   GET  /jobs                                  (public)  latest 20, payload stripped → {data}
 *   GET  /jobs/:id                              (public)  full job record | 404
 *   GET  /status                                (public)  {pool:{model,concurrency,inflight}, jobs, schedules}
 *   GET  /thumbnails/:file                      (public)  SVG poster (sanitised basename,
 *                                                         ^[a-z0-9-]+\.svg$, image/svg+xml,
 *                                                         Cache-Control public max-age=3600)
 *
 * `jobId` is the numeric PG queue job id (the monolith returned a UUID — the
 * shape is identical, ids are simply integers now). Handlers run in this
 * service's consumer pool (consumers.js) instead of ad-hoc worker threads.
 */

import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { enqueue, listJobs, getJob, queueStats } from '@animaxia/common/queue.js';
import { getContentById } from '@animaxia/common/db.js';
import { requireAuth, requireAdmin } from '@animaxia/domain/users/auth.js';
import { auditLog, clientIpOf } from '@animaxia/domain/security/security.js';
import { wrap } from '@animaxia/common/middleware.js';
import { consumerStats } from './consumers.js';
import { schedulesOverview } from './cron.js';

/** Same data dir the thumbnails.generate handler writes into (LOCALDATADIR or ./data). */
const THUMBNAILS_DIR = path.resolve(process.env.LOCALDATADIR || './data', 'thumbnails');
const THUMBNAIL_NAME_RE = /^[a-z0-9-]+\.svg$/;

export const workersCompatRouter = express.Router();

/* POST /mine — queue a URL mining job (requireAuth). */
workersCompatRouter.post('/mine', requireAuth, wrap(async (req, res) => {
  const { url, type, externalId } = req.body || {};
  if (!url || typeof url !== 'string' || !url.trim()) {
    return res.status(400).json({ error: 'Missing required field: url' });
  }
  const job = await enqueue({
    type: 'miner.mine',
    payload: { url: url.trim(), type, externalId, userid: req.user.id },
  });
  await auditLog({
    userid: req.user.id,
    action: 'workers.mine.queued',
    ip: clientIpOf(req),
    meta: { url: url.trim(), jobId: job.id },
  });
  return res.json({ ok: true, jobId: job.id });
}));

/* POST /prefetch — pre-resolve the player for a content row (requireAuth). */
workersCompatRouter.post('/prefetch', requireAuth, wrap(async (req, res) => {
  const contentId = Number(req.body?.contentId);
  if (!Number.isInteger(contentId) || contentId <= 0) {
    return res.status(400).json({ error: 'Missing or invalid contentId' });
  }
  const content = await getContentById(contentId);
  if (!content) return res.status(404).json({ error: 'Content not found' });
  const job = await enqueue({
    type: 'miner.prefetch',
    payload: { contentId, userid: req.user.id },
  });
  return res.json({ ok: true, jobId: job.id });
}));

/* POST /thumbnails — generate SVG posters (requireAdmin). */
workersCompatRouter.post('/thumbnails', requireAuth, requireAdmin, wrap(async (req, res) => {
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
  const job = await enqueue({ type: 'thumbnails.generate', payload });
  return res.json({ ok: true, jobId: job.id });
}));

/* POST /refresh — pull fresh TMDB/Jikan data (requireAdmin). */
workersCompatRouter.post('/refresh', requireAuth, requireAdmin, wrap(async (req, res) => {
  const { source } = req.body || {};
  if (source !== 'tmdb' && source !== 'jikan') {
    return res.status(400).json({ error: 'source must be "tmdb" or "jikan"' });
  }
  const job = await enqueue({
    type: 'providers.refresh',
    payload: { source, userid: req.user.id },
  });
  await auditLog({
    userid: req.user.id,
    action: 'workers.refresh.queued',
    ip: clientIpOf(req),
    meta: { source, jobId: job.id },
  });
  return res.json({ ok: true, jobId: job.id });
}));

/* GET /jobs — latest 20 jobs, payload stripped (public). */
workersCompatRouter.get('/jobs', wrap(async (req, res) => {
  const jobs = await listJobs({ limit: 20 });
  return res.json({ data: jobs.map(({ payload, ...job }) => job) });
}));

/* GET /jobs/:id — full job record (public). */
workersCompatRouter.get('/jobs/:id', wrap(async (req, res) => {
  const job = await getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  return res.json(job);
}));

/* GET /status — pool + job counters + schedule lastrun map (public). */
workersCompatRouter.get('/status', wrap(async (req, res) => {
  const [stats, schedules] = await Promise.all([queueStats(), schedulesOverview()]);
  const consumers = consumerStats();
  return res.json({
    pool: { model: 'postgres-queue', concurrency: consumers.concurrency, inflight: consumers.inflight },
    jobs: stats.byStatus,
    schedules: schedules.map(({ schedule, type, lastrunat }) => ({ schedule, type, lastrunat })),
  });
}));

/* GET /thumbnails/:file — serve a generated SVG poster (sanitised, public). */
workersCompatRouter.get('/thumbnails/:file', (req, res) => {
  const file = path.basename(String(req.params.file || ''));
  if (!THUMBNAIL_NAME_RE.test(file)) {
    return res.status(404).json({ error: 'Invalid thumbnail file name' });
  }
  return fs.readFile(path.join(THUMBNAILS_DIR, file), 'utf8', (err, data) => {
    if (err) return res.status(404).json({ error: 'Thumbnail not found' });
    res.set('Cache-Control', 'public, max-age=3600');
    res.type('image/svg+xml');
    return res.send(data);
  });
});

export default workersCompatRouter;
