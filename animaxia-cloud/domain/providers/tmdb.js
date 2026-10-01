/**
 * domain/providers/tmdb.js — TMDB routers for movies (/api/movies) and TV (/api/tv).
 * Includes a 24h-cached genre map (movie/tv) and MediaItem normalization.
 */

import express from 'express';
import { fetchProviderJson, ProviderError } from '@animaxia/common/fetcher.js';
import { cache } from '@animaxia/common/cache.js';

const BASE = process.env.TMDBBASEURL || 'https://api.themoviedb.org/3';
const API_KEY = process.env.TMDBAPIKEY || '';
const IMAGE_BASE = 'https://image.tmdb.org/t/p';
const GENRE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function tmdbFetch(path, params = {}) {
  return fetchProviderJson('tmdb', `${BASE}${path}`, {
    params: { api_key: API_KEY, ...params },
    timeoutMs: 10000,
  });
}

export async function getGenreMap(mediaType) {
  const key = `tmdb:genreMap:${mediaType}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const data = await tmdbFetch(`/genre/${mediaType}/list`);
  const map = {};
  for (const genre of data.genres || []) map[genre.id] = genre.name;
  cache.set(key, map, GENRE_CACHE_TTL_MS);
  return map;
}

function genreNames(item, mediaType, map) {
  if (Array.isArray(item.genres) && item.genres.length > 0) {
    return item.genres.map((g) => g.name).filter(Boolean);
  }
  if (Array.isArray(item.genre_ids)) {
    return item.genre_ids.map((id) => map[id]).filter(Boolean);
  }
  return [];
}

function normalizeMedia(item, mediaType = 'movie', genreMap = {}) {
  if (!item || !item.id) return null;
  return {
    id: item.id,
    title: item.title || item.name || 'Untitled',
    image: item.poster_path ? `${IMAGE_BASE}/w500${item.poster_path}` : null,
    backdrop: item.backdrop_path ? `${IMAGE_BASE}/w780${item.backdrop_path}` : null,
    overview: item.overview || '',
    rating: item.vote_average ?? null,
    year: (item.release_date || item.first_air_date || '').slice(0, 4) || null,
    mediaType,
    genres: genreNames(item, mediaType, genreMap),
    source: 'tmdb',
  };
}

async function normalizeListWithGenres(payload, mediaType) {
  const map = await getGenreMap(mediaType);
  const results = Array.isArray(payload?.results) ? payload.results : [];
  return results.map((item) => normalizeMedia(item, mediaType, map)).filter(Boolean);
}

function firstTrailerKey(videos) {
  const results = Array.isArray(videos?.results) ? videos.results : [];
  const trailer = results.find((v) => v.type === 'Trailer' && v.site === 'YouTube');
  return trailer ? trailer.key : null;
}

function pageParam(req) {
  const page = parseInt(req.query.page, 10);
  return Number.isInteger(page) && page > 0 ? page : 1;
}

/* ------------------------------ movies router ----------------------------- */

export const moviesRouter = express.Router();

moviesRouter.get(
  '/trending',
  wrap(async (req, res) => {
    const window_ = req.query.window === 'week' ? 'week' : 'day';
    const payload = await tmdbFetch(`/trending/movie/${window_}`, { page: pageParam(req) });
    res.json({ data: await normalizeListWithGenres(payload, 'movie') });
  }),
);

moviesRouter.get(
  '/popular',
  wrap(async (req, res) => {
    const payload = await tmdbFetch('/movie/popular', { page: pageParam(req) });
    res.json({ data: await normalizeListWithGenres(payload, 'movie') });
  }),
);

moviesRouter.get(
  '/top',
  wrap(async (req, res) => {
    const payload = await tmdbFetch('/movie/top_rated', { page: pageParam(req) });
    res.json({ data: await normalizeListWithGenres(payload, 'movie') });
  }),
);

moviesRouter.get(
  '/upcoming',
  wrap(async (req, res) => {
    const payload = await tmdbFetch('/movie/upcoming', { page: pageParam(req) });
    res.json({ data: await normalizeListWithGenres(payload, 'movie') });
  }),
);

moviesRouter.get(
  '/search',
  wrap(async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q) return res.status(400).json({ error: 'Missing q parameter' });
    const payload = await tmdbFetch('/search/multi', { query: q, page: pageParam(req), include_adult: 'false' });
    const movieMap = await getGenreMap('movie');
    const tvMap = await getGenreMap('tv');
    const items = (payload?.results || [])
      .filter((item) => item.media_type === 'movie' || item.media_type === 'tv')
      .map((item) => normalizeMedia(item, item.media_type, item.media_type === 'tv' ? tvMap : movieMap))
      .filter(Boolean);
    res.json({ data: items });
  }),
);

moviesRouter.get(
  '/:id',
  wrap(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid movie id' });
    let detail;
    try {
      detail = await tmdbFetch(`/movie/${id}`, { append_to_response: 'videos,credits' });
    } catch (err) {
      if (err instanceof ProviderError && err.status === 404) {
        return res.status(404).json({ error: 'Movie not found' });
      }
      throw err;
    }
    const base = normalizeMedia(detail, 'movie', {});
    const cast = (detail.credits?.cast || []).slice(0, 8).map((c) => ({
      name: c.name,
      character: c.character || '',
      profile: c.profile_path ? `${IMAGE_BASE}/w185${c.profile_path}` : null,
    }));
    res.json({
      data: {
        ...base,
        genres: (detail.genres || []).map((g) => g.name),
        trailerKey: firstTrailerKey(detail.videos),
        tagline: detail.tagline || '',
        runtime: detail.runtime ?? null,
        cast,
      },
    });
  }),
);

/* -------------------------------- tv router ------------------------------- */

export const tvRouter = express.Router();

tvRouter.get(
  '/trending',
  wrap(async (req, res) => {
    const window_ = req.query.window === 'week' ? 'week' : 'day';
    const payload = await tmdbFetch(`/trending/tv/${window_}`, { page: pageParam(req) });
    res.json({ data: await normalizeListWithGenres(payload, 'tv') });
  }),
);

tvRouter.get(
  '/popular',
  wrap(async (req, res) => {
    const payload = await tmdbFetch('/tv/popular', { page: pageParam(req) });
    res.json({ data: await normalizeListWithGenres(payload, 'tv') });
  }),
);

tvRouter.get(
  '/top',
  wrap(async (req, res) => {
    const payload = await tmdbFetch('/tv/top_rated', { page: pageParam(req) });
    res.json({ data: await normalizeListWithGenres(payload, 'tv') });
  }),
);

tvRouter.get(
  '/search',
  wrap(async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q) return res.status(400).json({ error: 'Missing q parameter' });
    const payload = await tmdbFetch('/search/tv', { query: q, page: pageParam(req), include_adult: 'false' });
    const map = await getGenreMap('tv');
    res.json({
      data: (payload?.results || []).map((item) => normalizeMedia(item, 'tv', map)).filter(Boolean),
    });
  }),
);

tvRouter.get(
  '/:id',
  wrap(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid tv id' });
    let detail;
    try {
      detail = await tmdbFetch(`/tv/${id}`, { append_to_response: 'videos' });
    } catch (err) {
      if (err instanceof ProviderError && err.status === 404) {
        return res.status(404).json({ error: 'TV show not found' });
      }
      throw err;
    }
    const base = normalizeMedia(detail, 'tv', {});
    res.json({
      data: {
        ...base,
        genres: (detail.genres || []).map((g) => g.name),
        trailerKey: firstTrailerKey(detail.videos),
        episodes: detail.number_of_episodes ?? null,
        seasons: detail.number_of_seasons ?? null,
      },
    });
  }),
);
