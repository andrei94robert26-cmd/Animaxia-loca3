/**
 * tasks/refresh.mjs — worker task: pull fresh "trending/top" pages from TMDB
 * or Jikan and upsert the first 10 results into the content table, following
 * the seed.js externalid + metadata conventions (mediaType included for UI
 * compatibility; Jikan rows carry both `rating` and `score` since seed rows
 * historically use `score` while the platform search/UI normalises `rating`).
 *
 * workerData: { source: 'tmdb' | 'jikan', userid? }
 * posts:      { ok: true, upserted: n, source } | { ok: false, error }
 *
 * The main-thread pool emits `content:changed` after a successful run.
 */

import { parentPort, workerData } from 'node:worker_threads';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';

dotenv.config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });

const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p/w500';

/** TMDB trending movies of the day → first 10 upserts (tmdb:movie:{id}). */
async function refreshTmdb({ upsertContent }) {
  const base = process.env.TMDBBASEURL || 'https://api.themoviedb.org/3';
  const { fetchProviderJson } = await import('../../../utils/fetcher.js');
  const payload = await fetchProviderJson('tmdb', `${base}/trending/movie/day`, {
    params: { api_key: process.env.TMDBAPIKEY },
  });
  const results = (payload?.results || []).slice(0, 10);
  let upserted = 0;
  for (const item of results) {
    try {
      await upsertContent({
        externalid: `tmdb:movie:${item.id}`,
        type: 'movie',
        title: item.title || item.name || 'Untitled',
        thumbnail: item.poster_path ? `${TMDB_IMAGE_BASE}${item.poster_path}` : null,
        metadata: {
          source: 'tmdb-auto',
          mediaType: 'movie',
          overview: item.overview || '',
          rating: item.vote_average ?? null,
          year: item.release_date ? String(item.release_date).slice(0, 4) : null,
          genres: [],
        },
      });
      upserted += 1;
    } catch {
      /* skip individual failures — one bad row must not kill the run */
    }
  }
  return upserted;
}

/** Jikan top anime → first 10 upserts (jikan:anime:{mal_id}). */
async function refreshJikan({ upsertContent }) {
  const base = process.env.JIKANBASEURL || 'https://api.jikan.moe/v4';
  const { fetchProviderJson } = await import('../../../utils/fetcher.js');
  const payload = await fetchProviderJson('jikan', `${base}/top/anime`, { timeoutMs: 15000 });
  const results = (payload?.data || []).slice(0, 10);
  let upserted = 0;
  for (const item of results) {
    try {
      await upsertContent({
        externalid: `jikan:anime:${item.mal_id}`,
        type: 'anime',
        title: item.title || item.title_english || 'Untitled',
        thumbnail: item.images?.jpg?.large_image_url || item.images?.webp?.large_image_url || null,
        metadata: {
          source: 'jikan-auto',
          mediaType: 'anime',
          synopsis: String(item.synopsis || '').slice(0, 1000),
          rating: item.score ?? item.scored ?? null,
          score: item.score ?? item.scored ?? null,
          year: item.year || (item.aired?.from ? String(item.aired.from).slice(0, 4) : null),
          genres: (item.genres || []).map((g) => g.name).slice(0, 5),
        },
      });
      upserted += 1;
    } catch {
      /* skip individual failures */
    }
  }
  return upserted;
}

/* ---------------------------------- task body -------------------------------- */

try {
  const { source } = workerData || {};
  if (source !== 'tmdb' && source !== 'jikan') {
    throw new Error('refresh task requires source "tmdb" or "jikan"');
  }

  const { initDb, closeDb, upsertContent } = await import('../../../db.js');
  await initDb();

  const upserted = source === 'tmdb' ? await refreshTmdb({ upsertContent }) : await refreshJikan({ upsertContent });

  await closeDb();
  parentPort.postMessage({ ok: true, source, upserted });
} catch (err) {
  try {
    const { closeDb } = await import('../../../db.js');
    await closeDb();
  } catch {
    /* pool may never have opened */
  }
  parentPort.postMessage({ ok: false, error: err?.message || String(err) });
}
