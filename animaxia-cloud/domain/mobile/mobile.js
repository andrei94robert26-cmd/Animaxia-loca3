/**
 * domain/mobile/mobile.js — Mobile BFF (backend-for-frontend): compact,
 * bandwidth-friendly payloads for the Animaxia mobile client.
 *
 * Mount: app.use('/api/mobile', mobileRouter) — public router; auth is
 * optional (global attachUser) except /profile which enforces requireAuth.
 * NEVER wrap these routes in the global HTTP cacheMiddleware: responses are
 * user-dependent. The ANONYMOUS /home variant is cached in advancedCache
 * (key 'mobile:home', 60s TTL, tagged 'content' → auto-invalidated on
 * content:changed); the authenticated variant is always built fresh.
 *
 * Routes:
 *   GET /home       (public; auth adds the Continue-watching row)
 *                  → { hero, rows: [{ key, title, items }], config }
 *   GET /player/:id (public) → { content, mode, allowedTypes, sources, primary, nextUp }
 *   GET /profile    (requireAuth) → { user, plan, limits, watchlistCount, recentHistory }
 *   GET /config     (public) → { versions, features, endpoints }
 *
 * Compact item shape: { id, title, type, thumbnail, rating, year } where
 * rating = metadata.rating ?? metadata.score (movies/tv use `rating`, Jikan
 * anime rows use `score`).
 */

import express from 'express';
import { rows, one, num, isoOrNull, parseJsonb } from '@animaxia/common/sql.js';
import { requireAuth } from '../users/auth.js';
import { planLimits } from '../premium/plans.js';
import { resolvePlayer } from '../player/player.js';
import { getContentById } from '@animaxia/common/db.js';
import { advancedCache } from '../cache/advancedCache.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* -------------------------------- constants --------------------------------- */

const ROW_LIMIT = 10;
const HOME_CACHE_KEY = 'mobile:home';
const HOME_CACHE_TTL_MS = 60000;
const HOME_CONFIG = { minVersion: '1.0.0', latestVersion: '1.2.0' };
const ROW_TITLES = {
  continue: 'Continue watching',
  trending: 'Trending now',
  latest: 'New in Animaxia',
  anime: 'Popular anime',
  movies: 'Movies',
};

/** Content columns shared by every mobile query (alias `c` for content). */
const CONTENT_COLUMNS = `c.id, c.externalid, c.type, c.title, c.metadata, c.thumbnail, c.createdat`;

/* --------------------------------- helpers ---------------------------------- */

function metadataOf(row) {
  return parseJsonb(row?.metadata, {});
}

/** Compact list item — the mobile payload shape (no heavy metadata blob). */
function compactItem(row) {
  const metadata = metadataOf(row);
  return {
    id: num(row?.id),
    title: row?.title ?? null,
    type: row?.type ?? null,
    thumbnail: row?.thumbnail ?? null,
    rating: metadata.rating ?? metadata.score ?? null,
    year: metadata.year ?? null,
  };
}

/**
 * Trending = most-viewed content over the last 7 days (viewevents table).
 * Cold start: with zero view events the row would be empty, so it falls back
 * to the newest content — a home screen must never render an empty hero.
 */
async function trendingContent(limit = ROW_LIMIT) {
  const data = await rows(
    `SELECT ${CONTENT_COLUMNS}, COUNT(v.id)::int AS views
     FROM viewevents v
     JOIN content c ON c.id = v.contentid
     WHERE v.createdat > NOW() - interval '7 days'
     GROUP BY c.id
     ORDER BY views DESC, MAX(v.createdat) DESC
     LIMIT $1`,
    [limit],
  );
  if (data.length > 0) return data;
  return rows(`SELECT ${CONTENT_COLUMNS} FROM content c ORDER BY c.createdat DESC, c.id DESC LIMIT $1`, [limit]);
}

/** Newest content regardless of type. */
async function latestContent(limit = ROW_LIMIT) {
  return rows(`SELECT ${CONTENT_COLUMNS} FROM content c ORDER BY c.createdat DESC, c.id DESC LIMIT $1`, [limit]);
}

/** Newest content of a given type ('anime' / 'movie'). */
async function contentByType(type, limit = ROW_LIMIT) {
  return rows(
    `SELECT ${CONTENT_COLUMNS} FROM content c WHERE c.type = $1 ORDER BY c.createdat DESC, c.id DESC LIMIT $2`,
    [type, limit],
  );
}

/**
 * Watch-history rows for a user, most recently watched first. Also used for
 * the /profile recentHistory card (limit 5 there).
 */
async function continueWatching(userid, limit = ROW_LIMIT) {
  return rows(
    `SELECT ${CONTENT_COLUMNS}, h.watchedat, h.progress
     FROM watchhistory h
     JOIN content c ON c.id = h.contentid
     WHERE h.userid = $1
     ORDER BY h.watchedat DESC, h.id DESC
     LIMIT $2`,
    [userid, limit],
  );
}

/** Build the home payload. `user` present → the Continue-watching row leads. */
async function buildHome(user) {
  const [trending, latest, anime, movies, cont] = await Promise.all([
    trendingContent(),
    latestContent(),
    contentByType('anime'),
    contentByType('movie'),
    user ? continueWatching(user.id) : Promise.resolve([]),
  ]);

  const homeRows = [];
  // Continue-watching only exists for authenticated callers with history —
  // never rendered (nor cached) for anonymous ones.
  if (user && cont.length > 0) {
    homeRows.push({ key: 'continue', title: ROW_TITLES.continue, items: cont.map(compactItem) });
  }
  homeRows.push(
    { key: 'trending', title: ROW_TITLES.trending, items: trending.map(compactItem) },
    { key: 'latest', title: ROW_TITLES.latest, items: latest.map(compactItem) },
    { key: 'anime', title: ROW_TITLES.anime, items: anime.map(compactItem) },
    { key: 'movies', title: ROW_TITLES.movies, items: movies.map(compactItem) },
  );

  // Hero = first trending item (latest as fallback), enriched with overview + backdrop.
  const heroSource = trending[0] || latest[0] || null;
  let hero = null;
  if (heroSource) {
    const metadata = metadataOf(heroSource);
    hero = {
      ...compactItem(heroSource),
      overview: metadata.overview || metadata.synopsis || null,
      backdrop: metadata.backdrop || null,
    };
  }

  return { hero, rows: homeRows, config: HOME_CONFIG };
}

/* ---------------------------------- router ---------------------------------- */

const router = express.Router();

/**
 * GET /home — public home screen. Authenticated callers additionally get the
 * Continue-watching row (user-dependent → built fresh every time). The
 * ANONYMOUS variant is cached in advancedCache (60s, tag 'content').
 */
router.get('/home', wrap(async (req, res) => {
  if (!req.user) {
    const cached = advancedCache.get(HOME_CACHE_KEY);
    if (cached) return res.json(cached);
    const payload = await buildHome(null);
    advancedCache.set(HOME_CACHE_KEY, payload, { ttlMs: HOME_CACHE_TTL_MS, tags: ['content'] });
    return res.json(payload);
  }
  return res.json(await buildHome(req.user));
}));

/**
 * GET /player/:id — public compact player payload. resolvePlayer is async and
 * may call the YouTube API for the trailer fallback, so this is never cached.
 */
router.get('/player/:id', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid content id' });
  }

  const content = await getContentById(id);
  if (!content) return res.status(404).json({ error: 'Content not found' });

  const resolved = await resolvePlayer(content);
  const metadata = content.metadata || {};

  // nextUp: the next trending item that isn't the current one (null if none).
  const trending = await trendingContent();
  const next = trending.find((r) => num(r.id) !== id) || null;

  return res.json({
    content: { ...compactItem(content), overview: metadata.overview || metadata.synopsis || null },
    mode: resolved.mode,
    allowedTypes: resolved.allowedTypes,
    sources: resolved.sources,
    primary: resolved.primary || null,
    nextUp: next ? compactItem(next) : null,
  });
}));

/** GET /profile — authenticated mobile profile card. */
router.get('/profile', requireAuth, wrap(async (req, res) => {
  const plan = req.user.plan || 'free';
  const watchRow = await one(`SELECT COUNT(*)::int AS count FROM watchlist WHERE userid = $1`, [req.user.id]);
  const recent = await continueWatching(req.user.id, 5);
  res.json({
    user: req.user,
    plan,
    limits: planLimits(plan),
    watchlistCount: num(watchRow?.count),
    recentHistory: recent.map((r) => ({
      content: compactItem(r),
      watchedat: isoOrNull(r.watchedat),
      progress: num(r.progress),
    })),
  });
}));

/** GET /config — public client bootstrap (versions, feature flags, endpoints). */
router.get('/config', (_req, res) => {
  res.json({
    versions: { min: HOME_CONFIG.minVersion, latest: HOME_CONFIG.latestVersion },
    features: { ai: true, social: true, premium: true, workers: true },
    endpoints: {
      home: '/api/mobile/home',
      player: '/api/mobile/player/:id',
      profile: '/api/mobile/profile',
    },
  });
});

export default router;
