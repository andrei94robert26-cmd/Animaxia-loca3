/**
 * services/mobile-service/cache.js — Cache topology for mobile-service.
 *
 * Mobile responses are user-dependent, so this service deliberately does NOT
 * use the global HTTP cacheMiddleware anywhere (the domain router's doc
 * header says exactly that — mounting /api/mobile behind cacheMiddleware()
 * would leak one user's Continue-watching row to everyone). The caches in
 * play:
 *
 *   1. domain advancedCache (ADVANCEDCACHEMAX / ADVANCEDCACHETTLMS) — inside
 *      the domain mobile router: the ANONYMOUS /api/mobile/home payload is
 *      cached under key 'mobile:home' (60s TTL, tag 'content', auto-invalidated
 *      on content:changed). Authenticated /home builds are always fresh.
 *   2. `serviceCache` below — this service's own bounded instance from the
 *      BLUEPRINT §7 frozen folder template. Currently NOT used by any handler
 *      (nothing here should be blindly cached); kept as the composition point
 *      for service-internal caching should a genuinely user-independent
 *      payload appear.
 */

import { createCache } from '@animaxia/common/cache.js';

export const serviceCache = createCache({
  ttlMs: parseInt(process.env.CACHETTLMS || '60000', 10),
  maxEntries: 10000,
  name: 'mobile-service',
});

export default serviceCache;
