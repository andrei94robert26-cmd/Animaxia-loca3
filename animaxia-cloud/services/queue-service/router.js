/**
 * services/queue-service/router.js — The /api/queue REST surface (BLUEPRINT §10).
 *
 *   POST   /jobs                     (requireAuth)  {type,payload?,priority?,runAt?,maxAttempts?} → 201 {ok,job}
 *   GET    /jobs?status=&type=&limit=&offset=       (public)  {ok,data,total} — total via SQL count
 *   GET    /jobs/:id                                 (public)  job | 404
 *   POST   /jobs/:id/retry            (requireAdmin) re-queue a failed/dead job → {ok,job} | 404
 *   DELETE /jobs/:id                  (requireAdmin) → {ok} | 404
 *   GET    /stats                     (public)       queueStats + live consumer counters + handler list
 *   POST   /cron/tick                 (public, K8s CronJob target)
 *          body {job,payload} → enqueue that job directly (validated) → {ok,jobId}
 *          empty body       → evaluateSchedules() → {ok,enqueued:[...]}
 *   GET    /cron/schedules            (public)       schedule table + lastrunat
 *
 * The gateway proxies /api/queue here; job types are validated against the
 * live HANDLERS registry in consumers.js so only runnable types can be
 * enqueued. requireAuth/requireAdmin come from domain/users/auth.js (they
 * re-verify the Bearer token themselves — no dependency on attachUser).
 */

import express from 'express';
import { enqueue, listJobs, getJob, retryJob, deleteJob, queueStats } from '@animaxia/common/queue.js';
import { query } from '@animaxia/common/db.js';
import { requireAuth, requireAdmin } from '@animaxia/domain/users/auth.js';
import { wrap } from '@animaxia/common/middleware.js';
import { HANDLERS, consumerStats } from './consumers.js';
import { evaluateSchedules, schedulesOverview } from './cron.js';

export const queueRouter = express.Router();

const KNOWN_TYPES = Object.keys(HANDLERS);

/** `payload` must be a plain object when present. */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/* POST /jobs — enqueue (requireAuth). */
queueRouter.post('/jobs', requireAuth, wrap(async (req, res) => {
  const { type, payload, priority, runAt, maxAttempts } = req.body || {};
  if (!type || !KNOWN_TYPES.includes(type)) {
    return res.status(400).json({ error: `Unknown job type (one of: ${KNOWN_TYPES.join(', ')})` });
  }
  if (payload !== undefined && !isPlainObject(payload)) {
    return res.status(400).json({ error: 'payload must be a JSON object' });
  }
  if (runAt !== undefined && runAt !== null && Number.isNaN(Date.parse(runAt))) {
    return res.status(400).json({ error: 'runAt must be a parseable date' });
  }
  const job = await enqueue({ type, payload: payload ?? {}, priority, runAt, maxAttempts });
  return res.status(201).json({ ok: true, job });
}));

/* GET /jobs — filtered list (public). Invalid status → 400 from listJobs. */
queueRouter.get('/jobs', wrap(async (req, res) => {
  const { status, type, limit, offset } = req.query;
  const clauses = [];
  const params = [];
  if (status) {
    params.push(String(status));
    clauses.push(`status = $${params.length}`);
  }
  if (type) {
    params.push(String(type));
    clauses.push(`type = $${params.length}`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const countRes = await query(`SELECT COUNT(*)::int AS total FROM jobs ${where}`, params);
  const jobs = await listJobs({ status: status || null, type: type || null, limit, offset });
  return res.json({ ok: true, data: jobs, total: countRes.rows[0]?.total ?? jobs.length });
}));

/* GET /jobs/:id — one job (public). */
queueRouter.get('/jobs/:id', wrap(async (req, res) => {
  const job = await getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  return res.json(job);
}));

/* POST /jobs/:id/retry — re-queue a failed/dead job (requireAdmin). */
queueRouter.post('/jobs/:id/retry', requireAdmin, wrap(async (req, res) => {
  const job = await retryJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found (or not in failed/dead state)' });
  return res.json({ ok: true, job });
}));

/* DELETE /jobs/:id — remove a job (requireAdmin). */
queueRouter.delete('/jobs/:id', requireAdmin, wrap(async (req, res) => {
  const deleted = await deleteJob(req.params.id);
  if (!deleted) return res.status(404).json({ error: 'Job not found' });
  return res.json({ ok: true });
}));

/* GET /stats — queue + consumer snapshot (public). */
queueRouter.get('/stats', wrap(async (req, res) => {
  const stats = await queueStats();
  return res.json({ ok: true, ...stats, consumers: consumerStats(), handlers: KNOWN_TYPES });
}));

/* POST /cron/tick — K8s CronJob target + manual scheduler kick (public). */
queueRouter.post('/cron/tick', wrap(async (req, res) => {
  const body = req.body || {};
  if (body.job) {
    if (!KNOWN_TYPES.includes(body.job)) {
      return res.status(400).json({ error: `Unknown job type (one of: ${KNOWN_TYPES.join(', ')})` });
    }
    const payload = isPlainObject(body.payload) ? body.payload : {};
    const job = await enqueue({ type: body.job, payload });
    return res.json({ ok: true, jobId: job.id });
  }
  const enqueued = await evaluateSchedules(new Date());
  return res.json({ ok: true, enqueued });
}));

/* GET /cron/schedules — schedule table + lastrunat (public). */
queueRouter.get('/cron/schedules', wrap(async (req, res) => {
  const schedules = await schedulesOverview();
  return res.json({ ok: true, schedules });
}));

export default queueRouter;
