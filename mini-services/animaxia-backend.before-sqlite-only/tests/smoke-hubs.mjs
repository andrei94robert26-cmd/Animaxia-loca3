#!/usr/bin/env bun
/**
 * tests/smoke-hubs.mjs — FAZA 20 (hub) smoke suite: EXACT 35 checks.
 *
 * Live end-to-end checks against the Animaxia monolith (:4000) covering the
 * whole /api/hub surface (9 routes, 100% real Neon data):
 *   A. Routes 1-9         — every hub route answers 200 ok with honest labels
 *   B. Browse filters     — type / genre / year / q reduce or target the set
 *   C. Browse sorts       — rating desc non-increasing, title asc
 *   D. Facets             — coherent with total (own-dimension exclusion)
 *   E. Cache              — MISS → HIT on /browse, /stats, /years (X-Cache)
 *   F. Stats cross-check  — totalItems == /api/health, viewevents, completeness 0-100
 *   G. Scale honesty      — realItems == stats totalItems, capacity designed
 *                          == 10.000.000 (AR10M; fost 30B simulat — eliminat)
 *   H. Years & genres     — non-empty, numeric samples, Δ0 genre cross-check
 *   I. Honest tails       — actors/studios structure, feed 3 sources, rec split, latency
 *
 * Zero dependencies (bun-native fetch). Exits non-zero on any failure.
 *
 * Usage:  bun tests/smoke-hubs.mjs
 * Env:    API_ORIGIN  default http://localhost:4000
 */

const API_ORIGIN = process.env.API_ORIGIN || 'http://localhost:4000';
// Per-run nonce keeps the cache-probe URLs unique (re-runnable within the 60s TTL).
const NONCE = process.env.SMOKENONCE || String(Date.now());

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
  const t0 = performance.now();
  const res = await fetch(`${API_ORIGIN}${path}`, { headers, signal: AbortSignal.timeout(15000) });
  const text = await res.text();
  const ms = performance.now() - t0;
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* keep null */
  }
  return { res, text, json, ms };
}

const routeMs = {}; // route path → measured response time (section A, check 35)

/* ------------------------------------------------- A. routes 1-9 (1..9) --- */

console.log('── A. Hub routes 1-9 (200 + ok + honest labels) ──');

const a1 = await get('/api/hub/browse');
routeMs['/api/hub/browse'] = a1.ms;
record(
  'A1 (1) GET /api/hub/browse → 200 ok, source neon',
  a1.res.status === 200 && a1.json?.ok === true && a1.json?.source === 'neon' && Array.isArray(a1.json?.data),
  `status=${a1.res.status} total=${a1.json?.total}`,
);

const a2 = await get('/api/hub/stats');
routeMs['/api/hub/stats'] = a2.ms;
record(
  'A2 (2) GET /api/hub/stats → 200 ok, source neon, totalItems number',
  a2.res.status === 200 && a2.json?.ok === true && a2.json?.source === 'neon' && Number.isInteger(a2.json?.totalItems),
  `status=${a2.res.status} totalItems=${a2.json?.totalItems}`,
);

const a3 = await get('/api/hub/scale');
routeMs['/api/hub/scale'] = a3.ms;
record(
  'A3 (3) GET /api/hub/scale → 200 ok, real + capacity sections present (AR10M)',
  a3.res.status === 200 && a3.json?.ok === true && a3.json?.real?.totalItems != null && a3.json?.capacity?.designed === 10000000,
  `status=${a3.res.status}`,
);

const a4 = await get('/api/hub/years');
routeMs['/api/hub/years'] = a4.ms;
record(
  'A4 (4) GET /api/hub/years → 200 ok, source neon, data array',
  a4.res.status === 200 && a4.json?.ok === true && a4.json?.source === 'neon' && Array.isArray(a4.json?.data),
  `status=${a4.res.status} years=${a4.json?.total}`,
);

const a5 = await get('/api/hub/genres');
routeMs['/api/hub/genres'] = a5.ms;
record(
  'A5 (5) GET /api/hub/genres → 200 ok, source neon, data array',
  a5.res.status === 200 && a5.json?.ok === true && a5.json?.source === 'neon' && Array.isArray(a5.json?.data),
  `status=${a5.res.status} genres=${a5.json?.total}`,
);

const a6 = await get('/api/hub/actors');
routeMs['/api/hub/actors'] = a6.ms;
record(
  'A6 (6) GET /api/hub/actors → 200 ok, source neon (honest — list may be small)',
  a6.res.status === 200 && a6.json?.ok === true && a6.json?.source === 'neon' && Array.isArray(a6.json?.data),
  `status=${a6.res.status} actors=${a6.json?.total}`,
);

const a7 = await get('/api/hub/studios');
routeMs['/api/hub/studios'] = a7.ms;
record(
  'A7 (7) GET /api/hub/studios → 200 ok, source neon (honest — list may be small)',
  a7.res.status === 200 && a7.json?.ok === true && a7.json?.source === 'neon' && Array.isArray(a7.json?.data),
  `status=${a7.res.status} studios=${a7.json?.total}`,
);

const a8 = await get('/api/hub/feed');
routeMs['/api/hub/feed'] = a8.ms;
record(
  'A8 (8) GET /api/hub/feed → 200 ok, personal/global/ai sections',
  a8.res.status === 200 && a8.json?.ok === true && a8.json?.personal && a8.json?.global && a8.json?.ai && Array.isArray(a8.json?.combined),
  `status=${a8.res.status} combined=${a8.json?.combinedCount}`,
);

const a9 = await get('/api/hub/recommendations');
routeMs['/api/hub/recommendations'] = a9.ms;
record(
  'A9 (9) GET /api/hub/recommendations → 200 ok, split onest, real (AR10M — fost „logical” 30B eliminat)',
  a9.res.status === 200 && a9.json?.ok === true && a9.json?.split === 'onest' && Array.isArray(a9.json?.real?.items),
  `status=${a9.res.status} real=${a9.json?.real?.count}`,
);

/* ------------------------------------------------------ dynamic fixtures --- */

// Real title from the DB (via /api/all, per the FAZA 20 QA recipe).
const all = await get('/api/all?limit=5');
const realTitle = all.json?.data?.[0]?.title || null;
const unfilteredTotal = a1.json?.total ?? 0;
const topYear = a4.json?.data?.[0]?.year ?? null;
const topGenre = a5.json?.data?.[0]?.value ?? null;
const topGenreCount = a5.json?.data?.[0]?.count ?? null;

/* --------------------------------------------- B. browse filters (10..13) --- */

console.log('── B. /browse filters ──');

const b1 = await get('/api/hub/browse?type=movie&facet=false');
record(
  'B1 (10) type=movie reduces total',
  b1.json?.ok === true && b1.json?.total < unfilteredTotal && b1.json?.total > 0 && b1.json?.data?.every((r) => r.type === 'movie'),
  `movie=${b1.json?.total} < all=${unfilteredTotal}`,
);

const b2 = await get(`/api/hub/browse?genre=${encodeURIComponent(topGenre || '')}`);
record(
  `B2 (11) genre=${topGenre} reduces total`,
  b2.json?.ok === true && b2.json?.total < unfilteredTotal && b2.json?.total > 0,
  `genre=${topGenre} → ${b2.json?.total} < ${unfilteredTotal}`,
);

const b3 = await get(`/api/hub/browse?year=${topYear}&facet=false`);
record(
  `B3 (12) year=${topYear} filters the set (all rows match the year)`,
  b3.json?.ok === true && b3.json?.total > 0 && b3.json?.total < unfilteredTotal && b3.json?.data?.every((r) => Number(r.metadata?.year) === Number(topYear)),
  `year=${topYear} → ${b3.json?.total}`,
);

const b4 = await get(`/api/hub/browse?q=${encodeURIComponent(realTitle || '')}&facet=false`);
record(
  `B4 (13) q=<real title "${realTitle}"> finds it`,
  b4.json?.ok === true && b4.json?.total >= 1 && b4.json?.data?.some((r) => r.title?.toLowerCase() === String(realTitle).toLowerCase()),
  `q="${realTitle}" → total=${b4.json?.total}`,
);

/* ------------------------------------------------- C. sorts (14..15) --- */

console.log('── C. /browse sorts ──');

const c1 = await get('/api/hub/browse?sort=rating&limit=100&facet=false');
const c1ratings = (c1.json?.data || []).map((r) => r.metadata?.rating ?? null);
let nonIncreasing = true;
for (let i = 1; i < c1ratings.length; i += 1) {
  if (c1ratings[i - 1] !== null && c1ratings[i] !== null && c1ratings[i] > c1ratings[i - 1]) nonIncreasing = false;
}
record(
  'C1 (14) sort=rating → non-increasing (desc), nulls last',
  c1.json?.ok === true && nonIncreasing && c1ratings.length >= 2,
  `first=${c1ratings[0]} last-non-null=${c1ratings.findLast?.((v) => v !== null) ?? '…'} n=${c1ratings.length}`,
);

const c2 = await get('/api/hub/browse?sort=title&limit=100&facet=false');
const c2titles = (c2.json?.data || []).map((r) => String(r.title || '').toLowerCase());
let ascending = true;
for (let i = 1; i < c2titles.length; i += 1) {
  if (c2titles[i] < c2titles[i - 1]) ascending = false;
}
record(
  'C2 (15) sort=title → lexicographic ascending',
  c2.json?.ok === true && ascending && c2titles.length >= 2,
  `first="${c2titles[0]}" last="${c2titles[c2titles.length - 1]}"`,
);

/* ------------------------------------------------- D. facets (16..18) --- */

console.log('── D. /browse facets (coherent with total) ──');

const d1facets = a1.json?.facets;
const d1sum = (d1facets?.types || []).reduce((acc, t) => acc + Number(t.count), 0);
record(
  'D1 (16) facets present (types/genres/years) + sum(types) == total (unfiltered)',
  Array.isArray(d1facets?.types) && d1facets.types.length > 0 && Array.isArray(d1facets?.genres) && d1facets.genres.length > 0
    && Array.isArray(d1facets?.years) && d1facets.years.length > 0 && d1sum === unfilteredTotal,
  `sum(types)=${d1sum} total=${unfilteredTotal}`,
);

const d2facetGenre = (b2.json?.facets?.genres || []).find((g) => g.value?.toLowerCase() === String(topGenre).toLowerCase());
record(
  `D2 (17) genre=${topGenre} active → its facet count == total (${topGenreCount})`,
  d2facetGenre != null && Number(d2facetGenre.count) === Number(b2.json?.total) && Number(b2.json?.total) === Number(topGenreCount),
  `facet=${d2facetGenre?.count} total=${b2.json?.total} genres-route=${topGenreCount}`,
);

const d3sum = (b2.json?.facets?.types || []).reduce((acc, t) => acc + Number(t.count), 0);
record(
  'D3 (18) genre-filtered set → sum(facets.types) == total (type facet on filtered set)',
  d3sum === Number(b2.json?.total) && (b2.json?.facets?.types || []).length > 0,
  `sum(types)=${d3sum} total=${b2.json?.total}`,
);

/* ------------------------------------------------- E. cache (19..21) --- */

console.log('── E. Cache MISS → HIT (X-Cache header) ──');

const e1a = await get(`/api/hub/browse?limit=3&sort=year&facet=false&cacheprobe=${NONCE}`);
const e1b = await get(`/api/hub/browse?limit=3&sort=year&facet=false&cacheprobe=${NONCE}`);
record(
  'E1 (19) /browse cache: 1st=MISS, 2nd=HIT',
  e1a.res.headers.get('x-cache') === 'MISS' && e1b.res.headers.get('x-cache') === 'HIT',
  `1st=${e1a.res.headers.get('x-cache')} 2nd=${e1b.res.headers.get('x-cache')}`,
);

const e2a = await get(`/api/hub/stats?cacheprobe=${NONCE}`);
const e2b = await get(`/api/hub/stats?cacheprobe=${NONCE}`);
record(
  'E2 (20) /stats cache: 1st=MISS, 2nd=HIT',
  e2a.res.headers.get('x-cache') === 'MISS' && e2b.res.headers.get('x-cache') === 'HIT',
  `1st=${e2a.res.headers.get('x-cache')} 2nd=${e2b.res.headers.get('x-cache')}`,
);

const e3a = await get(`/api/hub/years?cacheprobe=${NONCE}`);
const e3b = await get(`/api/hub/years?cacheprobe=${NONCE}`);
record(
  'E3 (21) /years cache: 1st=MISS, 2nd=HIT',
  e3a.res.headers.get('x-cache') === 'MISS' && e3b.res.headers.get('x-cache') === 'HIT',
  `1st=${e3a.res.headers.get('x-cache')} 2nd=${e3b.res.headers.get('x-cache')}`,
);

/* ------------------------------------------ F. stats cross-checks (22..24) --- */

console.log('── F. /stats cross-checks ──');

const health = await get('/api/health');
record(
  'F1 (22) /stats totalItems == /api/health db.totalItems',
  a2.json?.totalItems === health.json?.db?.totalItems,
  `stats=${a2.json?.totalItems} health=${health.json?.db?.totalItems}`,
);

record(
  'F2 (23) /stats viewevents object present (total + last24h + topViewed)',
  a2.json?.viewevents && Number.isInteger(a2.json.viewevents.total) && Number.isInteger(a2.json.viewevents.last24h)
    && Array.isArray(a2.json.viewevents.topViewed),
  `total=${a2.json?.viewevents?.total} last24h=${a2.json?.viewevents?.last24h} top=${a2.json?.viewevents?.topViewed?.length}`,
);

const comp = a2.json?.metadataCompleteness;
record(
  'F3 (24) metadata completeness is a number 0-100',
  typeof comp === 'number' && comp >= 0 && comp <= 100,
  `completeness=${comp}%`,
);

/* ------------------------------------------------- G. scale (25..26) --- */

console.log('── G. /scale honesty ──');

record(
  'G1 (25) scale.real.totalItems == /stats totalItems',
  a3.json?.real?.totalItems === a2.json?.totalItems,
  `scale=${a3.json?.real?.totalItems} stats=${a2.json?.totalItems}`,
);

record(
  'G2 (26) capacity designed == 10000000 (AR10M — fost 30B simulat, eliminat)',
  a3.json?.capacity?.designed === 10000000,
  `designed=${a3.json?.capacity?.designed} tested=${a3.json?.capacity?.tested}`,
);

/* --------------------------------------------- H. years & genres (27..30) --- */

console.log('── H. /years + /genres + Δ0 cross-check ──');

const yearsData = a4.json?.data || [];
record(
  'H1 (27) /years non-empty + every entry has a sample with numeric id',
  yearsData.length > 0 && yearsData.every((y) => Number.isInteger(y.year) && y.count > 0 && y.sample != null && Number.isInteger(y.sample.id)),
  `years=${yearsData.length} first={year:${yearsData[0]?.year}, sample.id:${yearsData[0]?.sample?.id}}`,
);

record(
  'H2 (28) /years sorted desc by year with positive counts',
  yearsData.every((y, i) => i === 0 || y.year <= yearsData[i - 1].year) && yearsData.every((y) => y.count > 0),
  `top year=${yearsData[0]?.year} (count ${yearsData[0]?.count}), oldest=${yearsData[yearsData.length - 1]?.year}`,
);

const genresData = a5.json?.data || [];
record(
  'H3 (29) /genres non-empty, sorted desc by count, samples numeric',
  genresData.length > 0 && genresData.every((g, i) => i === 0 || g.count <= genresData[i - 1].count)
    && genresData.every((g) => typeof g.value === 'string' && Number.isInteger(g.count) && g.sample != null && Number.isInteger(g.sample.id)),
  `top=${genresData[0]?.value}(${genresData[0]?.count})`,
);

const delta0 = await get(`/api/hub/browse?genre=${encodeURIComponent(topGenre || '')}&limit=1&facet=false`);
record(
  `H4 (30) Δ0: /genres count(${topGenre}) == /browse?genre= total`,
  delta0.json?.total === topGenreCount,
  `genres-route=${topGenreCount} browse=${delta0.json?.total}`,
);

/* --------------------------------------------- I. honest tails (31..35) --- */

console.log('── I. actors / studios / feed / recommendations / latency ──');

const actorsData = a6.json?.data || [];
record(
  'I1 (31) /actors structure: value/count/sample per entry (honest — small list allowed)',
  a6.json?.ok === true && Array.isArray(actorsData) && actorsData.every((x) => typeof x.value === 'string' && Number.isInteger(x.count) && x.sample != null),
  `actors=${actorsData.length} (metadata.actors is sparsely populated — honest)`,
);

const studiosData = a7.json?.data || [];
record(
  'I2 (32) /studios structure: value/count/sample per entry (honest — small list allowed)',
  a7.json?.ok === true && Array.isArray(studiosData) && studiosData.every((x) => typeof x.value === 'string' && Number.isInteger(x.count) && x.sample != null),
  `studios=${studiosData.length}`,
);

record(
  'I3 (33) /feed: 3 sources (personal/global/ai) + combined ≤ 36',
  Array.isArray(a8.json?.personal?.items) && Array.isArray(a8.json?.global?.items) && Array.isArray(a8.json?.ai?.items)
    && a8.json.personal.source && a8.json.global.source && a8.json.ai.source
    && Array.isArray(a8.json?.combined) && a8.json.combined.length <= 36,
  `personal=${a8.json?.personal?.items?.length} global=${a8.json?.global?.items?.length} ai=${a8.json?.ai?.items?.length} combined=${a8.json?.combined?.length}`,
);

const recReal = a9.json?.real?.items || [];
record(
  'I4 (34) /recommendations: real items have criteria (AR10M — fostul „logical” 30B simulat eliminat)',
  recReal.length > 0 && recReal.every((i) => i.criteria === 'trending' || i.criteria === 'top-rated')
    && a9.json?.real?.source === 'neon',
  `real=${recReal.length} (criteria: ${[...new Set(recReal.map((i) => i.criteria))].join('/')})`,
);

const slowest = Object.entries(routeMs).sort((a, b) => b[1] - a[1])[0];
record(
  `I5 (35) all 9 hub routes < 2000ms (slowest: ${slowest[0]} ${Math.round(slowest[1])}ms)`,
  Object.values(routeMs).length === 9 && Object.values(routeMs).every((ms) => ms < 2000),
  Object.entries(routeMs).map(([p, ms]) => `${p}=${Math.round(ms)}ms`).join(' · '),
);

/* -------------------------------------------------------------- summary --- */

console.log('');
console.log(`RESULT: ${passed}/35 PASSED${failed ? `, ${failed} FAILED` : ''}`);
if (failures.length) {
  console.log('Failures:');
  for (const f of failures) console.log(`  ✗ ${f}`);
}
process.exit(failed ? 1 : 0);
