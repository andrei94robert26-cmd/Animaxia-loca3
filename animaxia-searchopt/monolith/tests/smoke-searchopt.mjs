#!/usr/bin/env bun
/**
 * animaxia-backend/tests/smoke-searchopt.mjs — FAZA 17 (Search Optimization
 * Layer) live smoke suite.
 *
 * End-to-end checks against the Animaxia monolith (:4000) covering the whole
 * FAZA 17 surface — the dedup + batching + micro-cache layer inside the
 * FAZA 15 flow queue (modules/search/opt.js):
 *   A. Contract exposure   — batching { enabled, activeBatches } +
 *                            cache { ttlMs, hits, misses } + dedup
 *                            { active, deduplicatedRequests } + the exact
 *                            10-stage pipeline array on /api/search/status;
 *                            full console on /api/search/opt
 *   B. Real search +       — an admitted /advanced stays 100% REAL and
 *      provenance            carries the additive opt { source, queryHash }
 *                            block (source 'neon' on a fresh query)
 *   C. 100 identical       — 100 SIMULTANEOUS identical searches from 100
 *                            DISTINCT users (worker): all answered 200 +
 *                            100% real, EXACTLY 1 real Neon query
 *                            (ftsQueries Δ1, deduplicatedRequests Δ99)
 *   D. 1000 identical      — 10 workers × 100: all 1000 answered 200 +
 *                            100% real, EXACTLY 1 real Neon query, queue
 *                            intact (dropped/timedOut Δ0), wall clock sane
 *   E. 5000 identical      — 50 workers × 100 with the documented admin
 *                            runtime knobs temporarily raised (window
 *                            50ms × 100 = 2000/s + cacheTtlMs 5000, both
 *                            RESTORED after): all 5000 answered 200 + 100%
 *                            real, EXACTLY 1 real Neon query (reduction
 *                            5000×), platform stable, burst event observed
 *   F. Cache lifecycle     — repeat within TTL → served from cache
 *                            (opt.source 'cache', same queryHash, real
 *                            data); after TTL expiry → an honest miss + a
 *                            NEW real execution (opt.source 'neon')
 *   G. No false dedup      — 30 distinct queries → 30 real executions with
 *                            30 distinct hashes (long-tail traffic never
 *                            collapsed)
 *   H. Autocomplete        — 30 identical concurrent autocomplete probes
 *                            (distinct users) → EXACTLY 1 real probe, every
 *                            response carries opt provenance
 *   I. Shard awareness    — 30 identical requests all carrying the SAME
 *                            X-Animaxia-Shard header → still EXACTLY 1 real
 *                            query, batch hits attributed per shard
 *   J. Metrics             — the 4 spec-pinned series
 *                            (search_batch_hits, search_cache_hits,
 *                            search_cache_misses, search_dedup_count) +
 *                            supporting series in Prometheus text +
 *                            collectors.searchopt in ?format=json
 *   K. Settings + switch   — POST /opt/settings: anonymous 401, non-admin
 *                            403; admin runtime reconfig (cacheTtlMs) works
 *                            + is clamped; enabled=false → honest 'bypass'
 *                            provenance with REAL results (FAZA 16
 *                            behavior), re-enabled after
 *   L. Regressions         — FAZA 15 /flow + FAZA 16 /rate consoles intact;
 *                            /api/health ok + db.connected after everything
 *
 * Identity model: every simulated user carries a UNIQUE X-Forwarded-For
 * (the FAZA 16 per-user pacing admits all of them — the limits are per
 * user); the identical q is what FAZA 17 collapses. Fresh queries per
 * section (unique stamps) keep the cache/batch state deterministic.
 *
 * Zero dependencies (bun-native fetch). Exits non-zero on any failure.
 * Usage:  bun tests/smoke-searchopt.mjs       (from the monolith)
 * Env:    API_ORIGIN  default http://localhost:4000
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const API_ORIGIN = process.env.API_ORIGIN || 'http://localhost:4000';
const WORKER_PATH = new URL('./opt-burst-worker.mjs', import.meta.url).pathname;

/** Spawn one opt-burst-worker (N identical searches from N distinct users,
 *  chunked at 100 concurrent per process — the proven 2-core load) and
 *  collect its JSON outcome line. `subnet` gives every section a UNIQUE IP
 *  range (10.<subnet>.a.b) so the FAZA 16 post-result cooldown of one
 *  section's simulated users never collides with the next section's. */
function fireWorker(offset, count, query, stamp, subnet) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [WORKER_PATH, String(offset), String(count), query, stamp, String(subnet)],
      {
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'inherit'],
      },
    );
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    child.on('error', (err) => resolve([{ status: -1, engine: null, hasData: false, source: null, queryHash: null, err: String(err) }]));
    child.on('close', () => {
      try {
        const parsed = JSON.parse(out);
        resolve(Array.isArray(parsed) ? parsed : []);
      } catch {
        resolve([]);
      }
    });
  });
}

let passed = 0;
let failed = 0;
const failures = [];

function record(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function getJson(path, headers = {}, timeoutMs = 60000) {
  const res = await fetch(`${API_ORIGIN}${path}`, {
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

async function postJson(path, body, headers = {}, timeoutMs = 30000) {
  const res = await fetch(`${API_ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  let parsed = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Current opt console counters (the Δ base for every burst section). */
async function optCounters() {
  const { body } = await getJson('/api/search/opt');
  return {
    counters: body?.counters ?? {},
    batching: body?.batching ?? {},
    flow: (await getJson('/api/search/flow')).body?.flowControl ?? {},
    rate: (await getJson('/api/search/rate')).body?.counters ?? {},
  };
}

/** Register a throwaway QA user and promote it to admin directly in Neon
 *  (DATABASEURL from the monolith .env — bun auto-loads it). Returns the
 *  Bearer token or null when promotion is unavailable (local fallback). */
async function promoteAndLoginAdmin() {
  try {
    const stamp = Date.now().toString(36);
    const email = `opt-admin-${stamp}@synth.animaxia`;
    const reg = await fetch(`${API_ORIGIN}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Forwarded-For': '10.78.0.10' },
      body: JSON.stringify({ email, username: `optadmin${stamp}`, password: 'OptAdmin!2026' }),
      signal: AbortSignal.timeout(15000),
    });
    const regBody = await reg.json().catch(() => null);
    if (!regBody?.accessToken) return null;
    const dbUrl = process.env.DATABASEURL;
    if (!dbUrl) return null;
    const pg = (await import('pg')).default;
    const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
    await client.connect();
    await client.query('UPDATE users SET role = $1 WHERE email = $2', ['admin', email]);
    await client.end();
    // A fresh token carries the new role (role is read at verify time from
    // the DB in this platform — but to be safe, log in again).
    const login = await fetch(`${API_ORIGIN}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Forwarded-For': '10.78.0.11' },
      body: JSON.stringify({ email, password: 'OptAdmin!2026' }),
      signal: AbortSignal.timeout(15000),
    });
    const loginBody = await login.json().catch(() => null);
    return loginBody?.accessToken ?? regBody.accessToken;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ sections -- */

async function sectionA() {
  console.log('\nA. Contract exposure (status + console)');
  const { status, body } = await getJson('/api/search/status');
  record('GET /api/search/status → 200', status === 200, `status=${status}`);

  const batching = body?.batching;
  record(
    'batching pinned contract (enabled: true + activeBatches integer + fan-out state)',
    Boolean(
      batching &&
        batching.enabled === true &&
        Number.isInteger(batching.activeBatches) &&
        batching.activeBatches >= 0 &&
        Number.isInteger(batching.maxFanout) &&
        Number.isInteger(batching.created) &&
        Number.isInteger(batching.completed),
    ),
    `batching=${JSON.stringify(batching)?.slice(0, 200)}`,
  );

  const cache = body?.cache;
  record(
    'cache pinned contract (ttlMs in the 1000–5000 pinned range + hits + misses)',
    Boolean(
      cache &&
        cache.enabled === true &&
        Number.isInteger(cache.ttlMs) &&
        cache.ttlMs >= 1000 &&
        cache.ttlMs <= 5000 &&
        Number.isInteger(cache.hits) &&
        Number.isInteger(cache.misses) &&
        Number.isInteger(cache.entries) &&
        typeof cache.hitRatio === 'number',
    ),
    `cache=${JSON.stringify(cache)?.slice(0, 200)}`,
  );

  const dedup = body?.dedup;
  record(
    'dedup pinned contract (active: true + deduplicatedRequests + the Neon split)',
    Boolean(
      dedup &&
        dedup.active === true &&
        Number.isInteger(dedup.deduplicatedRequests) &&
        Number.isInteger(dedup.ftsQueries) &&
        Number.isInteger(dedup.cacheServed) &&
        Number.isInteger(dedup.batchServed) &&
        Number.isInteger(dedup.served) &&
        typeof dedup.reductionFactor === 'number',
    ),
    `dedup=${JSON.stringify(dedup)?.slice(0, 200)}`,
  );

  const PIPELINE = ['antiSpam', 'rateLimit', 'cooldown', 'queue', 'priority', 'windowing', 'dedup', 'batching', 'cache', 'fts'];
  record(
    'pipeline is the exact pinned 10-stage array (antiSpam → … → cache → fts)',
    Array.isArray(body?.pipeline) && body.pipeline.length === 10 && body.pipeline.every((s, i) => s === PIPELINE[i]),
    `pipeline=${JSON.stringify(body?.pipeline)}`,
  );

  // FAZA 15 + 16 blocks untouched (additive contract).
  record(
    'FAZA 15 + 16 blocks intact on /status (flowControl + rateLimit)',
    Boolean(body?.flowControl && body?.rateLimit && body?.burstControl && body?.windowing),
    `flow=${Boolean(body?.flowControl)} rate=${Boolean(body?.rateLimit)}`,
  );

  const console_ = await getJson('/api/search/opt');
  const cb = console_.body;
  record('GET /api/search/opt console → 200', console_.status === 200, `status=${console_.status}`);
  record(
    'console: config + counters + activeBatches + history + 30-row perShard',
    Boolean(
      cb?.config?.enabled === true &&
        Number.isInteger(cb?.config?.cacheTtlMs) &&
        cb?.counters &&
        Number.isInteger(cb.counters.served) &&
        typeof cb.counters.reductionFactor === 'number' &&
        Array.isArray(cb?.activeBatches) &&
        Array.isArray(cb?.history) &&
        Array.isArray(cb?.perShard) &&
        cb.perShard.length === 30 &&
        cb.perShard.every((s) => 'shardid' in s && 'served' in s && 'cacheHits' in s && 'batchHits' in s && 'ftsQueries' in s),
    ),
    `config=${JSON.stringify(cb?.config)} perShard=${cb?.perShard?.length}`,
  );
}

async function sectionB() {
  console.log('\nB. Real search + additive provenance');
  const stamp = Date.now().toString(36);
  const first = await getJson(`/api/search/advanced?q=dune ${stamp}&limit=3`, { 'X-Forwarded-For': '10.79.0.1' });
  record(
    'fresh search → 200 + 100% REAL (engine animaxia-neon-fts + data) + opt.source "neon"',
    Boolean(
      first.status === 200 &&
        first.body?.engine === 'animaxia-neon-fts' &&
        Array.isArray(first.body?.data) &&
        first.body?.opt?.source === 'neon' &&
        typeof first.body?.opt?.queryHash === 'string' &&
        first.body.opt.queryHash.length === 16,
    ),
    `status=${first.status} engine=${first.body?.engine} opt=${JSON.stringify(first.body?.opt)}`,
  );
  record(
    'provenance is additive: flow (FAZA 15) + rate (FAZA 16) still present',
    Boolean(first.body?.flow?.priority && first.body?.rate?.perUserMs),
    `flow=${JSON.stringify(first.body?.flow)} rate=${JSON.stringify(first.body?.rate)}`,
  );
}

/** Shared burst runner: N identical requests via workers, returns the outcome
 *  deltas + aggregate. workers × perWorker must equal total. Each worker
 *  streams its requests in chunks of 100 concurrent fetches (the 2-core
 *  sandbox proven load), so 10 workers × 500 = 5000 requests without the
 *  CPU starvation / connection storms of 50 spawned processes. */
async function identicalBurst(label, workers, perWorker, query, subnet) {
  const before = await optCounters();
  const startedAt = Date.now();
  const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const results = await Promise.all(
    Array.from({ length: workers }, (_, w) =>
      fireWorker(w * perWorker, perWorker, query, stamp, subnet),
    ),
  );
  const flat = results.flat();
  const wallMs = Date.now() - startedAt;
  const after = await optCounters();

  const all200 = flat.every((r) => r.status === 200);
  const allReal = flat.every((r) => r.engine === 'animaxia-neon-fts' && r.hasData);
  const sources = {};
  const statuses = {};
  for (const r of flat) {
    sources[r.source ?? 'none'] = (sources[r.source ?? 'none'] ?? 0) + 1;
    statuses[r.status] = (statuses[r.status] ?? 0) + 1;
  }
  const d = (a, b, k) => (a?.[k] ?? 0) - (b?.[k] ?? 0);
  return {
    label,
    flat,
    wallMs,
    all200,
    allReal,
    sources,
    statuses,
    total: flat.length,
    dServed: d(after.counters, before.counters, 'served'),
    dFts: d(after.counters, before.counters, 'ftsQueries'),
    dDedup: d(after.counters, before.counters, 'deduplicatedRequests'),
    dDropped: d(after.flow, before.flow, 'dropped'),
    dTimedOut: d(after.flow, before.flow, 'timedOut'),
    dBatchHits: d(after.counters, before.counters, 'batchHits'),
    dCacheHits: d(after.counters, before.counters, 'cacheHits'),
    maxFanout: after.batching?.maxFanout ?? 0,
    queueHighWater: after.flow?.queueHighWater ?? 0,
    before,
    after,
  };
}

async function sectionC() {
  console.log('\nC. 100 identical simultaneous requests (1 worker × 100)');
  const r = await identicalBurst('C', 1, 100, 'opt one hundred', 71);
  record(
    'all 100 answered 200 + 100% real engine + real data',
    r.all200 && r.allReal && r.total === 100,
    `total=${r.total} all200=${r.all200} allReal=${r.allReal} statuses=${JSON.stringify(r.statuses)} sources=${JSON.stringify(r.sources)}`,
  );
  record(
    'EXACTLY 1 real Neon query for 100 identical requests (fts Δ1, dedup Δ99)',
    r.dServed === 100 && r.dFts === 1 && r.dDedup === 99,
    `served Δ${r.dServed} · fts Δ${r.dFts} · dedup Δ${r.dDedup}`,
  );
  record(
    'source distribution: 1 neon + 99 shared (batch/cache), zero bypass',
    (r.sources.neon ?? 0) + (r.sources.batch ?? 0) + (r.sources.cache ?? 0) === 100 && (r.sources.bypass ?? 0) === 0 && (r.sources.neon ?? 0) === 1,
    `sources=${JSON.stringify(r.sources)}`,
  );
  record(
    'max fan-out recorded ≥ 100 (one execution shared by the whole burst)',
    r.maxFanout >= 100,
    `maxFanout=${r.maxFanout}`,
  );
  record('FAZA 15 queue intact (dropped Δ0, timedOut Δ0)', r.dDropped === 0 && r.dTimedOut === 0, `dropped Δ${r.dDropped} timedOut Δ${r.dTimedOut}`);
}

async function sectionD() {
  console.log('\nD. 1000 identical simultaneous requests (10 workers × 100)');
  const r = await identicalBurst('D', 10, 100, 'opt one thousand', 72);
  record(
    'all 1000 answered 200 + 100% real engine + real data',
    r.all200 && r.allReal && r.total === 1000,
    `total=${r.total} all200=${r.all200} allReal=${r.allReal} statuses=${JSON.stringify(r.statuses)} sources=${JSON.stringify(r.sources)}`,
  );
  record(
    'EXACTLY 1 real Neon query for 1000 identical requests (reduction 1000×)',
    r.dServed === 1000 && r.dFts === 1 && r.dDedup === 999,
    `served Δ${r.dServed} · fts Δ${r.dFts} · dedup Δ${r.dDedup}`,
  );
  record(
    'every response is a REAL result (engine + data on all 1000)',
    r.flat.every((x) => x.engine === 'animaxia-neon-fts' && x.hasData),
    `nonReal=${r.flat.filter((x) => x.engine !== 'animaxia-neon-fts' || !x.hasData).length}`,
  );
  record(
    'FAZA 15 queue + FAZA 16 pacing intact (dropped Δ0, timedOut Δ0)',
    r.dDropped === 0 && r.dTimedOut === 0,
    `dropped Δ${r.dDropped} timedOut Δ${r.dTimedOut}`,
  );
  record(
    `burst completed in sane wall clock (< 30s, got ${(r.wallMs / 1000).toFixed(1)}s)`,
    r.wallMs < 30000,
    `wallMs=${r.wallMs}`,
  );
}

async function sectionE(adminToken) {
  console.log('\nE. 5000 identical simultaneous requests (10 workers × 500, chunked)');
  // With the default window (80ms × 80 = 1000 dispatches/s) a 5000-burst
  // takes ~5s > the default TTL (3000ms) — the cache would honestly refresh
  // mid-burst. The documented admin runtime knobs make the pinned "1 real
  // query" deterministic: window 50ms × 100 (2000/s → ~2.6s) + cacheTtlMs
  // 5000. Both are RESTORED and verified after the burst.
  if (!adminToken) {
    record(
      '5000-burst: SKIPPED (no DATABASEURL for the QA admin promotion — sections C/D already prove the 1-query collapse)',
      true,
      'skipped',
    );
    return;
  }
  const authHeader = { authorization: `Bearer ${adminToken}` };
  const flowBefore = (await getJson('/api/search/flow')).body?.config ?? {};
  const optBefore = (await getJson('/api/search/opt')).body?.config ?? {};

  const tunedFlow = await postJson('/api/search/flow/settings', { intervalMs: 50, batchSize: 100 }, authHeader);
  const tunedOpt = await postJson('/api/search/opt/settings', { cacheTtlMs: 5000 }, authHeader);
  record(
    'admin runtime tuning applied (window 50ms × 100 + cacheTtlMs 5000)',
    tunedFlow.status === 200 && tunedOpt.status === 200 && tunedOpt.body?.config?.cacheTtlMs === 5000,
    `flow=${tunedFlow.status} opt=${tunedOpt.status} ttl=${tunedOpt.body?.config?.cacheTtlMs}`,
  );

  try {
    // 10 workers × 500 requests, each worker streaming chunks of 100 (the
    // 2-core sandbox proven load — 50 spawned processes starve the CPU for
    // everyone): 5000 requests land within ~1–2s, all overlapping in the
    // FAZA 15 queue (arrivals outrun the 2000/s tuned drain), which the
    // layer must collapse to ONE real Neon query.
    const r = await identicalBurst('E', 10, 500, 'opt five thousand', 73);
    record(
      'all 5000 answered 200 + 100% real engine + real data (zero losses)',
      r.all200 && r.allReal && r.total === 5000,
      `total=${r.total} all200=${r.all200} allReal=${r.allReal} statuses=${JSON.stringify(r.statuses)} sources=${JSON.stringify(r.sources)}`,
    );
    record(
      'EXACTLY 1 real Neon query for 5000 identical requests (reduction 5000×)',
      r.dServed === 5000 && r.dFts === 1 && r.dDedup === 4999,
      `served Δ${r.dServed} · fts Δ${r.dFts} · dedup Δ${r.dDedup}`,
    );
    record(
      'a real batch formed (fan-out ≥ 100 — bounded by maxConcurrent dispatches during the execution window; the rest serve from cache)',
      r.maxFanout >= 100,
      `maxFanout=${r.maxFanout} (sources: ${JSON.stringify(r.sources)})`,
    );
    record(
      'FAZA 15 queue intact under 5000 (dropped Δ0, timedOut Δ0)',
      r.dDropped === 0 && r.dTimedOut === 0,
      `dropped Δ${r.dDropped} timedOut Δ${r.dTimedOut}`,
    );
    record(
      `platform stable (wall < 60s, got ${(r.wallMs / 1000).toFixed(1)}s)`,
      r.wallMs < 60000,
      `wallMs=${r.wallMs} queueHighWater=${r.queueHighWater}`,
    );
    const rateAfter = (await getJson('/api/search/rate')).body?.burstControl ?? {};
    record(
      'FAZA 16 burst detector fired on the 5000-arrival spike (event recorded)',
      (rateAfter.events ?? 0) > 0 && rateAfter.lastBurstAt != null,
      `events=${rateAfter.events} last=${rateAfter.lastBurstAt}`,
    );
  } finally {
    // RESTORE both configs and verify (production knobs are sacred).
    const restoredFlow = await postJson(
      '/api/search/flow/settings',
      { intervalMs: flowBefore.intervalMs, batchSize: flowBefore.batchSize },
      authHeader,
    );
    const restoredOpt = await postJson('/api/search/opt/settings', { cacheTtlMs: optBefore.cacheTtlMs }, authHeader);
    record(
      `runtime knobs RESTORED (window ${flowBefore.intervalMs}ms × ${flowBefore.batchSize}, ttl ${optBefore.cacheTtlMs}ms)`,
      restoredFlow.status === 200 &&
        restoredOpt.status === 200 &&
        restoredOpt.body?.config?.cacheTtlMs === optBefore.cacheTtlMs,
      `flow=${JSON.stringify(restoredFlow.body?.config)} opt=${JSON.stringify(restoredOpt.body?.config)}`,
    );
  }
}

async function sectionF() {
  console.log('\nF. Cache lifecycle (hit within TTL, honest miss after)');
  const stamp = Date.now().toString(36);
  const q = encodeURIComponent(`opt lifecycle ${stamp}`);
  const first = await getJson(`/api/search/advanced?q=${q}&limit=2`, { 'X-Forwarded-For': '10.80.0.1' });
  record(
    'fresh query → real execution (source "neon") + result cached',
    first.status === 200 && first.body?.opt?.source === 'neon',
    `source=${first.body?.opt?.source}`,
  );
  const second = await getJson(`/api/search/advanced?q=${q}&limit=2`, { 'X-Forwarded-For': '10.80.0.2' });
  record(
    'repeat within TTL (different user) → served from cache, SAME hash, real data',
    second.status === 200 &&
      second.body?.opt?.source === 'cache' &&
      second.body?.opt?.queryHash === first.body?.opt?.queryHash &&
      second.body?.engine === 'animaxia-neon-fts' &&
      Array.isArray(second.body?.data),
    `source=${second.body?.opt?.source} hash=${second.body?.opt?.queryHash}`,
  );
  record(
    'cached payload is the EXACT real result (same total + same ids in the same order)',
    JSON.stringify(second.body?.data?.map((x) => x.id)) === JSON.stringify(first.body?.data?.map((x) => x.id)) &&
      second.body?.total === first.body?.total,
    `firstIds=${JSON.stringify(first.body?.data?.map((x) => x.id))}`,
  );
  // Wait for the TTL to expire (default 3000ms; read the live value first).
  const ttl = (await getJson('/api/search/opt')).body?.config?.cacheTtlMs ?? 3000;
  await sleep(ttl + 600);
  const third = await getJson(`/api/search/advanced?q=${q}&limit=2`, { 'X-Forwarded-For': '10.80.0.3' });
  record(
    `after TTL (${ttl}ms + margin) → honest miss + NEW real execution (source "neon", same hash)`,
    third.status === 200 && third.body?.opt?.source === 'neon' && third.body?.opt?.queryHash === first.body?.opt?.queryHash,
    `source=${third.body?.opt?.source}`,
  );
}

async function sectionG() {
  console.log('\nG. No false dedup (distinct queries stay distinct)');
  const stamp = Date.now().toString(36);
  const before = (await optCounters()).counters;
  const distinct = await Promise.all(
    Array.from({ length: 30 }, (_, i) =>
      getJson(`/api/search/advanced?q=opt distinct ${stamp} ${i}&limit=1`, { 'X-Forwarded-For': `10.81.0.${i + 1}` }),
    ),
  );
  const after = (await optCounters()).counters;
  const dFts = (after.ftsQueries ?? 0) - (before.ftsQueries ?? 0);
  const hashes = new Set(distinct.map((d) => d.body?.opt?.queryHash));
  record(
    '30 distinct queries → 30 real executions (fts Δ30) + 30 distinct hashes',
    distinct.every((d) => d.status === 200 && d.body?.opt?.source === 'neon') && dFts === 30 && hashes.size === 30,
    `dFts=${dFts} distinctHashes=${hashes.size}`,
  );
}

async function sectionH() {
  console.log('\nH. Autocomplete optimization (typeahead shares one probe)');
  const q = encodeURIComponent('opt typea');
  const before = (await optCounters()).counters;
  const probes = await Promise.all(
    Array.from({ length: 30 }, (_, i) =>
      getJson(`/api/search/autocomplete?q=${q}`, { 'X-Forwarded-For': `10.82.0.${i + 1}` }, 30000),
    ),
  );
  const after = (await optCounters()).counters;
  const dFts = (after.ftsQueries ?? 0) - (before.ftsQueries ?? 0);
  const sources = {};
  for (const p of probes) sources[p.body?.opt?.source ?? 'none'] = (sources[p.body?.opt?.source ?? 'none'] ?? 0) + 1;
  record(
    '30 identical autocomplete probes (distinct users) → all 200 + suggestions + opt provenance',
    probes.every((p) => p.status === 200 && Array.isArray(p.body?.suggestions) && p.body?.opt),
    `sources=${JSON.stringify(sources)}`,
  );
  record(
    'EXACTLY 1 real Neon probe for 30 identical typeaheads (fts Δ1)',
    dFts === 1,
    `dFts=${dFts} sources=${JSON.stringify(sources)}`,
  );
}

async function sectionI() {
  console.log('\nI. Shard awareness (same shard affinity → one execution, per-shard attribution)');
  const stamp = Date.now().toString(36);
  const q = encodeURIComponent(`opt shard ${stamp}`);
  const before = (await getJson('/api/search/opt')).body;
  const sameShard = await Promise.all(
    Array.from({ length: 30 }, (_, i) =>
      getJson(`/api/search/advanced?q=${q}&limit=2`, {
        'X-Forwarded-For': `10.83.0.${i + 1}`,
        'X-Animaxia-Shard': '7',
      }),
    ),
  );
  const after = (await getJson('/api/search/opt')).body;
  const dFts = (after?.counters?.ftsQueries ?? 0) - (before?.counters?.ftsQueries ?? 0);
  record(
    '30 identical requests with the SAME X-Animaxia-Shard → all 200 real + EXACTLY 1 Neon query',
    sameShard.every((s) => s.status === 200 && s.body?.engine === 'animaxia-neon-fts') && dFts === 1,
    `dFts=${dFts}`,
  );
  const shard7 = after?.perShard?.find((s) => s.shardid === 7);
  const shard7Before = before?.perShard?.find((s) => s.shardid === 7);
  record(
    'per-shard attribution: shard #7 rows record the servings (served/batch Δ30 on shard 7)',
    Boolean(
      shard7 &&
        shard7Before &&
        shard7.served - shard7Before.served === 30 &&
        shard7.cacheHits + shard7.batchHits - (shard7Before.cacheHits + shard7Before.batchHits) === 29,
    ),
    `shard7 Δserved=${shard7?.served - (shard7Before?.served ?? 0)} Δshared=${(shard7?.cacheHits ?? 0) + (shard7?.batchHits ?? 0) - (shard7Before?.cacheHits ?? 0) - (shard7Before?.batchHits ?? 0)}`,
  );
}

async function sectionJ() {
  console.log('\nJ. Metrics (Prometheus text + JSON collector)');
  const metrics = await fetch(`${API_ORIGIN}/api/metrics`, { signal: AbortSignal.timeout(30000) });
  const text = await metrics.text();
  const pinned = [
    'animaxia_search_batch_hits',
    'animaxia_search_cache_hits',
    'animaxia_search_cache_misses',
    'animaxia_search_dedup_count',
  ];
  const missingPinned = pinned.filter((n) => !text.includes(`\n${n} `) && !text.includes(`\n${n}{`));
  record('the 4 spec-pinned series present (batch_hits, cache_hits, cache_misses, dedup_count)', missingPinned.length === 0, `missing=[${missingPinned.join(', ')}]`);

  const supporting = [
    'animaxia_search_opt_enabled',
    'animaxia_search_cache_ttl_ms',
    'animaxia_search_cache_entries',
    'animaxia_search_cache_hit_ratio',
    'animaxia_search_active_batches',
    'animaxia_search_batches_created',
    'animaxia_search_batches_completed',
    'animaxia_search_batch_max_fanout',
    'animaxia_search_fts_queries_total',
    'animaxia_search_fts_errors_total',
    'animaxia_search_opt_served_total',
    'animaxia_search_opt_bypassed_total',
  ];
  const missingSupporting = supporting.filter((n) => !text.includes(`\n${n} `) && !text.includes(`\n${n}{`));
  record('supporting series present (opt_enabled, ttl, entries, ratio, batches, fts_*, served)', missingSupporting.length === 0, `missing=[${missingSupporting.join(', ')}]`);

  record('per-shard series present (cache_hits_by_shard / batch_hits_by_shard)', text.includes('animaxia_search_batch_hits_by_shard{') || text.includes('animaxia_search_cache_hits_by_shard{'), 'sparse — present when shards have activity');

  const j = await (await fetch(`${API_ORIGIN}/api/metrics?format=json`, { signal: AbortSignal.timeout(30000) })).json();
  record(
    'collectors.searchopt in the ?format=json snapshot (with perShard)',
    Boolean(j?.collectors?.searchopt && Array.isArray(j.collectors.searchopt.perShard)),
    `keys=${Object.keys(j?.collectors ?? {}).join(',')}`,
  );
}

async function sectionK(adminToken) {
  console.log('\nK. Settings security + runtime reconfiguration + the master switch');

  // Security: anonymous 401, non-admin 403.
  const anon = await postJson('/api/search/opt/settings', { cacheTtlMs: 4000 });
  record('POST /opt/settings anonymous → 401', anon.status === 401, `status=${anon.status}`);

  const stamp = Date.now().toString(36);
  const email = `opt-nonadmin-${stamp}@synth.animaxia`;
  const reg = await postJson('/api/auth/register', { email, username: `optuser${stamp}`, password: 'OptUser!2026' });
  const userToken = reg.body?.accessToken ?? null;
  if (userToken) {
    const nonAdmin = await postJson('/api/search/opt/settings', { cacheTtlMs: 4000 }, { authorization: `Bearer ${userToken}` });
    record('POST /opt/settings non-admin → 403', nonAdmin.status === 403, `status=${nonAdmin.status}`);
  } else {
    record('POST /opt/settings non-admin → 403', false, 'registration failed — no user token');
  }

  if (!adminToken) {
    record('runtime reconfig + master switch: SKIPPED (no DATABASEURL for the QA admin promotion)', true, 'skipped');
    return;
  }
  const authHeader = { authorization: `Bearer ${adminToken}` };

  // Runtime reconfiguration works + clamps to the pinned range.
  const before = (await getJson('/api/search/opt')).body?.config ?? {};
  const tuned = await postJson('/api/search/opt/settings', { cacheTtlMs: 4200 }, authHeader);
  record(
    'admin sets cacheTtlMs 4200 → applied (pinned range honored)',
    tuned.status === 200 && tuned.body?.config?.cacheTtlMs === 4200,
    `config=${JSON.stringify(tuned.body?.config)}`,
  );
  const clamped = await postJson('/api/search/opt/settings', { cacheTtlMs: 99999 }, authHeader);
  record(
    'out-of-range value clamped server-side (99999 → 5000, the pinned max)',
    clamped.status === 200 && clamped.body?.config?.cacheTtlMs === 5000,
    `cacheTtlMs=${clamped.body?.config?.cacheTtlMs}`,
  );
  const restored = await postJson('/api/search/opt/settings', { cacheTtlMs: before.cacheTtlMs }, authHeader);
  record(
    `cacheTtlMs restored to ${before.cacheTtlMs}ms`,
    restored.status === 200 && restored.body?.config?.cacheTtlMs === before.cacheTtlMs,
    `config=${JSON.stringify(restored.body?.config)}`,
  );

  // Master switch: enabled=false → honest 'bypass' provenance + REAL results.
  const off = await postJson('/api/search/opt/settings', { enabled: false }, authHeader);
  record('admin disables the layer → 200', off.status === 200 && off.body?.config?.enabled === false, `config=${JSON.stringify(off.body?.config)}`);
  try {
    const stampB = Date.now().toString(36);
    const bypassed = await getJson(`/api/search/advanced?q=opt bypass ${stampB}&limit=2`, { 'X-Forwarded-For': '10.84.0.1' });
    const bypassed2 = await getJson(`/api/search/advanced?q=opt bypass ${stampB}&limit=2`, { 'X-Forwarded-For': '10.84.0.2' });
    record(
      'disabled layer → searches stay 100% REAL with honest source "bypass" (FAZA 16 behavior)',
      bypassed.status === 200 &&
        bypassed.body?.engine === 'animaxia-neon-fts' &&
        bypassed.body?.opt?.source === 'bypass' &&
        bypassed2.body?.opt?.source === 'bypass',
      `sources=${bypassed.body?.opt?.source},${bypassed2.body?.opt?.source}`,
    );
  } finally {
    const on = await postJson('/api/search/opt/settings', { enabled: true }, authHeader);
    record('layer RE-ENABLED (enabled: true restored)', on.status === 200 && on.body?.config?.enabled === true, `config=${JSON.stringify(on.body?.config)}`);
  }
  const back = await getJson('/api/search/advanced?q=opt back on&limit=1', { 'X-Forwarded-For': '10.84.0.9' });
  record(
    're-enabled layer serves with optimization provenance again (neon/cache/batch)',
    back.status === 200 && ['neon', 'cache', 'batch'].includes(back.body?.opt?.source),
    `source=${back.body?.opt?.source}`,
  );
}

async function sectionL() {
  console.log('\nL. Regressions (FAZA 15 + FAZA 16 + health)');
  const flow = await getJson('/api/search/flow');
  record(
    'FAZA 15 console intact (GET /flow → 200 + config + history + perShard 30)',
    flow.status === 200 && flow.body?.config && Array.isArray(flow.body?.history) && flow.body?.perShard?.length === 30,
    `status=${flow.status}`,
  );
  const rate = await getJson('/api/search/rate');
  record(
    'FAZA 16 console intact (GET /rate → 200 + counters + perShard 30)',
    rate.status === 200 && rate.body?.counters && rate.body?.perShard?.length === 30,
    `status=${rate.status}`,
  );
  const health = await getJson('/api/health');
  record(
    '/api/health ok + db.connected after the full FAZA 17 exercise',
    health.status === 200 && health.body?.status === 'ok' && health.body?.db?.connected === true,
    `status=${health.status} db=${health.body?.db?.connected}`,
  );
}

/* --------------------------------------------------------------------- main -- */

async function main() {
  console.log(`FAZA 17 — Search Optimization Layer smoke (against ${API_ORIGIN})`);
  const adminToken = await promoteAndLoginAdmin();

  await sectionA();
  await sectionB();
  await sectionC();
  await sectionD();
  await sectionE(adminToken);
  await sectionF();
  await sectionG();
  await sectionH();
  await sectionI();
  await sectionJ();
  await sectionK(adminToken);
  await sectionL();

  console.log(`\n────────────────────────────────────────`);
  console.log(`smoke-searchopt: ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log('failures:');
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('smoke-searchopt crashed:', err);
  process.exit(1);
});
