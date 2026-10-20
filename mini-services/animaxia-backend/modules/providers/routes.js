/**
 * Admin-only provider controls. Catalog is not installation and installation
 * is not an upstream API availability claim.
 */
import express from 'express';
import crypto from 'node:crypto';
import { requireAuth, requireAdmin } from '../users/auth.js';
import { userRateLimit } from '../security/security.js';
import { PROVIDER_CATALOG, getProviderDefinition, providerReadiness } from './catalog.js';
import { fetchProviderMetadata } from './fetch.js';
import { recordProviderFetch } from './health.js';
import { enqueueMetadataBatch } from '../ingest/queue.js';

const router = express.Router();
router.use(requireAuth, requireAdmin);
const limiter = userRateLimit({ scope: 'ip', max: 12, windowMs: 60_000, key: 'provider-fetch' });

router.get('/', (_req, res) => res.json({
  catalogCount: PROVIDER_CATALOG.length,
  implementedDrivers: PROVIDER_CATALOG.filter((x) => x.driverImplemented).length,
  catalogIsNotInstalled: true,
  providers: PROVIDER_CATALOG.map(providerReadiness),
}));
router.get('/:id', (req, res) => {
  const result = providerReadiness(req.params.id);
  return result ? res.json(result) : res.status(404).json({ error: 'Unknown provider' });
});
router.post('/:id/sync', limiter, async (req, res, next) => {
  try {
    const id = String(req.params.id || '').toLowerCase();
    const definition = getProviderDefinition(id);
    if (!definition) return res.status(404).json({ error: 'Provider is not in the catalog' });
    if (!definition.driverImplemented) return res.status(501).json({
      error: 'Provider is cataloged but no JSON fetch driver is installed',
    });
    const readiness = providerReadiness(definition);
    if (!readiness.installed || !readiness.enabled) {
      return res.status(409).json({
        error: 'Install and activate this API manifest in /api/integrations/sources first',
      });
    }
    if (!readiness.credentialsPresent) return res.status(503).json({
      error: 'Provider credentials missing from backend environment',
      requiredEnv: definition.requiredEnv,
    });
    const query = typeof req.body?.q === 'string' ? req.body.q : '';
    if (query.length > 120) return res.status(400).json({ error: 'q must be <=120 chars' });
    const page = req.body?.page ?? 1;
    if (!Number.isInteger(Number(page)) || Number(page) < 1 || Number(page) > 10) {
      return res.status(400).json({ error: 'page must be 1..10' });
    }
    let fetched;
    try {
      fetched = await fetchProviderMetadata(id, { q: query, page: Number(page) });
      recordProviderFetch(id, { ok: true, count: fetched.count });
    } catch (error) {
      recordProviderFetch(id, { ok: false, error: error?.message });
      throw error;
    }
    if (!fetched.items.length) return res.json({
      providerId: id, fetched: 0, enqueued: false, reason: 'No supported media metadata in provider response',
    });
    // Hash *all* input and output so equal batches dedupe but changed remote
    // metadata can still be imported under a new idempotency key.
    const digest = crypto.createHash('sha256').update(JSON.stringify({
      q: fetched.query, page: fetched.page, items: fetched.items,
    })).digest('hex').slice(0, 36);
    const key = 'provider:' + id + ':' + digest;
    const job = enqueueMetadataBatch({
      source: fetched.source, items: fetched.items, idempotencyKey: key,
    });
    return res.status(job.queued ? 202 : 200).json({
      providerId: id, fetched: fetched.count, enqueued: job.queued,
      duplicate: job.duplicate, jobId: job.id, status: job.status,
      workerRequired: true, source: fetched.source,
    });
  } catch (error) { next(error); }
});
export default router;
