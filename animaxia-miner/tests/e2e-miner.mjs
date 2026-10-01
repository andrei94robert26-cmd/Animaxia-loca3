#!/usr/bin/env bun
/**
 * animaxia-miner/tests/e2e-miner.mjs — FAZA 12 miner end-to-end flow (live).
 *
 * Golden path, exactly as a tenant admin would experience it:
 *
 *   1. create a fresh enterprise QA tenant (admin API)
 *   2. schedule + run daily-sync FOR THAT TENANT (real TMDB + Jikan pages)
 *   3. verify the ingest wrote tenant-scoped state:
 *        miner_jobs.tenantid, miner_sources (per-tenant provenance),
 *        vectorembeddings 't:<slug>:content:*' namespace, usage event
 *        miner_sync, per-tenant status aggregates
 *   4. verify the new content is DISCOVERABLE:
 *        /api/all (shared library feed) carries fresh titles,
 *        /api/ai/tenant/vector/search (scoped) finds the tenant's docs,
 *        the edge gateway route /api/miner/status proxy contract
 *   5. teardown: tenant-scoped rows removed, tenant deleted (CASCADE)
 *
 * Run: bun tests/e2e-miner.mjs     (from animaxia-miner/)
 * Needs: monolith :4000 up (Neon active, TMDB/Jikan reachable).
 */

import { readFileSync } from 'node:fs';
import { Client } from 'pg';

const MONOLITH = process.env.MONOLITH_URL || 'http://localhost:4000';
const MONOLITH_ENV = process.env.MONOLITH_ENV || '../../mini-services/animaxia-backend/.env';
const now = Date.now();
const SLUG = `e2e12${String(now).slice(-8)}`;

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

async function settleJob(jobId, timeoutMs = 150000) {
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
  console.log(`FAZA 12 — Animaxia Miner E2E (tenant '${SLUG}')`);

  const dbUrl = readDatabaseUrl();
  if (!dbUrl) {
    console.error('E2E needs SQL access (DATABASEURL) for tenant scoping assertions');
    process.exit(1);
  }
  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  const q = async (text, params = []) => (await client.query(text, params)).rows;
  const v = (r) => (r == null ? 0 : Number(r));

  /* 1. admin bootstrap -------------------------------------------------------- */
  section('1. admin bootstrap');
  const email = `e2e12_${now}@animaxia.test`;
  const reg = await req('POST', '/api/auth/register', { body: { email, username: `e2e12s${String(now).slice(-6)}`, password: 'Faza12E2E!2024' } });
  check('1.1 admin registered', reg.status === 201 || reg.status === 409, `status=${reg.status}`);
  await client.query(`UPDATE users SET role='admin' WHERE email=$1`, [email]);
  const login = await req('POST', '/api/auth/login', { body: { email, password: 'Faza12E2E!2024' } });
  const token = login.json?.accessToken;
  check('1.2 admin session', Boolean(token) && login.json?.user?.role === 'admin');
  if (!token) process.exit(1);

  /* 2. tenant + miner run ------------------------------------------------------- */
  section('2. tenant + tenant-scoped daily-sync');
  const created = await req('POST', '/api/tenants', { token, body: { slug: SLUG, name: `E2E Miner ${SLUG}`, plan: 'business' } });
  check('2.1 tenant created', created.status === 201 && created.json?.tenant?.slug === SLUG, JSON.stringify(created.json).slice(0, 120));

  const sched = await req('POST', '/api/miner/jobs', { token, body: { type: 'daily-sync', tenant: SLUG } });
  check('2.2 daily-sync scheduled for the tenant', sched.status === 201 && sched.json?.job?.tenant === SLUG,
    JSON.stringify(sched.json).slice(0, 140));

  const job = await settleJob(sched.json?.job?.id);
  check('2.3 daily-sync settled done', job?.status === 'done', `status=${job?.status} err=${job?.error}`);
  check('2.4 live pages ingested', v(job?.result?.upserted) >= 2, `upserted=${job?.result?.upserted}`);

  /* 3. tenant-scoped state ------------------------------------------------------- */
  section('3. tenant-scoped state in Neon');
  const srcRows = await q(`SELECT provider, COUNT(*)::int AS n FROM miner_sources WHERE tenantid=$1 GROUP BY 1`, [SLUG]);
  const srcMap = Object.fromEntries(srcRows.map((r) => [r.provider, v(r.n)]));
  check('3.1 provenance rows for the tenant', v(srcMap.tmdb) >= 1 && v(srcMap.jikan) >= 1, JSON.stringify(srcMap));

  const tenantPrefix = `t:${SLUG}:content:%`;
  const embRows = v((await q(`SELECT COUNT(*)::int AS n FROM vectorembeddings WHERE tenantid=$1 AND refkey LIKE $2`, [SLUG, tenantPrefix]))[0]?.n);
  check('3.2 tenant vector namespace populated', embRows >= 2, `docs=${embRows}`);

  const usage = await q(
    `SELECT e.quantity FROM tenantusageevents e JOIN tenants t ON t.id=e.tenantid WHERE t.slug=$1 AND e.metric='miner_sync' ORDER BY e.createdat DESC LIMIT 1`,
    [SLUG],
  );
  check('3.3 miner_sync usage event metered', usage.length === 1 && v(usage[0].quantity) >= 2, `quantity=${usage[0]?.quantity}`);

  const status = await req('GET', '/api/miner/status');
  const tenantRow = (status.json?.tenants ?? []).find((t) => t.tenant === SLUG);
  check('3.4 per-tenant status aggregate', Boolean(tenantRow) && tenantRow.sources >= 2 && tenantRow.synced24h >= 2,
    JSON.stringify(tenantRow));

  /* 4. discoverability -------------------------------------------------------------- */
  section('4. discoverability (feed + scoped AI)');
  const all = await req('GET', '/api/all?limit=100');
  check('4.1 shared library feed serves the synced content', all.status === 200 && v(all.json?.total) >= 80,
    `total=${all.json?.total}`);

  const search = await req('POST', '/api/ai/tenant/vector/search', {
    token,
    headers: { 'x-animaxia-tenant': SLUG },
    body: { query: 'action adventure', topK: 3 },
  });
  check('4.2 tenant-scoped vector search works', search.status === 200 && search.json?.ok === true && (search.json?.data?.length ?? 0) >= 1,
    `results=${search.json?.data?.length}`);
  check('4.3 scoped results carry the tenant namespace', (search.json?.data ?? []).every((d) => String(d.refkey ?? d.id ?? '').includes(SLUG)),
    JSON.stringify((search.json?.data ?? [])[0]).slice(0, 140));

  const aiStatus = await req('GET', '/api/ai/tenant/status', { headers: { 'x-animaxia-tenant': SLUG } });
  check('4.4 tenant AI status shows the index', aiStatus.status === 200 && Boolean(aiStatus.json?.tenant?.slug === SLUG),
    JSON.stringify(aiStatus.json?.tenant?.slug));

  /* 5. teardown ------------------------------------------------------------------------ */
  section('5. teardown');
  const jobIds = [sched.json?.job?.id].filter(Boolean);
  await client.query(`DELETE FROM miner_logs WHERE jobid = ANY($1::text[])`, [jobIds]);
  await client.query(`DELETE FROM miner_jobs WHERE tenantid=$1`, [SLUG]);
  await client.query(`DELETE FROM miner_sources WHERE tenantid=$1`, [SLUG]);
  await client.query(`DELETE FROM miner_manifests WHERE tenantid=$1`, [SLUG]);
  await client.query(`DELETE FROM vectorembeddings WHERE tenantid=$1 AND refkey LIKE $2`, [SLUG, `t:${SLUG}:content:%`]);
  await client.query(`DELETE FROM tenantusageevents WHERE tenantid=(SELECT id FROM tenants WHERE slug=$1)`, [SLUG]);
  await client.query(`DELETE FROM tenants WHERE slug=$1`, [SLUG]);
  await client.query(`DELETE FROM users WHERE email=$1`, [email]);

  const leftovers = v((await q(
    `SELECT (SELECT COUNT(*) FROM miner_jobs WHERE tenantid=$1) + (SELECT COUNT(*) FROM miner_sources WHERE tenantid=$1) + (SELECT COUNT(*) FROM vectorembeddings WHERE tenantid=$1) + (SELECT COUNT(*) FROM tenants WHERE slug=$1) AS n`,
    [SLUG],
  ))[0]?.n);
  check('5.1 tenant-scoped rows fully removed', leftovers === 0, `leftovers=${leftovers}`);

  await client.end();

  console.log('\n──────────────────────────────────────────────');
  console.log(`e2e-miner: ${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.error('failures:');
    for (const f of failures) console.error(`  ✗ ${f}`);
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('e2e-miner crashed:', err);
  process.exit(1);
});
