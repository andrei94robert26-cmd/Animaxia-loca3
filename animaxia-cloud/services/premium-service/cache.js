/**
 * services/premium-service/cache.js — The service's own LRU-bounded TTL cache
 * (common/cache.js factory; BLUEPRINT §7 template).
 *
 * General-purpose instance for internal memoization. The premium routes are
 * mounted verbatim from the domain (plansRouter + stripeRouter) and read
 * straight through to the DB — plan/subscription state must always be fresh
 * (a stale "plus" after /cancel would be a correctness bug), so no request
 * path reads through this cache. Hits/misses feed the
 * animaxia_cache_{hits,misses}_total metrics with the 'premium-service' label.
 */

import { createCache } from '@animaxia/common/cache.js';

export const serviceCache = createCache({
  ttlMs: 30000,
  maxEntries: 1000,
  name: 'premium-service',
});

export default serviceCache;
