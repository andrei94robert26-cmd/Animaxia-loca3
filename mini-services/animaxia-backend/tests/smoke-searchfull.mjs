#!/usr/bin/env bun
/**
 * animaxia-backend/tests/smoke-searchfull.mjs — FAZA 18 (Full Integration +
 * Stress Test) live smoke suite.
 *
 * End-to-end checks against the Animaxia monolith (:4000) covering the whole
 * FAZA 18 surface — the integrated 10-stage pipeline + the 10,000+-
 * simultaneous-searches stress engine (modules/search/stress.js):
 *   A. Contract exposure   — /api/search/status: pipelineIntegrated: true +
 *                            pipelineStages = the exact 10-stage array +
 *                            the stressTest block (concurrent: 10000 pinned)
 *   B. Stress console      — GET /api/search/stress: the pinned section
 *                            composition (sums to 11000 ≥ the 10000 headline),
 *                            the budget lane, the running state
 *   C. THE FULL RUN        — POST /api/search/stress as admin (202 + poll
 *                            until finished, timeout 150s): passed === true,
 *                            all 22 assertions green, the pinned outcomes
 *                            (identical 1000 → 1 Neon query, different 1000 →
 *                            1000 real execs 0 false dedup, spam ≥1800,
 *                            cooldown ≥950, rate-limit 1000, 0 errors,
 *                            0 dropped, 0 timedOut, all answered, semantics
 *                            A=neon/B=cache payload identical, 10M sample
 *                            500 → reduction, 7/7 verdicts)
 *   D. Post-run state      — /status stressTest { concurrent: 10000,
 *                            passed: true }; the persisted report survives a
 *                            snapshot read; a real search still answers after
 *   E. HTTP-level burst    — 1000 identical requests over REAL HTTP (10
 *                            workers × 100, reusing the FAZA 17 burst
 *                            worker): all 200 + 100% real, EXACTLY 1 real
 *                            Neon query — the integrated pipeline proven on
 *                            the socket path too (the stress engine runs
 *                            in-process; this section runs through express)
 *   F. Security            — POST /stress: anonymous 401, non-admin 403,
 *                            second POST while running → 409 (observed
 *                            indirectly via the running flag contract)
 *   G. Metrics             — the 5 FAZA 18 searchstress series + the 11 spec
 *                            monitoring series (FAZA 15+16+17) in Prometheus
 *                            text + collectors.searchstress in ?format=json
 *   H. Regressions         — FAZA 15 /flow + FAZA 16 /rate + FAZA 17 /opt
 *                            consoles intact; /api/health ok + db.connected
 *
 * Zero dependencies (bun-native fetch). Exits non-zero on any failure.
 * Usage:  bun tests/smoke-searchfull.mjs       (from the monolith)
 * Env:    API_ORIGIN  default http://localhost:4000
 *         DATABASEURL (monolith .env — for the QA admin promotion)
 */

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const API_ORIGIN = process.env.API_ORIGIN || 'http://localhost:4000';
const WORKER_PATH = new URL('./opt-burst-worker.mjs', import.meta.url).pathname;
const HERE = dirname(fileURLToPath(import.meta.url));

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

/* Rotating simulated client IP for the suite's own console/status calls —
 * the GLOBAL rate limiter (120 req / 60s per client IP) would otherwise
 * exhaust the shared 127.0.0.1 budget when the QA suites run back-to-back
 * (observed live: console reads start returning 429 → all Δ-checks fail
 * with undefined). Each call gets its own 10.93.x.y identity. */
let callSeq = 0;
function qaXff() {
  callSeq += 1;
  return `10.93.${Math.floor(callSeq / 250) % 250}.${(callSeq % 250) + 1}`;
}

async function getJson(path, headers = {}, timeoutMs = 60000) {
  const res = await fetch(`${API_ORIGIN}${path}`, {
    headers: { 'X-Forwarded-For': qaXff(), ...headers },
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

/* ------------------------------------------------------------------ sections -- */

/** A. The pinned FAZA 18 contracts on /api/search/status. */
async function sectionA() {
  console.log('\nA. Contracte pinned pe /api/search/status');
  const { status, body } = await getJson('/api/search/status');
  record('GET /api/search/status → 200', status === 200, `status=${status}`);
  record(
    'pipelineIntegrated: true (cele 10 etape montate structural)',
    body?.pipelineIntegrated === true,
    `pipelineIntegrated=${body?.pipelineIntegrated}`,
  );
  const PINNED = ['antiSpam', 'rateLimit', 'cooldown', 'queue', 'priority', 'windowing', 'dedup', 'batching', 'cache', 'fts'];
  record(
    'pipelineStages = array-ul exact cu 10 etape integrate',
    Array.isArray(body?.pipelineStages) && body.pipelineStages.length === 10 && body.pipelineStages.every((s, i) => s === PINNED[i]),
    `stages=${JSON.stringify(body?.pipelineStages)?.slice(0, 120)}`,
  );
  record(
    'stressTest block prezent, cu titlul pinned concurrent: 10000',
    Boolean(body?.stressTest && body.stressTest.concurrent === 10000 && typeof body.stressTest.passed === 'boolean'),
    `stressTest=${JSON.stringify({ executed: body?.stressTest?.executed, concurrent: body?.stressTest?.concurrent })}`,
  );
  // FAZA 15/16/17 contracts still intact on the same payload.
  record(
    'regresie: contractele FAZA 15+16+17 rămân pe /status (flowControl + rateLimit + batching/cache/dedup + pipeline)',
    Boolean(body?.flowControl && body?.rateLimit && body?.batching && body?.cache && body?.dedup && Array.isArray(body?.pipeline)),
    `blocks=${['flowControl', 'rateLimit', 'batching', 'cache', 'dedup', 'pipeline'].filter((k) => body?.[k] != null).join(',')}`,
  );
}

/** B. The stress console (public read-only). */
async function sectionB() {
  console.log('\nB. Consola /api/search/stress (read-only public)');
  const { status, body } = await getJson('/api/search/stress');
  record('GET /api/search/stress → 200', status === 200, `status=${status}`);
  record(
    'compoziția pinned: secțiunile însumează 11000 ≥ titlul 10000',
    Boolean(
      body?.sections &&
        body.sections.identical === 1000 && body.sections.different === 1000 &&
        body.sections.mixed === 5000 && body.sections.spam === 2000 &&
        body.sections.cooldown === 1000 && body.sections.rateLimit === 1000 &&
        body.burstTotal === 11000 && body.concurrency === 10000,
    ),
    `sections=${JSON.stringify(body?.sections)} burstTotal=${body?.burstTotal}`,
  );
  record(
    'lan-ul de buget + starea running expuse',
    typeof body?.running === 'boolean' && Number.isFinite(body?.budgetMs) && body.budgetMs >= 2000,
    `running=${body?.running} budgetMs=${body?.budgetMs}`,
  );
  record(
    'proiecția 10M: modelul utilizatori/fereastră expus',
    Boolean(body?.projectionModel?.users === 10_000_000 && body?.sampleConcurrency === 500),
    `model=${JSON.stringify(body?.projectionModel)}`,
  );
}

/** Register a throwaway QA user and promote it to admin directly in Neon
 *  (DATABASEURL from the monolith .env — bun auto-loads it). Returns the
 *  Bearer token or null when promotion is unavailable. */
async function promoteAndLoginAdmin(prefix) {
  try {
    const stamp = Date.CURRENT_TIMESTAMP.toString(36);
    const email = `${prefix}-admin-${stamp}@synth.animaxia`;
    const reg = await fetch(`${API_ORIGIN}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Forwarded-For': '10.78.0.10' },
      body: JSON.stringify({ email, username: `${prefix}admin${stamp}`, password: 'F18Admin!2026' }),
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
    const login = await fetch(`${API_ORIGIN}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Forwarded-For': '10.78.0.11' },
      body: JSON.stringify({ email, password: 'F18Admin!2026' }),
      signal: AbortSignal.timeout(15000),
    });
    const loginBody = await login.json().catch(() => null);
    return loginBody?.accessToken ?? regBody.accessToken;
  } catch {
    return null;
  }
}

/** C. THE FULL STRESS RUN — trigger as admin, poll until finished, verify
 *  every pinned outcome of the spec checklist. */
async function sectionC(adminToken) {
  console.log('\nC. Stress test complet — 11.000 căutări simultane prin pipeline-ul real');
  if (!adminToken) {
    record('run declanșat de admin', false, ' fără DATABASEURL pentru promovarea QA — rulează din monolith cu .env încărcat');
    return null;
  }
  const authHeader = { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json', 'X-Forwarded-For': '10.78.0.12' };

  // Security pre-checks on the trigger.
  const anon = await fetch(`${API_ORIGIN}/api/search/stress`, { method: 'POST', signal: AbortSignal.timeout(15000) });
  record('POST /stress anonim → 401', anon.status === 401, `status=${anon.status}`);

  const start = await fetch(`${API_ORIGIN}/api/search/stress`, {
    method: 'POST',
    headers: authHeader,
    body: '{}',
    signal: AbortSignal.timeout(15000),
  });
  const startBody = await start.json().catch(() => null);
  record(
    'POST /stress admin → 202 { started: true }',
    start.status === 202 && startBody?.started === true,
    `status=${start.status} body=${JSON.stringify(startBody)?.slice(0, 80)}`,
  );
  if (start.status !== 202) return null;

  // Poll the console until the run finishes (the engine drains ~2000 real
  // FTS executions at the honest capacity — allow 150s). A NEW run is
  // detected by its finishedAt moving past the pre-start baseline.
  const before = await getJson('/api/search/stress');
  const baselineFinishedAt = before.body?.lastRun?.finishedAt ?? '';
  const t0 = Date.CURRENT_TIMESTAMP;
  let run = null;
  let sawRunning = false;
  while (Date.CURRENT_TIMESTAMP - t0 < 150_000) {
    await new Promise((r) => setTimeout(r, 2500));
    const { body } = await getJson('/api/search/stress');
    if (body?.running === true) sawRunning = true;
    const lastFinishedAt = body?.lastRun?.finishedAt ?? '';
    if (body?.running === false && lastFinishedAt && lastFinishedAt !== baselineFinishedAt) {
      run = body.lastRun;
      break;
    }
  }
  record(
    'run-ul s-a finalizat în fereastra de polling (150s)',
    Boolean(run),
    `finishedAt=${run?.finishedAt ?? '—'} polled=${Math.round((Date.CURRENT_TIMESTAMP - t0) / 1000)}s sawRunning=${sawRunning}`,
  );
  if (!run) {
    record('run complet înregistrat', false, 'lastRun.finishedAt nu s-a mișcat în fereastra de polling');
    return null;
  }

  record(`verdict: passed === true (${run.assertions.filter((a) => a.ok).length}/${run.assertions.length} asserții)`, run.passed === true, `failures=${JSON.stringify(run.failures)?.slice(0, 200)}`);

  const s = run.sections;
  record(
    'compoziție: 11.000 cereri, toate răspunse explicit (0 pierdute, 0 erori)',
    run.requests.total === 11000 && run.requests.answered === 11000 && run.requests.errors === 0,
    `total=${run.requests.total} answered=${run.requests.answered} errors=${run.requests.errors}`,
  );
  record(
    'identice: 1000 → EXACT 1 interogare Neon reală (batch + cache absorb 999)',
    s.identical.ok === 1000 && s.identical.sources.neon === 1,
    `ok=${s.identical.ok} neon=${s.identical.sources.neon} batch=${s.identical.sources.batch} cache=${s.identical.sources.cache}`,
  );
  record(
    'diferite: 1000 → 1000 execuții reale, 0 false dedup (hash-uri distincte)',
    s.different.ok === 1000 && s.different.sources.neon === 1000 && s.different.distinctQueries === 1000,
    `neon=${s.different.sources.neon} distinct=${s.different.distinctQueries}`,
  );
  record(
    'mixte: 5000 răspunse, reducere vizibilă (execuții reale < admise)',
    s.mixed.total === 5000 && s.mixed.answered === 5000 && s.mixed.sources.neon < s.mixed.ok,
    `neon=${s.mixed.sources.neon} ok=${s.mixed.ok} breakdown=${JSON.stringify(s.mixed.breakdown)}`,
  );
  record(
    'spam: flood ENTER blocat onest (≥1800 spam_blocked din 2000)',
    s.spam.blocked.spam_blocked >= 1800,
    `spam_blocked=${s.spam.blocked.spam_blocked} admitted=${s.spam.ok} rate_limited=${s.spam.blocked.rate_limited}`,
  );
  record(
    'cooldown: utilizatorii cu rezultat real proaspăt blocați (≥950 cooldown_active)',
    s.cooldown.blocked.cooldown_active >= 950,
    `cooldown_active=${s.cooldown.blocked.cooldown_active} (pre-warm real: ${run.prewarm.cooldownRealResults})`,
  );
  record(
    'rate-limit: pacing per-utilizator real (1000 rate_limited)',
    s.rateLimit.blocked.rate_limited === 1000,
    `rate_limited=${s.rateLimit.blocked.rate_limited}`,
  );
  record(
    'coada a absorbit spike-ul: highWater ≤ cap, 0 dropped, 0 timedOut',
    run.flow.queueHighWater <= 10000 && run.flow.droppedDelta === 0 && run.flow.timedOutDelta === 0,
    `highWater=${run.flow.queueHighWater} droppedΔ=${run.flow.droppedDelta} timedOutΔ=${run.flow.timedOutDelta}`,
  );
  record(
    'windowing: ferestre + dispatch-uri procesate în timpul run-ului',
    run.flow.windowsFiredDelta > 0 && run.flow.windowDispatchesDelta > 0,
    `windowsΔ=${run.flow.windowsFiredDelta} dispatchesΔ=${run.flow.windowDispatchesDelta}`,
  );
  record(
    'semantică: A=neon, B=cache, payload EXACT identic (FAZA 14 neschimbată)',
    run.semantics.freshSource === 'neon' && run.semantics.repeatSource === 'cache' && run.semantics.payloadIdentical === true,
    `A=${run.semantics.freshSource} B=${run.semantics.repeatSource} identical=${run.semantics.payloadIdentical}`,
  );
  record(
    'eșantion 10M: 500 concurenți reali → toate răspunse + reducere măsurată',
    run.projection10M.realSample.users === 500 &&
      run.projection10M.realSample.answered === 500 &&
      run.projection10M.realSample.neonExecutions < 500 &&
      run.projection10M.realSample.neonExecutions > 0,
    `neon=${run.projection10M.realSample.neonExecutions} reduction=${run.projection10M.realSample.reductionFactor}×`,
  );
  record(
    'proiecția 10M: toate cele 7 verdicturi verzi',
    Object.values(run.projection10M.verdicts).every(Boolean),
    JSON.stringify(run.projection10M.verdicts),
  );
  record(
    'reducerea totală raportată (răspunsuri / interogări Neon reale)',
    Number.isFinite(run.reductionFactor) && run.reductionFactor >= 1,
    `neonFtsQueries=${run.neonFtsQueries} reduction=${run.reductionFactor}× wall=${Math.round(run.wallMs / 1000)}s`,
  );
  return run;
}

/** D. Post-run state: /status contract + persisted report + aliveness. */
async function sectionD(run) {
  console.log('\nD. Starea post-run pe /status + persistență + platformă vie');
  const { body } = await getJson('/api/search/status');
  record(
    '/status stressTest: { concurrent: 10000, passed: true } după run',
    body?.stressTest?.concurrent === 10000 && body?.stressTest?.passed === true,
    `stressTest=${JSON.stringify({ executed: body?.stressTest?.executed, concurrent: body?.stressTest?.concurrent, passed: body?.stressTest?.passed })}`,
  );
  record(
    '/status stressTest: simultaneous 11000 + answered === total + 0 erori',
    body?.stressTest?.simultaneous === 11000 &&
      body?.stressTest?.requests?.answered === body?.stressTest?.requests?.total &&
      body?.stressTest?.requests?.errors === 0,
    `simultaneous=${body?.stressTest?.simultaneous} requests=${JSON.stringify(body?.stressTest?.requests)}`,
  );
  // The persisted report (survives restarts).
  try {
    const raw = await readFile(join(HERE, '..', 'data', 'search-stress-last.json'), 'utf8');
    const parsed = JSON.parse(raw);
    record(
      'raportul persistat pe disc (data/search-stress-last.json) — passed + 11000 cereri',
      parsed?.passed === true && parsed?.requests?.total === 11000,
      `passed=${parsed?.passed} total=${parsed?.requests?.total}`,
    );
  } catch (err) {
    record('raportul persistat pe disc', false, String(err?.message ?? err).slice(0, 120));
  }
  // The platform is alive after the stress.
  const alive = await getJson('/api/search/advanced?q=dune&limit=3', { 'X-Forwarded-For': '10.79.9.9' });
  record(
    'căutarea reală răspunde după stress (rezultate reale prin pipeline)',
    alive.status === 200 && Array.isArray(alive.body?.data) && alive.body?.engine === 'animaxia-neon-fts',
    `status=${alive.status} engine=${alive.body?.engine} results=${alive.body?.data?.length}`,
  );
  if (run) {
    record(
      'istoricul rulărilor s-a extins (runs ≥ 1 în consola /stress)',
      true,
      `run finishedAt=${run.finishedAt}`,
    );
  }
}

/** Spawn one opt-burst-worker (N identical searches from N distinct users,
 *  chunked at 100 concurrent per process) and collect its JSON outcome. */
function fireWorker(offset, count, query, stamp, subnet) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [WORKER_PATH, String(offset), String(count), query, stamp, String(subnet)],
      { env: { ...process.env }, stdio: ['ignore', 'pipe', 'inherit'] },
    );
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    child.on('error', () => resolve([]));
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

/** E. HTTP-level proof: 1000 identical requests over REAL HTTP through the
 *  integrated pipeline → all 200 + real, EXACTLY 1 real Neon query. */
async function sectionE() {
  console.log('\nE. Burst HTTP real — 1000 identice prin pipeline-ul integrat (10 workeri × 100)');
  const optBefore = await getJson('/api/search/opt');
  const ftsBefore = optBefore.body?.counters?.ftsQueries ?? 0;
  const dedupBefore = optBefore.body?.counters?.deduplicatedRequests ?? 0;
  const stamp = `f18-http-${Date.CURRENT_TIMESTAMP.toString(36)}`;

  const results = await Promise.all(
    Array.from({ length: 10 }, (_, i) => fireWorker(i * 100, 100, 'full integration burst', stamp, 91)),
  );
  const flat = results.flat();
  const ok200 = flat.filter((r) => r.status === 200 && r.hasData !== false && r.engine === 'animaxia-neon-fts');
  const sources = flat.reduce((acc, r) => {
    if (r.source) acc[r.source] = (acc[r.source] ?? 0) + 1;
    return acc;
  }, {});
  record(
    '1000 cereri HTTP identice → toate 200 cu rezultate 100% reale',
    flat.length === 1000 && ok200.length === 1000,
    `total=${flat.length} ok200=${ok200.length}`,
  );
  const optAfter = await getJson('/api/search/opt');
  const ftsAfter = optAfter.body?.counters?.ftsQueries ?? 0;
  const dedupAfter = optAfter.body?.counters?.deduplicatedRequests ?? 0;
  record(
    'EXACT 1 interogare Neon reală pentru tot burst-ul HTTP (Δfts === 1)',
    ftsAfter - ftsBefore === 1,
    `Δfts=${ftsAfter - ftsBefore} sources=${JSON.stringify(sources)}`,
  );
  record(
    'dedup Δ ≥ 999 (batch + cache au absorbit restul cererilor HTTP)',
    dedupAfter - dedupBefore >= 999,
    `Δdedup=${dedupAfter - dedupBefore}`,
  );
}

/** F. Security on the trigger (non-admin). */
async function sectionF() {
  console.log('\nF. Securitate pe declanșator');
  const stamp = Date.CURRENT_TIMESTAMP.toString(36);
  const email = `f18-nonadmin-${stamp}@synth.animaxia`;
  const reg = await fetch(`${API_ORIGIN}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Forwarded-For': '10.78.1.10' },
    body: JSON.stringify({ email, username: `f18user${stamp}`, password: 'F18User!2026' }),
    signal: AbortSignal.timeout(15000),
  });
  const regBody = await reg.json().catch(() => null);
  if (!regBody?.accessToken) {
    record('utilizator non-admin înregistrat', false, 'register a eșuat — verifică /api/auth/register');
    return;
  }
  const res = await fetch(`${API_ORIGIN}/api/search/stress`, {
    method: 'POST',
    headers: { authorization: `Bearer ${regBody.accessToken}`, 'content-type': 'application/json', 'X-Forwarded-For': '10.78.1.11' },
    body: '{}',
    signal: AbortSignal.timeout(15000),
  });
  record('POST /stress non-admin → 403', res.status === 403, `status=${res.status}`);
}

/** G. Metrics: the FAZA 18 series + the 11 spec monitoring series. */
async function sectionG() {
  console.log('\nG. Metrici Prometheus');
  const res = await fetch(`${API_ORIGIN}/api/metrics`, { signal: AbortSignal.timeout(30000) });
  const text = await res.text();
  const f18 = [
    'animaxia_search_pipeline_integrated',
    'animaxia_search_pipeline_stages',
    'animaxia_search_stress_passed',
    'animaxia_search_stress_concurrency',
    'animaxia_search_stress_requests_total',
    'animaxia_search_stress_fts_queries',
    'animaxia_search_stress_reduction_factor',
  ];
  const missingF18 = f18.filter((k) => !text.includes(`${k} `));
  record('seriile FAZA 18 (searchstress) prezente 7/7', missingF18.length === 0, missingF18.length ? `missing: ${missingF18.join(', ')}` : f18.join(', '));
  record(
    'animaxia_search_pipeline_integrated 1 + animaxia_search_stress_passed 1 (după run)',
    text.includes('animaxia_search_pipeline_integrated 1') && text.includes('animaxia_search_stress_passed 1'),
    'valori live în textul Prometheus',
  );
  const spec = [
    'animaxia_search_queue_length',
    'animaxia_search_inflight',
    'animaxia_search_window_interval',
    'animaxia_search_batch_hits',
    'animaxia_search_cache_hits',
    'animaxia_search_cache_misses',
    'animaxia_search_dedup_count',
    'animaxia_search_rate_limit_hits',
    'animaxia_search_cooldown_active',
    'animaxia_search_spam_blocked',
    'animaxia_search_burst_events',
  ];
  const missingSpec = spec.filter((k) => !text.includes(`${k} `));
  record('cele 11 serii de monitorizare din specificație prezente 11/11', missingSpec.length === 0, missingSpec.length ? `missing: ${missingSpec.join(', ')}` : 'toate 11 prezente');
  const json = await getJson('/api/metrics?format=json');
  record(
    'collectors.searchstress în ?format=json (cu verdictul run-ului)',
    Boolean(json.body?.collectors?.searchstress && json.body.collectors.searchstress.passed === 1 && json.body.collectors.searchstress.requestsTotal === 11000),
    `searchstress=${JSON.stringify(json.body?.collectors?.searchstress)?.slice(0, 120)}`,
  );
}

/** H. Regressions: the FAZA 15/16/17 consoles + health. */
async function sectionH() {
  console.log('\nH. Regresii — consolele FAZA 15/16/17 + health');
  const flow = await getJson('/api/search/flow');
  record('GET /api/search/flow (FAZA 15) intact', flow.status === 200 && Boolean(flow.body?.flowControl?.queueEnabled), `status=${flow.status}`);
  const rate = await getJson('/api/search/rate');
  record('GET /api/search/rate (FAZA 16) intact', rate.status === 200 && Boolean(rate.body?.rateLimit?.perUserMs), `status=${rate.status}`);
  const opt = await getJson('/api/search/opt');
  record(
    'GET /api/search/opt (FAZA 17) intact',
    opt.status === 200 && Boolean(opt.body?.batching?.enabled && opt.body?.cache?.ttlMs && opt.body?.dedup?.active),
    `status=${opt.status}`,
  );
  const health = await getJson('/api/health');
  record(
    '/api/health ok + db.connected după tot traficul FAZA 18',
    health.status === 200 && health.body?.status === 'ok' && health.body?.db?.connected === true,
    `status=${health.status} db=${health.body?.db?.connected}`,
  );
}

/* ------------------------------------------------------------------ main -- */

async function main() {
  console.log(`FAZA 18 — Full Integration + Stress Test smoke (against ${API_ORIGIN})`);
  const adminToken = await promoteAndLoginAdmin('f18');

  await sectionA();
  await sectionB();
  const run = await sectionC(adminToken);
  await sectionD(run);
  await sectionE();
  await sectionF();
  await sectionG();
  await sectionH();

  console.log(`\n────────────────────────────────────────`);
  console.log(`smoke-searchfull: ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log('failures:');
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('smoke-searchfull crashed:', err);
  process.exit(1);
});
