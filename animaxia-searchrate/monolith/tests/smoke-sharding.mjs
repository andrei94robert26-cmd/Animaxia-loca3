#!/usr/bin/env bun
/**
 * animaxia-sharding/tests/smoke-sharding.mjs — FAZA 13 sharding smoke suite
 * + FAZA 14 (Task 14-3) conformance section.
 *
 * Live end-to-end checks against the Animaxia monolith (:4000) covering the
 * whole FAZA 13 sharding surface + the FAZA 14 definitive 30B-logical spec:
 *   A. Infra & model        — /api/shards composite status (model, schema, pools)
 *                             + FAZA 14: 30×1B topology & logical 30B space
 *   B. Shard stamping       — content upsert → shardid stamp → hinted reads → cleanup
 *   C. Search cluster       — fan-out, targeted routing, offset cap, legacy keyset hop
 *                             + FAZA 14: coalesced-logical execution marker
 *   D. Vector cluster       — pgvector search through the cluster + ops counters
 *   E. Health & metrics     — /api/shards/health + Prometheus shard/cluster gauges
 *   F. Ops snapshots        — cluster ops counters increment under load
 *   G. FAZA 14 conformance  — the GLOBAL 30B FEED (real overlay + O(1) deep
 *                             pages + shard ranges), the universal external
 *                             player (no DB dependency) and the logical
 *                             address-space reporting on /api/search.
 *
 * Zero dependencies (bun-native fetch). Exits non-zero on any failure.
 * A byte-identical copy lives at mini-services/animaxia-backend/tests/
 * (package.json "test": "bun tests/smoke-sharding.mjs").
 *
 * Usage:  bun tests/smoke-sharding.mjs       (from animaxia-sharding/ or the monolith)
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
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function get(path, headers = {}) {
  const res = await fetch(`${API_ORIGIN}${path}`, { headers, signal: AbortSignal.timeout(15000) });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* keep null */
  }
  return { res, text, json };
}

async function post(path, body, headers = {}) {
  const res = await fetch(`${API_ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
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

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/* ---------------------------------------------------------------- A. infra -- */

console.log('── A. Infra & model (/api/shards) ──');

const shardsA = await get('/api/shards');
record('A1 GET /api/shards → 200 ok', shardsA.res.status === 200 && shardsA.json?.ok === true, `status=${shardsA.res.status}`);

const shardcount = Number(shardsA.json?.model?.shardcount) || 0;
record('A2 model.shardcount ≥ 1', shardcount >= 1, `shardcount=${shardcount}`);
// FAZA 14 definitive spec: 30 logical shards × 1 billion ids = 30B address space.
record('A7 FAZA 14 topology is 30 shards (30 × 1B)', shardcount === 30, `shardcount=${shardcount}`);
record(
  'A8 FAZA 14 logical address space is 30,000,000,000',
  Number(shardsA.json?.logical?.addressSpace) === 30_000_000_000 && Number(shardsA.json?.logical?.shardSpan) === 1_000_000_000 && Number(shardsA.json?.logical?.shardcount) === shardcount,
  JSON.stringify(shardsA.json?.logical),
);
record(
  'A3 shardid columns on content/searchdocs/vectorembeddings',
  shardsA.json?.schema?.content === true && shardsA.json?.schema?.searchdocs === true && shardsA.json?.schema?.vectorembeddings === true,
  JSON.stringify(shardsA.json?.schema),
);
record(
  'A4 mode is logical or physical',
  shardsA.json?.model?.mode === 'logical' || shardsA.json?.model?.mode === 'physical',
  `mode=${shardsA.json?.model?.mode}`,
);
const pools = Array.isArray(shardsA.json?.pools) ? shardsA.json.pools : [];
record('A5 pool registry has one entry per shard', pools.length === shardcount, `pools=${pools.length} shards=${shardcount}`);
record('A6 every pool connected', pools.length > 0 && pools.every((p) => p.connected === true), JSON.stringify(pools.map((p) => p.connected)));

/* ------------------------------------------------------- B. stamp & reads -- */

console.log('── B. Shard stamping & hinted reads ──');

const STAMP_ID = `shard-smoke-${Date.now()}`;
const created = await post('/api/content', {
  externalid: STAMP_ID,
  title: 'Sharding smoke test row',
  type: 'video',
  metadata: { smoke: true },
});
record('B1 POST /api/content test row → ok', created.res.status === 200 && created.json?.ok === true, `status=${created.res.status}`);

const rowId = Number(created.json?.record?.id);
record('B2 upserted row has an id', Number.isInteger(rowId) && rowId > 0, `id=${rowId}`);

const plainRead = await get(`/api/content/${rowId}`);
record('B3 GET /api/content/:id (no header) → 200', plainRead.res.status === 200 && plainRead.json?.id === rowId, `status=${plainRead.res.status}`);

const hintedRead = await get(`/api/content/${rowId}`, { 'x-animaxia-shard': '0' });
record(
  'B4 GET with x-animaxia-shard: 0 → 200 identical body',
  hintedRead.res.status === 200 && hintedRead.json?.id === rowId && hintedRead.text === plainRead.text,
  `status=${hintedRead.res.status}`,
);

const bogusRead = await get(`/api/content/${rowId}`, { 'x-animaxia-shard': '99' });
record(
  'B5 GET with out-of-range shard header → 200 (legacy fallback)',
  bogusRead.res.status === 200 && bogusRead.json?.id === rowId,
  `status=${bogusRead.res.status}`,
);

const del = await fetch(`${API_ORIGIN}/api/content/${rowId}`, { method: 'DELETE', signal: AbortSignal.timeout(15000) });
const delJson = await del.json().catch(() => null);
record('B6 DELETE test row → ok (cleanup)', del.status === 200 && delJson?.ok === true, `status=${del.status}`);

/* -------------------------------------------------------- C. search cluster -- */

console.log('── C. Search cluster (FTS fan-out + legacy keyset) ──');

// FAZA 16 adaptation: each search below carries a DISTINCT X-Forwarded-For —
// the FAZA 16 per-user pacing/cooldown legitimately blocks one identity
// searching repeatedly within perUserMs/cooldownMs; every check here is a
// fresh user (the cluster behavior under test is unchanged).
const s1 = await get('/api/search/advanced?q=the&limit=5', { 'X-Forwarded-For': '10.40.0.11' });
record('C1 cluster query → 200', s1.res.status === 200 && s1.json?.engine === 'animaxia-neon-fts', `status=${s1.res.status}`);
const clusterNodes = Array.isArray(s1.json?.cluster?.nodes) ? s1.json.cluster.nodes : [];
record('C2 cluster.fanout "all" with one node per shard', s1.json?.cluster?.fanout === 'all' && clusterNodes.length === shardcount, `fanout=${s1.json?.cluster?.fanout} nodes=${clusterNodes.length}`);
const hitsSum = clusterNodes.reduce((a, n) => a + (Number(n.hits) || 0), 0);
record('C3 per-node hits sum === total', Number(s1.json?.total) === hitsSum, `total=${s1.json?.total} sum=${hitsSum}`);

const s2 = await get('/api/search/advanced?q=the&limit=5', { 'x-animaxia-shard': '0', 'X-Forwarded-For': '10.40.0.12' });
record(
  'C4 shard header → targeted fan-out on shard 0',
  s2.res.status === 200 && s2.json?.cluster?.fanout === 'targeted' && s2.json?.cluster?.nodes?.[0]?.shardid === 0,
  `fanout=${s2.json?.cluster?.fanout}`,
);

// FAZA 14: in logical mode the cluster executes ONE merged query
// (coalesced-logical); in physical mode it fans out per node.
record(
  'C8 FAZA 14 cluster.execution matches the deployment mode',
  s1.json?.cluster?.execution === (shardsA.json?.model?.mode === 'logical' ? 'coalesced-logical' : 'fanout'),
  `execution=${s1.json?.cluster?.execution} mode=${shardsA.json?.model?.mode}`,
);

const capped = await get('/api/search/advanced?q=the&page=600&limit=20', { 'X-Forwarded-For': '10.40.0.13' });
record(
  'C5 offset cap mirror (page*limit > 10000 → 400 useCursor)',
  capped.res.status === 400 && capped.json?.useCursor === true,
  `status=${capped.res.status}`,
);

const badCursor = await get('/api/search/advanced?q=the&limit=2&cursor=not-a-cursor', { 'X-Forwarded-For': '10.40.0.14' });
record(
  'C6 cursor param routes to the legacy keyset path (invalid → 400, no cluster field)',
  badCursor.res.status === 400 && badCursor.json?.error === 'Invalid cursor' && badCursor.json?.cluster === undefined,
  `status=${badCursor.res.status} cluster=${'cluster' in (badCursor.json || {})}`,
);

// Craft a valid title-sort cursor from the first row of a fresh cluster query,
// then hop one page through the legacy keyset implementation.
const base = await get('/api/search/advanced?q=the&sort=title&limit=2', { 'X-Forwarded-For': '10.40.0.15' });
const firstRow = base.json?.data?.[0];
const cursorText = firstRow ? b64url({ t: firstRow.title, id: Number(firstRow.id), p: 1 }) : '';
const hop = firstRow ? await get(`/api/search/advanced?q=the&sort=title&limit=2&cursor=${cursorText}`, { 'X-Forwarded-For': '10.40.0.16' }) : null;
record(
  'C7 valid cursor → legacy keyset hop (paginationMode cursor, nextCursor chain)',
  !!hop && hop.res.status === 200 && hop.json?.paginationMode === 'cursor' && typeof hop.json?.nextCursor === 'string' && hop.json?.cluster === undefined,
  `status=${hop?.res.status} mode=${hop?.json?.paginationMode}`,
);

/* -------------------------------------------------------- D. vector cluster -- */

console.log('── D. Vector cluster (pgvector via cluster) ──');

const vStatus = await get('/api/vector/status');
record('D1 GET /api/vector/status → 200 healthy', vStatus.res.status === 200 && vStatus.json?.ok !== false, `status=${vStatus.res.status}`);

const before = await get('/api/shards');
const vqBefore = Number(before.json?.ops?.vector?.queries) || 0;
const v1 = await post('/api/vector/search', { query: 'big buck bunny', kind: 'content', topK: 3 });
record(
  'D2 POST /api/vector/search → ok with data',
  v1.res.status === 200 && v1.json?.ok === true && Array.isArray(v1.json?.data) && v1.json.data.length >= 1,
  `status=${v1.res.status} backend=${v1.json?.backend}`,
);
const after = await get('/api/shards');
const vqAfter = Number(after.json?.ops?.vector?.queries) || 0;
record('D3 vector cluster ops counter incremented', vqAfter > vqBefore, `before=${vqBefore} after=${vqAfter}`);
record(
  'D4 vector cluster nodes registered',
  Array.isArray(after.json?.vectorCluster?.nodes) && after.json.vectorCluster.nodes.length === shardcount && after.json.vectorCluster.healthy === true,
  `nodes=${after.json?.vectorCluster?.nodes?.length}`,
);

/* -------------------------------------------------------- E. health & metrics -- */

console.log('── E. Health & metrics ──');

const h = await get('/api/shards/health');
const hShards = Array.isArray(h.json?.shards) ? h.json.shards : [];
record('E1 GET /api/shards/health → ok', h.res.status === 200 && h.json?.ok === true, `status=${h.res.status}`);
record('E2 every shard status "healthy"', hShards.length === shardcount && hShards.every((s) => s.status === 'healthy'), JSON.stringify(hShards.map((s) => s.status)));

const m = await get('/api/metrics');
const mtext = m.text;
record('E3 animaxia_db_shard_pool_total{shard="0"} present', mtext.includes('animaxia_db_shard_pool_total{shard="0"'), 'missing shard pool gauge');
record('E4 animaxia_search_cluster_enabled 1', /animaxia_search_cluster_enabled 1/.test(mtext), 'search cluster not enabled in metrics');
record('E5 animaxia_vector_cluster_node_healthy{shard="0"} present', mtext.includes('animaxia_vector_cluster_node_healthy{shard="0"'), 'missing vector node gauge');
record('E6 FAZA 9 legacy animaxia_db_pool_total still exported', /animaxia_db_pool_total \d+/.test(mtext), 'legacy db pool gauge missing');

/* ---------------------------------------------------------- F. ops snapshot -- */

console.log('── F. Ops snapshots ──');

const fin = await get('/api/shards');
record('F1 search cluster ops queries > 0', Number(fin.json?.ops?.search?.queries) > 0, `queries=${fin.json?.ops?.search?.queries}`);
record(
  'F2 search cluster nodes healthy === total',
  Number(fin.json?.ops?.search?.nodesHealthy) === Number(fin.json?.ops?.search?.nodesTotal) && Number(fin.json?.ops?.search?.nodesTotal) === shardcount,
  `${fin.json?.ops?.search?.nodesHealthy}/${fin.json?.ops?.search?.nodesTotal}`,
);

/* --------------------------------------------- G. FAZA 14 conformance (30B) -- */

console.log('── G. FAZA 14: global 30B feed + external player + logical space ──');

const fg = await get('/api/platform/feed/global?limit=20');
record(
  'G1 GET /api/platform/feed/global → 200, engine animaxia-global-30b, addressSpace 30B',
  fg.res.status === 200 && fg.json?.engine === 'animaxia-global-30b' && Number(fg.json?.addressSpace) === 30_000_000_000,
  `status=${fg.res.status} engine=${fg.json?.engine} addressSpace=${fg.json?.addressSpace}`,
);
const fgItems = Array.isArray(fg.json?.items) ? fg.json.items : [];
record(
  'G2 every item flagged virtual XOR real with a valid shardid',
  fgItems.length === 20 && fgItems.every((i) => (i.virtual === true) !== (i.real === true) && Number.isInteger(i.shardid) && i.shardid >= 0 && i.shardid < shardcount),
  `items=${fgItems.length}`,
);
const fgReal = Number(fg.json?.stats?.realCount) || 0;
record(
  'G3 real overlay: real rows surface at their own ids (page 1)',
  Number(fg.json?.stats?.realInPage) + Number(fg.json?.stats?.virtualInPage) === fgItems.length && (fgReal === 0 || Number(fg.json?.stats?.realInPage) >= 1) && fgItems.some((i) => i.real === true && typeof i.title === 'string' && i.title.length > 0),
  `realCount=${fgReal} realInPage=${fg.json?.stats?.realInPage}`,
);
const perShard = Array.isArray(fg.json?.stats?.perShard) ? fg.json.stats.perShard : [];
record(
  'G4 stats.perShard covers every shard and sums to realCount',
  perShard.length === shardcount && perShard.reduce((a, s) => a + (Number(s.real) || 0), 0) === fgReal,
  `perShard=${perShard.length} realCount=${fgReal}`,
);

// O(1) deep page proof: the very last window of the 30B space.
const deepCursor = b64url({ i: 29_999_999_980, s: 'animaxia' });
const deep = await get(`/api/platform/feed/global?cursor=${deepCursor}&limit=20`);
record(
  'G5 O(1) deep page at 29,999,999,980 → 200 in < 2s, ends the space',
  deep.res.status === 200 && Array.isArray(deep.json?.items) && deep.json.items.length === 20 && Number(deep.json?.tookMs) < 2000 && Number(deep.json?.items?.[19]?.id) === 29_999_999_999 && deep.json?.nextCursor === null,
  `status=${deep.res.status} tookMs=${deep.json?.tookMs}`,
);
record(
  'G6 last page sits on shard 29 (range rule floor(id/1B))',
  deep.json?.items?.every((i) => i.shardid === 29),
  `shardids=${[...new Set((deep.json?.items || []).map((i) => i.shardid))]}`,
);

const sFilter = await get('/api/platform/feed/global?shard=29&limit=5');
record(
  'G7 ?shard=29 serves only shard 29 ids ([29B, 30B))',
  sFilter.res.status === 200 && Array.isArray(sFilter.json?.items) && sFilter.json.items.length === 5 && sFilter.json.items.every((i) => i.shardid === 29 && i.id >= 29_000_000_000 && i.id < 30_000_000_000),
  `status=${sFilter.res.status}`,
);
const sBad = await get('/api/platform/feed/global?shard=30');
record('G8 ?shard=30 (out of range) → 400', sBad.res.status === 400, `status=${sBad.res.status}`);

// Universal external player — ZERO DB dependency (definitive spec rule 4).
const PY = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const pv = await get(`/api/player/external?url=${encodeURIComponent(PY)}`);
record(
  'G9 player external: YouTube watch URL → youtube embed',
  pv.res.status === 200 && pv.json?.ok === true && pv.json?.type === 'youtube' && pv.json?.embedUrl === 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ' && pv.json?.contentFree === true,
  `status=${pv.res.status} type=${pv.json?.type}`,
);
const pvv = await get(`/api/player/external?url=${encodeURIComponent('https://vimeo.com/76979871')}`);
const pvr = await get(`/api/player/external?url=${encodeURIComponent('https://rumble.com/embed/vabcde/x1y2z3.html')}`);
const pvm = await get(`/api/player/external?url=${encodeURIComponent('https://cdn.example.net/video/master.m3u8')}`);
record(
  'G10 player external: vimeo / rumble / m3u8 all resolve',
  pvv.json?.type === 'vimeo' && pvv.json?.embedUrl === 'https://player.vimeo.com/video/76979871' && pvr.json?.type === 'rumble' && pvm.json?.type === 'm3u8',
  `vimeo=${pvv.json?.type} rumble=${pvr.json?.type} m3u8=${pvm.json?.type}`,
);
const ssrf = await get('/api/player/external?url=http%3A%2F%2F127.0.0.1%2Fx');
record(
  'G11 player external: private network URL blocked (SSRF guard)',
  ssrf.res.status === 400 && ssrf.json?.ok === false,
  `status=${ssrf.res.status}`,
);

// Logical address-space reporting on /api/search (cluster covers the 30B space).
const st = await get('/api/search/status');
record(
  'G12 /api/search/status logical.addressSpace === 30B (30 × 1B)',
  Number(st.json?.logical?.addressSpace) === 30_000_000_000 && Number(st.json?.logical?.shardcount) === 30 && Number(st.json?.logical?.shardSpan) === 1_000_000_000,
  JSON.stringify(st.json?.logical),
);
record(
  'G13 /advanced (cluster path) carries the logical field',
  Number(s1.json?.logical?.addressSpace) === 30_000_000_000,
  JSON.stringify(s1.json?.logical),
);

/* ------------------------------------------------------------------ summary -- */

console.log('');
console.log(`SHARDING SMOKE: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('Failures:');
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
process.exit(0);
