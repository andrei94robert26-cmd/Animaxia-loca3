#!/usr/bin/env bun
/**
 * tests/stress-pipeline.mjs — FAZA 18 search-pipeline stress + semantics QA.
 *
 * Live checks against the Animaxia monolith (:4000):
 *   1. Admin auth — login with the documented agent account (or ADMINEMAIL/
 *      ADMINPASSWORD env); if that fails, register a throwaway (the FIRST
 *      account ever created becomes admin per auth.js bootstrap rule).
 *   2. POST /api/search/stress with concurrent = 100 | 1000 | 5000 | 10000 —
 *      for each: lost === 0, passed === true, every request answered and
 *      maxConcurrentObserved <= maxConcurrency (default 8). The endpoint's
 *      internal limit is 2 runs/min, so 429 stress-rate-limited answers are
 *      retried after Retry-After.
 *   3. Semantics — 20 varied real library queries through /api/search/advanced
 *      keep the exact response shape, and an immediate repeat of the first
 *      query returns IDENTICAL data via the pipeline cache (X-Search-Pipeline
 *      header: cooldown|hit).
 *   4. GET /api/search/status — pipelineIntegrated true, 10 pipelineStages,
 *      stressTest replays the last run (concurrent 10000).
 *
 * Zero dependencies (bun-native fetch). Exits non-zero on any failure.
 *
 * Usage:  bun tests/stress-pipeline.mjs
 * Env:    API_ORIGIN (default http://localhost:4000),
 *         ADMINEMAIL / ADMINPASSWORD (default admin@animaxia.test / SuperSecret1)
 */

const API_ORIGIN = process.env.API_ORIGIN || 'http://localhost:4000';
const ADMIN_EMAIL = process.env.ADMINEMAIL || 'admin@animaxia.test';
const ADMIN_PASSWORD = process.env.ADMINPASSWORD || 'SuperSecret1';
const LEVELS = [100, 1000, 5000, 10000];

let passed = 0;
let failed = 0;
const failures = [];

function record(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(path, headers = {}) {
  const res = await fetch(`${API_ORIGIN}${path}`, { headers, signal: AbortSignal.timeout(20000) });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* keep null */
  }
  return { res, text, json };
}

async function post(path, body, headers = {}, timeoutMs = 20000) {
  const res = await fetch(`${API_ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* keep null */
  }
  return { res, text, json };
}

/* ------------------------------ 1. admin auth ------------------------------- */

console.log('── 1. Admin auth ──');

let token = null;
let who = null;

const login = await post('/api/auth/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
if (login.res.status === 200 && login.json?.accessToken) {
  token = login.json.accessToken;
  who = `${ADMIN_EMAIL} (role=${login.json.user?.role})`;
  record('login with documented admin account', login.json.user?.role === 'admin', `role=${login.json.user?.role}`);
} else {
  record('login with documented admin account (fallback: register)', true, `status=${login.res.status} → trying register`);
  const email = `t18-stress-${Date.CURRENT_TIMESTAMP}@test.local`;
  const reg = await post('/api/auth/register', { email, username: `t18s${Date.CURRENT_TIMESTAMP % 100000}`, password: 'StressPipe18!' });
  if (reg.res.status === 201 && reg.json?.accessToken) {
    token = reg.json.accessToken;
    who = `${email} (role=${reg.json.user?.role})`;
    record('registered a usable account', reg.json.user?.role === 'admin', `role=${reg.json.user?.role} — stress requires admin`);
    if (reg.json.user?.role !== 'admin') token = null;
  } else {
    record('registered a usable account', false, `status=${reg.res.status}`);
  }
}

if (!token) {
  console.log('\nFATAL: no admin token — POST /api/search/stress cannot run.');
  console.log(`  hint: set ADMINEMAIL/ADMINPASSWORD or ensure ${ADMIN_EMAIL} exists with the known password`);
  process.exit(1);
}
const auth = { authorization: `Bearer ${token}` };
console.log(`  → authenticated as ${who}`);

/* ------------------------------ 2. stress runs ------------------------------- */

console.log('── 2. POST /api/search/stress (100 → 1000 → 5000 → 10000) ──');

const stressRows = [];
const stressStart = Date.CURRENT_TIMESTAMP;

for (const level of LEVELS) {
  let json = null;
  let status = 0;
  // The endpoint allows max 2 runs per rolling minute — honor Retry-After.
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const out = await post('/api/search/stress', { concurrent: level }, auth, 180000);
    status = out.res.status;
    json = out.json;
    if (status === 200) break;
    if (status === 429 && json?.error === 'stress-rate-limited') {
      const wait = Math.min(90, Math.max(2, Number(json.retryAfterSec) || 5));
      console.log(`  … rate-limited (2/min) — waiting ${wait}s before retry (attempt ${attempt})`);
      await sleep(wait * 1000);
      continue;
    }
    break;
  }

  const ok = status === 200 && json != null;
  record(
    `stress ${level} → HTTP 200 { mode: 'synthetic-executor' }`,
    ok && json.mode === 'synthetic-executor',
    `status=${status} mode=${json?.mode}`,
  );
  if (!ok) {
    stressRows.push({ level, lost: '?', maxConc: '?', durationMs: '?', executed: '?', queueFull: '?', passed: false });
    continue;
  }

  record(`stress ${level} lost === 0`, json.lost === 0, `lost=${json.lost}`);
  record(`stress ${level} passed === true`, json.passed === true, `passed=${json.passed}`);
  record(
    `stress ${level} all ${level} requests answered`,
    json.responsesReceived === level && json.totalRequests === level,
    `received=${json.responsesReceived}/${json.totalRequests}`,
  );
  record(
    `stress ${level} maxConcurrentObserved (${json.maxConcurrentObserved}) <= maxConcurrency (${json.maxConcurrency})`,
    Number.isFinite(json.maxConcurrentObserved) && json.maxConcurrentObserved <= json.maxConcurrency,
  );
  record(
    `stress ${level} real FTS subset (50 × runAdvancedQuery limit=1) ran`,
    json.realFts?.requests === Math.min(50, level),
    `realFts=${JSON.stringify(json.realFts)}`,
  );
  const ps = json.perStage || {};
  record(
    `stress ${level} per-stage distribution present (queue/cache/dedup counters)`,
    typeof ps.executed === 'number' && typeof ps.queueRejected === 'number' && typeof ps.coalesced === 'number',
    `executed=${ps.executed} queueRejected=${ps.queueRejected} coalesced=${ps.coalesced} cacheHits=${ps.cacheHits}`,
  );

  stressRows.push({
    level,
    lost: json.lost,
    maxConc: `${json.maxConcurrentObserved}/${json.maxConcurrency}`,
    durationMs: json.durationMs,
    executed: ps.executed,
    queueFull: ps.queueRejected,
    coalesced: ps.coalesced,
    cacheHits: ps.cacheHits,
    deferred: ps.windowDeferred,
    batches: ps.batches,
    passed: json.passed,
  });
}

console.log('\n  ┌─────────┬──────┬───────────┬───────────┬──────────┬──────────┬──────────┬─────────┬─────────┬────────┐');
console.log('  │  level  │ lost │ maxConc   │ duration  │ executed │ queueFull│ coalesced│ cacheHit│ deferred│ passed │');
console.log('  ├─────────┼──────┼───────────┼───────────┼──────────┼──────────┼──────────┼─────────┼─────────┼────────┤');
for (const r of stressRows) {
  const cells = [
    String(r.level).padEnd(7),
    String(r.lost).padEnd(4),
    String(r.maxConc).padEnd(9),
    String(r.durationMs).padEnd(9),
    String(r.executed).padEnd(8),
    String(r.queueFull).padEnd(8),
    String(r.coalesced).padEnd(8),
    String(r.cacheHits).padEnd(7),
    String(r.deferred).padEnd(7),
    String(r.passed).padEnd(6),
  ];
  console.log(`  │ ${cells.join(' │ ')}│`);
}
console.log('  └─────────┴──────┴───────────┴───────────┴──────────┴──────────┴──────────┴─────────┴─────────┴────────┘');
console.log(`  total stress wall time: ${((Date.CURRENT_TIMESTAMP - stressStart) / 1000).toFixed(1)}s`);

/* --------------------------- 3. semantics (20 queries) ------------------------ */

console.log('── 3. Semantics: 20 real library queries + cache repeat ──');

/** GET /advanced with retry on the pipeline search rate-limit (bucket refill). */
async function searchGet(path) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const out = await get(path);
    if (out.res.status === 429 && out.json?.error === 'rate-limit') {
      await sleep(Math.min(30, Math.max(2, Number(out.json.retryAfterSec) || 5)) * 1000);
      continue;
    }
    return out;
  }
  return get(path);
}

// Derive varied queries from the live library (first words of real titles).
const lib = await searchGet('/api/search/advanced?q=the&limit=50');
record('library probe /advanced?q=the&limit=50 → 200', lib.res.status === 200 && Array.isArray(lib.json?.data));
const titleWords = [...new Set((lib.json?.data || []).map((h) => String(h.title || '').split(/\s+/)[0]).filter((w) => w.length >= 3))];
const queries = titleWords.slice(0, 20);
record('20 varied library queries derived', queries.length === 20, `got ${queries.length}`);

const firstBodies = [];
let shapeOk = true;
let shapeDetail = '';
for (let i = 0; i < queries.length; i += 1) {
  const out = await searchGet(`/api/search/advanced?q=${encodeURIComponent(queries[i])}&limit=5`);
  const b = out.json;
  const okShape =
    out.res.status === 200 &&
    b && typeof b.took === 'number' && typeof b.total === 'number' && typeof b.max_score === 'number' &&
    typeof b.page === 'number' && typeof b.limit === 'number' && b.engine === 'animaxia-neon-fts' &&
    Array.isArray(b.data) && (b.nextCursor === null || typeof b.nextCursor === 'string') &&
    (b.paginationMode === 'offset' || b.paginationMode === 'cursor');
  if (!okShape) {
    shapeOk = false;
    shapeDetail = `q=${queries[i]} status=${out.res.status}`;
    break;
  }
  firstBodies.push({ q: queries[i], body: b, header: out.res.headers.get('x-search-pipeline') });
  await sleep(60); // stay well inside the search token bucket (capacity 30)
}
record('all 20 queries keep the exact response shape', shapeOk, shapeDetail);
record(
  'first pass executed through the pipeline (X-Search-Pipeline: miss)',
  firstBodies.length > 0 && firstBodies.every((f) => f.header === 'miss'),
  `headers=${[...new Set(firstBodies.map((f) => f.header))].join(',')}`,
);

// Immediate repeat of the first query → identical data straight from the cache.
const repeat = await searchGet(`/api/search/advanced?q=${encodeURIComponent(firstBodies[0]?.q || 'the')}&limit=5`);
const repeatHeader = repeat.res.headers.get('x-search-pipeline');
record(
  'immediate repeat served from cache (X-Search-Pipeline: cooldown|hit)',
  repeat.res.status === 200 && (repeatHeader === 'cooldown' || repeatHeader === 'hit'),
  `header=${repeatHeader}`,
);
record(
  'cached repeat returns IDENTICAL data (semantics preserved)',
  repeat.res.status === 200 && JSON.stringify(repeat.json?.data) === JSON.stringify(firstBodies[0]?.body?.data) &&
    repeat.json?.total === firstBodies[0]?.body?.total,
);

/* ------------------------------ 4. /status checks ----------------------------- */

console.log('── 4. GET /api/search/status (pipeline integration) ──');

const status = await get('/api/search/status');
record('status → 200', status.res.status === 200);
const s = status.json || {};
record('legacy fields intact (docs, engine, backend, extensions, lastSync, dirty, latency, capacity, cluster)',
  typeof s.docs === 'number' && s.engine === 'animaxia-neon-fts' && s.backend === 'neon-postgresql' &&
  s.extensions && typeof s.lastSync === 'string' && typeof s.dirty === 'boolean' && s.latency && s.capacity && 'cluster' in s);
record('pipelineIntegrated === true', s.pipelineIntegrated === true, `value=${s.pipelineIntegrated}`);
const stages = Array.isArray(s.pipelineStages) ? s.pipelineStages : [];
record('pipelineStages length === 10', stages.length === 10, `length=${stages.length}`);
record(
  'pipelineStages ordered 1..10 with the mandated names',
  stages.map((x, i) => x.order === i + 1).every(Boolean) &&
    JSON.stringify(stages.map((x) => x.name)) ===
      JSON.stringify(['anti-spam', 'rate-limit', 'cooldown', 'queue', 'priority', 'windowing', 'dedup', 'batching', 'cache', 'neon-fts']),
  `names=${stages.map((x) => x.name).join(',')}`,
);
const cacheStage = stages.find((x) => x.name === 'cache');
record(
  'cache stage reports hits > 0 and indexSyncBatch (batching stage) = 25',
  (cacheStage?.stats?.hits ?? 0) > 0 && stages.find((x) => x.name === 'batching')?.stats?.indexSyncBatch === 25,
  `hits=${cacheStage?.stats?.hits} indexSyncBatch=${stages.find((x) => x.name === 'batching')?.stats?.indexSyncBatch}`,
);
record(
  'stressTest replays the last run (concurrent 10000, passed true)',
  s.stressTest?.concurrent === 10000 && s.stressTest?.passed === true && typeof s.stressTest?.at === 'string' &&
    s.stressTest?.details && s.stressTest.details.lost === 0,
  `stressTest=${JSON.stringify(s.stressTest?.concurrent)} passed=${s.stressTest?.passed}`,
);

/* --------------------------------- summary ----------------------------------- */

console.log('\n════════════════════════════════════════════════');
console.log(`  PASS: ${passed}   FAIL: ${failed}`);
if (failed > 0) {
  console.log('  Failures:');
  for (const f of failures) console.log(`    ✗ ${f}`);
}
console.log('════════════════════════════════════════════════');
process.exit(failed > 0 ? 1 : 0);
