/**
 * cache.js — Global TTL cache shared by HTTP response caching and the provider layer.
 * Map-backed with per-entry expiry, periodic 60s sweep, and Express middleware that
 * caches GET responses keyed by req.originalUrl (X-Cache: HIT/MISS headers).
 */

const DEFAULT_TTL_MS = parseInt(process.env.CACHETTLMS || '60000', 10);

class TTLCache {
  constructor(defaultTtlMs = DEFAULT_TTL_MS) {
    this.store = new Map();
    this.defaultTtlMs = defaultTtlMs;
    this.hits = 0;
    this.misses = 0;
    this.sweepTimer = setInterval(() => this.sweep(), 60000);
    if (typeof this.sweepTimer.unref === 'function') this.sweepTimer.unref();
  }

  get(key) {
    const entry = this.store.get(key);
    if (!entry) {
      this.misses += 1;
      return undefined;
    }
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      this.misses += 1;
      return undefined;
    }
    this.hits += 1;
    return entry.value;
  }

  set(key, value, ttlMs = this.defaultTtlMs) {
    this.store.set(key, {
      value,
      expiresAt: Date.now() + (Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : this.defaultTtlMs),
    });
    return value;
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
      keys: this.store.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total === 0 ? 0 : Number((this.hits / total).toFixed(4)),
    };
  }
}

export const cache = new TTLCache();

/**
 * Express middleware caching GET responses by original URL.
 * On hit: responds with the identical JSON body + X-Cache: HIT.
 * On miss: intercepts res.json, stores 200 responses, tags X-Cache: MISS.
 * NEON FREE PLAN: acceptă { ttlMs } per-rută — rutele de catalog DB-backed
 * (/api/all, /api/content/*) primesc TTL lung (60 min) cu invalidare la
 * content:changed (clearPrefix('http:')), ca homepage-ul să nu trezească
 * Neon decât la primul vizitator sau la conținut schimbat.
 */
export function cacheMiddleware({ ttlMs } = {}) {
  return (req, res, next) => {
    if (req.method !== 'GET') return next();
    const key = req.originalUrl || req.url;
    const cached = cache.get(`http:${key}`);
    if (cached !== undefined) {
      res.set('X-Cache', 'HIT');
      res.status(200).json(cached);
      return;
    }
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode === 200) {
        cache.set(`http:${key}`, body, ttlMs);
        res.set('X-Cache', 'MISS');
      }
      return originalJson(body);
    };
    return next();
  };
}

export default cache;
