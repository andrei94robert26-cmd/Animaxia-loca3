#!/usr/bin/env bun
/**
 * animaxia-backend/tests/smoke-searchrate.mjs — FAZA 16 (Search Rate
 * Management) live smoke suite.
 *
 * End-to-end checks against the Animaxia monolith (:4000) covering the whole
 * FAZA 16 surface — the per-user pacing layer in front of the FAZA 15 flow
 * queue (modules/search/rate.js):
 *   A. Contract exposure    — rateLimit { perUserMs, enforced } +
 *                             burstControl { active, maxBurstPerWindow } on
 *                             /api/search/status; full console on
 *                             /api/search/rate (config + counters + history
 *                             + 30-row perShard)
 *   B. Real search + pacing — an admitted /advanced stays 100% REAL
 *                             (engine animaxia-neon-fts, real data) and
 *                             carries the additive rate { perUserMs,
 *                             cooldownMs } block
 *   C. Rate limit           — 2 truly-simultaneous searches from ONE user →
 *                             200 + explicit 429 { error: 'rate_limited',
 *                             retryInMs } + Retry-After; a DIFFERENT user
 *                             is never collaterally blocked
 *   D. Cooldown             — after a received result, the same user's next
 *                             /advanced → 429 { error: 'cooldown_active',
 *                             retryInMs } (the exact pinned shape); after
 *                             cooldownMs the user searches 200 again
 *   E. Anti-spam ENTER      — 10 searches fired within <200ms from ONE user:
 *                             exactly 1 admitted, 9 explicit 429s, the flood
 *                             auto-blocked (follow-up spam_blocked), and the
 *                             user RECOVERS after the block expires
 *   F. Lane independence    — autocomplete is admitted during the advanced
 *                             cooldown (typing never blocks ENTER); an
 *                             autocomplete flood is spam-blocked the same
 *   G. Burst 1000 users     — 1000 SIMULTANEOUS searches from 1000 DISTINCT
 *                             users: every request answered 200, every
 *                             answer REAL, dropped/timedOut deltas 0 (FAZA
 *                             15 queue intact), windowing discipline kept,
 *                             burst event recorded, Neon healthy after
 *   H. Fast-fail validation — missing q / offset cap 400s never burn a
 *                             pacing slot (gate runs after validation)
 *   I. Metrics              — the 4 spec-pinned series
 *                             (search_rate_limit_hits, search_cooldown_active,
 *                             search_spam_blocked, search_burst_events) in
 *                             Prometheus text + collectors.searchrate in
 *                             ?format=json
 *   J. Settings security    — POST /rate/settings: anonymous 401 ·
 *                             non-admin 403
 *   K. FAZA 15 regression   — /api/search/flow console unchanged; /api/health
 *                             ok + db.connected after everything
 *
 * Identity model: every simulated user carries a UNIQUE X-Forwarded-For
 * (same trust model as the FAZA 15 bursts); the QA tests that deliberately
 * reuse one identity (C, D, E, F) prove the per-USER rhythm, while G proves
 * that 1000 DISTINCT users searching simultaneously are ALL served — the
 * limits never block collaterally.
 *
 * Zero dependencies (bun-native fetch). Exits non-zero on any failure.
 * Usage:  bun tests/smoke-searchrate.mjs       (from the monolith)
 * Env:    API_ORIGIN  default http://localhost:4000
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const API_ORIGIN = process.env.API_ORIGIN || 'http://localhost:4000';
const WORKER_PATH = new URL('./burst-worker.mjs', import.meta.url).pathname;

/** Spawn one burst-worker (100 simultaneous distinct-user searches) and
 *  collect its JSON outcome line. 10 workers in parallel = a TRUE 1000/s
 *  arrival spike no single client process could generate. */
function fireWorker(offset, count, prefix, stamp) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [WORKER_PATH, String(offset), String(count), prefix, stamp], {
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    child.on('error', (err) => resolve([{ status: -1, engine: null, hasData: false, err: String(err) }]));
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
  return { status: res.status, body, retryAfter: res.headers.get('retry-after') };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ sections -- */

async function sectionA() {
  console.log('\nA. Contract exposure (status + console)');
  const { status, body } = await getJson('/api/search/status');
  record('GET /api/search/status → 200', status === 200, `status=${status}`);
  const rl = body?.rateLimit;
  record(
    'rateLimit pinned contract (perUserMs + enforced: true + cooldownMs + spamProtection)',
    Boolean(
      rl &&
        rl.enforced === true &&
        Number.isInteger(rl.perUserMs) &&
        rl.perUserMs >= 100 &&
        rl.perUserMs <= 5000 &&
        Number.isInteger(rl.cooldownMs) &&
        rl.cooldownMs >= 250 &&
        rl.spamProtection &&
        Number.isInteger(rl.spamProtection.threshold) &&
        Number.isInteger(rl.spamProtection.windowMs) &&
        Number.isInteger(rl.spamProtection.blockMs),
    ),
    `rateLimit=${JSON.stringify(rl)?.slice(0, 200)}`,
  );
  const bc = body?.burstControl;
  record(
    'burstControl pinned contract (active: true + maxBurstPerWindow)',
    Boolean(
      bc &&
        bc.active === true &&
        Number.isInteger(bc.maxBurstPerWindow) &&
        bc.maxBurstPerWindow >= 10 &&
        Number.isInteger(bc.windowMs) &&
        Number.isInteger(bc.events),
    ),
    `burstControl=${JSON.stringify(bc)?.slice(0, 200)}`,
  );
  // FAZA 15 blocks still present (100% compatibility).
  record(
    'FAZA 15 blocks intact (flowControl + windowing)',
    Boolean(body?.flowControl?.queueEnabled === true && body?.windowing?.intervalMs > 0),
    `flowControl=${JSON.stringify(body?.flowControl)?.slice(0, 80)}`,
  );

  const console_ = await getJson('/api/search/rate');
  record('GET /api/search/rate → 200', console_.status === 200, `status=${console_.status}`);
  const cb = console_.body;
  record(
    'console: config + counters + history + perShard',
    Boolean(
      cb?.config?.enabled === true &&
        cb?.counters &&
        typeof cb.counters.admitted === 'number' &&
        typeof cb.counters.rateLimitHits === 'number' &&
        Array.isArray(cb?.history) &&
        Array.isArray(cb?.perShard),
    ),
    `config=${JSON.stringify(cb?.config)} history=${cb?.history?.length}`,
  );
  record(
    'perShard covers the 30×1B logical topology (30 rows)',
    cb?.perShard?.length === 30,
    `perShard.length=${cb?.perShard?.length}`,
  );
  return cb?.config ?? null;
}

async function sectionB() {
  console.log('\nB. Real search + pacing attribution');
  const stamp = Date.now().toString(36);
  const { status, body } = await getJson(`/api/search/advanced?q=dune ${stamp}&limit=3`, {
    'X-Forwarded-For': '10.60.0.10',
  });
  record(
    '/advanced → 200 REAL (engine + data)',
    status === 200 &&
      body?.engine === 'animaxia-neon-fts' &&
      Array.isArray(body?.data) &&
      body.data.length > 0,
    `status=${status} engine=${body?.engine} total=${body?.total}`,
  );
  record(
    'additive rate field { perUserMs, cooldownMs }',
    Boolean(
      body?.rate &&
        Number.isInteger(body.rate.perUserMs) &&
        body.rate.perUserMs >= 100 &&
        Number.isInteger(body.rate.cooldownMs) &&
        body.rate.cooldownMs >= 250,
    ),
    `rate=${JSON.stringify(body?.rate)}`,
  );
  record(
    'FAZA 15 flow field still present { priority, shardid, queuedMs }',
    Boolean(body?.flow && body.flow.priority && Number.isInteger(body.flow.shardid)),
    `flow=${JSON.stringify(body?.flow)}`,
  );
}

async function sectionC() {
  console.log('\nC. Rate limit (2 searches in <500ms from one user)');
  const xff = '10.61.0.10';
  const stamp = Date.now().toString(36);
  // Two truly-simultaneous requests from the SAME identity: the first burns
  // the pacing slot, the second is answered explicitly.
  const before = (await getJson('/api/search/rate')).body?.counters ?? {};
  const pair = await Promise.all([
    getJson(`/api/search/advanced?q=rate a ${stamp}&limit=1`, { 'X-Forwarded-For': xff }),
    getJson(`/api/search/advanced?q=rate b ${stamp}&limit=1`, { 'X-Forwarded-For': xff }),
  ]);
  const codes = pair.map((r) => r.status).sort((a, b) => a - b);
  record(
    '2 simultaneous from one user → exactly 200 + 429',
    codes.length === 2 && codes[0] === 200 && codes[1] === 429,
    `codes=${JSON.stringify(pair.map((r) => r.status))}`,
  );
  const blocked = pair.find((r) => r.status === 429);
  record(
    '429 body: { error: "rate_limited", retryInMs > 0 } + Retry-After header',
    Boolean(
      blocked &&
        blocked.body?.error === 'rate_limited' &&
        blocked.body?.code === 'SEARCH_RATE_LIMITED' &&
        Number.isInteger(blocked.body?.retryInMs) &&
        blocked.body.retryInMs > 0 &&
        blocked.body.retryInMs <= 5000 &&
        blocked.retryAfter != null,
    ),
    `body=${JSON.stringify(blocked?.body)} retryAfter=${blocked?.retryAfter}`,
  );
  // The rejections are counted (observability contract).
  const after = (await getJson('/api/search/rate')).body?.counters ?? {};
  record(
    'console counter rateLimitHits moved',
    (after.rateLimitHits ?? 0) > (before.rateLimitHits ?? 0),
    `rateLimitHits ${before.rateLimitHits ?? '?'} → ${after.rateLimitHits ?? '?'}`,
  );
  // A DIFFERENT user is never collaterally blocked.
  const other = await getJson(`/api/search/advanced?q=rate other ${stamp}&limit=1`, {
    'X-Forwarded-For': '10.61.0.11',
  });
  record(
    'a different user searches 200 immediately (per-user isolation)',
    other.status === 200 && other.body?.engine === 'animaxia-neon-fts',
    `status=${other.status}`,
  );
}

async function sectionD(config) {
  console.log('\nD. Cooldown (search again right after a result)');
  const xff = '10.62.0.10';
  const stamp = Date.now().toString(36);
  const first = await getJson(`/api/search/advanced?q=cd first ${stamp}&limit=1`, {
    'X-Forwarded-For': xff,
  });
  record('first search → 200 REAL', first.status === 200 && first.body?.engine === 'animaxia-neon-fts', `status=${first.status}`);
  const cd = await getJson(`/api/search/advanced?q=cd second ${stamp}&limit=1`, {
    'X-Forwarded-For': xff,
  });
  record(
    'immediate re-search → 429 { error: "cooldown_active", retryInMs } (pinned shape)',
    Boolean(
      cd.status === 429 &&
        cd.body?.error === 'cooldown_active' &&
        cd.body?.code === 'SEARCH_COOLDOWN_ACTIVE' &&
        Number.isInteger(cd.body?.retryInMs) &&
        cd.body.retryInMs > 0 &&
        typeof cd.body?.cooldownMs === 'number' &&
        cd.retryAfter != null,
    ),
    `status=${cd.status} body=${JSON.stringify(cd.body)}`,
  );
  // Recovery: wait out the cooldown (config-driven, clamped for test speed)
  // and search again — the rhythm allows it, the search is REAL.
  const cooldownMs = Math.min(config?.cooldownMs ?? 1200, 1500);
  await sleep(cooldownMs + 250);
  const again = await getJson(`/api/search/advanced?q=cd third ${stamp}&limit=1`, {
    'X-Forwarded-For': xff,
  });
  record(
    `after cooldown (${cooldownMs}ms + margin) → 200 REAL again`,
    again.status === 200 && again.body?.engine === 'animaxia-neon-fts',
    `status=${again.status}`,
  );
}

async function sectionE() {
  console.log('\nE. Anti-spam ENTER (10 searches in <200ms from one user)');
  const xff = '10.63.0.10';
  const stamp = Date.now().toString(36);
  const before = (await getJson('/api/search/rate')).body?.counters ?? {};
  const flood = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      getJson(`/api/search/advanced?q=spam ${i} ${stamp}&limit=1`, { 'X-Forwarded-For': xff }),
    ),
  );
  const codes = flood.map((r) => r.status);
  const okCount = codes.filter((c) => c === 200).length;
  const blockedCount = codes.filter((c) => c === 429).length;
  record(
    'flood of 10 → exactly 1 admitted, 9 explicit 429s (zero losses, zero 5xx)',
    okCount === 1 && blockedCount === 9,
    `codes=${JSON.stringify(codes)}`,
  );
  const spamBodies = flood.filter((r) => r.body?.error === 'spam_blocked');
  record(
    'flood answered { error: "spam_blocked", retryInMs } — „Așteaptă un moment…”',
    spamBodies.length >= 5 &&
      spamBodies.every((r) => Number.isInteger(r.body?.retryInMs) && r.body.retryInMs > 0),
    `spamBlocked=${spamBodies.length} sample=${JSON.stringify(spamBodies[0]?.body)?.slice(0, 140)}`,
  );
  // The auto-block is active: an immediate follow-up is spam_blocked too.
  const during = await getJson(`/api/search/advanced?q=spam during ${stamp}&limit=1`, {
    'X-Forwarded-For': xff,
  });
  record(
    'during the auto-block → 429 spam_blocked',
    during.status === 429 && during.body?.error === 'spam_blocked',
    `status=${during.status} body=${JSON.stringify(during.body)?.slice(0, 100)}`,
  );
  // Recovery after the block expires.
  await sleep(1300);
  const recovered = await getJson(`/api/search/advanced?q=spam recovered ${stamp}&limit=1`, {
    'X-Forwarded-For': xff,
  });
  record(
    'after the auto-block expires → 200 REAL (the user is not banned)',
    recovered.status === 200 && recovered.body?.engine === 'animaxia-neon-fts',
    `status=${recovered.status}`,
  );
  const after = (await getJson('/api/search/rate')).body?.counters ?? {};
  // 8 spam_blocked from the flood itself (the 2nd request is typically
  // rate_limited before the flood threshold trips) + 1 during-block probe.
  record(
    'console counter spamBlocked moved (≥8: flood + auto-block)',
    (after.spamBlocked ?? 0) - (before.spamBlocked ?? 0) >= 8,
    `spamBlocked ${before.spamBlocked ?? '?'} → ${after.spamBlocked ?? '?'}`,
  );
}

async function sectionF() {
  console.log('\nF. Autocomplete lane independence');
  const xff = '10.64.0.10';
  const stamp = Date.now().toString(36);
  // Burn the advanced lane + start a cooldown…
  const first = await getJson(`/api/search/advanced?q=lane first ${stamp}&limit=1`, {
    'X-Forwarded-For': xff,
  });
  record('advanced search → 200', first.status === 200, `status=${first.status}`);
  // …then an autocomplete from the SAME user must be admitted (own lane).
  const ac = await getJson(`/api/search/autocomplete?q=big`, { 'X-Forwarded-For': xff });
  record(
    'autocomplete admitted during the advanced cooldown (separate lane)',
    ac.status === 200 && Array.isArray(ac.body?.suggestions),
    `status=${ac.status} n=${ac.body?.suggestions?.length}`,
  );
  // An autocomplete FLOOD from one user is spam-blocked exactly like ENTER.
  const floodXff = '10.64.0.11';
  const flood = await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      getJson(`/api/search/autocomplete?q=flood ${i} ${stamp}`, { 'X-Forwarded-For': floodXff }),
    ),
  );
  const floodCodes = flood.map((r) => r.status);
  const acOk = floodCodes.filter((c) => c === 200).length;
  const ac429 = floodCodes.filter((c) => c === 429).length;
  record(
    'autocomplete flood (6 rapid) → explicit 429s (shared anti-spam window)',
    acOk + ac429 === 6 && ac429 >= 3,
    `codes=${JSON.stringify(floodCodes)}`,
  );
}

async function sectionG() {
  console.log('\nG. Burst — 1000 simultaneous searches from 1000 DISTINCT users');
  // Let the FAZA 15 queue drain first (sections E/F leave residual load that
  // would smear the burst arrivals across the detection window).
  for (let i = 0; i < 40; i += 1) {
    const drain = (await getJson('/api/search/flow')).body?.flowControl ?? {};
    if ((drain.queueLength ?? 0) === 0 && (drain.inflight ?? 0) === 0) break;
    await sleep(250);
  }
  const beforeConsole = (await getJson('/api/search/flow')).body ?? {};
  const before = beforeConsole.flowControl ?? {};
  const beforeWindowing = beforeConsole.windowing ?? {};
  const beforeRate = (await getJson('/api/search/rate')).body ?? {};
  const beforeBurst = beforeRate.burstControl ?? {};
  const beforeCounters = beforeRate.counters ?? {};

  const stamp = Date.now().toString(36);
  // 10 parallel worker processes × 100 distinct users each = 1000 requests
  // fired at once; the workers\' per-process connection saturation (~260
  // concurrent in-flight /advanced) spreads the ARRIVALS at a sustainable
  // rate while the FAZA 15 queue absorbs ALL 1000 concurrently — every one
  // answered 200 with a real result, zero losses (the spec\'s promise).
  const t0 = Date.now();
  const workerResults = await Promise.all(
    Array.from({ length: 10 }, (_, w) => fireWorker(w * 100, 100, 'burst', stamp)),
  );
  const results = workerResults.flat();
  const wallMs = Date.now() - t0;

  const ok = results.filter((r) => r.status === 200);
  const real = ok.filter((r) => r.engine === 'animaxia-neon-fts' && r.hasData === true);
  record(
    `burst 1000 distinct users: ALL answered 200 (${ok.length}/1000)`,
    ok.length === 1000,
    `ok=${ok.length}/1000 statuses=${[...new Set(results.map((r) => r.status))].join(',')}`,
  );
  record(
    `burst 1000: ALL real (engine animaxia-neon-fts + data)`,
    real.length === 1000,
    `real=${real.length}/1000`,
  );

  const afterConsole = (await getJson('/api/search/flow')).body ?? {};
  const after = afterConsole.flowControl ?? {};
  const afterWindowing = afterConsole.windowing ?? {};
  const droppedDelta = (after.dropped ?? 0) - (before.dropped ?? 0);
  const timedOutDelta = (after.timedOut ?? 0) - (before.timedOut ?? 0);
  record(`burst 1000: FAZA 15 dropped delta = 0`, droppedDelta === 0, `dropped +${droppedDelta}`);
  record(`burst 1000: FAZA 15 timedOut delta = 0`, timedOutDelta === 0, `timedOut +${timedOutDelta}`);
  const dispatchDelta = (afterWindowing.windowDispatches ?? 0) - (beforeWindowing.windowDispatches ?? 0);
  record(
    `burst 1000: all executions released BY windows (windowing discipline intact)`,
    dispatchDelta >= 1000,
    `windowDispatches +${dispatchDelta} < 1000`,
  );
  record(
    `burst 1000: maxInflightSeen ≤ maxConcurrent (${after.maxConcurrent})`,
    (after.maxInflightSeen ?? 0) <= (after.maxConcurrent ?? 0),
    `maxInflightSeen=${after.maxInflightSeen}`,
  );

  const afterRate = (await getJson('/api/search/rate')).body ?? {};
  const afterBurst = afterRate.burstControl ?? {};
  const afterCounters = afterRate.counters ?? {};
  record(
    `burst 1000: per-user limits never blocked distinct users (admitted +≥1000)`,
    (afterCounters.admitted ?? 0) - (beforeCounters.admitted ?? 0) >= 1000,
    `admitted ${beforeCounters.admitted ?? '?'} → ${afterCounters.admitted ?? '?'}`,
  );
  console.log(
    `    (wall ${wallMs}ms · wait p50 ${after.waitP50Ms}ms · p95 ${after.waitP95Ms}ms · peak arrivals/window ${afterBurst.peak})`,
  );
  record(`burst 1000: wall time < 60s (Neon saw a controlled stream)`, wallMs < 60000, `wall=${wallMs}ms`);
  record(
    `burst 1000: detector observed a real spike (peak arrivals/window ≥ 200)`,
    (afterBurst.peak ?? 0) >= 200,
    `peak=${afterBurst.peak}`,
  );

  /* ── G2: burst EVENT, deterministic — the production threshold (1000 per
   *  1000ms) demands a truly instant 1000-request spike that no sustainable
   *  client pattern produces (a single bun process saturates at ~260
   *  concurrent in-flight requests), so the QA proves the detector the way
   *  ops tunes it: lower burstThreshold at runtime (admin), cross it with a
   *  real burst, verify the event, restore the production threshold. ── */
  console.log('  G2. Burst event (deterministic — runtime threshold + restore)');
  const adminToken = await promoteAndLoginAdmin();
  if (!adminToken) {
    record(
      'burst event: SKIPPED (no DATABASEURL for the QA admin promotion — the detector spike check above stands)',
      (afterBurst.peak ?? 0) >= 200,
      `peak=${afterBurst.peak}`,
    );
    return { wallMs };
  }
  // Lower the threshold below what the worker pattern reliably crosses.
  const lowered = await fetch(`${API_ORIGIN}/api/search/rate/settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ burstThreshold: 200 }),
    signal: AbortSignal.timeout(15000),
  });
  record('admin lowered burstThreshold → 200 (runtime)', lowered.status === 200, `status=${lowered.status}`);

  for (let i = 0; i < 40; i += 1) {
    const drain = (await getJson('/api/search/flow')).body?.flowControl ?? {};
    if ((drain.queueLength ?? 0) === 0 && (drain.inflight ?? 0) === 0) break;
    await sleep(250);
  }
  const beforeEvent = (await getJson('/api/search/rate')).body?.burstControl ?? {};
  const burstStamp = Date.now().toString(36);
  const smallResults = await Promise.all(
    Array.from({ length: 6 }, (_, w) => fireWorker(2000 + w * 60, 60, 'bstep', burstStamp)),
  );
  const smallOk = smallResults.flat().filter((r) => r.status === 200).length;
  const afterEvent = (await getJson('/api/search/rate')).body?.burstControl ?? {};
  record(
    'threshold burst: 360 distinct users all answered 200',
    smallOk === 360,
    `ok=${smallOk}/360`,
  );
  record(
    `burst event recorded while arrivals ≥ threshold (events ${beforeEvent.events ?? '?'} → ${afterEvent.events ?? '?'})`,
    (afterEvent.events ?? 0) > (beforeEvent.events ?? 0) && Boolean(afterEvent.lastBurstAt),
    `events=${afterEvent.events} peak=${afterEvent.peak}`,
  );

  const restored = await fetch(`${API_ORIGIN}/api/search/rate/settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ burstThreshold: 1000 }),
    signal: AbortSignal.timeout(15000),
  });
  const restoredOk = restored.status === 200;
  const configAfter = (await getJson('/api/search/rate')).body?.config ?? {};
  record(
    'production burstThreshold restored → 1000',
    restoredOk && configAfter.burstThreshold === 1000,
    `config=${JSON.stringify(configAfter)?.slice(0, 120)}`,
  );
  return { wallMs };
}

/** Register a throwaway QA user and promote it to admin directly in Neon
 *  (DATABASEURL from the monolith .env — bun auto-loads it). Returns the
 *  Bearer token or null when promotion is unavailable (local fallback). */
async function promoteAndLoginAdmin() {
  try {
    const stamp = Date.now().toString(36);
    const email = `rate-admin-${stamp}@synth.animaxia`;
    const reg = await fetch(`${API_ORIGIN}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Forwarded-For': '10.69.0.10' },
      body: JSON.stringify({ email, username: `rateadmin${stamp}`, password: 'RateAdmin!2026' }),
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
      headers: { 'content-type': 'application/json', 'X-Forwarded-For': '10.69.0.11' },
      body: JSON.stringify({ email, password: 'RateAdmin!2026' }),
      signal: AbortSignal.timeout(15000),
    });
    const loginBody = await login.json().catch(() => null);
    return loginBody?.accessToken ?? regBody.accessToken;
  } catch {
    return null;
  }
}

async function sectionH() {
  console.log('\nH. Fast-fail validation (never burns a pacing slot)');
  const rateBefore = (await getJson('/api/search/rate')).body?.counters ?? {};
  const missing = await getJson('/api/search/advanced', { 'X-Forwarded-For': '10.66.0.10' });
  record('missing q (and filters) → 400', missing.status === 400, `status=${missing.status}`);
  const capped = await getJson('/api/search/advanced?q=dune&page=100000&limit=50', {
    'X-Forwarded-For': '10.66.0.11',
  });
  record(
    'offset cap → 400 + useCursor (pre-gate, FAZA 15 contract intact)',
    capped.status === 400 && capped.body?.useCursor === true,
    `status=${capped.status}`,
  );
  // Both 400s happened BEFORE the gate → the same user can search right away.
  const rightAfter = await getJson('/api/search/advanced?q=valid after 400s&limit=1', {
    'X-Forwarded-For': '10.66.0.10',
  });
  record(
    'a 400 does not consume the user’s pacing slot (next search admitted)',
    rightAfter.status === 200,
    `status=${rightAfter.status}`,
  );
  const rateAfter = (await getJson('/api/search/rate')).body?.counters ?? {};
  record(
    'gate arrivals unchanged by the 400s (validation is pre-gate)',
    (rateAfter.arrivals ?? 0) - (rateBefore.arrivals ?? 0) === 1, // only the valid search
    `arrivals ${rateBefore.arrivals ?? '?'} → ${rateAfter.arrivals ?? '?'}`,
  );
}

async function sectionI() {
  console.log('\nI. Metrics (Prometheus + JSON)');
  const res = await fetch(`${API_ORIGIN}/api/metrics`, { signal: AbortSignal.timeout(30000) });
  const text = await res.text();
  for (const name of [
    'animaxia_search_rate_enabled',
    'animaxia_search_rate_per_user_ms',
    'animaxia_search_rate_cooldown_ms',
    'animaxia_search_rate_limit_hits',
    'animaxia_search_cooldown_active',
    'animaxia_search_spam_blocked',
    'animaxia_search_burst_events',
    'animaxia_search_burst_arrivals_per_s',
    'animaxia_search_rate_admitted_total',
    'animaxia_search_rate_tracked_users',
  ]) {
    record(`Prometheus: ${name}`, text.includes(`\n${name} `) || text.includes(`\n${name}{`), 'series missing');
  }
  const jsonRes = await fetch(`${API_ORIGIN}/api/metrics?format=json`, {
    signal: AbortSignal.timeout(30000),
  });
  const json = await jsonRes.json();
  record(
    'JSON: collectors.searchrate present',
    Boolean(
      json?.collectors?.searchrate?.enabled === true &&
        typeof json.collectors.searchrate.rateLimitHits === 'number' &&
        typeof json.collectors.searchrate.spamBlocked === 'number',
    ),
    `searchrate=${JSON.stringify(json?.collectors?.searchrate)?.slice(0, 140)}`,
  );
}

async function sectionJ() {
  console.log('\nJ. Settings security');
  const anon = await fetch(`${API_ORIGIN}/api/search/rate/settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Forwarded-For': '10.67.0.10' },
    body: JSON.stringify({ perUserMs: 600 }),
    signal: AbortSignal.timeout(15000),
  });
  record('POST /rate/settings anonymous → 401', anon.status === 401, `status=${anon.status}`);

  // Register a non-admin user and verify the 403.
  const stamp = Date.now().toString(36);
  const email = `rate-smoke-${stamp}@synth.animaxia`;
  const reg = await fetch(`${API_ORIGIN}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Forwarded-For': '10.67.0.11' },
    body: JSON.stringify({ email, username: `ratesmoke${stamp}`, password: 'RateSmoke!2026' }),
    signal: AbortSignal.timeout(15000),
  });
  const regBody = await reg.json().catch(() => null);
  const token = regBody?.accessToken;
  record('register rate-smoke user', reg.status === 200 || reg.status === 201, `status=${reg.status}`);
  if (token) {
    const nonAdmin = await fetch(`${API_ORIGIN}/api/search/rate/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'X-Forwarded-For': '10.67.0.12' },
      body: JSON.stringify({ perUserMs: 600 }),
      signal: AbortSignal.timeout(15000),
    });
    record('POST /rate/settings non-admin → 403', nonAdmin.status === 403, `status=${nonAdmin.status}`);
  }
}

async function sectionK() {
  console.log('\nK. FAZA 15 regression + Neon health');
  const flow = await getJson('/api/search/flow');
  const fc = flow.body?.flowControl;
  record(
    'GET /api/search/flow console intact (config + history + perShard 30)',
    Boolean(
      flow.status === 200 &&
        flow.body?.config?.enabled === true &&
        Array.isArray(flow.body?.history) &&
        flow.body?.perShard?.length === 30 &&
        typeof fc?.processed === 'number',
    ),
    `status=${flow.status} perShard=${flow.body?.perShard?.length}`,
  );
  const { status, body } = await getJson('/api/health', { 'X-Forwarded-For': '10.68.0.10' });
  record(
    '/api/health → ok + db.connected (Neon healthy after everything)',
    status === 200 && body?.status === 'ok' && body?.db?.connected === true,
    `status=${status} db=${JSON.stringify(body?.db)?.slice(0, 80)}`,
  );
}

/* --------------------------------------------------------------------- main -- */

async function main() {
  console.log('FAZA 16 — Search Rate Management smoke suite');
  console.log(`  API ${API_ORIGIN}`);

  const config = await sectionA();
  await sectionB();
  await sectionC();
  await sectionD(config);
  await sectionE();
  await sectionF();
  await sectionG();
  await sectionH();
  await sectionI();
  await sectionJ();
  await sectionK();

  console.log('\n────────────────────────────────────────');
  console.log(`searchrate smoke: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log(`failed: ${failures.join(' · ')}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('smoke-searchrate crashed:', err);
  process.exit(1);
});
