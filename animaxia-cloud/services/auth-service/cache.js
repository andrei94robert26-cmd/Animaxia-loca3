/**
 * services/auth-service/cache.js — The service's own LRU-bounded TTL cache
 * (common/cache.js factory; BLUEPRINT §7 template).
 *
 * Deliberately a general-purpose instance: the auth routes are user-specific
 * and security-sensitive, so NOTHING in the request path reads through this
 * cache (sessions, profiles and admin checks must always reflect the fresh
 * DB row — the gateway owns the 60s admin-check memo instead). It exists for
 * internal memoization (e.g. future hot-path lookups) and is reported via
 * cache.stats(); hits/misses feed the animaxia_cache_{hits,misses}_total
 * metrics with the 'auth-service' label.
 */

import { createCache } from '@animaxia/common/cache.js';

export const serviceCache = createCache({
  ttlMs: 30000,
  maxEntries: 1000,
  name: 'auth-service',
});

export default serviceCache;
