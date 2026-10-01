/**
 * common/cache.js — TTL cache for Animaxia Cloud microservices.
 *
 * Monolith-compatible surface: the default `cache` singleton (CACHETTLMS)
 * and `cacheMiddleware()` (X-Cache: HIT/MISS). Extended for the cloud with
 * `createCache({ ttlMs, maxEntries, name })` so every microservice owns a
 * bounded (LRU-evicting) instance with per-instance stats and optional
 * metric hooks (animaxia_cache_hits_total / animaxia_cache_misses_total).
 */

const DEFAULT_TTL_MS = parseInt(process.env.CACHETTLMS || '60000', 10);

class TTLCache {
  constructor({ defaultTtlMs = DEFAULT_TTL_MS, maxEntries = 0, name = 'default' } = {}) {
    this.store = new Map();
    this.defaultTtlMs = defaultTtlMs;
    this.maxEntries = Number.isFinite(maxEntries) && maxEntries > 0 ? maxEntries : 0; // 0 = unbounded
    this.name = name;
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
    this.sweepTimer = setInterval(() => this.sweep(), 60000);
    if (typeof this.sweepTimer.unref === 'function') this.sweepTimer.unref();
  }

  _recordHit() {
    this.hits += 1;
    const m = typeof globalThis.__animaxiaMetrics !== 'undefined' ? globalThis.__animaxiaMetrics : null;
    if (m && m.cacheHits) m.cacheHits.inc({ service: this.name === 'default' ? (process.env.SERVICENAME || 'unknown') : this.name });
  }

  _recordMiss() {
    this.misses += 1;
    const m = typeof globalThis.__animaxiaMetrics !== 'undefined' ? globalThis.__animaxiaMetrics : null;
    if (m && m.cacheMisses) m.cacheMisses.inc({ service: this.name === 'default' ? (process.env.SERVICENAME || 'unknown') : this.name });
  }

  get(key) {
    const entry = this.store.get(key);
    if (!entry) {
      this._recordMiss();
      return undefined;
    }
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      this._recordMiss();
      return undefined;
    }
    // LRU touch: re-insert to keep iteration order = recency order.
    this.store.delete(key);
    this.store.set(key, entry);
    this._recordHit();
    return entry.value;
  }

  set(key, value, ttlMs = this.defaultTtlMs) {
    if (this.maxEntries > 0 && this.store.size >= this.maxEntries && !this.store.has(key)) {
      // Evict the oldest (least-recently-used) entry.
      const oldestKey = this.store.keys().next().value;
      if (oldestKey !== undefined) {
        this.store.delete(oldestKey);
        this.evictions += 1;
      }
    }
    this.store.set(key, {
      value,
      expiresAt: Date.now() + (Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : this.defaultTtlMs),
      storedAt: Date.now(),
    });
    return value;
  }

  /** Peek without recording a hit/miss (used by stale-while-error fallbacks). */
  peek(key, { maxAgeMs = 0 } = {}) {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) return undefined;
    if (maxAgeMs > 0 && Date.now() - entry.storedAt > maxAgeMs) return undefined;
    return entry.value;
  }

  del(key) {
    return this.store.delete(key);
  }

  clear() {
    this.store.clear();
  }

  /** Remove only entries whose key starts with the given prefix (e.g. 'http:'). */
  clearPrefix(prefix) {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) this.store.delete(key);
    }
  }

  sweep() {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (entry.expiresAt <= now) this.store.delete(key);
    }
  }

  stats() {
    const total = this.hits + this.misses;
    return {
      name: this.name,
      keys: this.store.size,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      hitRate: total === 0 ? 0 : Number((this.hits / total).toFixed(4)),
    };
  }
}

/** Default singleton — identical semantics to the monolith cache. */
export const cache = new TTLCache({ defaultTtlMs: DEFAULT_TTL_MS, name: 'default' });

/** Factory for per-service caches (each microservice owns its instance). */
export function createCache({ ttlMs = DEFAULT_TTL_MS, maxEntries = 0, name = 'service' } = {}) {
  return new TTLCache({ defaultTtlMs: ttlMs, maxEntries, name });
}

/**
 * Express middleware caching GET responses by original URL against the given
 * cache instance (default: the shared singleton). On hit: responds with the
 * identical JSON body + X-Cache: HIT. On miss: intercepts res.json, stores
 * 200 responses, tags X-Cache: MISS.
 */
export function cacheMiddleware(instance = cache) {
  return (req, res, next) => {
    if (req.method !== 'GET') return next();
    const key = req.originalUrl || req.url;
    const cached = instance.get(`http:${key}`);
    if (cached !== undefined) {
      res.set('X-Cache', 'HIT');
      res.status(200).json(cached);
      return;
    }
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode === 200) {
        instance.set(`http:${key}`, body);
        res.set('X-Cache', 'MISS');
      }
      return originalJson(body);
    };
    return next();
  };
}

export default cache;
