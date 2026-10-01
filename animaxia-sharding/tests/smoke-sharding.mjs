#!/usr/bin/env bun
/**
 * animaxia-sharding/tests/smoke-sharding.mjs — FAZA 13 sharding smoke suite.
 *
 * Live end-to-end checks against the Animaxia monolith (:4000) covering the
 * whole FAZA 13 sharding surface:
 *   A. Infra & model        — /api/shards composite status (model, schema, pools)
 *   B. Shard stamping       — content upsert → shardid stamp → hinted reads → cleanup
 *     (TS1: POST /api/content + DELETE now need auth — B1/B6 use the
 *      documented admin account, env ADMINEMAIL/ADMINPASSWORD)
 *   C. Search cluster       — fan-out, targeted routing, offset cap, legacy keyset hop
 *   D. Vector cluster       — pgvector search through the cluster + ops counters
 *   E. Health & metrics     — /api/shards/health + Prometheus shard/cluster gauges
 *   F. Ops snapshots        — cluster ops counters increment under load
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

/* TS1 (security): content mutations require auth (POST: user, DELETE: admin)
 * — login with the documented admin account, env-overridable (same
 * convention as tests/stress-pipeline.mjs). */
const ADMIN_EMAIL = process.env.ADMINEMAIL || 'admin@animaxia.test';
const ADMIN_PASSWORD = process.env.ADMINPASSWORD || 'SuperSecret1';
const authLogin = await post('/api/auth/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
if (authLogin.res.status !== 200 || !authLogin.json?.accessToken) {
  console.error(`SETUP FAILED: admin login as ${ADMIN_EMAIL} → ${authLogin.res.status} (set ADMINEMAIL/ADMINPASSWORD)`);
  process.exit(1);
}
const authHeaders = { authorization: `Bearer ${authLogin.json.accessToken}` };

const STAMP_ID = `shard-smoke-${Date.now()}`;
const created = await post('/api/content', {
  externalid: STAMP_ID,
  title: 'Sharding smoke test row',
  type: 'video',
  metadata: { smoke: true },
}, authHeaders);
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

const del = await fetch(`${API_ORIGIN}/api/content/${rowId}`, { method: 'DELETE', headers: authHeaders, signal: AbortSignal.timeout(15000) });
const delJson = await del.json().catch(() => null);
record('B6 DELETE test row → ok (cleanup)', del.status === 200 && delJson?.ok === true, `status=${del.status}`);

/* -------------------------------------------------------- C. search cluster -- */

console.log('── C. Search cluster (FTS fan-out + legacy keyset) ──');

const s1 = await get('/api/search/advanced?q=the&limit=5');
record('C1 cluster query → 200', s1.res.status === 200 && s1.json?.engine === 'animaxia-neon-fts', `status=${s1.res.status}`);
const clusterNodes = Array.isArray(s1.json?.cluster?.nodes) ? s1.json.cluster.nodes : [];
record('C2 cluster.fanout "all" with one node per shard', s1.json?.cluster?.fanout === 'all' && clusterNodes.length === shardcount, `fanout=${s1.json?.cluster?.fanout} nodes=${clusterNodes.length}`);
const hitsSum = clusterNodes.reduce((a, n) => a + (Number(n.hits) || 0), 0);
record('C3 per-node hits sum === total', Number(s1.json?.total) === hitsSum, `total=${s1.json?.total} sum=${hitsSum}`);

const s2 = await get('/api/search/advanced?q=the&limit=5', { 'x-animaxia-shard': '0' });
record(
  'C4 shard header → targeted fan-out on shard 0',
  s2.res.status === 200 && s2.json?.cluster?.fanout === 'targeted' && s2.json?.cluster?.nodes?.[0]?.shardid === 0,
  `fanout=${s2.json?.cluster?.fanout}`,
);

const capped = await get('/api/search/advanced?q=the&page=600&limit=20');
record(
  'C5 offset cap mirror (page*limit > 10000 → 400 useCursor)',
  capped.res.status === 400 && capped.json?.useCursor === true,
  `status=${capped.res.status}`,
);

const badCursor = await get('/api/search/advanced?q=the&limit=2&cursor=not-a-cursor');
record(
  'C6 cursor param routes to the legacy keyset path (invalid → 400, no cluster field)',
  badCursor.res.status === 400 && badCursor.json?.error === 'Invalid cursor' && badCursor.json?.cluster === undefined,
  `status=${badCursor.res.status} cluster=${'cluster' in (badCursor.json || {})}`,
);

// Craft a valid title-sort cursor from the first row of a fresh cluster query,
// then hop one page through the legacy keyset implementation.
const base = await get('/api/search/advanced?q=the&sort=title&limit=2');
const firstRow = base.json?.data?.[0];
const cursorText = firstRow ? b64url({ t: firstRow.title, id: Number(firstRow.id), p: 1 }) : '';
const hop = firstRow ? await get(`/api/search/advanced?q=the&sort=title&limit=2&cursor=${cursorText}`) : null;
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

/* ------------------------------------------------------------------ summary -- */

console.log('');
console.log(`SHARDING SMOKE: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('Failures:');
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
process.exit(0);
