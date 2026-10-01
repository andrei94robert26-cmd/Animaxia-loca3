/**
 * services/search-service/cache.js — The service's own LRU-bounded TTL cache.
 *
 * A short 30s / 2000-entry instance from common/cache.js — search results are
 * cache-hot (autocomplete keystrokes repeat prefixes, popular queries recur).
 * It is kept available for service-level caching; it is intentionally NOT
 * wired in front of the /api/search router by default:
 *   • /advanced and /autocomplete already answer from the in-memory index in
 *     microseconds-to-milliseconds once built,
 *   • GET /status must stay live (dirty/docs diagnostics),
 *   • POST /index is never cacheable,
 *   • the gateway's edge cache already provides a shared 30s GET layer.
 * Mount `cacheMiddleware(searchCache)` in server.js if a deployment ever
 * needs an extra service-local response layer.
 */

import { createCache } from '@animaxia/common/cache.js';

export const searchCache = createCache({
  ttlMs: 30000,
  maxEntries: 2000,
  name: 'search-service',
});

export default searchCache;
