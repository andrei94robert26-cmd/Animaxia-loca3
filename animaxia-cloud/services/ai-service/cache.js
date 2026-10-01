/**
 * services/ai-service/cache.js — The service's own LRU-bounded TTL cache.
 *
 * A short-lived (60s, 2000 entries) instance from common/cache.js, kept
 * available for service-level caching needs. It is intentionally NOT wired
 * in front of the /api/ai router: the domain module already caches what is
 * safely cacheable through the tag-aware advancedCache (recommendations per
 * user for 5 min, summaries globally for 10 min) AFTER the quota guard has
 * run — front-caching responses here would let anonymous clients farm cached
 * LLM output past their daily quota, and stale recommendations would defeat
 * the personalized ranking. Quota correctness beats cache-hit ratio.
 */

import { createCache } from '@animaxia/common/cache.js';

export const aiCache = createCache({
  ttlMs: 60000,
  maxEntries: 2000,
  name: 'ai-service',
});

export default aiCache;
