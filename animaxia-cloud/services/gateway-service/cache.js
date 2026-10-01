/**
 * services/gateway-service/cache.js — The gateway's own edge-cache instance.
 *
 * A small, LRU-bounded TTL cache (common/cache.js) holding verbatim upstream
 * responses for cacheable GET prefixes (see edgeCache.js for the policy).
 * Tunables: GATEWAYEDGEDEFAULTTTLMS (default 30000) and
 * GATEWAYEDGECACHEENTRIES (default 5000). Expiry is lazy + a 60s sweeper,
 * which also bounds the stale-while-error window (see edgeCache.js).
 */

import { createCache } from '@animaxia/common/cache.js';

export const EDGE_TTL_MS = parseInt(process.env.GATEWAYEDGEDEFAULTTTLMS || '30000', 10);
export const EDGE_MAX_ENTRIES = parseInt(process.env.GATEWAYEDGECACHEENTRIES || '5000', 10);

/** The edge cache instance (responses are stored as { status, contentType, body, storedAt }). */
export const edgeCache = createCache({
  ttlMs: EDGE_TTL_MS,
  maxEntries: EDGE_MAX_ENTRIES,
  name: 'gateway-edge',
});

export default edgeCache;
