/**
 * modules/miner/providers/jikan.js — FAZA 12 miner provider: Jikan (MAL) anime.
 *
 * Additive, standalone module. Same conventions as tmdb.js:
 *   • pagination (/top/anime?page=N — Jikan v4 caps at 250 pages)
 *   • normalizeToContentRow() → ready-to-upsert content row
 *   • breaker-backed fetcher via fetchProviderJson('jikan', …)
 *
 * Env (existing, no new keys required): JIKANBASEURL.
 * Jikan rate limit ≈ 3 req/s — the miner issues ONE request per page job.
 */

import { fetchProviderJson } from '../../../utils/fetcher.js';

const DEFAULT_BASE = 'https://api.jikan.moe/v4';
const JIKAN_MAX_PAGE = 250;

function jikanBase() {
  return process.env.JIKANBASEURL || DEFAULT_BASE;
}

/**
 * Fetch one page of Jikan top anime. Returns the RAW provider payload
 * (data array + pagination metadata).
 */
export async function fetchAnimePage(page = 1) {
  const safePage = Math.max(1, Math.min(JIKAN_MAX_PAGE, Number(page) || 1));
  const payload = await fetchProviderJson('jikan', `${jikanBase()}/top/anime`, {
    params: { page: safePage, limit: 20 },
  });
  return {
    provider: 'jikan',
    kind: 'anime',
    page: safePage,
    items: Array.isArray(payload?.data) ? payload.data : [],
    totalPages: Number(payload?.pagination?.last_visible_page) || 1,
  };
}

/**
 * Map one raw Jikan anime item → a content-table upsert row, following the
 * refresh.mjs conventions (externalid 'jikan:anime:{mal_id}',
 * metadata.source 'jikan-miner'; both `rating` and `score` are kept since
 * seed rows use `score` while search/UI normalises `rating`).
 */
export function normalizeToContentRow(item) {
  const externalid = `jikan:anime:${item?.mal_id}`;
  return {
    externalid,
    type: 'anime',
    title: item?.title || item?.title_english || item?.title_japanese || 'Untitled',
    thumbnail:
      item?.images?.jpg?.large_image_url ||
      item?.images?.webp?.large_image_url ||
      null,
    metadata: {
      source: 'jikan-miner',
      mediaType: 'anime',
      synopsis: String(item?.synopsis || '').slice(0, 1000),
      rating: item?.score ?? item?.scored ?? null,
      score: item?.score ?? item?.scored ?? null,
      year: item?.year || (item?.aired?.from ? String(item.aired.from).slice(0, 4) : null),
      episodes: item?.episodes ?? null,
      status: item?.status || null,
      genres: (item?.genres || []).map((g) => g.name).slice(0, 6),
    },
    provenance: { provider: 'jikan', externalid, kind: 'anime' },
  };
}

/** Convenience: fetch a page + normalize every item. */
export async function fetchAnimeRows(page = 1) {
  const result = await fetchAnimePage(page);
  return { ...result, rows: result.items.map(normalizeToContentRow) };
}

export const JIKAN_PROVIDER_NAME = 'jikan';
