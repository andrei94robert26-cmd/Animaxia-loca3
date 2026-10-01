#!/usr/bin/env bun
/**
 * animaxia-backend/tests/smoke-hubs.mjs — FAZA 20 (Hub-uri API) live smoke
 * suite (Task 20-2, backend QA).
 *
 * End-to-end checks against the Animaxia monolith (:4000) covering the whole
 * FAZA 20 hub surface (modules/hub/hub.js, mounted at /api/hub with the 60s
 * cache middleware — 9 public routes, real Neon aggregates):
 *   A. /content   — faceted browse: shape {data,page,limit,total,totalPages,
 *      facets{types,genres,years}}, data.length ≤ limit, facets populated
 *      (movie count > 0, genres/years {value,count}), type=movie filter
 *      consistency at limit=48, genre filter containment (metadata.genres),
 *      q=dune ILIKE hit, sort=rating descending (first 3 non-null), strict
 *      400s (limit=100 / page=0 / sort=invalid), page=999 → 200 empty data,
 *      and the 60s HTTP cache (X-Cache: MISS → HIT on the second identical
 *      call — the backend DOES expose X-Cache, so the check is real, not
 *      skipped; a unique ignored `qa=` param guarantees a fresh cache key)
 *   B. /stats     — totals (content ≥ 100, users > 0, byType object),
 *      engagement (topWatched ≤ 5 with id+title, topRated, mostLiked),
 *      recency counters ≥ 0, FAZA 19 playlists ≥ 1 / playlistItems ≥ 2,
 *      generatedAt valid ISO
 *   C. /scale     — real.contentItems === stats.totals.content (INTERNAL
 *      CONSISTENCY — both re-fetched back-to-back with cache-busting `qa=`
 *      keys so the two SQL aggregates are computed within ~100ms of each
 *      other), shards 30 + shardMode 'logical', searchDocs > 0, player
 *      allowedTypes mp4+youtube, pipelineIntegrated true (live FAZA 18
 *      source), capacityClaim '30000000000' + non-empty note
 *   D. facet hubs — /years {year,count,sample≤3} sorted desc, /genres sorted
 *      count desc, /actors + /studios arrays, limit validation
 *      (?limit=1 → 1 elem, ?limit=0 → 400, ?limit=500 → 400), cross-check
 *      /genres count === /content?genre=<same> total (±2 tolerance — cache
 *      TTL 60s vs. fresh SQL timing documented below), ≥ 1 actor count ≥ 1
 *   E. /feed +    — 3 sources (recent/popular/rated) with id+label+data ≤ 12,
 *      /recommendations exactly 12 rows, all with finite id, all DISTINCT
 *   F. Regresii   — /api/search/status (pipelineIntegrated + 10 stages —
 *      FAZA 15–18 intact), /api/health (ok + db.connected),
 *      /api/playerhub/status (hub playerhub 19.1 — FAZA 19 intact)
 *
 * Zero dependencies (bun-native fetch). Exits non-zero on any failure.
 *
 * Rotating X-Forwarded-For identities (10.80.x.y, unique per request) keep
 * the GLOBAL rate limiter (120 req / 60s per client IP) out of the way —
 * the whole suite (~30 requests) stays far below any per-IP budget.
 *
 * Cache-timing notes (60s TTL on /api/hub/*):
 *   - C1 busts the cache on BOTH /stats and /scale with fresh `qa=` keys so
 *     the internal consistency check compares two back-to-back aggregates,
 *     not a fresh one against a ≤ 60s stale one.
 *   - D6 compares the /genres aggregate against /content?genre= total with a
 *     documented ±2 tolerance (both are fresh in-suite, but a background
 *     writer could land between the two queries; the tolerance absorbs it).
 *
 * Usage:  bun tests/smoke-hubs.mjs       (from the monolith)
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
    failures.push(name);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/* Rotating simulated client IP (10.80.x.y) for EVERY request the suite
 * makes — the GLOBAL rate limiter (120 req / 60s per client IP) would
 * otherwise exhaust the shared 127.0.0.1 budget when QA suites run
 * back-to-back. Each call gets its own identity. */
let callSeq = 0;
function qaXff() {
  callSeq += 1;
  return `10.80.${Math.floor(callSeq / 250) % 250}.${(callSeq % 250) + 1}`;
}

async function request(method, path, { body, headers = {}, timeoutMs = 30000 } = {}) {
  return fetch(`${API_ORIGIN}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      'X-Forwarded-For': qaXff(),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

async function getJson(path, timeoutMs = 30000) {
  const res = await request('GET', path, { timeoutMs });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

/** GET returning the response headers too (for the X-Cache cache check). */
async function getWithHeaders(path, timeoutMs = 30000) {
  const res = await request('GET', path, { timeoutMs });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body, header: (name) => res.headers.get(name) };
}

/* ------------------------------------------------------------------ sections -- */

/** A. GET /api/hub/content — the faceted browse (10 checks). */
async function sectionA() {
  console.log('\nA. /api/hub/content — browse faceted (10 checks)');
  const c = await getJson('/api/hub/content');

  const shapeOk =
    c.status === 200 &&
    Array.isArray(c.body?.data) &&
    Number.isFinite(c.body?.page) &&
    Number.isFinite(c.body?.limit) &&
    Number.isFinite(c.body?.total) &&
    Number.isFinite(c.body?.totalPages) &&
    Boolean(c.body?.facets) &&
    Array.isArray(c.body.facets.types) &&
    Array.isArray(c.body.facets.genres) &&
    Array.isArray(c.body.facets.years);
  record(
    'GET /api/hub/content → 200 cu shape {data,page,limit,total,totalPages,facets{types,genres,years}}',
    shapeOk,
    `status=${c.status} keys=${Object.keys(c.body || {}).join(',')}`,
  );

  const lenOk =
    Array.isArray(c.body?.data) &&
    c.body.data.length <= c.body.limit &&
    c.body.total >= c.body.data.length;
  record(
    'data.length ≤ limit și total ≥ data.length',
    lenOk,
    `len=${c.body?.data?.length} limit=${c.body?.limit} total=${c.body?.total}`,
  );

  const movieFacet = (c.body?.facets?.types || []).find((t) => t?.value === 'movie');
  const genresFacet = c.body?.facets?.genres || [];
  const yearsFacet = c.body?.facets?.years || [];
  const facetsOk =
    Boolean(movieFacet) &&
    movieFacet.count > 0 &&
    genresFacet.length > 0 &&
    genresFacet.every((g) => typeof g.value === 'string' && Number.isFinite(g.count)) &&
    yearsFacet.length > 0 &&
    yearsFacet.every((y) => Number.isFinite(y.value) && Number.isFinite(y.count));
  record(
    'facets: types conține movie cu count > 0; genres + years non-gol cu {value,count}',
    facetsOk,
    `movie=${movieFacet?.count} genres=${genresFacet.length} years=${yearsFacet.length}`,
  );

  const movies = await getJson('/api/hub/content?type=movie&limit=48');
  const mTotal = movies.body?.total ?? -1;
  const moviesOk =
    movies.status === 200 &&
    Array.isArray(movies.body?.data) &&
    movies.body.data.length > 0 &&
    movies.body.data.every((r) => r?.type === 'movie') &&
    movies.body.data.length === Math.min(48, mTotal) &&
    movies.body.totalPages === Math.ceil(mTotal / 48);
  record(
    'type=movie&limit=48 → toate rândurile movie + total consistent cu len la limit=48',
    moviesOk,
    `len=${movies.body?.data?.length} total=${mTotal} totalPages=${movies.body?.totalPages} (expected ${Math.ceil(mTotal / 48)})`,
  );

  const genre = genresFacet.length > 0 ? genresFacet[0].value : null;
  let genreOk = false;
  let genreDetail = `genre=${genre}`;
  if (genre) {
    const byGenre = await getJson(`/api/hub/content?genre=${encodeURIComponent(genre)}&limit=48`);
    genreOk =
      byGenre.status === 200 &&
      Array.isArray(byGenre.body?.data) &&
      byGenre.body.data.length > 0 &&
      byGenre.body.data.every(
        (r) => Array.isArray(r?.metadata?.genres) && r.metadata.genres.includes(genre),
      );
    genreDetail = `genre=${genre} len=${byGenre.body?.data?.length}`;
  }
  record(
    `genre="${genre}" (din facets) → toate rândurile au genul în metadata.genres`,
    genreOk,
    genreDetail,
  );

  const dune = await getJson('/api/hub/content?q=dune');
  const duneHit = (dune.body?.data || []).some((r) =>
    String(r?.title || '').toLowerCase().includes('dune'),
  );
  record(
    'q=dune → cel puțin 1 rezultat cu titlul conținând "dune" (case-insensitive)',
    dune.status === 200 && Array.isArray(dune.body?.data) && dune.body.data.length > 0 && duneHit,
    `status=${dune.status} len=${dune.body?.data?.length} hit=${duneHit}`,
  );

  const rated = await getJson('/api/hub/content?sort=rating&limit=48');
  const ratings = (rated.body?.data || [])
    .map((r) => r?.metadata?.rating)
    .filter((v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)))
    .map((v) => Number(v));
  const top3 = ratings.slice(0, 3);
  const ratingOk =
    rated.status === 200 && top3.length === 3 && top3[0] >= top3[1] && top3[1] >= top3[2];
  record(
    'sort=rating → rating-urile descrescătoare (primele 3 non-null)',
    ratingOk,
    `top3=${JSON.stringify(top3)}`,
  );

  const badLimit = await getJson('/api/hub/content?limit=100');
  const badPage = await getJson('/api/hub/content?page=0');
  const badSort = await getJson('/api/hub/content?sort=invalid');
  record(
    'validare strictă: limit=100 → 400, page=0 → 400, sort=invalid → 400',
    badLimit.status === 400 && badPage.status === 400 && badSort.status === 400,
    `limit100=${badLimit.status} page0=${badPage.status} sortInvalid=${badSort.status}`,
  );

  const farPage = await getJson('/api/hub/content?page=999');
  record(
    'page=999 (peste totalPages) → 200 cu data goală',
    farPage.status === 200 && Array.isArray(farPage.body?.data) && farPage.body.data.length === 0,
    `status=${farPage.status} len=${farPage.body?.data?.length}`,
  );

  /* Cache check — the backend DOES expose X-Cache (cache.js sets HIT/MISS),
   * so this is a real check, no skip needed. The `qa=` param is ignored by
   * the handler but is part of the cache key (req.originalUrl), so the key
   * is guaranteed fresh for this run: call 1 = MISS, call 2 = HIT. */
  const cacheStamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
  const cachePath = `/api/hub/content?limit=17&sort=title&qa=${cacheStamp}`;
  const c1 = await getWithHeaders(cachePath);
  const c2 = await getWithHeaders(cachePath);
  const first = (c1.header('x-cache') || '').toUpperCase();
  const second = (c2.header('x-cache') || '').toUpperCase();
  record(
    'cache 60s: al doilea apel identic → header X-Cache: HIT (primul MISS)',
    c1.status === 200 && c2.status === 200 && first === 'MISS' && second === 'HIT',
    `first=${first || 'lipsă'} second=${second || 'lipsă'}`,
  );
}

/** B. GET /api/hub/stats — public platform statistics (5 checks). */
async function sectionB() {
  console.log('\nB. /api/hub/stats — statistici platformă (5 checks)');
  const st = await getJson('/api/hub/stats');
  const totals = st.body?.totals;
  const totalsOk =
    st.status === 200 &&
    Boolean(totals) &&
    Number.isFinite(totals?.content) &&
    totals.content >= 100 &&
    Number.isFinite(totals?.users) &&
    totals.users > 0 &&
    Boolean(totals?.byType) &&
    typeof totals.byType === 'object' &&
    Object.keys(totals.byType).length > 0;
  record(
    'GET /api/hub/stats → 200 + totals {content ≥ 100, users > 0, byType object}',
    totalsOk,
    `status=${st.status} content=${totals?.content} users=${totals?.users} byType=${Object.keys(totals?.byType || {}).length}`,
  );

  const eng = st.body?.engagement || {};
  const topWatched = eng.topWatched;
  const engOk =
    Array.isArray(topWatched) &&
    topWatched.length <= 5 &&
    topWatched.length > 0 &&
    topWatched.every((r) => Number.isFinite(r?.id) && typeof r?.title === 'string' && r.title.length > 0) &&
    Array.isArray(eng.topRated) &&
    eng.topRated.length > 0 &&
    eng.topRated.every((r) => Number.isFinite(r?.id) && typeof r?.title === 'string') &&
    Array.isArray(eng.mostLiked) &&
    eng.mostLiked.every((r) => Number.isFinite(r?.id) && typeof r?.title === 'string');
  record(
    'engagement: topWatched ≤ 5 (id+title), topRated + mostLiked array-uri cu id+title',
    engOk,
    `topWatched=${Array.isArray(topWatched) ? topWatched.length : 'not-array'} topRated=${Array.isArray(eng.topRated) ? eng.topRated.length : 'not-array'} mostLiked=${Array.isArray(eng.mostLiked) ? eng.mostLiked.length : 'not-array'}`,
  );

  const rec = st.body?.recency || {};
  const recOk =
    Number.isFinite(rec.contentAddedLast7d) &&
    rec.contentAddedLast7d >= 0 &&
    Number.isFinite(rec.activeUsersLast7d) &&
    rec.activeUsersLast7d >= 0;
  record(
    'recency: contentAddedLast7d ≥ 0 și activeUsersLast7d ≥ 0',
    recOk,
    `contentAddedLast7d=${rec.contentAddedLast7d} activeUsersLast7d=${rec.activeUsersLast7d}`,
  );

  const plOk =
    Number.isFinite(totals?.playlists) &&
    totals.playlists >= 1 &&
    Number.isFinite(totals?.playlistItems) &&
    totals.playlistItems >= 2;
  record(
    'totals: playlists ≥ 1 și playlistItems ≥ 2 (playlistul real FAZA 19 există)',
    plOk,
    `playlists=${totals?.playlists} playlistItems=${totals?.playlistItems}`,
  );

  const gen = st.body?.generatedAt;
  const genOk = typeof gen === 'string' && gen.length > 0 && !Number.isNaN(Date.parse(gen));
  record(
    'generatedAt e un timestamp ISO valid',
    genOk,
    `generatedAt=${JSON.stringify(gen)}`,
  );
}

/** C. GET /api/hub/scale — the scale hub: real numbers vs the 30B claim
 *  (6 checks). /stats and /scale are BOTH re-fetched back-to-back with
 *  cache-busting `qa=` keys (ignored by the handlers, part of the cache key)
 *  so the internal consistency check compares two fresh aggregates. */
async function sectionC() {
  console.log('\nC. /api/hub/scale — hub de scară real + 30B (6 checks)');
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
  const [scale, stats] = await Promise.all([
    getJson(`/api/hub/scale?qa=${stamp}`),
    getJson(`/api/hub/stats?qa=${stamp}`),
  ]);
  const real = scale.body?.real;
  const statsContent = stats.body?.totals?.content;

  const c1Ok =
    scale.status === 200 &&
    stats.status === 200 &&
    Number.isFinite(real?.contentItems) &&
    Number.isFinite(statsContent) &&
    real.contentItems === statsContent;
  record(
    'real.contentItems === stats.totals.content (consistență internă, ambele proaspete)',
    c1Ok,
    `scale=${real?.contentItems} stats=${statsContent}`,
  );

  record(
    "real.shards === 30 + shardMode 'logical'",
    scale.status === 200 && real?.shards === 30 && real?.shardMode === 'logical',
    `shards=${real?.shards} shardMode=${real?.shardMode}`,
  );

  record(
    'real.searchDocs > 0 (indexul FTS FAZA 15–18 populat)',
    scale.status === 200 && Number.isFinite(real?.searchDocs) && real.searchDocs > 0,
    `searchDocs=${real?.searchDocs}`,
  );

  const allowed = scale.body?.player?.allowedTypes;
  record(
    "player.allowedTypes conține 'mp4' și 'youtube' (politica live a playerului real)",
    scale.status === 200 && Array.isArray(allowed) && allowed.includes('mp4') && allowed.includes('youtube'),
    `allowedTypes=${JSON.stringify(allowed)}`,
  );

  record(
    'search.pipelineIntegrated === true (live, sursa reală /api/search/status)',
    scale.status === 200 && scale.body?.search?.pipelineIntegrated === true,
    `pipelineIntegrated=${scale.body?.search?.pipelineIntegrated}`,
  );

  const view = scale.body?.view;
  record(
    "view.capacityClaim === '30000000000' + notă non-gol",
    scale.status === 200 && view?.capacityClaim === '30000000000' && typeof view?.note === 'string' && view.note.length > 0,
    `capacityClaim=${JSON.stringify(view?.capacityClaim)} note=${JSON.stringify(view?.note)?.slice(0, 60)}`,
  );
}

/** D. The facet hubs — /years, /genres, /actors, /studios (7 checks). */
async function sectionD() {
  console.log('\nD. Hub-uri de facete — years/genres/actors/studios (7 checks)');

  const years = await getJson('/api/hub/years');
  const yData = years.body?.data;
  const yearsOk =
    years.status === 200 &&
    Array.isArray(yData) &&
    yData.length > 0 &&
    yData.every(
      (r) =>
        Number.isFinite(r?.year) &&
        Number.isFinite(r?.count) &&
        Array.isArray(r?.sample) &&
        r.sample.length <= 3,
    ) &&
    yData.every((r, i) => i === 0 || yData[i - 1].year > r.year);
  record(
    '/years → 200 array {year,count,sample≤3} sortat desc după an',
    yearsOk,
    `status=${years.status} len=${Array.isArray(yData) ? yData.length : 'not-array'} primul=${JSON.stringify(yData?.[0])?.slice(0, 90)}`,
  );

  const genres = await getJson('/api/hub/genres');
  const gData = genres.body?.data;
  const genresOk =
    genres.status === 200 &&
    Array.isArray(gData) &&
    gData.length > 0 &&
    gData.every(
      (r) =>
        typeof r?.genre === 'string' &&
        Number.isFinite(r?.count) &&
        Array.isArray(r?.sample) &&
        r.sample.length <= 3,
    ) &&
    gData.every((r, i) => i === 0 || gData[i - 1].count >= r.count);
  record(
    '/genres → 200 sortat după count desc (cu {genre,count,sample})',
    genresOk,
    `status=${genres.status} len=${Array.isArray(gData) ? gData.length : 'not-array'} top=${JSON.stringify(gData?.[0])?.slice(0, 70)}`,
  );

  const actors = await getJson('/api/hub/actors');
  const aData = actors.body?.data;
  record(
    '/actors → 200 array (scurt onest — doar actorii reali din metadata)',
    actors.status === 200 &&
      Array.isArray(aData) &&
      aData.every((r) => typeof r?.actor === 'string' && Number.isFinite(r?.count)),
    `status=${actors.status} len=${Array.isArray(aData) ? aData.length : 'not-array'} coverage=${JSON.stringify(actors.body?.coverage)}`,
  );

  const studios = await getJson('/api/hub/studios');
  const sData = studios.body?.data;
  record(
    '/studios → 200 array ({studio,count,sample})',
    studios.status === 200 &&
      Array.isArray(sData) &&
      sData.every((r) => typeof r?.studio === 'string' && Number.isFinite(r?.count)),
    `status=${studios.status} len=${Array.isArray(sData) ? sData.length : 'not-array'}`,
  );

  const y1 = await getJson('/api/hub/years?limit=1');
  const g0 = await getJson('/api/hub/genres?limit=0');
  const y500 = await getJson('/api/hub/years?limit=500');
  record(
    'limite facete: /years?limit=1 → exact 1 element; /genres?limit=0 → 400; /years?limit=500 → 400',
    y1.status === 200 && Array.isArray(y1.body?.data) && y1.body.data.length === 1 &&
      g0.status === 400 &&
      y500.status === 400,
    `yearsLimit1=${y1.status}/${y1.body?.data?.length} genresLimit0=${g0.status} yearsLimit500=${y500.status}`,
  );

  /* Cross-check with a documented ±2 tolerance: both /genres and
   * /content?genre= aggregate the same live table, but they are two separate
   * SQL round-trips (and separate 60s cache entries) — a background writer
   * landing between them would shift one side by the number of rows added.
   * ±2 absorbs that without weakening the check. */
  const g = Array.isArray(gData) && gData.length > 0 ? gData[0] : null;
  let crossOk = false;
  let crossDetail = 'gen indisponibil';
  if (g) {
    const byGenre = await getJson(`/api/hub/content?genre=${encodeURIComponent(g.genre)}&limit=1`);
    const diff = Math.abs(g.count - (byGenre.body?.total ?? -1));
    crossOk = byGenre.status === 200 && Number.isFinite(byGenre.body?.total) && diff <= 2;
    crossDetail = `/genres ${g.genre}=${g.count} vs /content total=${byGenre.body?.total} (Δ${diff}, toleranță ±2)`;
  }
  record(
    'verificare încrucișată: count-ul genului din /genres === total din /content?genre=<același> (±2)',
    crossOk,
    crossDetail,
  );

  record(
    '/actors conține cel puțin 1 actor cu count ≥ 1 (actorii reali există)',
    actors.status === 200 &&
      Array.isArray(aData) &&
      aData.some((r) => Number.isFinite(r?.count) && r.count >= 1),
    `len=${Array.isArray(aData) ? aData.length : 'not-array'} cuCount=${Array.isArray(aData) ? aData.filter((r) => r.count >= 1).length : 0}`,
  );
}

/** E. GET /api/hub/feed + GET /api/hub/recommendations (4 checks). */
async function sectionE() {
  console.log('\nE. /api/hub/feed + /api/hub/recommendations (4 checks)');

  const feed = await getJson('/api/hub/feed');
  const sources = feed.body?.sources;
  const sourcesOk =
    feed.status === 200 &&
    Array.isArray(sources) &&
    sources.length === 3 &&
    sources.every(
      (s) =>
        typeof s?.id === 'string' &&
        typeof s?.label === 'string' &&
        s.label.length > 0 &&
        Array.isArray(s?.data) &&
        s.data.length >= 1 &&
        s.data.length <= 12 &&
        s.data.every((r) => Number.isFinite(r?.id)),
    );
  record(
    '/feed → 200 cu 3 surse, fiecare cu id + label + data (1..12 rânduri cu id)',
    sourcesOk,
    `status=${feed.status} sources=${Array.isArray(sources) ? sources.map((s) => `${s.id}:${s.data?.length}`).join(', ') : 'not-array'}`,
  );

  const ids = Array.isArray(sources) ? sources.map((s) => s?.id).join(',') : '';
  record(
    'sursele au id-urile recent/popular/rated',
    ids === 'recent,popular,rated',
    `ids=${ids}`,
  );

  const recs = await getJson('/api/hub/recommendations');
  const rData = recs.body?.data;
  const recOk =
    recs.status === 200 &&
    Array.isArray(rData) &&
    rData.length === 12 &&
    rData.every((r) => Number.isFinite(r?.id));
  record(
    '/recommendations → 200 cu exact 12 rânduri, toate cu id',
    recOk,
    `status=${recs.status} len=${Array.isArray(rData) ? rData.length : 'not-array'} strategy=${recs.body?.strategy} fromGenre=${recs.body?.fromGenre}/backfilled=${recs.body?.backfilled}`,
  );

  const distinct = Array.isArray(rData) ? new Set(rData.map((r) => r?.id)).size : 0;
  record(
    '/recommendations: toate cele 12 id-uri distincte (fără duplicate)',
    Array.isArray(rData) && rData.length === 12 && distinct === 12,
    `distincte=${distinct}/12`,
  );
}

/** F. Platform regressions — the golden rules must hold after FAZA 20. */
async function sectionF() {
  console.log('\nF. Regresii de platformă — pipeline FAZA 15–18 + health + Player Hub FAZA 19');

  const search = await getJson('/api/search/status');
  record(
    'regresie: /api/search/status pipelineIntegrated:true + pipelineStages exact 10 (FAZA 15–18 INTACT)',
    search.status === 200 &&
      search.body?.pipelineIntegrated === true &&
      Array.isArray(search.body?.pipelineStages) &&
      search.body.pipelineStages.length === 10,
    `status=${search.status} integrated=${search.body?.pipelineIntegrated} stages=${search.body?.pipelineStages?.length}`,
  );

  const health = await getJson('/api/health');
  record(
    'regresie: /api/health status ok + db.connected:true',
    health.status === 200 && health.body?.status === 'ok' && health.body?.db?.connected === true,
    `status=${health.status} db=${health.body?.db?.connected}`,
  );

  const ph = await getJson('/api/playerhub/status');
  record(
    'regresie: /api/playerhub/status → hub "playerhub" + version "19.1" (FAZA 19 INTACT)',
    ph.status === 200 && ph.body?.hub === 'playerhub' && ph.body?.version === '19.1',
    `status=${ph.status} hub=${ph.body?.hub} version=${ph.body?.version}`,
  );
}

/* ------------------------------------------------------------------ main -- */

async function main() {
  console.log(`FAZA 20 — Hub-uri API smoke (against ${API_ORIGIN})`);

  await sectionA();
  await sectionB();
  await sectionC();
  await sectionD();
  await sectionE();
  await sectionF();

  console.log(`\n────────────────────────────────────────`);
  console.log(`HUBS SMOKE: ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log('failures:');
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('smoke-hubs crashed:', err);
  process.exit(1);
});
