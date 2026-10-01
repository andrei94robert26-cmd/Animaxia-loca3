/**
 * services/gateway-service/edgeCache.js — Edge caching + stale-while-error.
 *
 * Policy (all keys are `<service>:<originalUrl-with-query>`):
 *   • Cacheable = method GET && upstream status 200 && path under one of
 *     CACHEABLE_PREFIXES (exact prefix or a /child of it).
 *   • HIT  → served with `X-Cache: HIT` + standard `Age` (no upstream call).
 *   • MISS → proxied; fresh 200s are stored under the edge TTL
 *     (GATEWAYEDGEDEFAULTTTLMS, default 30s) and served with `X-Cache: MISS`.
 *   • STALE-while-error → when the upstream call fails (network error, timeout
 *     or 5xx — NEVER a 4xx, those pass through verbatim) the last stored copy
 *     (from the shadow stale store, see below) is served with
 *     `X-Cache: STALE` + 200 instead of the error, for up to
 *     STALE_WINDOW_MS (10 × TTL) after it was stored.
 *   • Smart invalidation → any unsafe method (POST/PUT/PATCH/DELETE) to /api/*
 *     purges the /api/all, /api/content and /api/mobile prefixes (best-effort;
 *     every service still owns and invalidates its own internal caches).
 */

import { edgeCache, EDGE_TTL_MS, EDGE_MAX_ENTRIES } from './cache.js';

/** GET paths eligible for edge caching (matched as exact prefix or parent). */
export const CACHEABLE_PREFIXES = [
  '/api/all',
  '/api/content',
  '/api/anime',
  '/api/movies',
  '/api/tv',
  '/api/sports',
  '/api/news',
  '/api/search',
  '/api/mobile/home',
  '/api/analytics/trending',
];

/** Stale-while-error window: 10 × TTL after storage. */
export const STALE_WINDOW_MS = 10 * EDGE_TTL_MS;

/**
 * Shadow stale store — the SAME entry objects as the edge cache, kept beyond
 * their TTL for the stale-while-error fallback. Necessary because
 * common/cache.js's `get()` DELETES expired entries on lookup (and `peek()`
 * rejects anything past `expiresAt`), so the spec's
 * `instance.peek(key, { maxAgeMs: 10 * TTL })` alone would make
 * stale-while-error dead code. Entries here share the body Buffer with the
 * main cache (no duplication); the map is FIFO-bounded at 2 × maxEntries.
 */
const staleStore = new Map();
const STALE_MAX_ENTRIES = Math.max(64, 2 * EDGE_MAX_ENTRIES);

/** Prefixes purged after ANY unsafe /api/* write. */
export const INVALIDATE_PREFIXES = ['/api/all', '/api/content', '/api/mobile'];

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

let totalPurges = 0;

function pathMatches(path, prefix) {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** Cacheable = GET + path under one of CACHEABLE_PREFIXES. */
export function isCacheable(method, path) {
  if (method !== 'GET') return false;
  return CACHEABLE_PREFIXES.some((prefix) => pathMatches(path, prefix));
}

/** Normal cache lookup — records a hit/miss on the instance stats. */
export function lookupEdge(key) {
  return edgeCache.get(key);
}

/** Store a fresh upstream response (body is a Buffer; status is 200). */
export function storeEdge(key, status, contentType, body) {
  const entry = { status, contentType, body, storedAt: Date.now() };
  edgeCache.set(key, entry);
  staleStore.set(key, entry); // same object — body stored once
  while (staleStore.size > STALE_MAX_ENTRIES) {
    const oldest = staleStore.keys().next().value;
    if (oldest === undefined) break;
    staleStore.delete(oldest);
  }
  return true;
}

/**
 * Stale lookup — no stats, no hit/miss recording; tolerates entries up to
 * STALE_WINDOW_MS old (from the shadow stale store, see above).
 */
export function peekStaleEdge(key) {
  const entry = staleStore.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.storedAt > STALE_WINDOW_MS) {
    staleStore.delete(key);
    return undefined;
  }
  return entry;
}

/** Purge everything (main cache + stale shadow). Returns { purged }. */
export function purgeAll() {
  const purged = edgeCache.stats().keys;
  edgeCache.clear();
  staleStore.clear();
  totalPurges += 1;
  return { purged };
}

/**
 * Purge every entry whose URL path sits under `prefix` — from BOTH the main
 * cache and the stale shadow (keys are "<service>:<originalUrl>").
 * Returns the number of entries removed.
 */
export function purgePrefix(prefix) {
  let removed = 0;
  for (const key of Array.from(edgeCache.store.keys())) {
    const path = String(key.slice(key.indexOf(':') + 1)).split('?')[0]; // strip "<service>:"
    if (pathMatches(path, prefix)) {
      edgeCache.store.delete(key);
      removed += 1;
    }
  }
  for (const key of Array.from(staleStore.keys())) {
    const path = String(key.slice(key.indexOf(':') + 1)).split('?')[0];
    if (pathMatches(path, prefix)) {
      staleStore.delete(key);
      removed += 1;
    }
  }
  if (removed > 0) totalPurges += 1;
  return removed;
}

/** Smart invalidation on unsafe methods — called by proxy.js BEFORE forwarding. */
export function invalidateOnUnsafe(method, path) {
  if (!UNSAFE_METHODS.has(method)) return 0;
  let purged = 0;
  for (const prefix of INVALIDATE_PREFIXES) purged += purgePrefix(prefix);
  return purged;
}

/** Edge cache stats: instance stats + policy/config + purge counters. */
export function edgeStats() {
  return {
    ...edgeCache.stats(),
    staleKeys: staleStore.size,
    ttlMs: EDGE_TTL_MS,
    maxEntries: EDGE_MAX_ENTRIES,
    staleWindowMs: STALE_WINDOW_MS,
    cacheablePrefixes: CACHEABLE_PREFIXES,
    invalidatePrefixes: INVALIDATE_PREFIXES,
    totalPurges,
  };
}

export default edgeCache;
