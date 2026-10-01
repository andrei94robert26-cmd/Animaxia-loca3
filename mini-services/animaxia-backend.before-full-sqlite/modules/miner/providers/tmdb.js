/**
 * modules/miner/providers/tmdb.js — FAZA 12 miner provider: TMDB movies.
 *
 * Additive, standalone module (no existing file is touched). Uses the same
 * fetchProviderJson breaker-backed fetcher and externalid/metadata
 * conventions as the Phase-3 tasks/refresh.mjs worker, but adds:
 *   • pagination (discover + trending endpoints accept ?page=)
 *   • normalizeToContentRow() → a ready-to-upsert content row
 *   • per-tenant provenance info returned alongside the rows
 *
 * Env (existing, no new keys required): TMDBAPIKEY, TMDBBASEURL.
 */

import { fetchProviderJson } from '../../../utils/fetcher.js';

const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p/w500';
const DEFAULT_BASE = 'https://api.themoviedb.org/3';
const DEFAULT_PAGE_SIZE = 20;

function tmdbBase() {
  return process.env.TMDBBASEURL || DEFAULT_BASE;
}

/**
 * Fetch one page of TMDB movies. mode:
 *   'trending'  → /trending/movie/day (the classic refresh feed)
 *   'discover'  → /discover/movie?sort_by=popularity.desc (deep catalog)
 * Returns the RAW provider payload (results array + page metadata).
 */
export async function fetchMoviesPage(page = 1, { mode = 'trending' } = {}) {
  const safePage = Math.max(1, Math.min(500, Number(page) || 1));
  const url =
    mode === 'discover'
      ? `${tmdbBase()}/discover/movie`
      : `${tmdbBase()}/trending/movie/day`;
  const payload = await fetchProviderJson('tmdb', url, {
    params: mode === 'discover'
      ? { api_key: process.env.TMDBAPIKEY, page: safePage, sort_by: 'popularity.desc', include_adult: 'false' }
      : { api_key: process.env.TMDBAPIKEY, page: safePage },
  });
  return {
    provider: 'tmdb',
    kind: 'movie',
    mode,
    page: safePage,
    items: Array.isArray(payload?.results) ? payload.results : [],
    totalPages: Number(payload?.total_pages) || 1,
  };
}

/**
 * Map one raw TMDB movie item → a content-table upsert row, following the
 * seed.js / refresh.mjs conventions (externalid 'tmdb:movie:{id}',
 * metadata.source 'tmdb-miner' to distinguish miner-synced rows).
 */
export function normalizeToContentRow(item) {
  const externalid = `tmdb:movie:${item?.id}`;
  return {
    externalid,
    type: 'movie',
    title: item?.title || item?.name || item?.original_title || 'Untitled',
    thumbnail: item?.poster_path ? `${TMDB_IMAGE_BASE}${item.poster_path}` : null,
    metadata: {
      source: 'tmdb-miner',
      mediaType: 'movie',
      overview: item?.overview || '',
      rating: item?.vote_average ?? null,
      votes: item?.vote_count ?? null,
      year: item?.release_date ? String(item.release_date).slice(0, 4) : null,
      language: item?.original_language || null,
      popularity: item?.popularity ?? null,
      genres: [], // discover/trending lists carry genre ids only; names need a second call
    },
    provenance: { provider: 'tmdb', externalid, kind: 'movie' },
  };
}

/** Convenience: fetch a page + normalize every item. */
export async function fetchMoviesRows(page = 1, { mode = 'trending' } = {}) {
  const result = await fetchMoviesPage(page, { mode });
  return {
    ...result,
    rows: result.items.map(normalizeToContentRow).slice(0, DEFAULT_PAGE_SIZE),
  };
}

export const TMDB_PROVIDER_NAME = 'tmdb';
