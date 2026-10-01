/**
 * domain/platform/seed.js — Initial content seeding: 3 always-available demo playable items,
 * TMDB trending movies + TV, and top anime via Jikan (with a TMDB anime
 * fallback when Jikan is unreachable). Each step fails independently.
 */

import { db } from '@animaxia/common/db.js';
import { fetchProviderJson } from '@animaxia/common/fetcher.js';
import { tmdbFetch, getGenreMap } from '@animaxia/domain/providers/tmdb.js';
import { logger } from '@animaxia/common/logger.js';

const IMAGE_BASE = 'https://image.tmdb.org/t/p';
const JIKAN_BASE = process.env.JIKANBASEURL || 'https://api.jikan.moe/v4';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const DEMO_ITEMS = [
  {
    externalid: 'demo:big-buck-bunny',
    type: 'movie',
    title: 'Big Buck Bunny',
    thumbnail: '/posters/big-buck-bunny.jpg',
    metadata: {
      source: 'demo',
      mediaType: 'movie',
      year: 2008,
      rating: 7.4,
      genres: ['Animation', 'Comedy', 'Family'],
      overview:
        'A big good-natured rabbit takes sweet revenge on three bullying rodents in this beloved open-source animated short from the Blender Foundation.',
      backdrop: '/posters/backdrop.jpg',
      player: {
        sources: [
          {
            type: 'mp4',
            url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
            label: '1080p · MP4',
          },
          {
            type: 'mp4',
            url: 'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/720/Big_Buck_Bunny_720_10s_1MB.mp4',
            label: '720p clip · test-videos',
          },
        ],
      },
    },
  },
  {
    externalid: 'demo:sintel',
    type: 'movie',
    title: 'Sintel',
    thumbnail: '/posters/sintel.jpg',
    metadata: {
      source: 'demo',
      mediaType: 'movie',
      year: 2010,
      rating: 7.5,
      genres: ['Animation', 'Fantasy', 'Adventure'],
      overview:
        'A lonely young woman travels far from home searching for Scales, the baby dragon she once nursed back to health, in this epic Blender Foundation fantasy.',
      backdrop: '/posters/backdrop.jpg',
      player: {
        sources: [
          {
            type: 'mp4',
            url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/Sintel.mp4',
            label: '1080p · MP4',
          },
          {
            type: 'mp4',
            url: 'https://media.w3.org/2010/05/sintel/trailer.mp4',
            label: 'Trailer · w3.org',
          },
        ],
      },
    },
  },
  {
    externalid: 'demo:hls-stream',
    type: 'featured',
    title: 'Animaxia HLS Demo',
    thumbnail: '/posters/hls-demo.jpg',
    metadata: {
      source: 'demo',
      mediaType: 'demo',
      year: 2025,
      rating: 8.0,
      genres: ['Demo', 'Streaming'],
      overview:
        'Adaptive bitrate HLS test streams (Apple BipBop + Mux) demonstrating native m3u8 playback in the Animaxia player.',
      backdrop: '/posters/backdrop.jpg',
      player: {
        sources: [
          {
            type: 'm3u8',
            url: 'https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_ts/master.m3u8',
            label: 'Apple BipBop · HLS',
          },
          {
            type: 'm3u8',
            url: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
            label: 'Mux Test · HLS',
          },
        ],
      },
    },
  },
];

async function seedTmdbTrending(mediaType) {
  const payload = await tmdbFetch(`/trending/${mediaType}/day`);
  const results = (payload?.results || []).slice(0, 20);
  let genreMap = {};
  try {
    genreMap = await getGenreMap(mediaType);
  } catch {
    genreMap = {};
  }
  let added = 0;
  for (const item of results) {
    try {
      await db.upsertContent({
        externalid: `tmdb:${mediaType}:${item.id}`,
        type: mediaType,
        title: item.title || item.name || 'Untitled',
        thumbnail: item.poster_path ? `${IMAGE_BASE}/w500${item.poster_path}` : null,
        metadata: {
          source: 'tmdb',
          mediaType,
          overview: item.overview || '',
          rating: item.vote_average ?? null,
          year: (item.release_date || item.first_air_date || '').slice(0, 4) || null,
          genres: (item.genre_ids || []).map((id) => genreMap[id]).filter(Boolean),
          backdrop: item.backdrop_path ? `${IMAGE_BASE}/w780${item.backdrop_path}` : null,
        },
      });
      added += 1;
    } catch (err) {
      logger.warn(`[seed] Failed to upsert tmdb:${mediaType}:${item.id}: ${err.message}`);
    }
  }
  return added;
}

async function seedAnimeFromJikan() {
  let payload = null;
  let lastError = null;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      payload = await fetchProviderJson('jikan', `${JIKAN_BASE}/top/anime`, {
        params: { limit: 20 },
        retries: 0,
        timeoutMs: 10000,
      });
      break;
    } catch (err) {
      lastError = err;
      logger.warn(`[seed] Jikan attempt ${attempt}/4 failed: ${err.message}`);
      if (attempt < 4) await sleep(4000);
    }
  }
  if (!payload?.data) {
    throw lastError || new Error('Jikan returned no data');
  }
  let added = 0;
  for (const item of payload.data.slice(0, 20)) {
    try {
      await db.upsertContent({
        externalid: `jikan:anime:${item.mal_id}`,
        type: 'anime',
        title: item.title || item.title_english || 'Untitled',
        thumbnail: item.images?.jpg?.large_image_url || item.images?.webp?.large_image_url || null,
        metadata: {
          source: 'jikan',
          mediaType: 'anime',
          synopsis: item.synopsis || '',
          score: item.score ?? item.scored ?? null,
          year: item.year || (item.aired?.from ? String(item.aired.from).slice(0, 4) : null),
          genres: (item.genres || []).slice(0, 4).map((g) => g.name),
          url: item.url || '',
        },
      });
      added += 1;
    } catch (err) {
      logger.warn(`[seed] Failed to upsert jikan:anime:${item.mal_id}: ${err.message}`);
    }
  }
  return added;
}

async function seedAnimeFromTmdb() {
  const payload = await tmdbFetch('/discover/tv', {
    with_genres: 16,
    with_original_language: 'ja',
    sort_by: 'popularity.desc',
    page: 1,
  });
  const results = (payload?.results || []).slice(0, 20);
  let genreMap = {};
  try {
    genreMap = await getGenreMap('tv');
  } catch {
    genreMap = {};
  }
  let added = 0;
  for (const item of results) {
    try {
      await db.upsertContent({
        externalid: `tmdb:anime:${item.id}`,
        type: 'anime',
        title: item.name || item.title || 'Untitled',
        thumbnail: item.poster_path ? `${IMAGE_BASE}/w500${item.poster_path}` : null,
        metadata: {
          source: 'tmdb-anime',
          mediaType: 'anime',
          overview: item.overview || '',
          rating: item.vote_average ?? null,
          year: (item.first_air_date || '').slice(0, 4) || null,
          genres: (item.genre_ids || []).map((id) => genreMap[id]).filter(Boolean),
          backdrop: item.backdrop_path ? `${IMAGE_BASE}/w780${item.backdrop_path}` : null,
        },
      });
      added += 1;
    } catch (err) {
      logger.warn(`[seed] Failed to upsert tmdb:anime:${item.id}: ${err.message}`);
    }
  }
  return added;
}

/**
 * Seed demo items + TMDB trending movies/TV + top anime.
 * Demo items are seeded first and must never fail; remote steps degrade gracefully.
 */
export async function seed() {
  const added = { movie: 0, tv: 0, anime: 0, demo: 0 };
  let animeSource = 'jikan';

  try {
    for (const item of DEMO_ITEMS) {
      await db.upsertContent(item);
      added.demo += 1;
    }
  } catch (err) {
    logger.error(`[seed] Demo seeding failed (unexpected): ${err.message}`);
  }

  try {
    added.movie = await seedTmdbTrending('movie');
    logger.info(`[seed] Seeded ${added.movie} trending movies from TMDB`);
  } catch (err) {
    logger.warn(`[seed] TMDB movie seeding skipped: ${err.message}`);
  }

  try {
    added.tv = await seedTmdbTrending('tv');
    logger.info(`[seed] Seeded ${added.tv} trending TV shows from TMDB`);
  } catch (err) {
    logger.warn(`[seed] TMDB TV seeding skipped: ${err.message}`);
  }

  try {
    added.anime = await seedAnimeFromJikan();
    logger.info(`[seed] Seeded ${added.anime} anime from Jikan`);
  } catch (err) {
    logger.warn(`[seed] Jikan anime seeding failed (${err.message}) — falling back to TMDB anime`);
    try {
      animeSource = 'tmdb-fallback';
      added.anime = await seedAnimeFromTmdb();
      logger.info(`[seed] Seeded ${added.anime} anime via TMDB fallback`);
    } catch (fallbackErr) {
      logger.warn(`[seed] TMDB anime fallback also failed: ${fallbackErr.message}`);
    }
  }

  const totalItems = await db.countContent();
  return { added, totalItems, animeSource };
}
