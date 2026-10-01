/**
 * worker/src/ratelimiter-do.ts — RateLimiterDurable, the strongly consistent
 * rate-limit tier (tier 1 of shared/rate-limit.ts). One fixed window per
 * `rl:{key}` entry in the Durable Object's SQLite storage; an alarm sweeps
 * expired windows so the object stays small even under many keys.
 *
 * Internal HTTP API (called from shared/rate-limit.ts::checkViaDo):
 *   GET /check?key=<rl key>&limit=<n>&windowSec=<s> → RateResult JSON
 *   GET|POST /reset                                              → { ok: true }
 *
 * Bound by worker/wrangler.toml as RATE_LIMITER (new_sqlite_classes). The
 * class is re-exported from src/index.ts so wrangler can find it.
 */

import type { EdgeEnv } from '../../shared/types';

interface WindowState {
  count: number;
  resetAt: number; // epoch ms
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export class RateLimiterDurable {
  constructor(private state: DurableObjectState, _env: EdgeEnv) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/reset') {
      await this.state.storage.deleteAll();
      return json({ ok: true });
    }

    if (url.pathname !== '/check') {
      return json({ error: 'not_found' }, 404);
    }

    const key = url.searchParams.get('key') || '';
    const limit = Number(url.searchParams.get('limit'));
    const windowSec = Math.max(1, Number(url.searchParams.get('windowSec')) || 60);
    if (!key || !Number.isFinite(limit) || limit <= 0) {
      return json({ error: 'bad_request', message: 'key, limit and windowSec are required' }, 400);
    }

    const now = Date.now();
    const storageKey = `rl:${key}`;

    let win = await this.state.storage.get<WindowState>(storageKey);
    if (!win || win.resetAt <= now) {
      win = { count: 0, resetAt: now + windowSec * 1000 };
    }
    win.count += 1;
    await this.state.storage.put(storageKey, win);

    // Keep the sweeping alarm no later than this window's reset.
    const currentAlarm = await this.state.storage.getAlarm();
    if (currentAlarm === null || currentAlarm > win.resetAt) {
      await this.state.storage.setAlarm(win.resetAt + 1_000);
    }

    return json({
      allowed: win.count <= limit,
      limit,
      remaining: Math.max(0, limit - win.count),
      resetSec: Math.floor(win.resetAt / 1000),
    });
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const entries = await this.state.storage.list<WindowState>();
    const expired: string[] = [];
    for (const [k, w] of entries) {
      if (!w || w.resetAt <= now) expired.push(k);
    }
    if (expired.length > 0) {
      await this.state.storage.delete(expired);
    }
  }
}
