/**
 * shared/rate-limit.ts — global rate limiting, per-IP and per-user.
 *
 * Three tiers with graceful degradation, strongest first:
 *   1. Durable Object  (env.RATE_LIMITER, class RateLimiterDurable in
 *      worker/src/ratelimiter-do.ts) — strongly consistent fixed window,
 *      accurate across all colos.
 *   2. KV fixed window (env.EDGE_RATELIMIT) — eventually consistent
 *      fallback (last-write-wins increments under race; acceptable as a
 *      coarse limiter).
 *   3. Per-isolate in-memory Map — last-resort backstop, same idea as the
 *      Phase-3 cdn worker.
 *
 * Responses carry X-RateLimit-Limit / -Remaining / -Reset; 429s add
 * Retry-After. See shared/types.ts RateResult.
 */

import type { EdgeEnv, RateResult } from './types';

export function rateLimitHeaders(r: RateResult): Record<string, string> {
  return {
    'x-ratelimit-limit': String(r.limit),
    'x-ratelimit-remaining': String(Math.max(0, r.remaining)),
    'x-ratelimit-reset': String(r.resetSec),
  };
}

export function rateLimitedResponse(r: RateResult): Response {
  const retryAfter = Math.max(1, r.resetSec - Math.floor(Date.now() / 1000));
  return new Response(JSON.stringify({
    error: 'rate_limited',
    message: 'Too many requests at the Animaxia edge — slow down.',
    limit: r.limit,
    resetSec: r.resetSec,
  }), {
    status: 429,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'retry-after': String(retryAfter),
      ...rateLimitHeaders(r),
    },
  });
}

/* ------------------------------------------------------------- DO tier ----- */

async function checkViaDo(env: EdgeEnv, key: string, limit: number, windowSec: number): Promise<RateResult | null> {
  if (!env.RATE_LIMITER) return null;
  try {
    const id = env.RATE_LIMITER.idFromName(key);
    const stub = env.RATE_LIMITER.get(id);
    const url = `http://do/check?key=${encodeURIComponent(key)}&limit=${limit}&windowSec=${windowSec}`;
    const res = await stub.fetch(new Request(url));
    if (!res.ok) return null;
    return (await res.json()) as RateResult;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------- KV tier ----- */

async function checkViaKv(env: EdgeEnv, key: string, limit: number, windowSec: number): Promise<RateResult | null> {
  if (!env.EDGE_RATELIMIT) return null;
  const nowSec = Math.floor(Date.now() / 1000);
  const bucket = Math.floor(nowSec / windowSec);
  const resetSec = (bucket + 1) * windowSec;
  const kvKey = `rl:${key}:${bucket}`;
  try {
    const raw = await env.EDGE_RATELIMIT.get(kvKey);
    const count = raw ? Number(raw) || 0 : 0;
    const newCount = count + 1;
    // 2× window TTL so stale buckets vanish.
    await env.EDGE_RATELIMIT.put(kvKey, String(newCount), { expirationTtl: Math.max(60, windowSec * 2) });
    return {
      allowed: newCount <= limit,
      limit,
      remaining: Math.max(0, limit - newCount),
      resetSec,
    };
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------- memory tier ---- */

const memoryBuckets = new Map<string, { count: number; resetAt: number }>();

function checkViaMemory(key: string, limit: number, windowSec: number): RateResult {
  const now = Date.now();
  if (memoryBuckets.size > 10_000) {
    for (const [k, b] of memoryBuckets) if (b.resetAt <= now) memoryBuckets.delete(k);
  }
  const resetAt = now + windowSec * 1000;
  let bucket = memoryBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt };
    memoryBuckets.set(key, bucket);
  }
  bucket.count += 1;
  return {
    allowed: bucket.count <= limit,
    limit,
    remaining: Math.max(0, limit - bucket.count),
    resetSec: Math.floor(bucket.resetAt / 1000),
  };
}

/**
 * Check a rate limit for `key` (e.g. `ip:1.2.3.4` or `user:42`).
 * Never throws — falls through the tiers and always returns a verdict.
 */
export async function checkRateLimit(
  env: EdgeEnv,
  args: { key: string; limit: number; windowSec?: number },
): Promise<RateResult> {
  const { key, limit } = args;
  const windowSec = Math.max(1, Math.floor(args.windowSec ?? 60));
  if (limit <= 0) {
    return { allowed: true, limit: 0, remaining: 0, resetSec: Math.floor(Date.now() / 1000) + windowSec };
  }
  const viaDo = await checkViaDo(env, key, limit, windowSec);
  if (viaDo) return viaDo;
  const viaKv = await checkViaKv(env, key, limit, windowSec);
  if (viaKv) return viaKv;
  return checkViaMemory(key, limit, windowSec);
}

/** Test hook: clear the per-isolate memory tier. */
export function resetMemoryRateLimits(): void {
  memoryBuckets.clear();
}
