/**
 * services/queue-service/cache.js — The service's own LRU-bounded TTL cache.
 *
 * A short-lived (15s, 500 entries) instance from common/cache.js. It is
 * intentionally NOT mounted in front of the routers: every /api/queue and
 * /api/workers endpoint returns live queue state (job rows, stats, schedule
 * lastrunat) where a 15s-stale snapshot would be actively misleading — and
 * POST endpoints are never cached anyway. The instance exists for
 * service-level needs (e.g. future dedupe of rapid identical enqueues) and
 * keeps the per-service template uniform across the fleet.
 */

import { createCache } from '@animaxia/common/cache.js';

export const serviceCache = createCache({
  ttlMs: 15000,
  maxEntries: 500,
  name: 'queue-service',
});

export default serviceCache;
