/**
 * modules/miner/routes.js — FAZA 12 miner HTTP API (mount: /api/miner).
 *
 * Additive router — no existing route is touched. Mirrors the workers.js
 * security policy: mutations require admin, reads are public (payload
 * stripped from list responses; job detail keeps results for observability,
 * exactly like workers /jobs/:id).
 *
 *   POST /jobs             (admin) schedule a job.
 *                          Body: { type, tenant?, page?, mode?, limit?,
 *                                  contentIds?, pages?, allTenants? }
 *                          allTenants:true → one daily-sync per ACTIVE tenant
 *                          (the edge cron uses this — one call, the monolith
 *                          owns tenant iteration).
 *   GET  /jobs             (public) latest jobs, filters: ?status&tenant&type&limit
 *   GET  /jobs/:id         (public) full job record incl. logs
 *   POST /run/:id          (admin) manual run (queued → run now; finished → re-run)
 *   GET  /status           (public) pool + jobs + per-tenant sources + manifests
 *   POST /search/push      (admin) push content rows to the search catalog
 *                          for a tenant (uses miner/search-index.js)
 */

import express from 'express';
import { rows } from '../platform/sql.js';
import { requireAuth, requireAdmin } from '../users/auth.js';
import { auditLog, clientIpOf } from '../security/security.js';
import { logger } from '../../utils/logger.js';
import {
  MINER_JOB_TYPES,
  scheduleJob,
  runJob,
  listJobs,
  getJob,
  minerStats,
} from './core.js';
import { pushToSearchIndex, searchIndexBackend } from './search-index.js';
import { listContent } from '../../db.js';
import { autoSyncProviderStatus } from './auto-sync.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const router = express.Router();
/** Explicit current provider sync status (requires admin). */
router.get('/auto-sync', requireAuth, requireAdmin, wrap(async (_req, res) =>
  res.json(await autoSyncProviderStatus())
));


/** Resolve the target tenant slug from the body / query / request context. */
function tenantFromRequest(req, body = {}) {
  if (body.tenant && typeof body.tenant === 'string') return body.tenant.trim().toLowerCase();
  if (req.query.tenant && typeof req.query.tenant === 'string') return String(req.query.tenant).trim().toLowerCase();
  if (req.user?.tenant && typeof req.user.tenant === 'string') return req.user.tenant;
  return 'global';
}

/** Extract the job-type-specific payload fields from the body. */
function payloadFromBody(body = {}) {
  const payload = {};
  if (body.page != null) payload.page = Number(body.page) || 1;
  if (body.mode != null) payload.mode = String(body.mode);
  if (body.limit != null) payload.limit = Number(body.limit);
  if (body.pages != null) payload.pages = Number(body.pages);
  if (body.tmdbPage != null) payload.tmdbPage = Number(body.tmdbPage);
  if (body.jikanPage != null) payload.jikanPage = Number(body.jikanPage);
  if (Array.isArray(body.contentIds)) payload.contentIds = body.contentIds.map(Number).filter(Number.isInteger);
  return payload;
}

/**
 * POST /api/miner/jobs — schedule one job (or one per active tenant when
 * allTenants:true, which forces type 'daily-sync').
 */
router.post('/jobs', requireAuth, requireAdmin, wrap(async (req, res) => {
  const body = req.body || {};
  const allTenants = body.allTenants === true;

  if (allTenants) {
    const active = await rows(`SELECT slug FROM tenants WHERE status = 'active' ORDER BY id ASC`);
    const slugs = (active || []).map((t) => t.slug).filter(Boolean);
    if (!slugs.length) {
      return res.status(503).json({ error: 'No active tenants found', code: 'MINER_NO_TENANTS' });
    }
    const scheduled = [];
    for (const slug of slugs) {
      const job = await scheduleJob('daily-sync', slug, payloadFromBody(body), { createdBy: req.user.id });
      scheduled.push(job);
    }
    await auditLog({
      userid: req.user.id,
      action: 'miner.jobs.scheduled',
      ip: clientIpOf(req),
      meta: { allTenants: true, count: scheduled.length, type: 'daily-sync' },
    }).catch(() => {});
    logger.info(`[miner] Scheduled daily-sync for ${scheduled.length} active tenant(s) by user ${req.user.id}`);
    return res.status(201).json({ ok: true, allTenants: true, count: scheduled.length, jobs: scheduled.map((j) => ({ id: j.id, tenant: j.tenant, status: j.status })) });
  }

  const { type } = body;
  if (!MINER_JOB_TYPES.includes(type)) {
    return res.status(400).json({ error: `type must be one of: ${MINER_JOB_TYPES.join(', ')}` });
  }
  const tenant = tenantFromRequest(req, body);
  const job = await scheduleJob(type, tenant, payloadFromBody(body), { createdBy: req.user.id });
  await auditLog({
    userid: req.user.id,
    action: 'miner.job.scheduled',
    ip: clientIpOf(req),
    meta: { jobid: job.id, type, tenant },
  }).catch(() => {});
  return res.status(201).json({ ok: true, job });
}));

/** GET /api/miner/jobs — latest jobs (payloads stripped). Public. */
router.get('/jobs', wrap(async (req, res) => {
  const jobs = await listJobs({
    status: req.query.status ? String(req.query.status) : undefined,
    tenant: req.query.tenant ? String(req.query.tenant) : undefined,
    type: req.query.type ? String(req.query.type) : undefined,
    limit: req.query.limit ? Number(req.query.limit) : undefined,
  });
  return res.json({
    data: jobs.map(({ payload, ...job }) => job),
    total: jobs.length,
  });
}));

/** GET /api/miner/jobs/:id — full job record incl. logs. Public. */
router.get('/jobs/:id', wrap(async (req, res) => {
  const job = await getJob(String(req.params.id));
  if (!job) return res.status(404).json({ error: 'Job not found' });
  return res.json(job);
}));

/** POST /api/miner/run/:id — manual run (admin). */
router.post('/run/:id', requireAuth, requireAdmin, wrap(async (req, res) => {
  const job = await runJob(String(req.params.id));
  await auditLog({
    userid: req.user.id,
    action: 'miner.job.run',
    ip: clientIpOf(req),
    meta: { jobid: String(req.params.id) },
  }).catch(() => {});
  return res.json({ ok: true, job });
}));

/** GET /api/miner/status — health + stats snapshot. Public. */
router.get('/status', wrap(async (req, res) => {
  const stats = await minerStats();
  return res.json({
    ok: true,
    service: 'animaxia-miner',
    searchBackend: searchIndexBackend(),
    ...stats,
  });
}));

/**
 * POST /api/miner/search/push — push library rows to the search catalog for
 * a tenant (admin). Body: { tenant?, limit? } (default: newest 50 rows).
 */
router.post('/search/push', requireAuth, requireAdmin, wrap(async (req, res) => {
  const body = req.body || {};
  const tenant = tenantFromRequest(req, body);
  const limit = Math.max(1, Math.min(100, Number(body.limit) || 50));
  const list = await listContent({ page: 1, limit });
  const push = await pushToSearchIndex(list?.data || [], tenant);
  return res.json({ ok: true, tenant, ...push });
}));

export default router;
