/**
 * common/rateLimit.js — Fixed-window per-client rate limiter for Animaxia
 * Cloud microservices.
 *
 * Monolith-compatible surface: `rateLimitMiddleware` / `rateLimitStats`
 * (RATELIMITWINDOW_MS / RATELIMITMAX). Extended with `createRateLimit`
 * so every microservice (and the gateway) runs its own limiter with its
 * own limits, key function and metric counter.
 */

const DEFAULT_WINDOW_MS = parseInt(process.env.RATELIMITWINDOW_MS || '60000', 10);
const DEFAULT_MAX = parseInt(process.env.RATELIMITMAX || '120', 10);

export function clientIpOf(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const first = String(xff).split(',')[0].trim();
    if (first) return first;
  }
  if (req.headers['x-real-ip']) return String(req.headers['x-real-ip']);
  if (req.socket && req.socket.remoteAddress) return req.socket.remoteAddress;
  return 'unknown';
}

class FixedWindowLimiter {
  constructor({ windowMs = DEFAULT_WINDOW_MS, max = DEFAULT_MAX, name = 'default', keyFn = clientIpOf } = {}) {
    this.windowMs = Math.max(1000, windowMs);
    this.max = Math.max(1, max);
    this.name = name;
    this.keyFn = keyFn;
    this.clients = new Map();
    this.totalLimited = 0;
    this.cleanupTimer = setInterval(() => this.cleanup(), Math.max(this.windowMs, 30000));
    if (typeof this.cleanupTimer.unref === 'function') this.cleanupTimer.unref();
  }

  cleanup() {
    const now = Date.now();
    for (const [id, entry] of this.clients) {
      if (entry.resetAt <= now) this.clients.delete(id);
    }
  }

  /** Returns { allowed, remaining, resetUnixSec, retryAfterSec } for a request. */
  check(req) {
    const clientId = this.keyFn(req);
    const now = Date.now();
    let entry = this.clients.get(clientId);

    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + this.windowMs };
      this.clients.set(clientId, entry);
    }

    entry.count += 1;
    const remaining = Math.max(0, this.max - entry.count);
    const resetUnixSec = Math.ceil(entry.resetAt / 1000);
    const allowed = entry.count <= this.max;
    if (!allowed) {
      this.totalLimited += 1;
      const m = typeof globalThis.__animaxiaMetrics !== 'undefined' ? globalThis.__animaxiaMetrics : null;
      if (m && m.rateLimited) m.rateLimited.inc({ service: this.name === 'default' ? (process.env.SERVICENAME || 'unknown') : this.name });
    }
    return {
      allowed,
      remaining,
      resetUnixSec,
      retryAfterSec: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
    };
  }

  middleware() {
    return (req, res, next) => {
      const result = this.check(req);
      res.set('X-RateLimit-Limit', String(this.max));
      res.set('X-RateLimit-Remaining', String(result.remaining));
      res.set('X-RateLimit-Reset', String(result.resetUnixSec));
      if (!result.allowed) {
        res.set('Retry-After', String(result.retryAfterSec));
        return res.status(429).json({
          error: 'Too many requests — please slow down',
          retryAfterSec: result.retryAfterSec,
        });
      }
      return next();
    };
  }

  stats() {
    return {
      name: this.name,
      windowMs: this.windowMs,
      max: this.max,
      trackedClients: this.clients.size,
      totalLimited: this.totalLimited,
    };
  }
}

/** Monolith-compatible default limiter (global env tuning). */
const defaultLimiter = new FixedWindowLimiter({ windowMs: DEFAULT_WINDOW_MS, max: DEFAULT_MAX, name: 'default' });
export const rateLimitMiddleware = defaultLimiter.middleware();
export const rateLimitStats = () => defaultLimiter.stats();

/** Factory: per-service limiter with its own limits. */
export function createRateLimit({ windowMs, max, name, keyFn } = {}) {
  const limiter = new FixedWindowLimiter({ windowMs, max, name, keyFn });
  return {
    middleware: () => limiter.middleware(),
    check: (req) => limiter.check(req),
    stats: () => limiter.stats(),
    limiter,
  };
}

export default rateLimitMiddleware;
