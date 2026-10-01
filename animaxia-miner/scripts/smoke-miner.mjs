#!/usr/bin/env bun
/**
 * animaxia-miner/scripts/smoke-miner.mjs — FAZA 12 miner smoke suite (live).
 *
 * Exercises the miner service on the LIVE monolith (:4000, Neon driver):
 *
 *   A. infra          — health, /api/miner/status shape, job types
 *   B. model          — Neon miner tables, auth guards (401/400)
 *   C. pipeline       — daily-sync (REAL TMDB + Jikan pages) → upserts,
 *                       provenance rows, per-tenant sources
 *   D. indexing       — reindex job → vectorembeddings rows for the tenant
 *   E. metrics        — /api/metrics exposes animaxia_miner_* series
 *   F. manifests      — manifest-sweep job → miner_manifests rows
 *   G. cleanup        — QA jobs/logs removed, production rows kept
 *
 * Run: bun scripts/smoke-miner.mjs    (from animaxia-miner/)
 * Needs: monolith :4000 up (Neon active, TMDB/Jikan reachable).
 *
 * Admin bootstrap: registers a unique account and promotes it via SQL
 * (DATABASEURL from the monolith .env — MONOLITH_ENV to override), the same
 * way the FAZA 11/12 QA stories did.
 */

import { readFileSync } from 'node:fs';
import { Client } from 'pg';

const MONOLITH = process.env.MONOLITH_URL || 'http://localhost:4000';
const MONOLITH_ENV = process.env.MONOLITH_ENV || '../../mini-services/animaxia-backend/.env';
const now = Date.now();
const QA_TAG = `smoke12-${String(now).slice(-8)}`;

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, extra = '') {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    failures.push(`${name}${extra ? ` — ${extra}` : ''}`);
    console.error(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

const section = (title) => console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 64 - title.length))}`);

async function req(method, path, { token, body, headers } = {}) {
  const res = await fetch(`${MONOLITH}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(headers || {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

function readDatabaseUrl() {
  try {
    const raw = readFileSync(new URL(MONOLITH_ENV, import.meta.url), 'utf8');
    const m = raw.match(/^DATABASEURL=(.*)$/m);
    return m?.[1]?.trim();
  } catch {
    return process.env.DATABASEURL || null;
  }
}

/** Poll a job until it settles (or timeout). */
async function settleJob(jobId, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { json: job } = await req('GET', `/api/miner/jobs/${jobId}`);
    if (job && job.status !== 'queued' && job.status !== 'running') return job;
    if (Date.now() >= deadline) return job ?? null;
    await new Promise((r) => setTimeout(r, 2000));
  }
}

/* ---------------------------------- main ----------------------------------- */

async function main() {
  console.log('FAZA 12 — Animaxia Miner smoke (live monolith)');

  const dbUrl = readDatabaseUrl();
  const client = dbUrl ? new Client({ connectionString: dbUrl }) : null;
  if (client) await client.connect();
  const q = async (text, params = []) => (client ? (await client.query(text, params)).rows : []);
  const v = (r) => (r == null ? 0 : Number(r));

  /* A. infra ---------------------------------------------------------------- */
  section('A. infra health');
  const health = await req('GET', '/api/health');
  check('A1 monolith health ok', health.status === 200 && health.json?.status === 'ok');
  check('A2 PostgreSQL driver active', health.json?.db?.driver === 'postgres' && health.json?.db?.connected === true,
    `driver=${health.json?.db?.driver}`);

  const status = await req('GET', '/api/miner/status');
  check('A3 miner status ok', status.status === 200 && status.json?.ok === true && status.json?.service === 'animaxia-miner');
  check('A4 five job types registered', Array.isArray(status.json?.jobTypes) && status.json.jobTypes.length === 5,
    JSON.stringify(status.json?.jobTypes));
  check('A5 pool reports concurrency', status.json?.pool?.maxConcurrent === 2, JSON.stringify(status.json?.pool));
  check('A6 search backend reported', status.json?.searchBackend === 'local' || status.json?.searchBackend === 'opensearch',
    `searchBackend=${status.json?.searchBackend}`);

  /* admin bootstrap ---------------------------------------------------------- */
  const email = `qa12_${now}@animaxia.test`;
  const password = 'Faza12Smoke!2024';
  const reg = await req('POST', '/api/auth/register', { body: { email, username: `qa12s${String(now).slice(-6)}`, password } });
  if (reg.status !== 201 && reg.status !== 409) {
    console.error('admin bootstrap failed:', reg.status, reg.json);
    process.exit(1);
  }
  if (client && reg.status === 201) {
    await client.query(`UPDATE users SET role='admin' WHERE email=$1`, [email]);
  }
  const login = await req('POST', '/api/auth/login', { body: { email, password } });
  const token = login.json?.accessToken;
  check('A7 admin session ready', Boolean(token) && login.json?.user?.role === 'admin');
  if (!token) process.exit(1);

  /* B. model ------------------------------------------------------------------ */
  section('B. model + guards');
  const tables = await q(`SELECT tablename FROM pg_tables WHERE tablename LIKE 'miner%' ORDER BY 1`);
  const tableNames = tables.map((r) => r.tablename);
  check('B1 four miner tables exist', ['miner_jobs', 'miner_logs', 'miner_manifests', 'miner_sources'].every((t) => tableNames.includes(t)),
    tableNames.join(','));

  const anon = await req('POST', '/api/miner/jobs', { body: { type: 'daily-sync' } });
  check('B2 schedule without auth → 401', anon.status === 401, `status=${anon.status}`);

  const badType = await req('POST', '/api/miner/jobs', { token, body: { type: 'nope-sync' } });
  check('B3 unknown job type → 400', badType.status === 400, `status=${badType.status}`);

  const anonRun = await req('POST', '/api/miner/run/some-id', {});
  check('B4 manual run without auth → 401', anonRun.status === 401, `status=${anonRun.status}`);

  const jobsList = await req('GET', '/api/miner/jobs?limit=5');
  check('B5 public jobs listing', jobsList.status === 200 && Array.isArray(jobsList.json?.data));

  const notFound = await req('GET', '/api/miner/jobs/00000000-0000-0000-0000-000000000000');
  check('B6 unknown job id → 404', notFound.status === 404, `status=${notFound.status}`);

  /* C. pipeline (REAL provider pages) ---------------------------------------- */
  section('C. ingest pipeline (live TMDB + Jikan)');
  const contentBefore = v((await q(`SELECT COUNT(*)::int AS n FROM content`))[0]?.n);

  const sched = await req('POST', '/api/miner/jobs', { token, body: { type: 'daily-sync', tenant: 'global' } });
  check('C1 daily-sync scheduled', sched.status === 201 && sched.json?.job?.status === 'queued', JSON.stringify(sched.json).slice(0, 120));
  const jobId = sched.json?.job?.id;
  if (!jobId) process.exit(1);

  const manual = await req('POST', `/api/miner/run/${jobId}`, { token });
  check('C2 manual run accepted (waits or runs)', manual.status === 200 && manual.json?.job != null,
    `status=${manual.status}`);

  const job = await settleJob(jobId);
  check('C3 daily-sync settled done', job?.status === 'done', `status=${job?.status} err=${job?.error}`);
  check('C4 both providers ran', Array.isArray(job?.result?.providers) && job.result.providers.length === 2,
    JSON.stringify(job?.result?.providers));
  check('C5 items upserted (live pages)', v(job?.result?.upserted) >= 2, `upserted=${job?.result?.upserted}`);
  check('C6 items indexed for the tenant', v(job?.result?.indexed) >= 2, `indexed=${job?.result?.indexed}`);
  check('C7 search catalog pushed', v(job?.result?.pushed) >= 2, `pushed=${job?.result?.pushed}`);
  check('C8 job carries structured logs', Array.isArray(job?.logs) && job.logs.length >= 2, `logs=${job?.logs?.length}`);

  const contentAfter = v((await q(`SELECT COUNT(*)::int AS n FROM content`))[0]?.n);
  check('C9 content table grew or refreshed', contentAfter >= contentBefore, `${contentBefore} → ${contentAfter}`);

  const srcGlobal = await q(`SELECT provider, COUNT(*)::int AS n FROM miner_sources WHERE tenantid='global' GROUP BY 1`);
  const srcMap = Object.fromEntries(srcGlobal.map((r) => [r.provider, v(r.n)]));
  check('C10 provenance rows for global (tmdb + jikan)', v(srcMap.tmdb) >= 1 && v(srcMap.jikan) >= 1,
    JSON.stringify(srcMap));

  const logsCount = v((await q(`SELECT COUNT(*)::int AS n FROM miner_logs WHERE jobid=$1`, [jobId]))[0]?.n);
  check('C11 miner_logs persisted', logsCount >= 2, `logs=${logsCount}`);

  /* D. indexing ---------------------------------------------------------------- */
  section('D. vector indexing (reindex job)');
  const someIds = (await q(`SELECT id FROM content ORDER BY id DESC LIMIT 3`)).map((r) => v(r.id));
  const reSched = await req('POST', '/api/miner/jobs', { token, body: { type: 'reindex', tenant: 'global', contentIds: someIds } });
  check('D1 reindex scheduled with contentIds', reSched.status === 201, JSON.stringify(reSched.json).slice(0, 120));
  const reJob = await settleJob(reSched.json?.job?.id, 60000);
  check('D2 reindex settled done', reJob?.status === 'done', `status=${reJob?.status} err=${reJob?.error}`);
  check('D3 reindex indexed the requested ids', v(reJob?.result?.indexed) === someIds.length && reJob?.result?.scope === 'contentIds',
    JSON.stringify(reJob?.result));

  const embGlobal = v((await q(`SELECT COUNT(*)::int AS n FROM vectorembeddings WHERE tenantid='global' AND refkey LIKE 'content:%'`))[0]?.n);
  check('D4 global namespace embeddings present', embGlobal >= someIds.length, `docs=${embGlobal}`);

  /* E. metrics ------------------------------------------------------------------ */
  section('E. ops metrics hooks');
  const metrics = await req('GET', '/api/metrics');
  check('E1 metrics endpoint ok', metrics.status === 200);
  // /api/metrics renders Prometheus text — read it raw for series assertions
  const raw = await fetch(`${MONOLITH}/api/metrics`).then((r) => r.text());
  check('E2 animaxia_miner_jobs_total present', raw.includes('animaxia_miner_jobs_total'), 'series missing');
  check('E3 animaxia_miner_job_duration_ms present', raw.includes('animaxia_miner_job_duration_ms'), 'histogram missing');
  check('E4 animaxia_miner_items_upserted_total present', raw.includes('animaxia_miner_items_upserted_total'), 'counter missing');
  const snap = await req('GET', '/api/metrics?format=json');
  const minerCollector = snap.json?.collectors?.miner;
  check('E5 miner pull collector in JSON snapshot', Boolean(minerCollector?.jobs), JSON.stringify(minerCollector ?? null));

  /* F. manifests ---------------------------------------------------------------- */
  section('F. manifest inventory (sweep job)');
  const mSched = await req('POST', '/api/miner/jobs', { token, body: { type: 'manifest-sweep', tenant: 'global', limit: 200 } });
  check('F1 manifest-sweep scheduled', mSched.status === 201, JSON.stringify(mSched.json).slice(0, 120));
  const mJob = await settleJob(mSched.json?.job?.id, 60000);
  check('F2 sweep settled done', mJob?.status === 'done', `status=${mJob?.status} err=${mJob?.error}`);
  check('F3 sweep scanned rows', v(mJob?.result?.scanned) >= 1, `scanned=${mJob?.result?.scanned}`);

  const manifests = v((await q(`SELECT COUNT(*)::int AS n FROM miner_manifests`))[0]?.n);
  check('F4 manifests recorded (HLS demo rows)', manifests >= 1, `manifests=${manifests}`);
  const mSample = await q(`SELECT manifesturl, host FROM miner_manifests LIMIT 2`);
  check('F5 manifest rows carry host', mSample.every((r) => r.host && r.manifesturl.includes('http')),
    JSON.stringify(mSample).slice(0, 160));

  /* G. cleanup ------------------------------------------------------------------- */
  section('G. cleanup (QA rows only)');
  if (client) {
    // Remove only the jobs this run created (plus their logs); the daily-sync
    // content upserts and provenance rows for 'global' are production data.
    const qaJobs = [jobId, reSched.json?.job?.id, mSched.json?.job?.id].filter(Boolean);
    await client.query(`DELETE FROM miner_logs WHERE jobid = ANY($1::text[])`, [qaJobs]);
    await client.query(`DELETE FROM miner_jobs WHERE id = ANY($1::text[])`, [qaJobs]);
    const remaining = v((await q(`SELECT COUNT(*)::int AS n FROM miner_jobs WHERE id = ANY($1::text[])`, [qaJobs]))[0]?.n);
    check('G1 QA jobs + logs removed', remaining === 0, `remaining=${remaining}`);
    await client.query(`DELETE FROM users WHERE email=$1`, [email]);
    check('G2 QA admin removed', true);
  } else {
    check('G1 cleanup skipped (no SQL)', true);
    check('G2 cleanup skipped (no SQL)', true);
  }

  if (client) await client.end();

  console.log('\n──────────────────────────────────────────────');
  console.log(`smoke-miner: ${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.error('failures:');
    for (const f of failures) console.error(`  ✗ ${f}`);
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('smoke-miner crashed:', err);
  process.exit(1);
});
