/**
 * modules/hub/hub.js — FAZA 20 (Task 20-1): Hub-urile API complete.
 *
 * Hub-urile publice de agregare ale platformei: browse faceted real peste
 * tabela `content` (filtre type/genre/year + căutare ILIKE pe titlu + sortări
 * reale incl. popularitate din viewevents), statistici publice (totals +
 * engagement + recency — toate SQL real peste datele reale din Neon: content,
 * users, comments, watchlist, watchhistory, viewevents, contentlikes,
 * playlists, playlistitems, subtitletracks), hub-ul de scară (date REALE
 * alături de claim-ul logic 30B — exact filosofia platformei), hub-uri
 * dedicate de ani / genuri / actori / studiouri (extras din metadata jsonb
 * cu array_agg sample thumbnails) + feed hub (3 surse într-un singur apel)
 * + recomandări publice reale (top-rated în genul cel mai vizitat global).
 *
 * ZERO mock-uri: fiecare counter, facet și listă e o agregare SQL parametrizată
 * peste rândurile reale din Neon. Tabelele goale → array-uri goale / countere
 * 0, niciodată erori. Hub-ul de browse NU depinde de pipeline-ul de căutare
 * FAZA 15–18 (modules/search/* e doar IMPORTAT read-only pentru status, nu
 * atins) — `q` este un simplu ILIKE pe titlu (browse, NU full-text search;
 * căutarea reală rămâne /api/search/*).
 *
 * Mount: app.use('/api/hub', cacheMiddleware(), hubRouter) — cache HTTP 60s
 * (aceeași politică ca /api/discover), potrivit pentru agregări. attachUser e
 * global, dar TOATE rutele hub sunt publice (req.user e ignorat aici).
 *
 * Routes (toate GET, toate publice):
 *   GET /content       ?type=&page=&limit=&sort=recent|rating|title|popular&genre=&year=&q=
 *                      → { data: [contentRow], page, limit, total, totalPages,
 *                          facets: { types, genres (top 30), years (top 30 desc) } }
 *                      Facetele sunt calculate pe SETUL FILTRAT (fără paginare),
 *                          countere reale. limit 1..48, page ≥ 1 → 400 invalid.
 *   GET /stats         → { ok, totals: { content, byType, users, comments,
 *                          watchlistEntries, watchEntries, viewEvents, playlists,
 *                          playlistItems, subtitleTracks },
 *                          engagement: { topWatched, topRated, mostLiked (top 5) },
 *                          recency: { contentAddedLast7d, activeUsersLast7d },
 *                          generatedAt }
 *   GET /scale         → { ok, real: { contentItems, searchDocs, vectorEmbeddings,
 *                          users, shards, shardMode }, view: { capacityClaim: '30000000000',
 *                          note }, player: { allowedTypes }, search: { engine,
 *                          pipelineIntegrated } } — date reale + claim logic 30B.
 *   GET /years         ?limit=50  → { data: [{ year, count, sample: [≤3 thumbnails] }] }
 *   GET /genres        ?limit=50  → { data: [{ genre, count, sample }] }
 *   GET /actors        ?limit=50  → { data: [{ actor, count, sample }], coverage }
 *                          (metadata.actors / metadata.cast — ce există real; 2026-09:
 *                          2 conținuturi cu actors reali, cast inexistentă)
 *   GET /studios       ?limit=50  → { data: [{ studio, count, sample }], coverage }
 *                          (metadata.studios / metadata.studio / metadata.network —
 *                          ce există real; 2026-09: 2 conținuturi cu studios)
 *   GET /feed          → { ok, sources: [{ id: 'recent', data: ≤12 contentRow },
 *                          { id: 'popular', data: +views }, { id: 'rated', data: +rating }] }
 *   GET /recommendations → { ok, strategy, genre?, fromGenre, backfilled,
 *                          data: [≤12 contentRow] } — top-rated în genul cel
 *                          mai vizitat global (viewevents JOIN content→genres),
 *                          completat onest din top rating global când genul
 *                          are <12 titluri; fallback top rating global.
 *                          Personalizarea completă per user rămâne în /api/ai/*.
 *
 * Netouch-uri (regulile de aur): modules/search/*, modules/sharding/*,
 * modules/player/player.js (doar import playerAllowedTypes), feed 30B,
 * db.js, cache.js, rateLimit.js, seed.js, migrările FAZA 19.
 */

import express from 'express';
import { rows, one, parseJsonb, isoOrNull, num } from '../platform/sql.js';
import { playerAllowedTypes } from '../player/player.js'; // read-only import — playerul extern real NU e atins
import { searchStressPipelineIntegrated } from '../search/stress.js'; // read-only import — sursa REALĂ a pipelineIntegrated din /api/search/status (FAZA 18)
import { shardCount } from '../sharding/model.js'; // read-only import — numărul real de shards logice (30)

/* --------------------------------- helpers --------------------------------- */

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Content slug for the browse `type` filter (matches the real content.type
 *  values: movie, tv, anime, mined, video, featured, page — lower-case). */
const TYPE_RE = /^[a-z0-9-]{1,24}$/;

/** Genres exist in metadata as a jsonb ARRAY of strings (verified live:
 *  81/100 rows array, 19 rows missing the key) — the guard below keeps the
 *  jsonb_array_elements_text lateral join total-safe even if a future writer
 *  stores a non-array value. */
const GENRES_ARRAY_SAFE = `CASE WHEN jsonb_typeof(c.metadata->'genres') = 'array' THEN c.metadata->'genres' ELSE '[]'::jsonb END`;
/** Same shape-guard for arbitrary string-array metadata keys (actors/cast/
 *  studios — verified live: 2 rows each with `actors`/`studios`, none with
 *  `cast`/`studio`/`network`). */
const ARRAY_KEY_SAFE = (key) => `CASE WHEN jsonb_typeof(c.metadata->'${key}') = 'array' THEN c.metadata->'${key}' ELSE '[]'::jsonb END`;

/** Sort key for metadata.rating: NULLS LAST + regex-guarded cast (a row with
 *  a non-numeric rating string sorts last instead of erroring the query). */
const RATING_SORT = `CASE WHEN (c.metadata->>'rating') ~ '^[0-9]+(\\.[0-9]+)?$' THEN (c.metadata->>'rating')::numeric ELSE NULL END`;

/** year filter: metadata.year exists on 93/100 rows as number OR string —
 *  `->>` normalizes both to text; the regex guards the ::int cast. */
const YEAR_TEXT_GUARD = `(c.metadata->>'year') ~ '^[0-9]{4}$'`;

/** Escape LIKE wildcards so a user `q` of "100%" matches literally. */
function escapeLike(value) {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** Strict integer query param: { value } when valid, { error } otherwise. */
function intQuery(raw, { min, max, label }) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    return { error: `${label} must be an integer between ${min} and ${max}` };
  }
  return { value: n };
}

/** Normalize a raw content row into the public content shape (same contract
 *  as modules/users/profile.js contentRow / modules/player/hub.js contentRow). */
function contentRow(row) {
  if (!row) return null;
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

/** First ≤3 real thumbnails of a facet group (array_agg slice) — [] not null. */
function sampleThumbnails(sample) {
  return Array.isArray(sample) ? sample.filter(Boolean) : [];
}

/* ---------------------------------- limits ---------------------------------- */

const CONTENT_PAGE_MAX = 48; // /content browse page size cap
const CONTENT_PAGE_DEFAULT = 24;
const FACET_TOP = 30; // genres/years facet cap (per spec)
const FACET_HUB_LIMIT_MAX = 100; // years/genres/actors/studios ?limit cap
const FACET_HUB_LIMIT_DEFAULT = 50;
const FEED_SOURCE_SIZE = 12;
const RECOMMENDATIONS_SIZE = 12;
const TOP_ENGAGEMENT = 5;
const MAX_Q_CHARS = 200;
const MAX_GENRE_CHARS = 80;

const SORTS = {
  recent: 'c.createdat DESC, c.id DESC',
  rating: `${RATING_SORT} DESC NULLS LAST, c.createdat DESC, c.id DESC`,
  title: 'c.title ASC, c.id ASC',
  popular: 've.views DESC NULLS LAST, c.createdat DESC, c.id DESC',
};

/* ---------------------------------- router ---------------------------------- */

export const hubRouter = express.Router();

/* ----------------------- A. /content — faceted browse ---------------------- */

/** GET /content — REAL faceted browse over `content`.
 *
 * Honest scope: `q` is a simple parametrized ILIKE on title (browse aid),
 * NOT the full-text search — the real search stays in /api/search/* (FAZA
 * 15–18 pipeline, untouched). Facets are computed on the FILTERED set
 * (without pagination): types = GROUP BY c.type; genres = lateral
 * jsonb_array_elements_text + GROUP BY; years = text year (regex-guarded)
 * + GROUP BY. The `popular` sort aggregates viewevents with a LEFT JOIN
 * (NULLS LAST + createdat tiebreak). */
hubRouter.get('/content', wrap(async (req, res) => {
  /* ---- parse + strict validation (invalid → 400) ---- */
  const limit = intQuery(req.query.limit ?? CONTENT_PAGE_DEFAULT, { min: 1, max: CONTENT_PAGE_MAX, label: 'limit' });
  if (limit.error) return res.status(400).json({ error: limit.error });
  const page = intQuery(req.query.page ?? 1, { min: 1, max: 100000, label: 'page' });
  if (page.error) return res.status(400).json({ error: page.error });

  const sort = req.query.sort === undefined ? 'recent' : String(req.query.sort);
  if (!Object.prototype.hasOwnProperty.call(SORTS, sort)) {
    return res.status(400).json({ error: `sort must be one of: ${Object.keys(SORTS).join(', ')}` });
  }

  const type = req.query.type === undefined ? null : String(req.query.type);
  if (type !== null && !TYPE_RE.test(type)) {
    return res.status(400).json({ error: 'type must be a lower-case slug (e.g. movie, tv, anime, mined, video)' });
  }

  const genre = req.query.genre === undefined ? null : String(req.query.genre).trim();
  if (genre !== null && (genre.length < 1 || genre.length > MAX_GENRE_CHARS)) {
    return res.status(400).json({ error: `genre must be 1-${MAX_GENRE_CHARS} characters (non-blank)` });
  }

  const year = req.query.year === undefined ? null : intQuery(req.query.year, { min: 1000, max: 3000, label: 'year' });
  if (year !== null && year.error) return res.status(400).json({ error: year.error });

  const q = req.query.q === undefined ? null : String(req.query.q).trim().slice(0, MAX_Q_CHARS + 1);
  if (q !== null && q.length > MAX_Q_CHARS) {
    return res.status(400).json({ error: `q must be at most ${MAX_Q_CHARS} characters` });
  }

  /* ---- parametrized WHERE (shared by data, count and facets) ---- */
  const conds = ['TRUE'];
  const params = [];
  if (type !== null) {
    params.push(type);
    conds.push(`c.type = $${params.length}`);
  }
  if (genre !== null) {
    // genres is a jsonb ARRAY of strings → exact containment beats ILIKE on
    // the serialized text (verified live: metadata->'genres' @> '"Action"').
    params.push(JSON.stringify(genre));
    conds.push(`c.metadata->'genres' @> $${params.length}::jsonb`);
  }
  if (year !== null) {
    params.push(year.value);
    conds.push(`${YEAR_TEXT_GUARD} AND (c.metadata->>'year')::int = $${params.length}`);
  }
  if (q !== null && q !== '') {
    params.push(`%${escapeLike(q)}%`);
    conds.push(`c.title ILIKE '%' || $${params.length} || '%' ESCAPE '\\'`);
  }
  const where = conds.join(' AND ');

  const fromPopular = sort === 'popular'
    ? 'LEFT JOIN (SELECT contentid, COUNT(*)::int AS views FROM viewevents GROUP BY contentid) ve ON ve.contentid = c.id'
    : '';

  const filterParams = params.slice(); // shared by count + facets
  params.push(limit.value, (page.value - 1) * limit.value);
  const limitIdx = params.length - 1;
  const offsetIdx = params.length;

  /* ---- data page + total + facets (all over the SAME filtered set) ---- */
  const [dataRows, totalRow, typeFacetRows, genreFacetRows, yearFacetRows] = await Promise.all([
    rows(
      `SELECT c.id, c.externalid, c.type, c.title, c.metadata, c.thumbnail, c.createdat
       FROM content c ${fromPopular}
       WHERE ${where}
       ORDER BY ${SORTS[sort]}
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params,
    ),
    one(`SELECT COUNT(*)::int AS total FROM content c WHERE ${where}`, filterParams),
    rows(
      `SELECT c.type AS value, COUNT(*)::int AS count
       FROM content c WHERE ${where}
       GROUP BY c.type ORDER BY count DESC, value ASC`,
      filterParams,
    ),
    rows(
      `SELECT g AS value, COUNT(*)::int AS count
       FROM content c, jsonb_array_elements_text(${GENRES_ARRAY_SAFE}) g
       WHERE ${where} AND g <> ''
       GROUP BY g ORDER BY count DESC, value ASC
       LIMIT ${FACET_TOP}`,
      filterParams,
    ),
    rows(
      `SELECT (c.metadata->>'year') AS value, COUNT(*)::int AS count
       FROM content c
       WHERE ${where} AND ${YEAR_TEXT_GUARD}
       GROUP BY 1 ORDER BY value DESC
       LIMIT ${FACET_TOP}`,
      filterParams,
    ),
  ]);

  const total = num(totalRow?.total);
  return res.json({
    data: dataRows.map(contentRow),
    page: page.value,
    limit: limit.value,
    total,
    totalPages: total === 0 ? 0 : Math.ceil(total / limit.value),
    facets: {
      types: typeFacetRows.map((r) => ({ value: r.value, count: num(r.count) })),
      genres: genreFacetRows.map((r) => ({ value: r.value, count: num(r.count) })),
      years: yearFacetRows.map((r) => ({ value: num(r.value), count: num(r.count) })),
    },
  });
}));

/* -------------------------- B. /stats — platform stats ---------------------- */

/** GET /stats — public platform statistics. 100% real SQL aggregates; empty
 *  tables surface as empty arrays / zero counters (never errors). */
hubRouter.get('/stats', wrap(async (req, res) => {
  const [totalsRow, byTypeRows, topWatchedRows, topRatedRows, mostLikedRows, recencyRow] = await Promise.all([
    one(
      `SELECT
         (SELECT COUNT(*)::int FROM content) AS content,
         (SELECT COUNT(*)::int FROM users) AS users,
         (SELECT COUNT(*)::int FROM comments) AS comments,
         (SELECT COUNT(*)::int FROM watchlist) AS watchlistentries,
         (SELECT COUNT(*)::int FROM watchhistory) AS watchentries,
         (SELECT COUNT(*)::int FROM viewevents) AS viewevents,
         (SELECT COUNT(*)::int FROM playlists) AS playlists,
         (SELECT COUNT(*)::int FROM playlistitems) AS playlistitems,
         (SELECT COUNT(*)::int FROM subtitletracks) AS subtitletracks`,
    ),
    rows(`SELECT type, COUNT(*)::int AS count FROM content GROUP BY type ORDER BY count DESC, type ASC`),
    rows(
      `SELECT c.id, c.title, c.thumbnail, c.type, COUNT(*)::int AS count
       FROM watchhistory h JOIN content c ON c.id = h.contentid
       GROUP BY c.id, c.title, c.thumbnail, c.type
       ORDER BY count DESC, c.id ASC
       LIMIT ${TOP_ENGAGEMENT}`,
    ),
    rows(
      `SELECT c.id, c.title, c.type, c.thumbnail, ${RATING_SORT} AS rating
       FROM content c
       ORDER BY rating DESC NULLS LAST, c.id ASC
       LIMIT ${TOP_ENGAGEMENT}`,
    ),
    rows(
      `SELECT c.id, c.title, c.type, c.thumbnail, COUNT(*)::int AS count
       FROM contentlikes l JOIN content c ON c.id = l.contentid
       GROUP BY c.id, c.title, c.type, c.thumbnail
       ORDER BY count DESC, c.id ASC
       LIMIT ${TOP_ENGAGEMENT}`,
    ),
    one(
      `SELECT
         (SELECT COUNT(*)::int FROM content WHERE createdat > NOW() - '7 days'::interval) AS contentaddedlast7d,
         (SELECT COUNT(DISTINCT userid)::int FROM watchhistory WHERE watchedat > NOW() - '7 days'::interval) AS activeuserslast7d`,
    ),
  ]);

  const byType = {};
  for (const r of byTypeRows) byType[r.type] = num(r.count);

  return res.json({
    ok: true,
    totals: {
      content: num(totalsRow?.content),
      byType,
      users: num(totalsRow?.users),
      comments: num(totalsRow?.comments),
      watchlistEntries: num(totalsRow?.watchlistentries),
      watchEntries: num(totalsRow?.watchentries),
      viewEvents: num(totalsRow?.viewevents),
      playlists: num(totalsRow?.playlists), // FAZA 19 tables, read-only here
      playlistItems: num(totalsRow?.playlistitems),
      subtitleTracks: num(totalsRow?.subtitletracks),
    },
    engagement: {
      topWatched: topWatchedRows.map((r) => ({ id: num(r.id), title: r.title, thumbnail: r.thumbnail ?? null, type: r.type ?? null, count: num(r.count) })),
      topRated: topRatedRows.map((r) => ({ id: num(r.id), title: r.title, type: r.type ?? null, thumbnail: r.thumbnail ?? null, rating: r.rating === null || r.rating === undefined ? null : Number(r.rating) })),
      mostLiked: mostLikedRows.map((r) => ({ id: num(r.id), title: r.title, type: r.type ?? null, thumbnail: r.thumbnail ?? null, count: num(r.count) })),
    },
    recency: {
      contentAddedLast7d: num(recencyRow?.contentaddedlast7d),
      activeUsersLast7d: num(recencyRow?.activeuserslast7d),
    },
    generatedAt: new Date().toISOString(),
  });
}));

/* --------------------------- C. /scale — scale hub -------------------------- */

/** GET /scale — REAL numbers next to the logical 30B claim (the platform's
 *  honesty contract): real = live counts (vectorembeddings guarded — 0 when
 *  the table is absent), view = the LOGICAL simulated capacity, player =
 *  live allow-list from the REAL player module, search = the live FAZA 18
 *  pipelineIntegrated verdict (same source as /api/search/status). */
hubRouter.get('/scale', wrap(async (req, res) => {
  const [countsRow, vectorRow] = await Promise.all([
    one(
      `SELECT
         (SELECT COUNT(*)::int FROM content) AS contentitems,
         (SELECT COUNT(*)::int FROM searchdocs) AS searchdocs,
         (SELECT COUNT(*)::int FROM users) AS users`,
    ),
    one(`SELECT COUNT(*)::int AS n FROM vectorembeddings`).catch(() => null),
  ]);

  return res.json({
    ok: true,
    real: {
      contentItems: num(countsRow?.contentitems),
      searchDocs: num(countsRow?.searchdocs),
      vectorEmbeddings: num(vectorRow?.n), // 0 when the table is absent/degraded
      users: num(countsRow?.users),
      shards: shardCount(), // live from modules/sharding/model.js (30)
      shardMode: 'logical',
    },
    view: {
      capacityClaim: '30000000000',
      note: 'capacitatea logică simulată 30B — datele reale sunt cele din real',
    },
    player: {
      allowedTypes: playerAllowedTypes(), // live policy of the REAL player
    },
    search: {
      engine: 'animaxia-neon-fts', // mirrors the ENGINE const in modules/search/search.js (not exported)
      pipelineIntegrated: searchStressPipelineIntegrated(), // LIVE from modules/search/stress.js — the exact value /api/search/status reports
      note: 'pipelineIntegrated citit live din modulul de stress FAZA 18 (sursa reală a /api/search/status)',
    },
  });
}));

/* -------------------- D–G. facet hubs: years/genres/actors/studios ---------- */

/** Shared strict ?limit validation for the facet hubs (1..100, default 50).
 *  Responds 400 and returns null when invalid. */
function facetHubLimit(req, res) {
  const limit = intQuery(req.query.limit ?? FACET_HUB_LIMIT_DEFAULT, { min: 1, max: FACET_HUB_LIMIT_MAX, label: 'limit' });
  if (limit.error) {
    res.status(400).json({ error: limit.error });
    return null;
  }
  return limit.value;
}

/** GET /years — real release years (DISTINCT metadata->>'year', numeric only,
 *  DESC) with counts + ≤3 real sample thumbnails per year. */
hubRouter.get('/years', wrap(async (req, res) => {
  const limit = facetHubLimit(req, res);
  if (limit === null) return undefined;
  const data = await rows(
    `SELECT (c.metadata->>'year')::int AS year, COUNT(*)::int AS count,
            COALESCE((array_agg(c.thumbnail ORDER BY c.id) FILTER (WHERE c.thumbnail IS NOT NULL))[1:3], ARRAY[]::text[]) AS sample
     FROM content c
     WHERE ${YEAR_TEXT_GUARD}
     GROUP BY 1
     ORDER BY 1 DESC
     LIMIT $1`,
    [limit],
  );
  return res.json({ data: data.map((r) => ({ year: num(r.year), count: num(r.count), sample: sampleThumbnails(r.sample) })) });
}));

/** GET /genres — real genres (lateral jsonb_array_elements_text over the
 *  genres array), counts + ≤3 sample thumbnails, count DESC. */
hubRouter.get('/genres', wrap(async (req, res) => {
  const limit = facetHubLimit(req, res);
  if (limit === null) return undefined;
  const data = await rows(
    `SELECT g AS genre, COUNT(*)::int AS count,
            COALESCE((array_agg(c.thumbnail ORDER BY c.id) FILTER (WHERE c.thumbnail IS NOT NULL))[1:3], ARRAY[]::text[]) AS sample
     FROM content c, jsonb_array_elements_text(${GENRES_ARRAY_SAFE}) g
     WHERE g <> ''
     GROUP BY g
     ORDER BY count DESC, genre ASC
     LIMIT $1`,
    [limit],
  );
  return res.json({ data: data.map((r) => ({ genre: r.genre, count: num(r.count), sample: sampleThumbnails(r.sample) })) });
}));

/** GET /actors — actors from the REAL metadata (verified live: `actors`
 *  exists as a string array on 2/100 rows — e.g. Moana 2, Men on a Mission;
 *  `cast` is checked too but currently absent everywhere; the miner/AI can
 *  add it later — the SQL already handles both keys). Honest coverage is
 *  reported alongside; when nothing exists the response gains an honest note. */
hubRouter.get('/actors', wrap(async (req, res) => {
  const limit = facetHubLimit(req, res);
  if (limit === null) return undefined;
  const [data, coverageRow] = await Promise.all([
    rows(
      `SELECT actor, COUNT(DISTINCT id)::int AS count,
              COALESCE((array_agg(thumbnail ORDER BY id) FILTER (WHERE thumbnail IS NOT NULL))[1:3], ARRAY[]::text[]) AS sample
       FROM (
         SELECT c.id, c.thumbnail, a AS actor
         FROM content c, jsonb_array_elements_text(${ARRAY_KEY_SAFE('actors')}) a
         WHERE a <> ''
         UNION ALL
         SELECT c.id, c.thumbnail, a AS actor
         FROM content c, jsonb_array_elements_text(${ARRAY_KEY_SAFE('cast')}) a
         WHERE a <> ''
       ) s
       GROUP BY actor
       ORDER BY count DESC, actor ASC
       LIMIT $1`,
      [limit],
    ),
    one(
      `SELECT COUNT(*)::int AS n FROM content
       WHERE jsonb_typeof(metadata->'actors') = 'array' OR jsonb_typeof(metadata->'cast') = 'array'`,
    ),
  ]);
  const body = {
    data: data.map((r) => ({ actor: r.actor, count: num(r.count), sample: sampleThumbnails(r.sample) })),
    coverage: { keys: ['actors', 'cast'], contentWithActors: num(coverageRow?.n) },
  };
  if (!body.data.length) {
    body.note = 'metadata reală nu conține încă actori — minerul/AI pot adăuga';
  }
  return res.json(body);
}));

/** GET /studios — studios from the REAL metadata (verified live: `studios`
 *  exists as a string array on 2/100 rows — JTBC, SM Culture & Contents,
 *  Walt Disney Animation Studios; singular `studio`/`network` keys are
 *  checked too but currently absent everywhere). Honest coverage alongside;
 *  `source` (tmdb/jikan/demo — the PROVIDER, not a studio) is deliberately
 *  NOT aggregated as a studio. */
hubRouter.get('/studios', wrap(async (req, res) => {
  const limit = facetHubLimit(req, res);
  if (limit === null) return undefined;
  const [data, coverageRow] = await Promise.all([
    rows(
      `SELECT studio, COUNT(DISTINCT id)::int AS count,
              COALESCE((array_agg(thumbnail ORDER BY id) FILTER (WHERE thumbnail IS NOT NULL))[1:3], ARRAY[]::text[]) AS sample
       FROM (
         SELECT c.id, c.thumbnail, s AS studio
         FROM content c, jsonb_array_elements_text(${ARRAY_KEY_SAFE('studios')}) s
         WHERE s <> ''
         UNION ALL
         SELECT c.id, c.thumbnail, c.metadata->>'studio' AS studio
         FROM content c
         WHERE c.metadata->>'studio' IS NOT NULL AND c.metadata->>'studio' <> ''
         UNION ALL
         SELECT c.id, c.thumbnail, c.metadata->>'network' AS studio
         FROM content c
         WHERE c.metadata->>'network' IS NOT NULL AND c.metadata->>'network' <> ''
       ) s
       GROUP BY studio
       ORDER BY count DESC, studio ASC
       LIMIT $1`,
      [limit],
    ),
    one(
      `SELECT COUNT(*)::int AS n FROM content
       WHERE jsonb_typeof(metadata->'studios') = 'array'
          OR (metadata->>'studio') IS NOT NULL
          OR (metadata->>'network') IS NOT NULL`,
    ),
  ]);
  const body = {
    data: data.map((r) => ({ studio: r.studio, count: num(r.count), sample: sampleThumbnails(r.sample) })),
    coverage: { keys: ['studios', 'studio', 'network'], contentWithStudios: num(coverageRow?.n) },
  };
  if (!body.data.length) {
    body.note = 'metadata reală nu conține încă studiouri — minerul/AI pot adăuga';
  }
  return res.json(body);
}));

/* ---------------------------- H. /feed — feed hub --------------------------- */

/** GET /feed — three real shelves in ONE call for the hub home page:
 *  recent (createdat DESC), popular (viewevents COUNT via LEFT JOIN) and
 *  rated (metadata.rating DESC, regex-guarded). contentRow shape + the
 *  shelf-specific extra (views / rating). */
hubRouter.get('/feed', wrap(async (req, res) => {
  const [recentRows, popularRows, ratedRows] = await Promise.all([
    rows(
      `SELECT c.id, c.externalid, c.type, c.title, c.metadata, c.thumbnail, c.createdat
       FROM content c
       ORDER BY c.createdat DESC, c.id DESC
       LIMIT ${FEED_SOURCE_SIZE}`,
    ),
    rows(
      `SELECT c.id, c.externalid, c.type, c.title, c.metadata, c.thumbnail, c.createdat,
              ve.views
       FROM content c
       LEFT JOIN (SELECT contentid, COUNT(*)::int AS views FROM viewevents GROUP BY contentid) ve
         ON ve.contentid = c.id
       ORDER BY ve.views DESC NULLS LAST, c.createdat DESC, c.id DESC
       LIMIT ${FEED_SOURCE_SIZE}`,
    ),
    rows(
      `SELECT c.id, c.externalid, c.type, c.title, c.metadata, c.thumbnail, c.createdat,
              ${RATING_SORT} AS rating
       FROM content c
       ORDER BY rating DESC NULLS LAST, c.createdat DESC, c.id DESC
       LIMIT ${FEED_SOURCE_SIZE}`,
    ),
  ]);
  return res.json({
    ok: true,
    sources: [
      { id: 'recent', label: 'Adăugate recent', data: recentRows.map(contentRow) },
      {
        id: 'popular',
        label: 'Cele mai vizionate',
        data: popularRows.map((r) => ({ ...contentRow(r), views: num(r.views) })),
      },
      {
        id: 'rated',
        label: 'Cel mai bine notate',
        data: ratedRows.map((r) => ({ ...contentRow(r), rating: r.rating === null || r.rating === undefined ? null : Number(r.rating) })),
      },
    ],
  });
}));

/* ---------------------- I. /recommendations — public hub -------------------- */

/** GET /recommendations — REAL public recommendations (no auth): the globally
 *  most-watched genre (viewevents JOIN content → genres lateral) drives a
 *  top-rated selection from that genre; when the genre holds fewer than 12
 *  real titles the list is BACKFILLED with the global top rating (distinct)
 *  and the split is reported honestly (fromGenre / backfilled). With zero
 *  viewevents it falls back to the global top rating. Honest scope: full
 *  per-user personalization already lives in /api/ai/* (FAZA 15–16,
 *  untouched). */
hubRouter.get('/recommendations', wrap(async (req, res) => {
  const topGenre = await one(
    `SELECT g AS genre, COUNT(*)::int AS views
     FROM viewevents v
     JOIN content c ON c.id = v.contentid,
          jsonb_array_elements_text(${GENRES_ARRAY_SAFE}) g
     WHERE g <> ''
     GROUP BY g
     ORDER BY views DESC, genre ASC
     LIMIT 1`,
  );

  const note = 'recomandări publice reale (genul cel mai vizitat global) — personalizarea completă per user există în /api/ai/*';
  if (topGenre) {
    const genreRows = await rows(
      `SELECT c.id, c.externalid, c.type, c.title, c.metadata, c.thumbnail, c.createdat
       FROM content c
       WHERE c.metadata->'genres' @> $1::jsonb
       ORDER BY ${RATING_SORT} DESC NULLS LAST, c.createdat DESC, c.id DESC
       LIMIT ${RECOMMENDATIONS_SIZE}`,
      [JSON.stringify(topGenre.genre)],
    );

    if (genreRows.length < RECOMMENDATIONS_SIZE) {
      // Honest backfill: the rest of the 12 comes from the GLOBAL top rating
      // (distinct ids) — reported via fromGenre/backfilled below.
      const seen = genreRows.map((r) => num(r.id));
      const fill = await rows(
        `SELECT c.id, c.externalid, c.type, c.title, c.metadata, c.thumbnail, c.createdat
         FROM content c
         WHERE c.id <> ALL($1::int[])
         ORDER BY ${RATING_SORT} DESC NULLS LAST, c.createdat DESC, c.id DESC
         LIMIT ${RECOMMENDATIONS_SIZE - genreRows.length}`,
        [seen],
      );
      return res.json({
        ok: true,
        strategy: 'most-watched-genre',
        genre: topGenre.genre,
        basedOnViews: num(topGenre.views),
        fromGenre: genreRows.length,
        backfilled: fill.length,
        data: [...genreRows, ...fill].map(contentRow),
        note,
      });
    }

    return res.json({
      ok: true,
      strategy: 'most-watched-genre',
      genre: topGenre.genre,
      basedOnViews: num(topGenre.views),
      fromGenre: genreRows.length,
      backfilled: 0,
      data: genreRows.map(contentRow),
      note,
    });
  }

  // No viewevents at all → honest global fallback (top rating, any genre).
  const data = await rows(
    `SELECT c.id, c.externalid, c.type, c.title, c.metadata, c.thumbnail, c.createdat
     FROM content c
     ORDER BY ${RATING_SORT} DESC NULLS LAST, c.createdat DESC, c.id DESC
     LIMIT ${RECOMMENDATIONS_SIZE}`,
  );
  return res.json({
    ok: true,
    strategy: 'top-rated-fallback',
    genre: null,
    fromGenre: 0,
    backfilled: data.length,
    data: data.map(contentRow),
    note,
  });
}));
