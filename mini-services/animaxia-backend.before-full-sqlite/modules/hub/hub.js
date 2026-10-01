/**
 * modules/hub/hub.js — FAZA 20 → AR10M: public hub API (mounted at /api/hub).
 *
 * 9 routes, 100% real Neon data (zero mock/placeholder — every number is a
 * live SQL measurement; AR10M: fostul spațiu logic 30B simulat a fost
 * eliminat — capacitatea se declară separat în /scale, onest):
 *
 *   GET /browse          → faceted browse: type[]/genre/year(+From/To)/q/
 *                          actor/studio/minRating filters + sort
 *                          (relevance|rating|year|title|recent) + facets
 *                          computed on the filtered set minus each facet's
 *                          own dimension (standard faceted browse).
 *   GET /stats           → public stats: counts by type, metadata completeness
 *                          (CASE WHEN), sources (contentsources registry +
 *                          content providers), viewevents (total/24h/top5),
 *                          users, uptime.
 *   GET /scale           → honest scale report: real Neon numbers (items,
 *                          sources, users, DB size) + AR10M capacity framing
 *                          (designed 10M / tested / benchmarked — proiectată,
 *                          testată, demonstrată, declarate separat).
 *   GET /years           → distinct years + count + best-rated sample per year.
 *   GET /genres          → distinct genres + count + best-rated sample per genre.
 *   GET /actors          → distinct actors (metadata.actors) + count + sample.
 *   GET /studios         → distinct studios (metadata.studios + network) + sample.
 *   GET /feed            → 3-source feed: personal (watchlist+history when
 *                          logged in) / global (activityevents, honest
 *                          viewevents fallback) / ai (top-rated per genre —
 *                          honest 'ai-fallback', the protected AI Home engine
 *                          is not importable) + 1:1:1 interleaved combined.
 *   GET /recommendations → real Neon picks only (trending 7d views +
 *                          top-rated fallback, criteria per item). AR10M:
 *                          fostul „logical" 30B sample simulat — eliminat.
 *
 * All queries are parameterized ($1..$n) through modules/platform/sql.js
 * (same house style as the other platform modules).
 */

import express from 'express';
import { readFileSync } from 'node:fs';
import { rows, one, num, isoOrNull, parseJsonb, assertPostgres } from '../platform/sql.js';
import { shardingModelSnapshot } from '../sharding/model.js'; // pure module (FAZA 13 legacy model)
import { logger } from '../../utils/logger.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* AR10M capacity framing — the same honest source as /api/ar10m/stats: the
 * benchmark state file written by tests/bench-ar10m.mjs (phase 'done' → the
 * row count actually benchmarked; anything else → null, nothing invented).
 * Fostul „logical 30B space” simulat a fost eliminat. */
const CAPACITY_DESIGNED = 10_000_000; // 10M titluri — arhitectura reală 15-shard (modules/ar10m)
const AR10M_BENCH_STATE_FILE = new URL('../../data/ar10m-bench-state.json', import.meta.url);
function ar10mBenchRows() {
  try {
    const state = JSON.parse(readFileSync(AR10M_BENCH_STATE_FILE, 'utf8'));
    if (state?.phase !== 'done') return null;
    const n = Number(state.rowsDone ?? state.rowsTarget);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/* Pagination / facet caps (the only other constants in this module). */
const DEFAULT_PAGE_LIMIT = 24;
const MAX_PAGE_LIMIT = 100;
const FACET_GENRES_CAP = 40;
const FACET_YEARS_CAP = 60;
const YEARS_CAP = 60;
const DIMENSION_SAMPLE_CAP = 100; // actors/studios top-N
const GENRES_LIST_CAP = 80;
const FEED_LIMIT = 12;
const FEED_COMBINED_CAP = 24;
const RECOMMENDATIONS_REAL_LIMIT = 12;
const RECOMMENDATIONS_TRENDING_LIMIT = 6;

/* ------------------------- JSONB helper expressions ------------------------- */
/* Safe JSONB array extraction ('[]' when the key is missing or not an array)
 * and safe numeric casts (regex-guarded — a malformed value degrades to NULL
 * instead of failing the whole query). Same approach as search.js filters. */
const GENRES_ARRAY = `CASE WHEN jsonb_typeof(metadata->'genres') = 'array' THEN metadata->'genres' ELSE '[]'::jsonb END`;
const ACTORS_ARRAY = `CASE WHEN jsonb_typeof(metadata->'actors') = 'array' THEN metadata->'actors' ELSE '[]'::jsonb END`;
const STUDIOS_ARRAY = `CASE WHEN jsonb_typeof(metadata->'studios') = 'array' THEN metadata->'studios' ELSE '[]'::jsonb END`;
const RATING_NUM = `CASE WHEN (metadata->>'rating') ~ '^[0-9]+\\.?[0-9]*$' THEN (metadata->>'rating')::numeric ELSE NULL END`;
const YEAR_INT = `CASE WHEN (metadata->>'year') ~ '^[0-9]+$' THEN (metadata->>'year')::int ELSE NULL END`;

const router = express.Router();

/** Shape a content row exactly like db.js normalizeRow (house contract). */
function contentRow(row) {
  return {
    id: num(row.id),
    externalid: row.externalid ?? null,
    type: row.type ?? null,
    title: row.title ?? null,
    metadata: parseJsonb(row.metadata, {}),
    thumbnail: row.thumbnail ?? null,
    createdat: isoOrNull(row.createdat),
  };
}

/** Parse an int query param (null when absent/malformed). */
function intOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = parseInt(value, 10);
  return Number.isInteger(n) ? n : null;
}

/* ================================ 1. /browse ================================ */

/** Build the parameterized WHERE clause for the browse filters.
 *  `exclude` drops a dimension's clauses — used for facet queries, which are
 *  computed on the filtered set WITHOUT their own dimension (standard
 *  faceted browse: filtering by genre still shows all genre counts). */
function buildBrowseWhere(filters, exclude = new Set()) {
  const clauses = [];
  const params = [];
  const add = (value) => {
    params.push(value);
    return `$${params.length}`;
  };
  if (!exclude.has('type') && filters.types.length) {
    clauses.push(`type IN (SELECT value FROM json_each(${add(JSON.stringify(filters.types))}))`);
  }
  if (!exclude.has('genre') && filters.genre) {
    // Exact case-insensitive match inside metadata.genres[] (ILIKE without wildcards).
    clauses.push(`EXISTS (SELECT 1 FROM json_each(${GENRES_ARRAY}) g WHERE lower(g.value) = lower(${add(filters.genre)}))`);
  }
  if (!exclude.has('year') && (filters.year != null || filters.yearFrom != null || filters.yearTo != null)) {
    clauses.push(`${YEAR_INT} IS NOT NULL`);
    if (filters.year != null) clauses.push(`${YEAR_INT} = ${add(filters.year)}`);
    if (filters.yearFrom != null) clauses.push(`${YEAR_INT} >= ${add(filters.yearFrom)}`);
    if (filters.yearTo != null) clauses.push(`${YEAR_INT} <= ${add(filters.yearTo)}`);
  }
  if (!exclude.has('q') && filters.q) {
    clauses.push(`lower(title) LIKE '%' || lower(${add(filters.q)}) || '%'`);
  }
  if (!exclude.has('actor') && filters.actor) {
    clauses.push(`EXISTS (SELECT 1 FROM json_each(${ACTORS_ARRAY}) a WHERE lower(a.value) LIKE '%' || lower(${add(filters.actor)}) || '%')`);
  }
  if (!exclude.has('studio') && filters.studio) {
    clauses.push(`EXISTS (SELECT 1 FROM json_each(${STUDIOS_ARRAY}) st WHERE lower(st.value) LIKE '%' || lower(${add(filters.studio)}) || '%')`);
  }
  if (!exclude.has('minRating') && filters.minRating != null) {
    clauses.push(`${RATING_NUM} >= ${add(filters.minRating)}`);
  }
  return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

/** Build the ORDER BY clause (its params are appended after the WHERE params). */
function buildBrowseOrder(sort, filters, startIdx) {
  const params = [];
  const add = (value) => {
    params.push(value);
    return `$${startIdx + params.length}`;
  };
  let sql;
  if (sort === 'rating') {
    sql = `ORDER BY ${RATING_NUM} DESC NULLS LAST, id ASC`;
  } else if (sort === 'year') {
    sql = `ORDER BY ${YEAR_INT} DESC NULLS LAST, id ASC`;
  } else if (sort === 'title') {
    sql = `ORDER BY title ASC, id ASC`;
  } else if (sort === 'relevance' && filters.q) {
    // Prefix hits outrank infix hits; ties break on recency (deterministic).
    const q1 = add(filters.q);
    const q2 = add(filters.q);
    sql = `ORDER BY (CASE WHEN lower(title) LIKE lower(${q1}) || '%' THEN 2 WHEN lower(title) LIKE '%' || lower(${q2}) || '%' THEN 1 ELSE 0 END) DESC, createdat DESC, id ASC`;
  } else {
    sql = `ORDER BY createdat DESC, id DESC`; // 'recent' (default)
  }
  return { sql, params };
}

router.get('/browse', wrap(async (req, res) => {
  assertPostgres();
  const startedAt = Date.now();

  // ---- filter parsing (echoed in the response) ----
  const rawType = req.query.type;
  const typeList = (Array.isArray(rawType) ? rawType.join(',') : String(rawType || ''))
    .split(',').map((s) => s.trim()).filter(Boolean);
  const filters = {
    types: typeList,
    genre: String(req.query.genre || '').trim().slice(0, 120) || null,
    year: intOrNull(req.query.year),
    yearFrom: intOrNull(req.query.yearFrom),
    yearTo: intOrNull(req.query.yearTo),
    q: String(req.query.q || '').trim().slice(0, 120) || null,
    actor: String(req.query.actor || '').trim().slice(0, 120) || null,
    studio: String(req.query.studio || '').trim().slice(0, 120) || null,
    minRating: (() => {
      const v = req.query.minRating;
      if (v === undefined || v === null || v === '') return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    })(),
  };

  const page = Math.max(1, intOrNull(req.query.page) ?? 1);
  const limit = Math.min(MAX_PAGE_LIMIT, Math.max(1, intOrNull(req.query.limit) ?? DEFAULT_PAGE_LIMIT));
  const wantFacets = String(req.query.facet ?? 'true') !== 'false';

  const requestedSort = String(req.query.sort || 'recent');
  const allowedSorts = ['relevance', 'rating', 'year', 'title', 'recent'];
  const sort = allowedSorts.includes(requestedSort) ? requestedSort : 'recent';
  // 'relevance' without a q falls back to 'recent' (nothing to rank on).
  const effectiveSort = sort === 'relevance' && !filters.q ? 'recent' : sort;

  // ---- one parallel round: COUNT + data page + the 3 facet queries ----
  // (facets are computed on the filtered set minus each facet's own dimension)
  const where = buildBrowseWhere(filters);
  const order = buildBrowseOrder(effectiveSort, filters, where.params.length);
  const dataParams = [...where.params, ...order.params, limit, (page - 1) * limit];
  const whereNoType = buildBrowseWhere(filters, new Set(['type']));
  const whereNoGenre = buildBrowseWhere(filters, new Set(['genre']));
  const whereNoYear = buildBrowseWhere(filters, new Set(['year']));
  const queries = [
    one(`SELECT COUNT(*)::int AS total FROM content ${where.sql}`, where.params),
    rows(`SELECT * FROM content ${where.sql} ${order.sql} LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`, dataParams),
  ];
  if (wantFacets) {
    queries.push(
      rows(`SELECT type AS value, COUNT(*)::int AS count FROM content ${whereNoType.sql} GROUP BY type ORDER BY count DESC, value ASC`, whereNoType.params),
      rows(`SELECT g.value AS value, COUNT(DISTINCT content.id)::int AS count
            FROM content, json_each(${GENRES_ARRAY}) AS g
            ${whereNoGenre.sql}
            GROUP BY g.value ORDER BY count DESC, value ASC LIMIT ${FACET_GENRES_CAP}`, whereNoGenre.params),
      rows(`SELECT ${YEAR_INT} AS value, COUNT(*)::int AS count
            FROM content ${whereNoYear.sql ? `${whereNoYear.sql} AND` : 'WHERE'} ${YEAR_INT} IS NOT NULL
            GROUP BY 1 ORDER BY 1 DESC LIMIT ${FACET_YEARS_CAP}`, whereNoYear.params),
    );
  }
  const [countRow, dataRows, typesFacet, genresFacet, yearsFacet] = await Promise.all(queries);
  const total = num(countRow?.total);
  const facets = wantFacets ? { types: typesFacet, genres: genresFacet, years: yearsFacet } : null;

  const filtersEcho = {};
  if (filters.types.length) filtersEcho.types = filters.types;
  if (filters.genre) filtersEcho.genre = filters.genre;
  if (filters.year != null) filtersEcho.year = filters.year;
  if (filters.yearFrom != null) filtersEcho.yearFrom = filters.yearFrom;
  if (filters.yearTo != null) filtersEcho.yearTo = filters.yearTo;
  if (filters.q) filtersEcho.q = filters.q;
  if (filters.actor) filtersEcho.actor = filters.actor;
  if (filters.studio) filtersEcho.studio = filters.studio;
  if (filters.minRating != null) filtersEcho.minRating = filters.minRating;

  res.json({
    ok: true,
    source: 'neon',
    data: dataRows.map(contentRow),
    total,
    page,
    pages: Math.max(1, Math.ceil(total / limit)),
    limit,
    facets,
    sort: effectiveSort,
    sortRequested: sort,
    filters: filtersEcho,
    tookMs: Date.now() - startedAt,
  });
}));

/* ============================ stats collector (shared) ======================= */

/** Live platform stats — shared verbatim by /stats and /scale (no HTTP reuse). */
async function collectHubStats() {
  const [totalRow, byType, completeRow, registryRow, registryByKind, providers, viewsRow, topViewed, usersRow] = await Promise.all([
    one('SELECT COUNT(*)::int AS n FROM content'),
    rows('SELECT type AS value, COUNT(*)::int AS count FROM content GROUP BY type ORDER BY count DESC, value ASC'),
    // Metadata completeness — CASE/FILTER WHEN per field + all three combined (0-100).
    one(`SELECT
           COUNT(*)::int AS rows,
           ROUND(100.0 * COUNT(*) FILTER (WHERE COALESCE(thumbnail, '') <> '') / COUNT(*))::int AS pct_thumbnail,
           ROUND(100.0 * COUNT(*) FILTER (WHERE COALESCE(metadata->>'overview', '') <> '') / COUNT(*))::int AS pct_overview,
           ROUND(100.0 * COUNT(*) FILTER (WHERE jsonb_array_length(${GENRES_ARRAY}) > 0) / COUNT(*))::int AS pct_genres,
           ROUND(100.0 * COUNT(*) FILTER (WHERE COALESCE(thumbnail, '') <> ''
             AND COALESCE(metadata->>'overview', '') <> ''
             AND jsonb_array_length(${GENRES_ARRAY}) > 0) / COUNT(*))::int AS pct_complete
         FROM content`),
    // contentsources registry (structure per modules/ingest/dedup.js — urlhash/url/kind/addedby).
    one('SELECT COUNT(*)::int AS total, COUNT(DISTINCT url)::int AS distinct_urls FROM contentsources'),
    rows('SELECT kind AS value, COUNT(*)::int AS count FROM contentsources GROUP BY kind ORDER BY count DESC'),
    // Ingest provider labels embedded in content metadata (honest supplement —
    // the registry itself is authoritative and may legitimately be empty).
    rows(`SELECT metadata->>'source' AS value, COUNT(*)::int AS count
          FROM content WHERE COALESCE(metadata->>'source', '') <> ''
          GROUP BY metadata->>'source' ORDER BY count DESC, value ASC`),
    one(`SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE createdat > datetime('now','-24 hours'))::int AS last24h
         FROM viewevents`),
    rows(`SELECT c.id, c.title, c.type, c.thumbnail, COUNT(*)::int AS views
          FROM viewevents v JOIN content c ON c.id = v.contentid
          GROUP BY c.id, c.title, c.type, c.thumbnail
          ORDER BY views DESC, c.id ASC LIMIT 5`),
    one('SELECT COUNT(*)::int AS n FROM users'),
  ]);

  const countsByType = {};
  for (const r of byType) countsByType[r.value] = num(r.count);

  return {
    totalItems: num(totalRow?.n),
    countsByType,
    countsByTypeRows: byType.map((r) => ({ value: r.value, count: num(r.count) })),
    completeness: {
      rows: num(completeRow?.rows),
      thumbnailPct: num(completeRow?.pct_thumbnail),
      overviewPct: num(completeRow?.pct_overview),
      genresPct: num(completeRow?.pct_genres),
      completePct: num(completeRow?.pct_complete), // thumbnail+overview+genres all non-empty
    },
    sources: {
      registry: {
        total: num(registryRow?.total),
        distinct: num(registryRow?.distinct_urls),
        byKind: registryByKind.map((r) => ({ value: r.value, count: num(r.count) })),
      },
      providers, // [{value,count}] from content.metadata.source
    },
    viewevents: {
      total: num(viewsRow?.total),
      last24h: num(viewsRow?.last24h),
      topViewed: topViewed.map((r) => ({ id: num(r.id), title: r.title, type: r.type, thumbnail: r.thumbnail, views: num(r.views) })),
    },
    users: num(usersRow?.n),
  };
}

/* 2. GET /stats — public platform stats (live SQL counters). */
router.get('/stats', wrap(async (req, res) => {
  assertPostgres();
  const stats = await collectHubStats();
  res.json({
    ok: true,
    source: 'neon',
    totalItems: stats.totalItems,
    countsByType: stats.countsByType,
    metadataCompleteness: stats.completeness.completePct, // 0-100 (thumbnail+overview+genres)
    completeness: stats.completeness,
    sources: stats.sources,
    viewevents: stats.viewevents,
    users: { count: stats.users },
    uptimeSec: Math.floor(process.uptime()),
    generatedAt: new Date().toISOString(),
  });
}));

/* 3. GET /scale — honest AR10M scale report: real Neon numbers + capacity
 *    framing (proiectată / testată / demonstrată — declared separately,
 *    never mixed). */
router.get('/scale', wrap(async (req, res) => {
  assertPostgres();
  const stats = await collectHubStats();
  const model = shardingModelSnapshot(); // { shardcount, shards, mode } — legacy FAZA 13 model
  const sizeRow = await one('SELECT pg_database_size(current_database())::bigint AS size');
  const tested = ar10mBenchRows(); // null until a real AR10M benchmark completes

  res.json({
    ok: true,
    source: 'neon (real measurements) + ar10m capacity framing',
    real: {
      label: 'measured live from Neon (real rows)',
      totalItems: stats.totalItems,
      countsByType: stats.countsByType,
      sources: stats.sources, // contentsources registry + content providers — real
      users: stats.users,
      viewevents: { total: stats.viewevents.total, last24h: stats.viewevents.last24h },
      dbSizeBytes: Number(sizeRow?.size ?? 0),
    },
    capacity: {
      label: 'AR10M — capacitate declarată separat: proiectată / testată / demonstrată',
      designed: CAPACITY_DESIGNED, // 10.000.000 — arhitectura reală 15-shard (modules/ar10m)
      tested, // null = netestat încă (onest)
      benchmarked: tested, // null = în curs / nerulat încă (onest)
    },
    shards: {
      shardcount: model.shardcount,
      mode: model.mode,
      map: model.shards, // [{ shardid, branch, urlConfigured }]
    },
    honesty: 'AR10M: toate cifrele „real” sunt măsurători SQL live din Neon (rânduri reale). Capacitatea proiectată este 10.000.000 de titluri pe arhitectura reală 15-shard (modules/ar10m); testată/demonstrată — doar ce arată benchmark-urile reale (/api/ar10m/stats). Fostul spațiu logic 30B simulat a fost eliminat.',
    generatedAt: new Date().toISOString(),
  });
}));

/* 4. GET /years — distinct years + count + best-rated sample per year. */
router.get('/years', wrap(async (req, res) => {
  assertPostgres();
  const data = await rows(
    `WITH years AS (
       SELECT ${YEAR_INT} AS year, COUNT(*)::int AS count
       FROM content
       GROUP BY 1
       HAVING ${YEAR_INT} IS NOT NULL
     ),
      samples_ranked AS (
        SELECT ${YEAR_INT} AS year, id, title, thumbnail, type,
               ROW_NUMBER() OVER (
                 PARTITION BY ${YEAR_INT}
                 ORDER BY ${RATING_NUM} DESC NULLS LAST, id ASC
               ) AS rn
        FROM content
        WHERE ${YEAR_INT} IS NOT NULL
      ),
      samples AS (
        SELECT year, id, title, thumbnail, type
        FROM samples_ranked
        WHERE rn = 1
      )
     SELECT years.year, years.count, samples.id AS sid, samples.title AS stitle,
            samples.thumbnail AS sthumbnail, samples.type AS stype
     FROM years LEFT JOIN samples ON samples.year = years.year
     ORDER BY years.year DESC
     LIMIT $1`,
    [YEARS_CAP],
  );
  res.json({
    ok: true,
    source: 'neon',
    data: data.map((r) => ({
      year: num(r.year),
      count: num(r.count),
      sample: r.sid != null
        ? { id: num(r.sid), title: r.stitle, thumbnail: r.sthumbnail, type: r.stype }
        : null,
    })),
    total: data.length,
    generatedAt: new Date().toISOString(),
  });
}));

/* ------------------- shared dimension listing (genres/actors/studios) ------- */

/** Distinct values of a metadata array (+ optional network supplement for
 *  studios) with count + best-rated sample per value, sorted count DESC. */
async function listDimension({ arrayExpr, extraValues, cap }) {
  const extra = extraValues
    ? `UNION ALL
       SELECT content.id, content.metadata->>'network' AS value
       FROM content WHERE COALESCE(content.metadata->>'network', '') <> ''`
    : '';
  const data = await rows(
    `WITH exploded AS (
       SELECT content.id, e.value AS value
       FROM content, json_each(${arrayExpr}) AS e
       ${extra}
     ),
     counts AS (
       SELECT value, COUNT(DISTINCT id)::int AS count FROM exploded GROUP BY value
     ),
      samples_ranked AS (
        SELECT e.value AS value, content.id AS sid, content.title AS stitle,
               content.thumbnail AS sthumbnail, content.type AS stype,
               ROW_NUMBER() OVER (
                 PARTITION BY e.value
                 ORDER BY ${RATING_NUM} DESC NULLS LAST, content.id ASC
               ) AS rn
        FROM exploded e JOIN content ON content.id = e.id
      ),
      samples AS (
        SELECT value, sid, stitle, sthumbnail, stype
        FROM samples_ranked
        WHERE rn = 1
      )
     SELECT counts.value, counts.count, samples.sid, samples.stitle,
            samples.sthumbnail, samples.stype
     FROM counts LEFT JOIN samples ON samples.value = counts.value
     ORDER BY counts.count DESC, counts.value ASC
     LIMIT $1`,
    [cap],
  );
  return data.map((r) => ({
    value: r.value,
    count: num(r.count),
    sample: r.sid != null
      ? { id: num(r.sid), title: r.stitle, thumbnail: r.sthumbnail, type: r.stype }
      : null,
  }));
}

/* 5. GET /genres — distinct genres (count DESC) + best-rated sample per genre. */
router.get('/genres', wrap(async (req, res) => {
  assertPostgres();
  const data = await listDimension({ arrayExpr: GENRES_ARRAY, extraValues: false, cap: GENRES_LIST_CAP });
  res.json({ ok: true, source: 'neon', data, total: data.length, generatedAt: new Date().toISOString() });
}));

/* 6. GET /actors — distinct actors + count + best-rated sample (top 100). */
router.get('/actors', wrap(async (req, res) => {
  assertPostgres();
  const data = await listDimension({ arrayExpr: ACTORS_ARRAY, extraValues: false, cap: DIMENSION_SAMPLE_CAP });
  res.json({
    ok: true,
    source: 'neon',
    data,
    total: data.length,
    note: data.length === 0
      ? 'metadata.actors is not populated in the current catalog — honest empty list (zero mock)'
      : `metadata.actors is sparsely populated in the current catalog (${data.length} distinct actors) — honest counts, zero mock`,
    generatedAt: new Date().toISOString(),
  });
}));

/* 7. GET /studios — distinct studios (+ network) + count + sample (top 100).
 *  /stududios is registered as an alias (the FAZA 20 spec spells it both ways). */
async function handleStudios(_req, res) {
  assertPostgres();
  const data = await listDimension({ arrayExpr: STUDIOS_ARRAY, extraValues: true, cap: DIMENSION_SAMPLE_CAP });
  res.json({
    ok: true,
    source: 'neon',
    data,
    total: data.length,
    note: data.length === 0
      ? 'metadata.studios/network is not populated in the current catalog — honest empty list (zero mock)'
      : `metadata.studios/network in the current catalog (${data.length} distinct studios) — honest counts, zero mock`,
    generatedAt: new Date().toISOString(),
  });
}
router.get('/studios', wrap(handleStudios));
router.get('/stududios', wrap(handleStudios));

/* 8. GET /feed — 3-source feed: personal / global / ai + 1:1:1 combined. */
router.get('/feed', wrap(async (req, res) => {
  assertPostgres();

  // Source A — personal: latest watchlist + history items (requires login).
  let personal;
  if (req.user) {
    const items = await rows(
      `SELECT c.*, 'watchlist' AS origin, w.createdat AS at
       FROM watchlist w JOIN content c ON c.id = w.contentid
       WHERE w.userid = $1
       UNION ALL
       SELECT c.*, 'history' AS origin, h.watchedat AS at
       FROM watchhistory h JOIN content c ON c.id = h.contentid
       WHERE h.userid = $1
       ORDER BY at DESC LIMIT $2`,
      [num(req.user.id), FEED_LIMIT],
    );
    personal = {
      items: items.map((r) => ({ content: contentRow(r), origin: r.origin, at: isoOrNull(r.at) })),
      source: 'neon:watchlist+history',
    };
  } else {
    personal = {
      items: [],
      source: 'neon:watchlist+history',
      note: 'personal feed requires a bearer token (attachUser found no user) — honest empty list',
    };
  }

  // Source B — global: latest public activity; honest viewevents fallback when empty.
  let global;
  const acts = await rows(
    `SELECT ae.id, ae.type, ae.createdat, ae.contentid, ae.metadata,
            u.username AS actorname, c.title AS contenttitle,
            c.type AS contenttype, c.thumbnail AS contentthumbnail
     FROM activityevents ae
     JOIN users u ON u.id = ae.actorid
     LEFT JOIN content c ON c.id = ae.contentid
     ORDER BY ae.createdat DESC, ae.id DESC LIMIT $1`,
    [FEED_LIMIT],
  );
  if (acts.length > 0) {
    global = {
      items: acts.map((r) => ({
        id: num(r.id),
        type: r.type,
        createdat: isoOrNull(r.createdat),
        actor: r.actorname ?? null,
        content: r.contentid != null
          ? { id: num(r.contentid), title: r.contenttitle, type: r.contenttype, thumbnail: r.contentthumbnail }
          : null,
        preview: (r.metadata && (r.metadata.preview || r.metadata.body))?.slice?.(0, 140) || null,
      })),
      source: 'neon:activity',
    };
  } else {
    const recent = await rows(
      `SELECT c.*, MAX(v.createdat) AS at, COUNT(*)::int AS views
       FROM viewevents v JOIN content c ON c.id = v.contentid
       GROUP BY c.id ORDER BY at DESC LIMIT $1`,
      [FEED_LIMIT],
    );
    global = {
      items: recent.map((r) => ({ content: contentRow(r), at: isoOrNull(r.at), views: num(r.views) })),
      source: 'neon:viewevents-fallback',
      note: 'activityevents is empty — honest fallback to the most recently viewed titles',
    };
  }

  // Source C — ai: the protected AI Home engine (modules/ai/home.js) does not
  // export its feed builder, so the honest in-process fallback is a simple
  // top-rated-title-per-top-genre query, clearly labeled 'ai-fallback'.
  const picks = await rows(
      `WITH top_genres AS (
         SELECT g.value AS genre, COUNT(DISTINCT content.id)::int AS count
         FROM content, json_each(${GENRES_ARRAY}) AS g
         GROUP BY g.value
         ORDER BY count DESC, g.value ASC
         LIMIT $1
       ),
       ranked AS (
         SELECT g.value AS genre, content.*,
                ROW_NUMBER() OVER (
                  PARTITION BY g.value
                  ORDER BY ${RATING_NUM} DESC NULLS LAST, content.id ASC
                ) AS rn
         FROM content, json_each(${GENRES_ARRAY}) AS g
       ),
       best_per_genre AS (
         SELECT * FROM ranked WHERE rn = 1
       )
       SELECT best_per_genre.*, top_genres.count AS genre_count
       FROM best_per_genre
       JOIN top_genres ON top_genres.genre = best_per_genre.genre
       ORDER BY top_genres.count DESC, best_per_genre.genre ASC
       LIMIT $1`,
    [FEED_LIMIT],
  );
  const ai = {
    items: picks.map((r) => ({ ...contentRow(r), genre: r.genre, criteria: 'top-rated-per-genre' })),
    source: 'neon:ai-fallback',
    note: 'AI Home engine (modules/ai/home.js) is protected/not exportable — honest fallback: best-rated title per top genre',
  };

  // Combined — interleave 1:1:1 (personal → global → ai per round), first 24.
  const combined = [];
  const sources = [
    ['personal', personal.items],
    ['global', global.items],
    ['ai', ai.items],
  ];
  for (let i = 0; combined.length < FEED_COMBINED_CAP; i += 1) {
    let added = false;
    for (const [name, list] of sources) {
      if (combined.length >= FEED_COMBINED_CAP) break;
      if (list[i]) {
        combined.push({ origin: name, item: list[i] });
        added = true;
      }
    }
    if (!added) break;
  }

  res.json({
    ok: true,
    personal,
    global,
    ai,
    combined,
    combinedCount: combined.length,
    generatedAt: new Date().toISOString(),
  });
}));

/* 9. GET /recommendations — real Neon picks only (AR10M: fostul „logical”
 *    30B sample simulat, adus printr-un apel localhost intern — eliminat). */

router.get('/recommendations', wrap(async (req, res) => {
  assertPostgres();

  // Real — trending: most-viewed titles in the last 7 days.
  const trending = await rows(
    `SELECT c.*, COUNT(*)::int AS views
     FROM viewevents v JOIN content c ON c.id = v.contentid
     WHERE v.createdat > datetime('now','-7 days')
     GROUP BY c.id
     ORDER BY views DESC, c.id ASC LIMIT $1`,
    [RECOMMENDATIONS_TRENDING_LIMIT],
  );
  const trendingIds = trending.map((r) => num(r.id));

  // Real — top-rated fill (high completeness first): covers the "too few
  // trending" case and completes the 12-item real section.
  const fillCount = Math.max(0, RECOMMENDATIONS_REAL_LIMIT - trending.length);
  const fill = fillCount > 0
    ? await rows(
        `SELECT * FROM content
         WHERE id NOT IN (SELECT value FROM json_each($1))
         ORDER BY (CASE WHEN COALESCE(thumbnail, '') <> ''
                        AND COALESCE(metadata->>'overview', '') <> ''
                        AND jsonb_array_length(${GENRES_ARRAY}) > 0
                   THEN 1 ELSE 0 END) DESC,
                  ${RATING_NUM} DESC NULLS LAST, id ASC
         LIMIT $2`,
        [JSON.stringify(trendingIds.length ? trendingIds : [0]), fillCount],
      )
    : [];
  const realItems = [
    ...trending.map((r) => ({ ...contentRow(r), criteria: 'trending', views: num(r.views) })),
    ...fill.map((r) => ({ ...contentRow(r), criteria: 'top-rated' })),
  ].slice(0, RECOMMENDATIONS_REAL_LIMIT);

  logger.debug(
    `[hub] recommendations: real=${realItems.length} (trending=${trending.length}, fill=${fill.length})`,
  );

  res.json({
    ok: true,
    split: 'onest',
    real: { items: realItems, count: realItems.length, source: 'neon' },
    generatedAt: new Date().toISOString(),
  });
}));

export default router;
