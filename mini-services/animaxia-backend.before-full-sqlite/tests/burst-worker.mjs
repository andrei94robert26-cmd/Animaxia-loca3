#!/usr/bin/env bun
/**
 * animaxia-backend/tests/burst-worker.mjs — FAZA 16 (Search Rate Management)
 * QA helper: fires N simultaneous /advanced searches from N DISTINCT
 * simulated users (unique X-Forwarded-For + unique q — single-flight
 * coalescing stays out of the way) and prints ONE JSON array line with the
 * per-request outcome to stdout.
 *
 * Why a separate process: a single bun client saturates around ~260
 * concurrent in-flight /advanced requests (its per-origin connection pool),
 * which spreads 1000 arrivals over ~4s — not a true simultaneous burst.
 * smoke-searchrate.mjs spawns THIS worker 10× in parallel (10 × 100
 * requests), so all 1000 arrivals land inside the 1000ms burst window and
 * the global burst detector sees a real micro-spike (the FAZA 15 queue +
 * windowing still absorb it — the whole point of the QA).
 *
 * Usage (spawned by the suite, not meant to be run by hand):
 *   bun tests/burst-worker.mjs <offset> <count> <prefix> <stamp>
 * Env: API_ORIGIN  default http://localhost:4000
 */

const offset = parseInt(process.argv[2] || '0', 10);
const count = parseInt(process.argv[3] || '100', 10);
const prefix = process.argv[4] || 'burst';
const stamp = process.argv[5] || Date.now().toString(36);
const API = process.env.API_ORIGIN || 'http://localhost:4000';

const results = await Promise.all(
  Array.from({ length: count }, async (_, i) => {
    const n = offset + i;
    const q = encodeURIComponent(`${prefix} ${stamp} ${n}`);
    try {
      const res = await fetch(`${API}/api/search/advanced?q=${q}&limit=3`, {
        headers: { 'X-Forwarded-For': `10.65.${Math.floor(n / 250)}.${(n % 250) + 1}` },
        signal: AbortSignal.timeout(120000),
      });
      let body = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      return {
        status: res.status,
        engine: body?.engine ?? null,
        hasData: Array.isArray(body?.data),
      };
    } catch (err) {
      return { status: 0, engine: null, hasData: false, err: String(err?.message || err) };
    }
  }),
);

console.log(JSON.stringify(results));
