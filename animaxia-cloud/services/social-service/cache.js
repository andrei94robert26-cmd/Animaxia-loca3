/**
 * services/social-service/cache.js — The service's own LRU-bounded TTL cache
 * (common/cache.js factory; BLUEPRINT §7 template).
 *
 * General-purpose instance for internal memoization. The social routes are
 * mounted verbatim from the domain (commentsRouter + feedRouter) and read
 * straight through to the DB — comment threads and likes are user-dependent
 * (myVote), so nothing in the request path reads through this cache. The
 * global-feed snapshot lives in the domain advancedCache instead (tagged
 * 'social'/'feed', refreshed by server.js every 5 min — see server.js).
 * serviceCache stats/hits feed the animaxia_cache_{hits,misses}_total metrics
 * with the 'social-service' label.
 */

import { createCache } from '@animaxia/common/cache.js';

export const serviceCache = createCache({
  ttlMs: 30000,
  maxEntries: 1000,
  name: 'social-service',
});

export default serviceCache;
