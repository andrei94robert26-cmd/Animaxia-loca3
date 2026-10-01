#!/usr/bin/env bun
/**
 * animaxia-ops/synthetics/run.mjs — FAZA 9 synthetic checks.
 *
 * Exercises the LIVE platform end-to-end the way a user would: web console,
 * monolith health + metrics, real register → login → /me, an authenticated AI
 * call, the player/HLS chain and the offline assets the mobile/desktop apps
 * fall back to. Zero dependencies (bun-native fetch); exits non-zero on any
 * hard failure so CI (ops-ci.yml) can gate on it.
 *
 * Usage:
 *   bun run ops:synthetics            # from animaxia-ops/
 *   bun run ops:synthetics --json     # machine-readable report
 *   bun run ops:synthetics --only api # single suite: web|api|auth|ai|player|edge|shards
 *
 * Environment:
 *   WEB_ORIGIN  default http://localhost:3000 (Next.js web app)
 *   API_ORIGIN  default http://localhost:4000 (Animaxia monolith)
 *
 * Soft results (e.g. AI quota exhausted → 402) never fail the run; they are
 * reported as soft-warned, mirroring the FAZA 8 e2e quota policy.
 */

import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const WEB_ORIGIN = process.env.WEB_ORIGIN || 'http://localhost:3000';
const API_ORIGIN = process.env.API_ORIGIN || 'http://localhost:4000';
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');

const args = process.argv.slice(2);
const JSON_MODE = args.includes('--json');
const onlyIdx = args.indexOf('--only');
const ONLY = onlyIdx >= 0 ? args[onlyIdx + 1] : null;

const results = [];
let passed = 0;
let failed = 0;
let soft = 0;

function record(suite, name, ok, detail = '', isSoft = false) {
  if (isSoft && !ok) {
    soft += 1;
    results.push({ suite, name, status: 'soft', detail });
    if (!JSON_MODE) console.log(`  ~ ${name} — ${detail}`);
    return;
  }
  if (ok) {
    passed += 1;
    results.push({ suite, name, status: 'pass' });
    if (!JSON_MODE) console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    results.push({ suite, name, status: 'fail', detail });
    if (!JSON_MODE) console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function fetchOk(url, opts = {}, timeoutMs = 15000) {
  const started = Date.now();
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  return { res, text, ms: Date.now() - started };
}

function tryJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ suites -- */

async function suiteWeb() {
  const { res, text, ms } = await fetchOk(`${WEB_ORIGIN}/`);
  record('web', 'GET / → 200', res.status === 200, `status=${res.status}`);
  record('web', 'web app renders Animaxia branding', /animaxia/i.test(text), 'branding marker missing');
  record('web', 'home responds under 3s', ms < 3000, `${ms}ms`);

  const edge = await fetchOk(`${WEB_ORIGIN}/api/edge-status`, {}, 20000);
  record('web', 'GET /api/edge-status (edge console probe) → 200', edge.res.status === 200, `status=${edge.res.status}`);
}

async function suiteApi() {
  const { res, text } = await fetchOk(`${API_ORIGIN}/api/health`);
  const body = tryJson(text);
  record('api', 'GET /api/health → 200', res.status === 200, `status=${res.status}`);
  record('api', 'Neon PostgreSQL connected', body?.db?.connected === true && body?.db?.driver === 'postgres', JSON.stringify(body?.db).slice(0, 120));
  record('api', 'catalog populated (≥ 50 items)', (body?.db?.totalItems ?? 0) >= 50, `totalItems=${body?.db?.totalItems}`);
  const circuits = Array.isArray(body?.providers) ? body.providers : [];
  record('api', 'all provider circuits closed', circuits.length > 0 && circuits.every((p) => p.state === 'closed'), JSON.stringify(circuits.map((p) => `${p.name}:${p.state}`)).slice(0, 140));
  record('api', 'health exposes the FAZA 9 ai section', Boolean(body?.ai?.provider?.provider), 'ai.provider missing');

  const prom = await fetchOk(`${API_ORIGIN}/api/metrics`);
  record('api', 'GET /api/metrics (Prometheus) → 200', prom.res.status === 200, `status=${prom.res.status}`);
  record('api', 'prometheus render has http requests_total', prom.text.includes('animaxia_http_requests_total'), 'metric family missing');
  record('api', 'prometheus render has db + provider gauges', prom.text.includes('animaxia_db_connected') && prom.text.includes('animaxia_provider_circuit_state'), 'collector gauges missing');

  const js = await fetchOk(`${API_ORIGIN}/api/metrics?format=json`);
  const snap = tryJson(js.text);
  record('api', 'GET /api/metrics?format=json → snapshot', Boolean(snap?.http?.totalRequests > 0), `totalRequests=${snap?.http?.totalRequests}`);
}

async function suiteAuth() {
  const stamp = Date.now().toString(36);
  const email = `ops-synth-${stamp}@synth.animaxia`;
  const username = `opssynth${stamp}`;
  const password = 'OpsSynth!2026';

  const reg = await fetchOk(`${API_ORIGIN}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, username, password }),
  });
  const regBody = tryJson(reg.text);
  record('auth', 'register → 200/201', reg.res.status === 200 || reg.res.status === 201, `status=${reg.res.status} ${reg.text.slice(0, 120)}`);

  const login = await fetchOk(`${API_ORIGIN}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const loginBody = tryJson(login.text);
  record('auth', 'login → 200 + accessToken', login.res.status === 200 && Boolean(loginBody?.accessToken), `status=${login.res.status}`);
  const token = loginBody?.accessToken || regBody?.accessToken;

  const me = await fetchOk(`${API_ORIGIN}/api/auth/me`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const meBody = tryJson(me.text);
  record('auth', 'GET /api/auth/me with Bearer → 200', me.res.status === 200, `status=${me.res.status} ${me.text.slice(0, 120)}`);
  record('auth', 'session identity matches', meBody?.email === email || meBody?.user?.email === email, 'email mismatch');

  return token;
}

async function suiteAi(token) {
  const status = await fetchOk(`${API_ORIGIN}/api/ai/cloud/status`);
  const st = tryJson(status.text);
  record('ai', 'GET /api/ai/cloud/status → 200', status.res.status === 200, `status=${status.res.status}`);
  record('ai', 'LLM provider reported', Boolean(st?.llm?.provider), 'llm.provider missing');
  record('ai', 'vector backend reported', Boolean(st?.vector?.backend), 'vector.backend missing');

  const headers = token ? { authorization: `Bearer ${token}` } : {};
  const home = await fetchOk(`${API_ORIGIN}/api/ai/personal/home`, { headers }, 30000);
  const quotaExhausted = home.res.status === 402;
  record('ai', 'GET /api/ai/personal/home → 200', home.res.status === 200, `status=${home.res.status} ${home.text.slice(0, 140)}`, quotaExhausted);
  const hb = tryJson(home.text);
  record('ai', 'personal home payload has AI content', Boolean(hb && (hb.picks || hb.greeting || hb.dailyPicks)), 'no picks/greeting in payload', quotaExhausted);
}

async function suitePlayer() {
  const { res, text } = await fetchOk(`${API_ORIGIN}/api/mobile/player/3`);
  const body = tryJson(text);
  record('player', 'GET /api/mobile/player/3 → 200', res.status === 200, `status=${res.status} ${text.slice(0, 120)}`);
  record('player', 'player payload has sources/mode', Boolean(body && (body.sources || body.mode)), 'sources/mode missing');

  // Real HLS chain: resolve an m3u8 source and fetch the live manifest.
  const sources = Array.isArray(body?.sources) ? body.sources : [];
  const hlsSrc = sources.find((s) => String(s.url || '').includes('.m3u8')) || (body?.mode === 'direct' && String(body?.url || '').includes('.m3u8') ? { url: body.url } : null);
  if (hlsSrc?.url) {
    const man = await fetchOk(hlsSrc.url, {}, 20000);
    record('player', 'HLS manifest reachable → 200 m3u8', man.res.status === 200 && man.text.includes('#EXTM3U'), `status=${man.res.status}`);
  } else {
    record('player', 'HLS manifest reachable → 200 m3u8', false, 'no .m3u8 source in payload', true);
  }

  // Offline fallback assets shipped for the mobile + desktop players.
  for (const asset of [
    'animaxia-mobile/app/assets/offline-test.mp4',
    'animaxia-desktop/public/offline-test.mp4',
  ]) {
    let size = 0;
    try {
      size = (await stat(join(REPO_ROOT, asset))).size;
    } catch {
      size = 0;
    }
    record('player', `offline asset present (${asset.split('/').slice(0, 2).join('/')})`, size > 300 * 1024, `${size} bytes`);
  }
}

async function suiteMiner() {
  // FAZA 12 (miner): the ingest service must answer with its health snapshot
  // — pool, registered job types and recent job stats (a fully failed queue
  // is a hard failure; individual provider outages surface in miner_logs).
  const { res, text } = await fetchOk(`${API_ORIGIN}/api/miner/status`);
  const body = tryJson(text);
  record('miner', 'GET /api/miner/status → 200', res.status === 200, `status=${res.status} ${text.slice(0, 120)}`);
  record('miner', 'miner service identity', body?.service === 'animaxia-miner' && body?.ok === true, 'identity mismatch');
  record('miner', 'five job types registered', Array.isArray(body?.jobTypes) && body.jobTypes.length === 5, JSON.stringify(body?.jobTypes));
  record('miner', 'pool concurrency reported', body?.pool?.maxConcurrent === 2 && typeof body?.pool?.running === 'number', JSON.stringify(body?.pool));
  const jobs = body?.jobs?.byStatus ?? {};
  record('miner', 'job queue stats present', typeof jobs === 'object' && jobs !== null, 'byStatus missing');
  const doneOk = Number(jobs.done ?? 0);
  const failedN = Number(jobs.failed ?? 0);
  record('miner', 'miner jobs healthy (runs recorded, failures bounded)', doneOk > 0 && failedN <= doneOk, `done=${doneOk} failed=${failedN}`);
}

async function suiteShards() {
  // FAZA 13 (sharding): per-shard synthetics — the lightweight /api/shards/health
  // probe, the composite /api/shards status and the search/vector clusters.
  // Physical-mode (branch URL configured but down) and config-disabled cases
  // are SOFT: physical sharding is config-dependent, so a down branch warns
  // instead of failing the gate.
  const light = await fetchOk(`${API_ORIGIN}/api/shards/health`);
  const lightBody = tryJson(light.text);
  record('shards', 'GET /api/shards/health → 200 & ok:true', light.res.status === 200 && lightBody?.ok === true, `status=${light.res.status} ok=${lightBody?.ok}`);
  const shards = Array.isArray(lightBody?.shards) ? lightBody.shards : [];
  record('shards', 'all shards report status "healthy"', shards.length > 0 && shards.every((s) => s.status === 'healthy'), JSON.stringify(shards.map((s) => `${s.shardid}:${s.status}`)));

  const full = await fetchOk(`${API_ORIGIN}/api/shards`, {}, 30000);
  const body = tryJson(full.text);
  record('shards', 'GET /api/shards → 200', full.res.status === 200, `status=${full.res.status}`);
  const shardcount = Number(body?.model?.shardcount ?? 0);
  record('shards', 'shardcount ≥ 1 reported', shardcount >= 1, `shardcount=${shardcount}`);
  const schema = body?.schema ?? {};
  record('shards', 'shardid schema columns on content/searchdocs/vectorembeddings', schema.content === true && schema.searchdocs === true && schema.vectorembeddings === true, JSON.stringify(schema));

  // Every pool entry connected — soft-warn when a configured branch URL is down
  // (physical mode is config-dependent; logical mode must always be connected).
  const pools = Array.isArray(body?.pools) ? body.pools : [];
  for (const p of pools) {
    const mode = p.mode === 'branch' ? 'physical' : 'logical';
    record('shards', `pool shard ${p.shardid} connected (${mode}${p.urlConfigured ? ', url configured' : ''})`, p.connected === true, `connected=${p.connected} lastError=${p.lastError ?? 'none'}`, p.mode === 'branch');
  }

  // Search + vector cluster enabled & healthy — soft when disabled by config
  // (SEARCHCLUSTENABLED / VECTORCLUSTENABLED = false → legacy single-node path).
  const sc = body?.searchCluster ?? {};
  const scDisabled = sc.enabled === false;
  record('shards', 'search cluster enabled & healthy', sc.enabled === true && sc.healthy === true, `enabled=${sc.enabled} healthy=${sc.healthy}`, scDisabled);
  const vc = body?.vectorCluster ?? {};
  const vcDisabled = vc.enabled === false;
  record('shards', 'vector cluster enabled & healthy', vc.enabled === true && vc.healthy === true, `enabled=${vc.enabled} healthy=${vc.healthy}`, vcDisabled);
}

async function suiteEdge() {
  // The web console's edge probe is the user-facing edge status; the full
  // edge pipeline (gateway/search/ai/auth/player/analytics/cron against the
  // real cloud + Neon) runs in CI via animaxia-edge `bun run test`.
  const { res, text } = await fetchOk(`${WEB_ORIGIN}/api/edge-status`, {}, 20000);
  const body = tryJson(text);
  record('edge', 'edge console status → 200', res.status === 200, `status=${res.status}`);
  record(
    'edge',
    'edge origin probe healthy',
    Boolean(body && (body?.upstream?.healthy === true || body?.healthy === true || body?.ok === true)),
    text.slice(0, 140),
  );
}

/* -------------------------------------------------------------------- main -- */

async function main() {
  if (!JSON_MODE) {
    console.log('Animaxia Ops — synthetic checks');
    console.log(`  web ${WEB_ORIGIN} · api ${API_ORIGIN}`);
  }

  const suites = [
    ['web', suiteWeb],
    ['api', suiteApi],
    ['auth', suiteAuth],
    ['ai', async (token) => suiteAi(token)],
    ['player', suitePlayer],
    ['miner', suiteMiner], // FAZA 12 ingest service
    ['edge', suiteEdge],
    ['shards', suiteShards], // FAZA 13 sharding (per-shard synthetics)
  ];

  let token = null;
  for (const [name, fn] of suites) {
    if (ONLY && name !== ONLY) continue;
    if (!JSON_MODE) console.log(`\n${name}:`);
    try {
      const out = await fn(token);
      if (name === 'auth' && typeof out === 'string') token = out;
    } catch (err) {
      record(name, `${name} suite completed`, false, String(err?.message || err).slice(0, 160));
    }
  }

  const summary = { passed, failed, softWarned: soft, webOrigin: WEB_ORIGIN, apiOrigin: API_ORIGIN };
  if (JSON_MODE) {
    console.log(JSON.stringify({ summary, results }, null, 2));
  } else {
    console.log('\n────────────────────────────────────────');
    console.log(`synthetics: ${passed} passed, ${failed} failed, ${soft} soft-warned`);
  }
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('synthetics crashed:', err);
  process.exit(1);
});
