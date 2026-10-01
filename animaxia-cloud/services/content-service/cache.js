/**
 * services/content-service/cache.js — Cache topology for content-service.
 *
 * THREE caches are in play; only the first two carry traffic (exactly like
 * the monolith):
 *
 *   1. common/cache.js `cache` singleton (CACHETTLMS) — used by
 *      cacheMiddleware() for the X-Cache: HIT/MISS HTTP response layer
 *      (keys 'http:<url>', invalidated by router.js invalidateHttpCache()
 *      on every mutation) AND by the provider fetch layer
 *      (common/fetcher.js, keys 'provider:…', TTL PROVIDERCACHETTL_MS —
 *      deliberately NOT 'http:'-prefixed so content mutations never evict
 *      warm provider responses) and the TMDB genre map (24h TTL).
 *   2. domain advancedCache (ADVANCEDCACHEMAX / ADVANCEDCACHETTLMS) — the
 *      per-user/tag-aware LRU behind /api/cache/stats and /api/cache/invalidate.
 *   3. `serviceCache` below — this service's own bounded instance from the
 *      BLUEPRINT §7 frozen folder template. Currently NOT used by any
 *      handler: the hot paths deliberately share the common singleton so
 *      cacheMiddleware + invalidateHttpCache behave identically to the
 *      monolith. Kept for service-internal caching should the service grow
 *      one (e.g. hot search facets) — importing it is free, using it is
 *      opt-in.
 */

import { createCache } from '@animaxia/common/cache.js';

export const serviceCache = createCache({
  ttlMs: parseInt(process.env.CACHETTLMS || '60000', 10),
  maxEntries: 10000,
  name: 'content-service',
});

export default serviceCache;
