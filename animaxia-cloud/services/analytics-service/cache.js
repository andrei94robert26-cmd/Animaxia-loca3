/**
 * services/analytics-service/cache.js — The service's own LRU-bounded TTL
 * cache.
 *
 * A 60s / 2000-entry instance from common/cache.js, kept available for
 * service-level caching needs. It is intentionally NOT wired in front of the
 * /api/analytics router: the domain module already caches exactly what is
 * safely cacheable through the tag-aware advancedCache (trending per window
 * for 60 s, admin overview for 30 s) — and POST /views must NEVER be cached
 * (it is the ingestion path). Front-caching GETs here would only serve stale
 * trending data that the advancedCache already invalidates via the
 * 'content:changed' / 'analytics' tag events.
 */

import { createCache } from '@animaxia/common/cache.js';

export const analyticsCache = createCache({
  ttlMs: 60000,
  maxEntries: 2000,
  name: 'analytics-service',
});

export default analyticsCache;
