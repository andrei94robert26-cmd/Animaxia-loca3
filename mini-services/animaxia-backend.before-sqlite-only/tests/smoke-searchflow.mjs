#!/usr/bin/env bun
/**
 * animaxia-backend/tests/smoke-searchflow.mjs — FAZA 15 (Search Flow
 * Control) live smoke suite.
 *
 * End-to-end checks against the Animaxia monolith (:4000) covering the
 * whole FAZA 15 surface — the search admission layer (queue + priority
 * lanes + windowed dispatch) sitting between /api/search/* and Neon:
 *   A. Contract exposure    — flowControl + windowing on /api/search/status,
 *                             full console on /api/search/flow
 *   B. Real search + flow   — /advanced and /autocomplete stay 100% real
 *                             (engine animaxia-neon-fts, real data) and gain
 *                             the additive flow { priority, shardid, queuedMs }
 *   C. Priority resolution  — anonymous low · X-Animaxia-Priority header ·
 *                             authenticated normal (register + Bearer)
 *   D. Bursts               — 10 / 100 / 500 SIMULTANEOUS searches: every
 *                             request answered, every answer real, 0 dropped,
 *                             0 timedOut, inflight never above maxConcurrent,
 *                             queue high-water proves smoothing, Neon healthy
 *   E. Priority ordering    — a burst above the window batch size: the high
 *                             lane's median queue wait < the low lane's
 *   F. Shard awareness      — burst spread over X-Animaxia-Shard headers →
 *                             perShard attribution on the console
 *   G. Semantic equivalence — identical query solo vs. under load returns
 *                             identical ids/order (the FTS is untouched)
 *   H. Fast-fail validation — missing q and the offset cap 400 WITHOUT being
 *                             admitted to the queue (processed unchanged)
 *   I. Metrics              — animaxia_search_* series in Prometheus text +
 *                             collectors.searchflow in ?format=json
 *   J. Settings security    — POST /flow/settings: anonymous 401 · non-admin 403
 *
 * Every burst request carries a UNIQUE X-Forwarded-For (distinct simulated
 * user, like the 10M-user target — the per-IP rate limiter stays honest and
 * active) and a UNIQUE q suffix (single-flight coalescing must NOT collapse
 * the burst — each request must exercise its own real query).
 *
 * FAZA 16 adaptation (Search Rate Management, additive): every burst now
 * uses a DISTINCT XFF range too (offset 0 / 250 / 500 below) — the FAZA 16
 * per-user cooldown legitimately blocks an identity re-searching within
 * cooldownMs, and each burst is a fresh set of users by design. The FAZA 15
 * behavior under test (queue + priority + windowing for distinct users) is
 * unchanged.
 *
 * Zero dependencies (bun-native fetch). Exits non-zero on any failure.
 * Usage:  bun tests/smoke-searchflow.mjs       (from the monolith)
 * Env:    API_ORIGIN  default http://localhost:4000
 */

const API_ORIGIN = process.env.API_ORIGIN || 'http://localhost:4000';

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

/** One burst search: unique simulated user (XFF) + unique q (no coalescing).
 *  Client-side aborts/timeouts are REPORTED (status 0) instead of crashing
 *  the suite — a lost answer is a test failure, not a crash. */
async function burstSearch(i, { prefix = 'dune', shard = null, priority = null } = {}) {
  const headers = {
    'X-Forwarded-For': `10.15.${Math.floor(i / 250)}.${(i % 250) + 1}`,
  };
  if (shard != null) headers['X-Animaxia-Shard'] = String(shard);
  if (priority != null) headers['X-Animaxia-Priority'] = priority;
  const q = encodeURIComponent(`${prefix} ${Date.now().toString(36)} ${i}`);
  try {
    const res = await fetch(`${API_ORIGIN}/api/search/advanced?q=${q}&limit=5`, {
      headers,
      signal: AbortSignal.timeout(90000),
    });
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, body };
  } catch (err) {
    return { status: 0, body: null, clientError: String(err?.message || err) };
  }
}

/** Median of a numeric array. */
function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/* ------------------------------------------------------------------ sections -- */

async function sectionA() {
  console.log('\nA. Contract exposure (status + console)');
  const { status, body } = await getJson('/api/search/status');
  record('GET /api/search/status → 200', status === 200, `status=${status}`);
  const fc = body?.flowControl;
  record(
    'flowControl pinned contract (queueEnabled/maxConcurrent/priorities)',
    Boolean(
      fc &&
        fc.queueEnabled === true &&
        Number.isInteger(fc.maxConcurrent) &&
        fc.maxConcurrent >= 1 &&
        fc.priorities &&
        typeof fc.priorities.high === 'number' &&
        typeof fc.priorities.normal === 'number' &&
        typeof fc.priorities.low === 'number',
    ),
    `flowControl=${JSON.stringify(fc)?.slice(0, 160)}`,
  );
  const w = body?.windowing;
  record(
    'windowing pinned contract (intervalMs/batchSize)',
    Boolean(
      w &&
        Number.isInteger(w.intervalMs) &&
        w.intervalMs >= 10 &&
        w.intervalMs <= 2000 &&
        Number.isInteger(w.batchSize) &&
        w.batchSize >= 1 &&
        w.batchSize <= 1000,
    ),
    `windowing=${JSON.stringify(w)}`,
  );

  const console_ = await getJson('/api/search/flow');
  record('GET /api/search/flow → 200', console_.status === 200, `status=${console_.status}`);
  const cb = console_.body;
  record(
    'console: config + history + perShard',
    Boolean(
      cb?.config?.enabled === true &&
        Array.isArray(cb?.history) &&
        Array.isArray(cb?.perShard) &&
        cb.perShard.length >= 1 &&
        typeof cb.perShard[0]?.shardid === 'number',
    ),
    `config=${JSON.stringify(cb?.config)} history=${cb?.history?.length} perShard=${cb?.perShard?.length}`,
  );
  record(
    'perShard covers the 30×1B logical topology (30 rows)',
    cb?.perShard?.length === 30,
    `perShard.length=${cb?.perShard?.length}`,
  );
}

async function sectionB() {
  console.log('\nB. Real search + flow attribution');
  const { status, body } = await getJson(
    '/api/search/advanced?q=dune&limit=3',
    { 'X-Forwarded-For': '10.20.0.10' },
  );
  record(
    '/advanced?q=dune → 200 REAL (engine + data)',
    status === 200 &&
      body?.engine === 'animaxia-neon-fts' &&
      Array.isArray(body?.data) &&
      body.data.length > 0 &&
      typeof body.data[0]?.id === 'number',
    `status=${status} engine=${body?.engine} total=${body?.total}`,
  );
  record(
    'additive flow field { priority, shardid, queuedMs }',
    Boolean(
      body?.flow &&
        body.flow.priority === 'low' &&
        Number.isInteger(body.flow.shardid) &&
        typeof body.flow.queuedMs === 'number',
    ),
    `flow=${JSON.stringify(body?.flow)}`,
  );

  const hi = await getJson('/api/search/advanced?q=dune&limit=1', {
    'X-Animaxia-Priority': 'high',
    'X-Forwarded-For': '10.20.0.11',
  });
  record(
    'X-Animaxia-Priority: high → flow.priority=high',
    hi.body?.flow?.priority === 'high',
    `flow=${JSON.stringify(hi.body?.flow)}`,
  );
  const mid = await getJson('/api/search/advanced?q=dune&limit=1', {
    'X-Animaxia-Priority': 'normal',
    'X-Forwarded-For': '10.20.0.12',
  });
  record(
    'X-Animaxia-Priority: normal → flow.priority=normal',
    mid.body?.flow?.priority === 'normal',
    `flow=${JSON.stringify(mid.body?.flow)}`,
  );

  const ac = await getJson('/api/search/autocomplete?q=big', { 'X-Forwarded-For': '10.20.0.13' });
  record(
    '/autocomplete → 200 + suggestions + flow',
    ac.status === 200 &&
      Array.isArray(ac.body?.suggestions) &&
      Boolean(ac.body?.flow?.priority),
    `status=${ac.status} n=${ac.body?.suggestions?.length} flow=${JSON.stringify(ac.body?.flow)}`,
  );
}

async function sectionC() {
  console.log('\nC. Authenticated priority (register + Bearer)');
  const stamp = Date.now().toString(36);
  const email = `flow-smoke-${stamp}@synth.animaxia`;
  const reg = await fetch(`${API_ORIGIN}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Forwarded-For': '10.21.0.10' },
    body: JSON.stringify({ email, username: `flowsmoke${stamp}`, password: 'FlowSmoke!2026' }),
    signal: AbortSignal.timeout(15000),
  });
  const regBody = await reg.json().catch(() => null);
  const token = regBody?.accessToken;
  record('register flow-smoke user', reg.status === 200 || reg.status === 201, `status=${reg.status}`);

  if (!token) return null;
  const auth = await getJson('/api/search/advanced?q=dune&limit=1', {
    authorization: `Bearer ${token}`,
    'X-Forwarded-For': '10.21.0.11',
  });
  record(
    'Bearer (logged-in) → flow.priority=normal',
    auth.body?.flow?.priority === 'normal',
    `flow=${JSON.stringify(auth.body?.flow)}`,
  );
  return token;
}

async function burstSection(label, n, options = {}) {
  console.log(`\nD. Burst ${n} simultaneous searches${options.note ? ` — ${options.note}` : ''}`);
  const beforeConsole = (await getJson('/api/search/flow')).body ?? {};
  const before = beforeConsole.flowControl ?? {};
  const beforeWindowing = beforeConsole.windowing ?? {};
  const t0 = Date.now();
  const results = await Promise.all(
    Array.from({ length: n }, (_, i) => burstSearch(i + (options.offset ?? 0), options)),
  );
  const wallMs = Date.now() - t0;
  const ok = results.filter((r) => r.status === 200);
  const real = ok.filter((r) => r.body?.engine === 'animaxia-neon-fts' && Array.isArray(r.body?.data));
  record(
    `burst ${n}: ALL answered 200 (${ok.length}/${n})`,
    ok.length === n,
    `ok=${ok.length}/${n} statuses=${[...new Set(results.map((r) => r.status))].join(',')}`,
  );
  record(
    `burst ${n}: ALL real (engine animaxia-neon-fts + data)`,
    real.length === n,
    `real=${real.length}/${n}`,
  );

  const afterConsole = (await getJson('/api/search/flow')).body ?? {};
  const after = afterConsole.flowControl ?? {};
  const afterWindowing = afterConsole.windowing ?? {};
  const droppedDelta = (after.dropped ?? 0) - (before.dropped ?? 0);
  const timedOutDelta = (after.timedOut ?? 0) - (before.timedOut ?? 0);
  record(`burst ${n}: dropped delta = 0`, droppedDelta === 0, `dropped +${droppedDelta}`);
  record(`burst ${n}: timedOut delta = 0`, timedOutDelta === 0, `timedOut +${timedOutDelta}`);
  record(
    `burst ${n}: processed increased ≥ ${n}`,
    (after.processed ?? 0) - (before.processed ?? 0) >= n,
    `processed ${before.processed ?? '?'} → ${after.processed ?? '?'}`,
  );
  record(
    `burst ${n}: maxInflightSeen ≤ maxConcurrent (${after.maxConcurrent})`,
    (after.maxInflightSeen ?? 0) <= (after.maxConcurrent ?? 0),
    `maxInflightSeen=${after.maxInflightSeen} maxConcurrent=${after.maxConcurrent}`,
  );
  if (n >= 100) {
    // Windowing discipline: EVERY execution is released by a window tick —
    // windowDispatches counts exactly the entries the windows released.
    const dispatchDelta =
      (afterWindowing.windowDispatches ?? 0) - (beforeWindowing.windowDispatches ?? 0);
    record(
      `burst ${n}: all ${n} executions released BY windows (windowing discipline)`,
      dispatchDelta >= n,
      `windowDispatches +${dispatchDelta} < ${n}`,
    );
    // Smoothing evidence robust to arrival timing: during the burst the 1s
    // history sampler must have seen queue or inflight at/above the batch
    // size — Neon observed a controlled stream, not an off-window spike.
    const burstSamples = (afterConsole.history ?? []).filter(
      (h) => h.inflight >= (afterWindowing.batchSize ?? 80) || h.queueLength >= (afterWindowing.batchSize ?? 80),
    );
    record(
      `burst ${n}: history shows controlled batch-scale load (≥ batchSize ${afterWindowing.batchSize ?? 80})`,
      burstSamples.length >= 1 || (after.queueHighWater ?? 0) >= (afterWindowing.batchSize ?? 80),
      `samples=${burstSamples.length} highWater=${after.queueHighWater}`,
    );
    record(
      `burst ${n}: wait p95 < maxWaitMs (${after.maxWaitMs}ms)`,
      (after.waitP95Ms ?? 0) < (after.maxWaitMs ?? 0),
      `waitP95=${after.waitP95Ms}ms`,
    );
  }
  console.log(`    (wall ${wallMs}ms · wait p50 ${after.waitP50Ms}ms · p95 ${after.waitP95Ms}ms)`);
  return { results, before, after };
}

async function sectionE() {
  console.log('\nE. Priority ordering (burst above window batch size)');
  // 160 low (anonymous) + 8 high (header) — the first window dispatches at
  // most batchSize (80), so the high lane MUST be served first and the low
  // tail spills into later windows → median(high) < median(low).
  const jobs = [];
  for (let i = 0; i < 160; i += 1) jobs.push(burstSearch(5000 + i, { prefix: 'sintel', priority: null }));
  for (let i = 0; i < 8; i += 1) jobs.push(burstSearch(7000 + i, { prefix: 'bunny', priority: 'high' }));
  const results = await Promise.all(jobs);
  const lows = results
    .filter((r) => r.body?.flow?.priority === 'low' && typeof r.body.flow.queuedMs === 'number')
    .map((r) => r.body.flow.queuedMs);
  const highs = results
    .filter((r) => r.body?.flow?.priority === 'high' && typeof r.body.flow.queuedMs === 'number')
    .map((r) => r.body.flow.queuedMs);
  record(
    'all 168 priority-burst requests answered 200',
    results.every((r) => r.status === 200),
    `statuses=${[...new Set(results.map((r) => r.status))].join(',')}`,
  );
  record(
    'median queue wait: high < low (priority honored)',
    median(highs) < median(lows),
    `median(high)=${median(highs)}ms median(low)=${median(lows)}ms (nHigh=${highs.length} nLow=${lows.length})`,
  );
  const console_ = (await getJson('/api/search/flow')).body?.flowControl;
  record(
    'processedByPriority.high ≥ 8 · low ≥ 160 (lanes attributed)',
    (console_?.processedByPriority?.high ?? 0) >= 8 && (console_?.processedByPriority?.low ?? 0) >= 160,
    `processedByPriority=${JSON.stringify(console_?.processedByPriority)}`,
  );
}

async function sectionF() {
  console.log('\nF. Shard awareness (per-shard attribution)');
  const before = (await getJson('/api/search/flow')).body?.perShard ?? [];
  const beforeMap = new Map(before.map((s) => [s.shardid, s.processed]));
  // 60 requests spread over shards 0, 7, 15, 29 via the gateway header.
  const shards = [0, 7, 15, 29];
  const results = await Promise.all(
    Array.from({ length: 60 }, (_, i) => burstSearch(9000 + i, { prefix: 'naruto', shard: shards[i % shards.length] })),
  );
  record(
    'shard-hinted burst: all 60 answered 200',
    results.every((r) => r.status === 200),
    `statuses=${[...new Set(results.map((r) => r.status))].join(',')}`,
  );
  const after = (await getJson('/api/search/flow')).body?.perShard ?? [];
  const grew = shards.filter((s) => {
    const b = beforeMap.get(s) ?? 0;
    const a = after.find((x) => x.shardid === s)?.processed ?? 0;
    return a - b >= 10; // 60 / 4 shards ≈ 15 each
  });
  record(
    'perShard.processed grew on all hinted shards (0, 7, 15, 29)',
    grew.length === shards.length,
    `grew on shards [${grew.join(', ')}] of [${shards.join(', ')}]`,
  );
}

async function sectionG() {
  console.log('\nG. Semantic equivalence (solo vs. under load)');
  const solo = await getJson('/api/search/advanced?q=big&sort=score&limit=10', {
    'X-Forwarded-For': '10.23.0.10',
  });
  const soloIds = (solo.body?.data ?? []).map((d) => d.id).join(',');
  // Fire the same query again WHILE a moderate burst runs — the flow queue
  // schedules it but the FTS result must be identical.
  const load = Array.from({ length: 30 }, (_, i) => burstSearch(11000 + i, { prefix: 'dune' }));
  const underLoad = getJson('/api/search/advanced?q=big&sort=score&limit=10', {
    'X-Forwarded-For': '10.23.0.11',
  });
  const [busyResult] = await Promise.all([underLoad, ...load]);
  const busyIds = (busyResult.body?.data ?? []).map((d) => d.id).join(',');
  record(
    'identical ids/order solo vs. under load (FTS untouched)',
    soloIds.length > 0 && soloIds === busyIds,
    `solo=[${soloIds.slice(0, 60)}…] under=[${busyIds.slice(0, 60)}…]`,
  );
  record(
    'same total solo vs. under load',
    solo.body?.total === busyResult.body?.total,
    `total ${solo.body?.total} vs ${busyResult.body?.total}`,
  );
}

async function sectionH() {
  console.log('\nH. Fast-fail validation (never admitted to the queue)');
  const before = (await getJson('/api/search/flow')).body?.flowControl ?? {};
  const missing = await getJson('/api/search/advanced', { 'X-Forwarded-For': '10.24.0.10' });
  record('missing q (and filters) → 400', missing.status === 400, `status=${missing.status}`);
  const capped = await getJson('/api/search/advanced?q=dune&page=100000&limit=50', {
    'X-Forwarded-For': '10.24.0.11',
  });
  record(
    'offset cap → 400 + useCursor',
    capped.status === 400 && capped.body?.useCursor === true,
    `status=${capped.status} body=${JSON.stringify(capped.body)?.slice(0, 120)}`,
  );
  const after = (await getJson('/api/search/flow')).body?.flowControl ?? {};
  record(
    'processed unchanged by the 400s (they never queued)',
    (after.processed ?? 0) === (before.processed ?? 0),
    `processed ${before.processed ?? '?'} → ${after.processed ?? '?'}`,
  );
}

async function sectionI() {
  console.log('\nI. Metrics (Prometheus + JSON)');
  const res = await fetch(`${API_ORIGIN}/api/metrics`, { signal: AbortSignal.timeout(30000) });
  const text = await res.text();
  for (const name of [
    'animaxia_search_queue_length',
    'animaxia_search_inflight',
    'animaxia_search_window_interval',
    'animaxia_search_dropped_requests',
    'animaxia_search_timedout_requests',
    'animaxia_search_processed_total',
    'animaxia_search_queue_by_priority',
    'animaxia_search_wait_ms_p50',
    'animaxia_search_processing_rate',
    'animaxia_search_max_concurrent',
  ]) {
    record(`Prometheus: ${name}`, text.includes(`\n${name} `) || text.includes(`\n${name}{`), 'series missing');
  }
  const jsonRes = await fetch(`${API_ORIGIN}/api/metrics?format=json`, {
    signal: AbortSignal.timeout(30000),
  });
  const json = await jsonRes.json();
  record(
    'JSON: collectors.searchflow present',
    Boolean(json?.collectors?.searchflow?.queueEnabled === true && typeof json.collectors.searchflow.processed === 'number'),
    `searchflow=${JSON.stringify(json?.collectors?.searchflow)?.slice(0, 120)}`,
  );
}

async function sectionJ(token) {
  console.log('\nJ. Settings security');
  const anon = await fetch(`${API_ORIGIN}/api/search/flow/settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Forwarded-For': '10.25.0.10' },
    body: JSON.stringify({ intervalMs: 60 }),
    signal: AbortSignal.timeout(15000),
  });
  record('POST /flow/settings anonymous → 401', anon.status === 401, `status=${anon.status}`);

  if (token) {
    const nonAdmin = await fetch(`${API_ORIGIN}/api/search/flow/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'X-Forwarded-For': '10.25.0.11' },
      body: JSON.stringify({ intervalMs: 60 }),
      signal: AbortSignal.timeout(15000),
    });
    record('POST /flow/settings non-admin → 403', nonAdmin.status === 403, `status=${nonAdmin.status}`);
  }
}

async function healthCheck() {
  console.log('\nK. Neon health after the bursts');
  const { status, body } = await getJson('/api/health', { 'X-Forwarded-For': '10.26.0.10' });
  record(
    '/api/health → ok + db.connected',
    status === 200 && body?.status === 'ok' && body?.db?.connected === true,
    `status=${status} db=${JSON.stringify(body?.db)?.slice(0, 80)}`,
  );
}

/* --------------------------------------------------------------------- main -- */

async function main() {
  console.log('FAZA 15 — Search Flow Control smoke suite');
  console.log(`  API ${API_ORIGIN}`);

  await sectionA();
  await sectionB();
  const token = await sectionC();
  await burstSection('burst10', 10, { prefix: 'dune', note: 'unique users (XFF) + unique q' });
  await burstSection('burst100', 100, { prefix: 'bunny', offset: 250 }); // FAZA 16: distinct XFF range per burst
  await burstSection('burst500', 500, { prefix: 'sintel', offset: 500 }); // FAZA 16: distinct XFF range per burst
  await sectionE();
  await sectionF();
  await sectionG();
  await sectionH();
  await sectionI();
  await sectionJ(token);
  await healthCheck();

  console.log('\n────────────────────────────────────────');
  console.log(`searchflow smoke: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log(`failed: ${failures.join(' · ')}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('smoke-searchflow crashed:', err);
  process.exit(1);
});
