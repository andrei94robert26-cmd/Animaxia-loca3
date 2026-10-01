/**
 * layers.ts — FAZA 22 global perimeter layers (defense-in-depth).
 *
 * These run at the GLOBAL GATEWAY (perimeter), in front of the backend, with
 * distributed state in Redis (rate-limit windows, cooldown locks, anti-spam
 * counters, response cache). The FAZA 18 pipeline inside the backend is
 * untouched and remains the authority for the search engine itself — the
 * perimeter mirrors the same layer philosophy:
 *
 *   anti-spam -> cooldown -> rate-limit -> cache
 *
 * (cooldown is checked before the limiter so locked clients short-circuit
 * early — a perimeter ordering choice, documented here honestly).
 */

import { createHash } from 'node:crypto';
import type { RedisLike } from './redis-client';

export type RouteClass = 'search' | 'hub' | 'ai' | 'general';

export const CLASS_LIMITS: Record<RouteClass, { limit: number; windowSec: number }> = {
  search: { limit: 120, windowSec: 60 },
  hub: { limit: 240, windowSec: 60 },
  ai: { limit: 60, windowSec: 60 },
  general: { limit: 600, windowSec: 60 },
};

export const CACHE_TTL_SEC = { search: 45, hub: 60 } as const;

export interface Verdict {
  ok: boolean;
  status?: number;
  error?: string;
  retryAfter?: number;
  headers?: Record<string, string>;
}

export interface CachedResponse {
  status: number;
  contentType: string;
  body: string;
  storedAt: number;
}

export class PerimeterLayers {
  stats = {
    requests: 0,
    cacheHits: 0,
    cacheMisses: 0,
    cacheBypasses: 0,
    rateLimited: 0,
    cooldownActive: 0,
    spamBlocked: 0,
    failovers: 0,
    perRegion: { eu: 0, us: 0, asia: 0 } as Record<string, number>,
  };

  constructor(private redis: RedisLike) {}

  static routeClass(path: string): RouteClass {
    if (path.startsWith('/api/search')) return 'search';
    if (path.startsWith('/api/hub')) return 'hub';
    if (path.startsWith('/api/ai')) return 'ai';
    return 'general';
  }

  /** Cacheable = public GET on search/hub reads without credentials. */
  static cacheable(method: string, path: string, hasAuth: boolean): boolean {
    return method === 'GET' && !hasAuth && (path.startsWith('/api/search/') || path.startsWith('/api/hub/'));
  }

  /** Cache key ignores our own `region` param and the sandbox `XTransformPort`. */
  static cacheKey(path: string, params: URLSearchParams): string {
    const clean = new URLSearchParams();
    const sorted = [...params.entries()].sort(([a], [b]) => a.localeCompare(b));
    for (const [k, v] of sorted) {
      if (k === 'region' || k.toLowerCase() === 'xtransformport') continue;
      clean.append(k, v);
    }
    const q = clean.toString();
    return `cache:GET:${path}${q ? '?' + q : ''}`;
  }

  /* ------------------------------------------------------------ anti-spam -- */

  async antiSpam(ip: string, method: string, path: string, query: string, body: string | null): Promise<Verdict> {
    const hardFail = query.length > 512 || /[\x00-\x08\x0e-\x1f]/.test(query + (body ?? ''));
    if (!hardFail) {
      const locked = await this.redis.get(`spamlock:${ip}`).catch(() => null);
      if (!locked) {
        const hash = createHash('sha1')
          .update(`${method} ${path} ${query} ${(body ?? '').slice(0, 4096)}`)
          .digest('hex')
          .slice(0, 16);
        let count = 0;
        try {
          count = await this.redis.incr(`spam:${ip}:${hash}`);
          if (count === 1) await this.redis.expire(`spam:${ip}:${hash}`, 10);
        } catch {
          count = 0; // fail-open: Redis semantic error must not block traffic
        }
        if (count <= 25) return { ok: true };
      }
    }
    await this.redis.set(`spamlock:${ip}`, '1', { exSec: 30 }).catch(() => {});
    this.stats.spamBlocked++;
    return { ok: false, status: 429, error: 'anti_spam', retryAfter: 30 };
  }

  /* ------------------------------------------------------------- cooldown -- */

  async cooldown(ip: string): Promise<Verdict> {
    const lockTtl = await this.redis.ttl(`cdlock:${ip}`).catch(() => -2);
    if (lockTtl > 0) {
      this.stats.cooldownActive++;
      return { ok: false, status: 429, error: 'cooldown_active', retryAfter: lockTtl };
    }
    const viol = Number((await this.redis.get(`cdviol:${ip}`).catch(() => null)) ?? 0);
    if (viol >= 3) {
      await this.redis.set(`cdlock:${ip}`, '1', { exSec: 60 }).catch(() => {});
      this.stats.cooldownActive++;
      return { ok: false, status: 429, error: 'cooldown_active', retryAfter: 60 };
    }
    return { ok: true };
  }

  /* ----------------------------------------------------------- rate-limit -- */

  async rateLimit(ip: string, path: string): Promise<Verdict> {
    const cls = PerimeterLayers.routeClass(path);
    const { limit, windowSec } = CLASS_LIMITS[cls];
    const windowId = Math.floor(Date.now() / (windowSec * 1000));
    const key = `rl:${cls}:${ip}:${windowId}`;
    let count = 0;
    try {
      count = await this.redis.incr(key);
      if (count === 1) await this.redis.expire(key, windowSec + 1);
    } catch {
      return { ok: true }; // fail-open on semantic errors (connection errors already fell back to memory)
    }
    const resetSec = Math.max(1, (windowId + 1) * windowSec - Math.floor(Date.now() / 1000));
    const headers = {
      'x-ratelimit-limit': String(limit),
      'x-ratelimit-remaining': String(Math.max(0, limit - count)),
      'x-ratelimit-reset': String(resetSec),
    };
    if (count > limit) {
      try {
        const v = await this.redis.incr(`cdviol:${ip}`);
        if (v === 1) await this.redis.expire(`cdviol:${ip}`, 300);
      } catch { /* best effort */ }
      this.stats.rateLimited++;
      return { ok: false, status: 429, error: 'rate_limited', retryAfter: resetSec, headers };
    }
    return { ok: true, headers };
  }

  /* ---------------------------------------------------------------- cache -- */

  async cacheGet(key: string): Promise<CachedResponse | null> {
    const raw = await this.redis.get(key).catch(() => null);
    if (!raw) {
      this.stats.cacheMisses++;
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as CachedResponse;
      this.stats.cacheHits++;
      return parsed;
    } catch {
      this.stats.cacheMisses++;
      return null;
    }
  }

  async cachePut(key: string, resp: CachedResponse): Promise<void> {
    const ttl = key.includes('/api/search/') ? CACHE_TTL_SEC.search : CACHE_TTL_SEC.hub;
    await this.redis.set(key, JSON.stringify(resp), { exSec: ttl }).catch(() => {});
  }

  async cachePurge(prefix: string): Promise<number> {
    const keys = await this.redis.keys(`${prefix}*`).catch(() => [] as string[]);
    if (!keys.length) return 0;
    return this.redis.del(keys).catch(() => 0);
  }
}
