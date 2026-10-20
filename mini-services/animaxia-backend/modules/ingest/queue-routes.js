/**
 * Authenticated metadata queue API. Service credential may enqueue only
 * configured sources; reading queue state is restricted to admins.
 */
import express from 'express';
import { requireMetadataIngestAccess, allowedMetadataServiceSource } from './service-auth.js';
import { requireAuth, requireAdmin } from '../users/auth.js';
import { userRateLimit } from '../security/security.js';
import {
  enqueueMetadataBatch, getMetadataJob, listMetadataJobs, metadataSourceStatus,
  ensureMetadataQueueSchema,
} from './queue.js';

const router = express.Router();
const submitLimit = userRateLimit({ scope: 'ip', max: 20, windowMs: 60_000, key: 'metadata-queue' });
router.post('/metadata/queue', requireMetadataIngestAccess, submitLimit, (req, res, next) => {
  try {
    const { source, items, idempotencyKey } = req.body || {};
    if (req.metadataIngestService && !allowedMetadataServiceSource(source)) {
      return res.status(403).json({ error: 'Source not approved for ingestion' });
    }
    ensureMetadataQueueSchema();
    const job = enqueueMetadataBatch({ source, items, idempotencyKey });
    const status = metadataSourceStatus();
    return res.status(job.queued ? 202 : 200).json({
      ...job, workerActive: status.queue.workerActive,
    });
  } catch (err) { return next(err); }
});
router.get('/metadata/jobs', requireAuth, requireAdmin, (req, res, next) => {
  try {
    return res.json({
      jobs: listMetadataJobs({
        limit: req.query.limit,
        sourceType: req.query.sourceType,
        sourceId: req.query.sourceId,
      }),
    });
  } catch (err) { return next(err); }
});
router.get('/metadata/jobs/:id', requireAuth, requireAdmin, (req, res, next) => {
  try {
    const job = getMetadataJob(req.params.id);
    return job ? res.json(job) : res.status(404).json({ error: 'Job not found' });
  } catch (err) { return next(err); }
});
router.get('/metadata/sources/status', requireAuth, requireAdmin, (_req, res, next) => {
  try { return res.json(metadataSourceStatus()); }
  catch (err) { return next(err); }
});
export default router;
