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
 *   bun run ops:synthetics --only api # single suite: web|api|auth|ai|player|edge|miner|shards|global30b|searchrate|searchopt|searchfull
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

  // FAZA 14 (definitive spec): 30 logical shards × 1 billion ids = the 30B
  // logical address space; in logical mode the clusters execute coalesced.
  record('shards', 'FAZA 14 topology: 30 shards × 1B ids', shardcount === 30, `shardcount=${shardcount}`);
  record(
    'shards',
    'FAZA 14 logical address space: 30.000.000.000 (30 × 1B)',
    Number(body?.logical?.addressSpace) === 30_000_000_000 && Number(body?.logical?.shardSpan) === 1_000_000_000,
    JSON.stringify(body?.logical ?? null),
  );
  record(
    'shards',
    'FAZA 14 cluster execution is coalesced-logical in logical mode',
    body?.model?.mode !== 'logical' || sc.execution === 'coalesced-logical',
    `mode=${body?.model?.mode} searchExecution=${sc.execution}`,
    scDisabled, // soft when the cluster is disabled by config
  );
}

async function suiteGlobal30b() {
  // FAZA 14 (global 30B feed + universal external player): the definitive
  // spec — 30B content ids SIMULATED LOGICALLY (real rows stay real in Neon),
  // O(1) pagination at any depth, real overlay at the rows' own ids, shard
  // ranges, and a player that resolves ANY external URL with zero DB access.
  const feed = await fetchOk(`${API_ORIGIN}/api/platform/feed/global?limit=20`);
  const feedBody = tryJson(feed.text);
  record('global30b', 'GET /api/platform/feed/global → 200, engine animaxia-global-30b', feed.res.status === 200 && feedBody?.engine === 'animaxia-global-30b', `status=${feed.res.status} engine=${feedBody?.engine}`);
  record(
    'global30b',
    'address space is 30.000.000.000 with 30 shards × 1B',
    Number(feedBody?.addressSpace) === 30_000_000_000 && Number(feedBody?.shardcount) === 30 && Number(feedBody?.shardSpan) === 1_000_000_000,
    `addressSpace=${feedBody?.addressSpace} shardcount=${feedBody?.shardcount}`,
  );
  const items = Array.isArray(feedBody?.items) ? feedBody.items : [];
  record(
    'global30b',
    'items flagged virtual XOR real with valid shard ids',
    items.length === 20 && items.every((i) => (i.virtual === true) !== (i.real === true) && Number.isInteger(i.shardid) && i.shardid >= 0 && i.shardid < 30),
    `items=${items.length}`,
  );
  const stats = feedBody?.stats ?? {};
  record(
    'global30b',
    'stats: real overlay counts + per-shard coverage (30 entries)',
    Number(stats.realInPage) + Number(stats.virtualInPage) === items.length && Array.isArray(stats.perShard) && stats.perShard.length === 30 && stats.perShard.reduce((a, s) => a + (Number(s.real) || 0), 0) === Number(stats.realCount),
    `realCount=${stats.realCount} realInPage=${stats.realInPage}`,
  );

  // O(1) deep page — the last window of the 30B space must answer fast.
  const lastCursor = Buffer.from(JSON.stringify({ i: 29_999_999_980, s: 'animaxia' }), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const deep = await fetchOk(`${API_ORIGIN}/api/platform/feed/global?cursor=${lastCursor}&limit=20`);
  const deepBody = tryJson(deep.text);
  record(
    'global30b',
    'O(1) deep page at 29.999.999.980 (< 2s, ends the space on shard 29)',
    deep.res.status === 200 && Array.isArray(deepBody?.items) && deepBody.items.length === 20 && Number(deepBody?.tookMs) < 2000 && Number(deepBody?.items?.[19]?.id) === 29_999_999_999 && deepBody?.nextCursor === null && deepBody.items.every((i) => i.shardid === 29),
    `status=${deep.res.status} tookMs=${deepBody?.tookMs}`,
  );

  // Shard range filter — shard 29 serves only ids in [29B, 30B).
  const s29 = await fetchOk(`${API_ORIGIN}/api/platform/feed/global?shard=29&limit=5`);
  const s29Body = tryJson(s29.text);
  record(
    'global30b',
    '?shard=29 serves only shard 29 ids ([29B, 30B))',
    s29.res.status === 200 && Array.isArray(s29Body?.items) && s29Body.items.length === 5 && s29Body.items.every((i) => i.shardid === 29 && i.id >= 29_000_000_000 && i.id < 30_000_000_000),
    `status=${s29.res.status}`,
  );

  // Universal external player — zero DB dependency (definitive rule 4).
  const pv = await fetchOk(`${API_ORIGIN}/api/player/external?url=${encodeURIComponent('https://www.youtube.com/watch?v=dQw4w9WgXcQ')}`);
  const pvBody = tryJson(pv.text);
  record(
    'global30b',
    'player external: YouTube URL → youtube embed, contentFree',
    pv.res.status === 200 && pvBody?.ok === true && pvBody?.type === 'youtube' && pvBody?.embedUrl === 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ' && pvBody?.contentFree === true,
    `status=${pv.res.status} type=${pvBody?.type}`,
  );
  const pvSSRF = await fetchOk(`${API_ORIGIN}/api/player/external?url=${encodeURIComponent('http://127.0.0.1/x')}`);
  record('global30b', 'player external: private network URL blocked (SSRF)', pvSSRF.res.status === 400, `status=${pvSSRF.res.status}`);

  // Logical address-space reporting on /api/search.
  const search = await fetchOk(`${API_ORIGIN}/api/search/status`);
  const searchBody = tryJson(search.text);
  record(
    'global30b',
    '/api/search/status reports the logical 30B space',
    Number(searchBody?.logical?.addressSpace) === 30_000_000_000 && Number(searchBody?.logical?.shardcount) === 30,
    JSON.stringify(searchBody?.logical ?? null),
  );
}

async function suiteSearchflow() {
  // FAZA 15 (Search Flow Control): the admission layer between /api/search/*
  // and Neon — queue + priority lanes + windowed dispatch over the untouched
  // FAZA 14 FTS. Every burst request simulates a DISTINCT user (unique
  // X-Forwarded-For, like the 10M-user target — the per-IP rate limiter stays
  // honest) with a UNIQUE q so the FAZA 17 single-flight coalescing never
  // collapses the burst: each request must exercise its own real query.
  const status = await fetchOk(`${API_ORIGIN}/api/search/status`);
  const statusBody = tryJson(status.text);
  const fc = statusBody?.flowControl;
  record('searchflow', 'GET /api/search/status → 200', status.res.status === 200, `status=${status.res.status}`);
  record(
    'searchflow',
    'flowControl pinned contract (queueEnabled + maxConcurrent + priorities)',
    Boolean(fc && fc.queueEnabled === true && Number.isInteger(fc.maxConcurrent) && fc.maxConcurrent >= 1 && typeof fc.priorities?.high === 'number' && typeof fc.priorities?.normal === 'number' && typeof fc.priorities?.low === 'number'),
    `flowControl=${JSON.stringify(fc)?.slice(0, 140)}`,
  );
  const w = statusBody?.windowing;
  record(
    'searchflow',
    'windowing pinned contract (intervalMs + batchSize)',
    Boolean(w && Number.isInteger(w.intervalMs) && w.intervalMs >= 10 && Number.isInteger(w.batchSize) && w.batchSize >= 1),
    `windowing=${JSON.stringify(w)}`,
  );

  const flow = await fetchOk(`${API_ORIGIN}/api/search/flow`);
  const flowBody = tryJson(flow.text);
  record(
    'searchflow',
    'GET /api/search/flow console (config + history + perShard)',
    Boolean(flowBody?.config?.enabled === true && Array.isArray(flowBody?.history) && Array.isArray(flowBody?.perShard) && flowBody.perShard.length >= 1),
    `config=${JSON.stringify(flowBody?.config)} history=${flowBody?.history?.length} perShard=${flowBody?.perShard?.length}`,
  );

  const before = tryJson((await fetchOk(`${API_ORIGIN}/api/search/flow`)).text)?.flowControl ?? {};
  // Live burst: 16 simultaneous searches from 16 distinct simulated users.
  const burst = await Promise.all(
    Array.from({ length: 16 }, (_, i) =>
      fetchOk(
        `${API_ORIGIN}/api/search/advanced?q=${encodeURIComponent(`synth ${Date.now().toString(36)} ${i}`)}&limit=3`,
        { headers: { 'X-Forwarded-For': `10.31.${Math.floor(i / 250)}.${(i % 250) + 1}` } },
        60000,
      ),
    ),
  );
  const burstOk = burst.filter((b) => b.res.status === 200);
  const burstReal = burstOk.filter((b) => tryJson(b.text)?.engine === 'animaxia-neon-fts');
  record('searchflow', '16-search burst: every request 200', burstOk.length === 16, `ok=${burstOk.length}/16`);
  record('searchflow', '16-search burst: every answer real (animaxia-neon-fts)', burstReal.length === 16, `real=${burstReal.length}/16`);
  const withFlow = burstReal.filter((b) => {
    const f = tryJson(b.text)?.flow;
    return f && typeof f.priority === 'string' && Number.isInteger(f.shardid) && typeof f.queuedMs === 'number';
  });
  record('searchflow', 'burst responses carry flow { priority, shardid, queuedMs }', withFlow.length === 16, `withFlow=${withFlow.length}/16`);

  const after = tryJson((await fetchOk(`${API_ORIGIN}/api/search/flow`)).text)?.flowControl ?? {};
  record(
    'searchflow',
    'burst: dropped & timedOut deltas 0 · processed +≥16',
    (after.dropped ?? 0) - (before.dropped ?? 0) === 0 && (after.timedOut ?? 0) - (before.timedOut ?? 0) === 0 && (after.processed ?? 0) - (before.processed ?? 0) >= 16,
    `dropped +${(after.dropped ?? 0) - (before.dropped ?? 0)} timedOut +${(after.timedOut ?? 0) - (before.timedOut ?? 0)} processed ${before.processed ?? '?'}→${after.processed ?? '?'}`,
  );
  record(
    'searchflow',
    `burst: maxInflightSeen ≤ maxConcurrent (${after.maxConcurrent ?? '?'})`,
    (after.maxInflightSeen ?? 0) <= (after.maxConcurrent ?? 1),
    `maxInflightSeen=${after.maxInflightSeen}`,
  );

  // Priority header honored on the response attribution.
  const hi = await fetchOk(`${API_ORIGIN}/api/search/advanced?q=dune&limit=1`, {
    headers: { 'X-Animaxia-Priority': 'high', 'X-Forwarded-For': '10.31.1.200' },
  });
  record('searchflow', 'X-Animaxia-Priority: high → flow.priority=high', tryJson(hi.text)?.flow?.priority === 'high', `flow=${JSON.stringify(tryJson(hi.text)?.flow)}`);

  // The animaxia_search_* series are scrapeable.
  const metrics = await fetchOk(`${API_ORIGIN}/api/metrics`);
  const required = [
    'animaxia_search_queue_length',
    'animaxia_search_inflight',
    'animaxia_search_window_interval',
    'animaxia_search_dropped_requests',
  ];
  const missing = required.filter((name) => !metrics.text.includes(`\n${name} `) && !metrics.text.includes(`\n${name}{`));
  record('searchflow', 'animaxia_search_* series present in /api/metrics', missing.length === 0, `missing=[${missing.join(', ')}]`);

  // Settings endpoint is admin-gated.
  const anon = await fetchOk(`${API_ORIGIN}/api/search/flow/settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ intervalMs: 60 }),
  });
  record('searchflow', 'POST /flow/settings anonymous → 401', anon.res.status === 401, `status=${anon.res.status}`);
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

/* ------------------------------------------------- FAZA 16: search rate ----- */

async function suiteSearchrate() {
  // Pinned contract on /api/search/status: rateLimit { perUserMs, enforced }
  // + burstControl { active, maxBurstPerWindow }.
  const status = await fetchOk(`${API_ORIGIN}/api/search/status`);
  const sb = tryJson(status.text);
  record('searchrate', 'GET /api/search/status → 200', status.res.status === 200, `status=${status.res.status}`);
  record(
    'searchrate',
    'status rateLimit pinned contract (perUserMs + enforced: true)',
    Boolean(
      sb?.rateLimit &&
        sb.rateLimit.enforced === true &&
        Number.isInteger(sb.rateLimit.perUserMs) &&
        sb.rateLimit.perUserMs >= 100 &&
        Number.isInteger(sb.rateLimit.cooldownMs) &&
        sb.rateLimit.cooldownMs >= 250 &&
        sb.rateLimit.spamProtection &&
        Number.isInteger(sb.rateLimit.spamProtection.threshold),
    ),
    `rateLimit=${JSON.stringify(sb?.rateLimit)?.slice(0, 160)}`,
  );
  record(
    'searchrate',
    'status burstControl pinned contract (active: true + maxBurstPerWindow)',
    Boolean(
      sb?.burstControl &&
        sb.burstControl.active === true &&
        Number.isInteger(sb.burstControl.maxBurstPerWindow) &&
        sb.burstControl.maxBurstPerWindow >= 10 &&
        Number.isInteger(sb.burstControl.windowMs),
    ),
    `burstControl=${JSON.stringify(sb?.burstControl)?.slice(0, 160)}`,
  );

  // Full console on /api/search/rate.
  const console_ = await fetchOk(`${API_ORIGIN}/api/search/rate`);
  const cb = tryJson(console_.text);
  record('searchrate', 'GET /api/search/rate console → 200', console_.res.status === 200, `status=${console_.res.status}`);
  record(
    'searchrate',
    'console: config + counters + history + 30-row perShard',
    Boolean(
      cb?.config?.enabled === true &&
        cb?.counters &&
        typeof cb.counters.admitted === 'number' &&
        Array.isArray(cb?.history) &&
        Array.isArray(cb?.perShard) &&
        cb.perShard.length === 30,
    ),
    `config=${JSON.stringify(cb?.config)} perShard=${cb?.perShard?.length}`,
  );

  // A real admitted search carries the additive rate block + stays REAL.
  const stamp = Date.now().toString(36);
  const real = await fetchOk(
    `${API_ORIGIN}/api/search/advanced?q=synth ${stamp}&limit=3`,
    { headers: { 'X-Forwarded-For': `10.41.${Math.floor(Number.parseInt(stamp.slice(-3), 36) % 250)}.10` } },
    30000,
  );
  const rb = tryJson(real.text);
  record(
    'searchrate',
    'admitted search stays 100% real + carries rate { perUserMs, cooldownMs }',
    Boolean(
      real.res.status === 200 &&
        rb?.engine === 'animaxia-neon-fts' &&
        Array.isArray(rb?.data) &&
        rb?.rate &&
        Number.isInteger(rb.rate.perUserMs) &&
        Number.isInteger(rb.rate.cooldownMs) &&
        rb?.flow?.priority,
    ),
    `status=${real.res.status} engine=${rb?.engine} rate=${JSON.stringify(rb?.rate)}`,
  );

  // Rate limit: two truly-simultaneous searches from ONE user → the second
  // is an explicit 429 rate_limited with retryInMs (never a drop).
  const dupXff = `10.41.90.7`;
  const beforeRate = tryJson((await fetchOk(`${API_ORIGIN}/api/search/rate`)).text)?.counters ?? {};
  const pair = await Promise.all([
    fetchOk(`${API_ORIGIN}/api/search/advanced?q=synth pair a ${stamp}&limit=1`, { headers: { 'X-Forwarded-For': dupXff } }, 30000),
    fetchOk(`${API_ORIGIN}/api/search/advanced?q=synth pair b ${stamp}&limit=1`, { headers: { 'X-Forwarded-For': dupXff } }, 30000),
  ]);
  const pairCodes = pair.map((p) => p.res.status).sort();
  const paced = pair.find((p) => p.res.status === 429);
  const pacedBody = tryJson(paced?.text);
  record(
    'searchrate',
    'rate limit: 2 simultaneous searches from one user → 200 + explicit 429',
    pairCodes[0] === 200 && pairCodes[1] === 429,
    `codes=${JSON.stringify(pair.map((p) => p.res.status))}`,
  );
  record(
    'searchrate',
    '429 rate_limited carries { error, retryInMs } + Retry-After header',
    Boolean(
      paced &&
        pacedBody?.error === 'rate_limited' &&
        Number.isInteger(pacedBody?.retryInMs) &&
        pacedBody.retryInMs > 0 &&
        paced.res.headers.get('retry-after') != null,
    ),
    `body=${JSON.stringify(pacedBody)?.slice(0, 120)}`,
  );

  // Cooldown: after a result, the same user's next /advanced is blocked with
  // the exact pinned shape { error: "cooldown_active", retryInMs }.
  const cdXff = `10.41.91.7`;
  const first = await fetchOk(
    `${API_ORIGIN}/api/search/advanced?q=synth cd ${stamp}&limit=1`,
    { headers: { 'X-Forwarded-For': cdXff } },
    30000,
  );
  const cd = await fetchOk(
    `${API_ORIGIN}/api/search/advanced?q=synth cd2 ${stamp}&limit=1`,
    { headers: { 'X-Forwarded-For': cdXff } },
    30000,
  );
  const cdBody = tryJson(cd.text);
  record(
    'searchrate',
    'cooldown: search right after a result → 429 cooldown_active',
    first.res.status === 200 && cd.res.status === 429 && cdBody?.error === 'cooldown_active' && Number.isInteger(cdBody?.retryInMs),
    `first=${first.res.status} second=${cd.res.status} body=${JSON.stringify(cdBody)?.slice(0, 120)}`,
  );

  // Anti-spam: 10 rapid searches from one user → 1 admitted + the rest
  // explicit 429s (rate_limited / spam_blocked); the flood is auto-blocked.
  const spamXff = `10.41.92.7`;
  const flood = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      fetchOk(
        `${API_ORIGIN}/api/search/advanced?q=synth spam ${i} ${stamp}&limit=1`,
        { headers: { 'X-Forwarded-For': spamXff } },
        30000,
      ),
    ),
  );
  const floodCodes = flood.map((f) => f.res.status);
  const okFlood = floodCodes.filter((c) => c === 200).length;
  const blocked429 = floodCodes.filter((c) => c === 429).length;
  record(
    'searchrate',
    'anti-spam: 10 ENTER presses in <200ms → exactly 1 admitted, 9 explicit 429s',
    okFlood === 1 && blocked429 === 9,
    `codes=${JSON.stringify(floodCodes)}`,
  );
  const spamBlockedBody = flood.map((f) => tryJson(f.text)).find((b) => b?.error === 'spam_blocked');
  record(
    'searchrate',
    'flood requests answered { error: "spam_blocked", retryInMs } (Așteaptă un moment…)',
    Boolean(spamBlockedBody && Number.isInteger(spamBlockedBody.retryInMs) && spamBlockedBody.retryInMs > 0),
    `spamBody=${JSON.stringify(spamBlockedBody)?.slice(0, 120)}`,
  );

  // Autocomplete paces in its OWN lane: even during the advanced cooldown,
  // a typeahead probe from the same user is admitted.
  const acDuring = await fetchOk(
    `${API_ORIGIN}/api/search/autocomplete?q=big`,
    { headers: { 'X-Forwarded-For': cdXff } },
    30000,
  );
  record(
    'searchrate',
    'autocomplete lane independent (admitted during advanced cooldown)',
    acDuring.res.status === 200 && Array.isArray(tryJson(acDuring.text)?.suggestions),
    `status=${acDuring.res.status}`,
  );

  // Distinct users are never collaterally blocked: a fresh user searches 200.
  const fresh = await fetchOk(
    `${API_ORIGIN}/api/search/advanced?q=synth fresh ${stamp}&limit=1`,
    { headers: { 'X-Forwarded-For': `10.41.93.7` } },
    30000,
  );
  record(
    'searchrate',
    'per-user isolation: a distinct user searches 200 while others are blocked',
    fresh.res.status === 200 && tryJson(fresh.text)?.engine === 'animaxia-neon-fts',
    `status=${fresh.res.status}`,
  );

  // Counters moved (the console observed the protections).
  const afterRate = tryJson((await fetchOk(`${API_ORIGIN}/api/search/rate`)).text)?.counters ?? {};
  record(
    'searchrate',
    'console counters reflect the exercise (rate hits + cooldown + spam)',
    Boolean(
      (afterRate.rateLimitHits ?? 0) > (beforeRate.rateLimitHits ?? 0) &&
        (afterRate.cooldownBlocks ?? 0) > (beforeRate.cooldownBlocks ?? 0) &&
        (afterRate.spamBlocked ?? 0) > (beforeRate.spamBlocked ?? 0),
    ),
    `rate ${beforeRate.rateLimitHits ?? '?'}→${afterRate.rateLimitHits ?? '?'} · cd ${beforeRate.cooldownBlocks ?? '?'}→${afterRate.cooldownBlocks ?? '?'} · spam ${beforeRate.spamBlocked ?? '?'}→${afterRate.spamBlocked ?? '?'}`,
  );

  // The spec-pinned series are scrapeable.
  const metrics = await fetchOk(`${API_ORIGIN}/api/metrics`, {}, 30000);
  const requiredRate = [
    'animaxia_search_rate_limit_hits',
    'animaxia_search_cooldown_active',
    'animaxia_search_spam_blocked',
    'animaxia_search_burst_events',
  ];
  const missingRate = requiredRate.filter((name) => !metrics.text.includes(`\n${name} `) && !metrics.text.includes(`\n${name}{`));
  record('searchrate', 'animaxia_search_rate_* series present in /api/metrics', missingRate.length === 0, `missing=[${missingRate.join(', ')}]`);

  // Settings endpoint is admin-gated (same policy as /flow/settings).
  const anonRate = await fetchOk(`${API_ORIGIN}/api/search/rate/settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ perUserMs: 600 }),
  });
  record('searchrate', 'POST /rate/settings anonymous → 401', anonRate.res.status === 401, `status=${anonRate.res.status}`);
}

/* ------------------------------------------------ FAZA 17: search opt ----- */

async function suiteSearchopt() {
  // Pinned contracts on /api/search/status: batching { enabled, activeBatches }
  // + cache { ttlMs, hits, misses } + dedup { active, deduplicatedRequests }
  // + the exact 10-stage pipeline array.
  const status = await fetchOk(`${API_ORIGIN}/api/search/status`);
  const sb = tryJson(status.text);
  record('searchopt', 'GET /api/search/status → 200', status.res.status === 200, `status=${status.res.status}`);
  record(
    'searchopt',
    'status batching pinned contract (enabled: true + activeBatches)',
    Boolean(
      sb?.batching &&
        sb.batching.enabled === true &&
        Number.isInteger(sb.batching.activeBatches) &&
        sb.batching.activeBatches >= 0 &&
        Number.isInteger(sb.batching.maxFanout),
    ),
    `batching=${JSON.stringify(sb?.batching)?.slice(0, 140)}`,
  );
  record(
    'searchopt',
    'status cache pinned contract (ttlMs in 1000-5000 + hits + misses)',
    Boolean(
      sb?.cache &&
        sb.cache.enabled === true &&
        Number.isInteger(sb.cache.ttlMs) &&
        sb.cache.ttlMs >= 1000 &&
        sb.cache.ttlMs <= 5000 &&
        Number.isInteger(sb.cache.hits) &&
        Number.isInteger(sb.cache.misses),
    ),
    `cache=${JSON.stringify(sb?.cache)?.slice(0, 140)}`,
  );
  record(
    'searchopt',
    'status dedup pinned contract (active: true + deduplicatedRequests)',
    Boolean(
      sb?.dedup &&
        sb.dedup.active === true &&
        Number.isInteger(sb.dedup.deduplicatedRequests) &&
        Number.isInteger(sb.dedup.ftsQueries),
    ),
    `dedup=${JSON.stringify(sb?.dedup)?.slice(0, 140)}`,
  );
  const PIPELINE = ['antiSpam', 'rateLimit', 'cooldown', 'queue', 'priority', 'windowing', 'dedup', 'batching', 'cache', 'fts'];
  record(
    'searchopt',
    'status pipeline is the exact pinned 10-stage array',
    Array.isArray(sb?.pipeline) && sb.pipeline.length === PIPELINE.length && sb.pipeline.every((s, i) => s === PIPELINE[i]),
    `pipeline=${JSON.stringify(sb?.pipeline)}`,
  );

  // Full console on /api/search/opt.
  const console_ = await fetchOk(`${API_ORIGIN}/api/search/opt`);
  const cb = tryJson(console_.text);
  record('searchopt', 'GET /api/search/opt console → 200', console_.res.status === 200, `status=${console_.res.status}`);
  record(
    'searchopt',
    'console: config + counters + activeBatches + history + 30-row perShard',
    Boolean(
      cb?.config?.enabled === true &&
        cb?.counters &&
        typeof cb.counters.served === 'number' &&
        typeof cb.counters.reductionFactor === 'number' &&
        Array.isArray(cb?.activeBatches) &&
        Array.isArray(cb?.history) &&
        Array.isArray(cb?.perShard) &&
        cb.perShard.length === 30,
    ),
    `config=${JSON.stringify(cb?.config)} perShard=${cb?.perShard?.length}`,
  );

  // THE money check: 50 identical concurrent requests from 50 DISTINCT users
  // (distinct XFFs — per-user pacing FAZA 16 never blocks distinct users) on
  // a FRESH query → all 200 + all REAL + exactly ONE real Neon query.
  const stamp = Date.now().toString(36);
  const q = `synth opt ${stamp}`;
  const before = tryJson((await fetchOk(`${API_ORIGIN}/api/search/opt`)).text)?.counters ?? {};
  const burst = await Promise.all(
    Array.from({ length: 50 }, (_, i) =>
      fetchOk(`${API_ORIGIN}/api/search/advanced?q=${encodeURIComponent(q)}&limit=3`, {
        headers: { 'X-Forwarded-For': `10.42.${i}.7` },
      }, 30000),
    ),
  );
  const all200 = burst.every((b) => b.res.status === 200);
  const bodies = burst.map((b) => tryJson(b.text));
  const allReal = bodies.every((b) => b?.engine === 'animaxia-neon-fts' && Array.isArray(b?.data));
  const allOpt = bodies.every((b) => b?.opt && typeof b.opt.source === 'string' && typeof b.opt.queryHash === 'string');
  record(
    'searchopt',
    '50 identical concurrent requests → all 200 + 100% real engine + opt provenance',
    all200 && allReal && allOpt,
    `codes=${JSON.stringify(burst.map((b) => b.res.status).filter((c, i, a) => a.indexOf(c) === i))} real=${allReal}`,
  );
  const after = tryJson((await fetchOk(`${API_ORIGIN}/api/search/opt`)).text)?.counters ?? {};
  const dServed = (after.served ?? 0) - (before.served ?? 0);
  const dFts = (after.ftsQueries ?? 0) - (before.ftsQueries ?? 0);
  const dDedup = (after.deduplicatedRequests ?? 0) - (before.deduplicatedRequests ?? 0);
  record(
    'searchopt',
    '50 identical requests → exactly 1 real Neon query (49 deduplicated)',
    dServed === 50 && dFts === 1 && dDedup === 49,
    `served Δ${dServed} · fts Δ${dFts} · dedup Δ${dDedup}`,
  );

  // Repeat within the TTL → the cache serves the stored REAL result.
  const cached = await fetchOk(`${API_ORIGIN}/api/search/advanced?q=${encodeURIComponent(q)}&limit=3`, {
    headers: { 'X-Forwarded-For': '10.42.99.7' },
  }, 30000);
  const cachedBody = tryJson(cached.text);
  record(
    'searchopt',
    'repeat within TTL → served from cache (opt.source = "cache") + real data',
    cached.res.status === 200 &&
      cachedBody?.opt?.source === 'cache' &&
      cachedBody?.engine === 'animaxia-neon-fts' &&
      Array.isArray(cachedBody?.data),
    `source=${cachedBody?.opt?.source} hash=${cachedBody?.opt?.queryHash}`,
  );

  // Distinct queries are NEVER falsely deduped: fresh distinct queries each
  // run their own real execution with distinct hashes.
  const distinct = await Promise.all(
    ['a', 'b', 'c'].map((s, i) =>
      fetchOk(`${API_ORIGIN}/api/search/advanced?q=${encodeURIComponent(`synth distinct ${s} ${stamp}`)}&limit=1`, {
        headers: { 'X-Forwarded-For': `10.42.10${i}.7` },
      }, 30000),
    ),
  );
  const distinctBodies = distinct.map((d) => tryJson(d.text));
  const hashes = distinctBodies.map((b) => b?.opt?.queryHash);
  record(
    'searchopt',
    'distinct queries → own real executions + distinct hashes (no false dedup)',
    distinctBodies.every((b) => b?.opt?.source === 'neon') && new Set(hashes).size === 3,
    `sources=${JSON.stringify(distinctBodies.map((b) => b?.opt?.source))} hashes=${JSON.stringify(hashes)}`,
  );

  // Autocomplete responses carry the additive opt provenance too.
  const ac = await fetchOk(`${API_ORIGIN}/api/search/autocomplete?q=big`, {
    headers: { 'X-Forwarded-For': '10.42.20.7' },
  }, 30000);
  const acBody = tryJson(ac.text);
  record(
    'searchopt',
    'autocomplete carries the additive opt provenance block',
    ac.res.status === 200 && Array.isArray(acBody?.suggestions) && acBody?.opt && typeof acBody.opt.source === 'string',
    `source=${acBody?.opt?.source}`,
  );

  // The spec-pinned series are scrapeable.
  const metrics = await fetchOk(`${API_ORIGIN}/api/metrics`, {}, 30000);
  const requiredOpt = [
    'animaxia_search_batch_hits',
    'animaxia_search_cache_hits',
    'animaxia_search_cache_misses',
    'animaxia_search_dedup_count',
  ];
  const missingOpt = requiredOpt.filter((name) => !metrics.text.includes(`\n${name} `) && !metrics.text.includes(`\n${name}{`));
  record('searchopt', 'animaxia_search_* FAZA 17 pinned series present in /api/metrics', missingOpt.length === 0, `missing=[${missingOpt.join(', ')}]`);

  // Settings endpoint is admin-gated (same policy as /flow + /rate settings).
  const anonOpt = await fetchOk(`${API_ORIGIN}/api/search/opt/settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cacheTtlMs: 4000 }),
  });
  record('searchopt', 'POST /opt/settings anonymous → 401', anonOpt.res.status === 401, `status=${anonOpt.res.status}`);
}

/* ------------------------------------------------------------------ */
/* FAZA 18: full integration + stress test (searchfull) — contract     */
/* checks WITHOUT triggering the heavy run (the smoke suite runs the   */
/* engine; synthetics verify the always-on contracts).                 */
async function suiteSearchfull() {
  // Pinned contracts on /api/search/status: pipelineIntegrated: true +
  // the exact 10-stage pipelineStages array + the stressTest block with
  // the pinned concurrency headline.
  const status = await fetchOk(`${API_ORIGIN}/api/search/status`);
  const sb = tryJson(status.text);
  record('searchfull', 'GET /api/search/status → 200', status.res.status === 200, `status=${status.res.status}`);
  record(
    'searchfull',
    'status pipelineIntegrated pinned contract (true)',
    sb?.pipelineIntegrated === true,
    `pipelineIntegrated=${sb?.pipelineIntegrated}`,
  );
  const PINNED_STAGES = ['antiSpam', 'rateLimit', 'cooldown', 'queue', 'priority', 'windowing', 'dedup', 'batching', 'cache', 'fts'];
  record(
    'searchfull',
    'status pipelineStages = the exact 10-stage integrated array',
    Array.isArray(sb?.pipelineStages) &&
      sb.pipelineStages.length === 10 &&
      sb.pipelineStages.every((s, i) => s === PINNED_STAGES[i]),
    `stages=${JSON.stringify(sb?.pipelineStages)?.slice(0, 120)}`,
  );
  record(
    'searchfull',
    'status stressTest pinned shape (concurrent: 10000)',
    Boolean(
      sb?.stressTest &&
        sb.stressTest.concurrent === 10000 &&
        sb.stressTest.concurrency === 10000 &&
        typeof sb.stressTest.passed === 'boolean',
    ),
    `stressTest=${JSON.stringify({ executed: sb?.stressTest?.executed, concurrent: sb?.stressTest?.concurrent, passed: sb?.stressTest?.passed })}`,
  );

  // The stress console: composition + budget + running state (+ lastRun
  // verdict when a run was recorded — the smoke suite records one).
  const con = await fetchOk(`${API_ORIGIN}/api/search/stress`);
  const cb = tryJson(con.text);
  record('searchfull', 'GET /api/search/stress console → 200', con.res.status === 200, `status=${con.res.status}`);
  record(
    'searchfull',
    'stress console: pinned section composition sums to 11000 (≥ the 10000 headline)',
    Boolean(
      cb?.sections &&
        cb.sections.identical === 1000 &&
        cb.sections.different === 1000 &&
        cb.sections.mixed === 5000 &&
        cb.sections.spam === 2000 &&
        cb.sections.cooldown === 1000 &&
        cb.sections.rateLimit === 1000 &&
        cb.burstTotal === 11000 &&
        cb.concurrency === 10000,
    ),
    `sections=${JSON.stringify(cb?.sections)} burstTotal=${cb?.burstTotal}`,
  );
  record(
    'searchfull',
    'stress console: running state + budget lane exposed',
    typeof cb?.running === 'boolean' && Number.isFinite(cb?.budgetMs) && cb.budgetMs >= 2000,
    `running=${cb?.running} budgetMs=${cb?.budgetMs}`,
  );
  if (cb?.lastRun) {
    record(
      'searchfull',
      'stress console: lastRun verdict + all-answered contract',
      Boolean(
        typeof cb.lastRun.passed === 'boolean' &&
          cb.lastRun.requests?.total === 11000 &&
          cb.lastRun.requests?.answered === cb.lastRun.requests.total &&
          cb.lastRun.requests?.errors === 0 &&
          Array.isArray(cb.lastRun.assertions) &&
          cb.lastRun.assertions.length >= 20,
      ),
      `passed=${cb.lastRun.passed} answered=${cb.lastRun.requests?.answered}/${cb.lastRun.requests?.total} assertions=${cb.lastRun.assertions?.length}`,
    );
    record(
      'searchfull',
      'stress console: 10M projection with the 7 verdicts',
      Boolean(
        cb.lastRun.projection10M?.realSample?.users === 500 &&
          cb.lastRun.projection10M?.verdicts &&
          Object.values(cb.lastRun.projection10M.verdicts).every(Boolean),
      ),
      `sample=${JSON.stringify(cb.lastRun.projection10M?.realSample)?.slice(0, 100)}`,
    );
  } else {
    record(
      'searchfull',
      'stress console: no run yet — honest executed: false state',
      cb?.lastRun === null,
      'lastRun=null (POST /api/search/stress records one)',
    );
  }

  // POST /stress is admin-gated: anonymous → 401 (never 500).
  const post = await fetchOk(`${API_ORIGIN}/api/search/stress`, { method: 'POST' });
  record(
    'searchfull',
    'POST /api/search/stress anonymous → 401 (admin-gated trigger)',
    post.res.status === 401,
    `status=${post.res.status}`,
  );

  // The FAZA 18 metrics: the searchstress collector in Prometheus text +
  // the 11 spec monitoring series from FAZA 15-17 all present.
  const met = await fetchOk(`${API_ORIGIN}/api/metrics`);
  const stressSeries = [
    'animaxia_search_pipeline_integrated',
    'animaxia_search_pipeline_stages',
    'animaxia_search_stress_passed',
    'animaxia_search_stress_concurrency',
    'animaxia_search_stress_reduction_factor',
  ];
  const missingStress = stressSeries.filter((s) => !met.text.includes(`${s} `));
  record(
    'searchfull',
    'metrics: FAZA 18 searchstress series present (5/5)',
    missingStress.length === 0,
    missingStress.length === 0 ? stressSeries.join(', ') : `missing: ${missingStress.join(', ')}`,
  );
  const specSeries = [
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
  const missingSpec = specSeries.filter((s) => !met.text.includes(`${s} `));
  record(
    'searchfull',
    'metrics: the 11 spec monitoring series present (FAZA 15+16+17)',
    missingSpec.length === 0,
    missingSpec.length === 0 ? 'all 11 present' : `missing: ${missingSpec.join(', ')}`,
  );
  const metJson = await fetchOk(`${API_ORIGIN}/api/metrics?format=json`);
  const mj = tryJson(metJson.text);
  record(
    'searchfull',
    'metrics JSON: collectors.searchstress exposed',
    Boolean(mj?.collectors?.searchstress && typeof mj.collectors.searchstress.pipelineIntegrated === 'number'),
    `searchstress=${JSON.stringify(mj?.collectors?.searchstress)?.slice(0, 110)}`,
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
    ['global30b', suiteGlobal30b], // FAZA 14: global 30B feed + external player conformance
    ['searchflow', suiteSearchflow], // FAZA 15: search flow control (queue + priority + windowing)
    ['searchrate', suiteSearchrate], // FAZA 16: search rate management (rate-limit + cooldown + anti-spam)
    ['searchopt', suiteSearchopt], // FAZA 17: search optimization (dedup + batching + cache)
    ['searchfull', suiteSearchfull], // FAZA 18: full integration + stress verdict contracts
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
