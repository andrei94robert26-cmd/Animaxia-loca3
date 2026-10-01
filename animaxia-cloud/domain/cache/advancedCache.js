/**
 * domain/cache/advancedCache.js — Advanced per-user LRU cache layer for the
 * Phase-2 platform modules (AI, social, player prefetch…).
 *
 *   • LRU semantics on a native Map (delete + re-set refreshes recency).
 *   • Per-entry TTL (default from ADVANCEDCACHETTLMS, fallback 300000 ms).
 *   • Capacity from ADVANCEDCACHEMAX (fallback 1000 entries) with eviction counter.
 *   • Tag-based invalidation (entries carry `tags: string[]`).
 *   • Per-user key namespace: userKey(userId, key) → `user:${userId}:${key}`.
 *   • Automatic invalidation driven by the platform event bus:
 *       content:changed → invalidateTag('content')
 *       comment:added  → invalidateTag('social')
 *       plan:changed   → invalidateTag('users') + invalidateTag(`user:${id}`)
 *       user:changed   → invalidateTag('users') + invalidateTag(`user:${id}`)
 *
 * Router (mount: app.use('/api/cache', advancedCacheRouter)):
 *   GET  /stats                     → { lru: {...}, global: {...} }        (public)
 *   POST /invalidate { tags?, prefix? } → { ok, cleared }                  (admin)
 *
 * FROZEN method surface (other modules import `advancedCache`):
 *   get(key) / set(key, value, { ttlMs, tags }) / del(key)
 *   invalidateTag(tag) / invalidateTags(tags[])
 *   userKey(userId, key) / stats()
 */

import express from 'express';
import { events } from '@animaxia/common/events.js';
import { requireAuth, requireAdmin } from '../users/auth.js';
import { clientIpOf, auditLog } from '../security/security.js';
import { cache } from '@animaxia/common/cache.js';
import { logger } from '@animaxia/common/logger.js';

/* ------------------------------- configuration ------------------------------ */

const MAX_ENTRIES = Math.max(1, parseInt(process.env.ADVANCEDCACHEMAX || '1000', 10) || 1000);
const DEFAULT_TTL_MS = Math.max(1000, parseInt(process.env.ADVANCEDCACHETTLMS || '300000', 10) || 300000);
const SWEEP_INTERVAL_MS = 60000;

/* ---------------------------------- LRU core --------------------------------- */

/**
 * Tag-aware LRU cache with TTL, hit/miss accounting and eviction statistics.
 * Recency is maintained via Map insertion order: every `get`/`set` on a live
 * key deletes and re-inserts it, so the first key is always the eviction victim.
 */
class AdvancedLRUCache {
  constructor(maxEntries = MAX_ENTRIES, defaultTtlMs = DEFAULT_TTL_MS) {
    this.maxEntries = maxEntries;
    this.defaultTtlMs = defaultTtlMs;
    /** @type {Map<string, { value: unknown, expiresAt: number, tags: string[] }>} */
    this.map = new Map();
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
    this.sweepTimer = setInterval(() => this.sweepExpired(), SWEEP_INTERVAL_MS);
    if (typeof this.sweepTimer.unref === 'function') this.sweepTimer.unref();
  }

  /** Remove expired entries (background sweep; get() also self-heals). */
  sweepExpired() {
    const now = Date.now();
    for (const [key, entry] of this.map) {
      if (entry.expiresAt <= now) this.map.delete(key);
    }
  }

  /**
   * Fetch a live entry and refresh its LRU recency.
   * @returns {unknown} the cached value, or undefined on miss/expiry.
   */
  get(key) {
    const entry = this.map.get(key);
    if (!entry) {
      this.misses += 1;
      return undefined;
    }
    if (entry.expiresAt <= Date.now()) {
      this.map.delete(key);
      this.misses += 1;
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, entry); // refresh recency
    this.hits += 1;
    return entry.value;
  }

  /**
   * Insert/replace an entry.
   * @param {string} key
   * @param {unknown} value
   * @param {{ ttlMs?: number, tags?: string[] }} [opts]
   */
  set(key, value, opts = {}) {
    const ttl = Number.isFinite(opts.ttlMs) && opts.ttlMs > 0 ? opts.ttlMs : this.defaultTtlMs;
    const tags = Array.isArray(opts.tags) ? opts.tags.map(String).filter(Boolean) : [];
    if (this.map.has(key)) {
      this.map.delete(key); // re-insert at the recency tail
    } else if (this.map.size >= this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) {
        this.map.delete(oldest);
        this.evictions += 1;
      }
    }
    this.map.set(key, { value, expiresAt: Date.now() + ttl, tags });
    return value;
  }

  /** Delete a single entry. @returns {boolean} whether a live-or-expired key existed. */
  del(key) {
    return this.map.delete(key);
  }

  /** Remove every entry carrying the given tag. @returns {number} entries removed. */
  invalidateTag(tag) {
    if (tag === undefined || tag === null) return 0;
    const needle = String(tag);
    let removed = 0;
    for (const [key, entry] of this.map) {
      if (entry.tags.includes(needle)) {
        this.map.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  /** Remove every entry carrying ANY of the given tags. @returns {number} entries removed. */
  invalidateTags(tags) {
    if (!Array.isArray(tags)) return 0;
    let removed = 0;
    for (const tag of tags) removed += this.invalidateTag(tag);
    return removed;
  }

  /** Namespaced per-user key: `user:${userId}:${key}`. */
  userKey(userId, key) {
    return `user:${userId}:${key}`;
  }

  /** Count of distinct tags currently held across live entries. */
  distinctTagCount() {
    const seen = new Set();
    for (const entry of this.map.values()) {
      for (const tag of entry.tags) seen.add(tag);
    }
    return seen.size;
  }

  /** Operational snapshot for /api/cache/stats. */
  stats() {
    const total = this.hits + this.misses;
    return {
      entries: this.map.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total === 0 ? 0 : Number((this.hits / total).toFixed(4)),
      evictions: this.evictions,
      maxEntries: this.maxEntries,
      defaultTtlMs: this.defaultTtlMs,
      tagCount: this.distinctTagCount(),
    };
  }
}

/** The shared platform LRU instance (FROZEN surface — see module doc). */
export const advancedCache = new AdvancedLRUCache();

/* --------------------------- event-bus invalidation -------------------------- */

events.on('content:changed', () => {
  advancedCache.invalidateTag('content');
});

events.on('comment:added', () => {
  advancedCache.invalidateTag('social');
});

for (const evt of ['plan:changed', 'user:changed']) {
  events.on(evt, (payload = {}) => {
    advancedCache.invalidateTag('users');
    if (payload?.userid != null) advancedCache.invalidateTag(`user:${payload.userid}`);
  });
}

/* ---------------------------------- router ----------------------------------- */

export const advancedCacheRouter = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** GET /api/cache/stats — public LRU + global HTTP/provider cache snapshot. */
advancedCacheRouter.get('/stats', (req, res) => {
  res.json({ lru: advancedCache.stats(), global: cache.stats() });
});

/**
 * POST /api/cache/invalidate — admin-only manual invalidation.
 * Body: { tags?: string[], prefix?: string } → { ok, cleared }
 */
advancedCacheRouter.post('/invalidate', requireAuth, requireAdmin, wrap(async (req, res) => {
  const { tags, prefix } = req.body || {};
  let cleared = 0;

  if (Array.isArray(tags) && tags.length > 0) {
    cleared += advancedCache.invalidateTags(tags.map(String).filter(Boolean));
  }

  if (typeof prefix === 'string' && prefix.length > 0) {
    for (const key of advancedCache.map.keys()) {
      if (key.startsWith(prefix)) {
        advancedCache.del(key);
        cleared += 1;
      }
    }
  }

  logger.info(
    `[cache] Manual invalidation by user ${req.user?.id ?? '?'} from ${clientIpOf(req)} — cleared ${cleared} entr${cleared === 1 ? 'y' : 'ies'}`,
  );
  await auditLog({
    userid: req.user?.id ?? null,
    action: 'cache.invalidate',
    ip: clientIpOf(req),
    meta: { tags: tags || null, prefix: prefix || null, cleared },
  });
  res.json({ ok: true, cleared });
}));

export default advancedCacheRouter;
