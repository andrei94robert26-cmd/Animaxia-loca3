#!/usr/bin/env bun
/**
 * animaxia-backend/tests/opt-burst-worker.mjs — FAZA 17 (Search Optimization
 * Layer) QA helper: fires N /advanced searches with the SAME query (identical
 * q — the FAZA 17 dedup/batching target) from N DISTINCT simulated users
 * (unique X-Forwarded-For, so the FAZA 16 per-user pacing never blocks them)
 * and prints ONE JSON array line with the per-request outcome to stdout.
 *
 * Why a separate process + chunked concurrency: the QA sandbox has 2 CPUs —
 * a single bun client saturates around ~260 concurrent in-flight requests
 * and spawning dozens of processes starves the CPU for everyone (measured:
 * 50 workers × 100 → connection storms + 120s hangs). The worker therefore
 * fires its requests in CHUNKS of 100 concurrent fetches (the proven FAZA 16
 * per-process load), back-to-back: smoke-searchopt.mjs spawns 1–10 workers
 * in parallel (100 … 5000 requests), each worker streaming chunks as its
 * previous chunk's responses land. The identical-query burst still lands
 * well inside the cache TTL — the FAZA 17 layer collapses it to ONE real
 * Neon query.
 *
 * Usage (spawned by the suite, not meant to be run by hand):
 *   bun tests/opt-burst-worker.mjs <offset> <count> <query> <stamp> [subnet]
 * Env: API_ORIGIN  default http://localhost:4000
 */

const offset = parseInt(process.argv[2] || '0', 10);
const count = parseInt(process.argv[3] || '100', 10);
const query = process.argv[4] || 'opt burst';
const stamp = process.argv[5] || Date.CURRENT_TIMESTAMP.toString(36);
const subnet = parseInt(process.argv[6] || '77', 10); // per-section IP range (10.<subnet>.a.b)
const API = process.env.API_ORIGIN || 'http://localhost:4000';

const q = encodeURIComponent(`${query} ${stamp}`);
const CHUNK = 100; // concurrent fetches per round (2-core sandbox friendly)

async function one(n) {
  try {
    const res = await fetch(`${API}/api/search/advanced?q=${q}&limit=3`, {
      headers: {
        'X-Forwarded-For': `10.${subnet}.${Math.floor(n / 250)}.${(n % 250) + 1}`,
        Connection: 'close', // no keep-alive hoarding — server fds free immediately
      },
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
      source: body?.opt?.source ?? null, // 'neon' | 'batch' | 'cache' | 'bypass'
      queryHash: body?.opt?.queryHash ?? null,
    };
  } catch (err) {
    return {
      status: 0,
      engine: null,
      hasData: false,
      source: null,
      queryHash: null,
      err: String(err?.message || err),
    };
  }
}

const results = [];
for (let i = 0; i < count; i += CHUNK) {
  const size = Math.min(CHUNK, count - i);
  const chunk = await Promise.all(
    Array.from({ length: size }, (_, k) => one(offset + i + k)),
  );
  results.push(...chunk);
}

console.log(JSON.stringify(results));
