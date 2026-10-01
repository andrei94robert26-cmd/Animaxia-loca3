/**
 * domain/providers/jikan.js — /api/anime router backed by Jikan v4 (MyAnimeList).
 * Jikan is flaky from this datacenter — all calls go through the provider layer
 * (retries + backoff + circuit breaker + response caching).
 */

import express from 'express';
import { fetchProviderJson, ProviderError } from '@animaxia/common/fetcher.js';
import { logger } from '@animaxia/common/logger.js';

const BASE = process.env.JIKANBASEURL || 'https://api.jikan.moe/v4';
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizeAnime(item) {
  if (!item) return null;
  return {
    id: item.mal_id,
    title: item.title || item.title_english || 'Untitled',
    image:
      item.images?.jpg?.large_image_url ||
      item.images?.webp?.large_image_url ||
      item.images?.jpg?.image_url ||
      null,
    score: item.score ?? item.scored ?? null,
    year: item.year || (item.aired?.from ? String(item.aired.from).slice(0, 4) : null),
    type: item.type || 'TV',
    genres: (item.genres || []).map((g) => g.name),
    synopsis: item.synopsis || '',
    url: item.url || '',
    source: 'jikan',
  };
}

function jikan(path, params = {}, retries = 2) {
  return fetchProviderJson('jikan', `${BASE}${path}`, { params, retries, timeoutMs: 10000 });
}

const router = express.Router();

router.get(
  '/top',
  wrap(async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const data = await jikan('/top/anime', { page, limit: 24 }, 3);
    res.json({ data: (data.data || []).map(normalizeAnime).filter(Boolean) });
  }),
);

router.get(
  '/search',
  wrap(async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q) return res.status(400).json({ error: 'Missing q parameter' });
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const data = await jikan('/anime', { q, limit, sfw: 'true' }, 3);
    res.json({ data: (data.data || []).map(normalizeAnime).filter(Boolean) });
  }),
);

router.get(
  '/season',
  wrap(async (req, res) => {
    const data = await jikan('/seasons/now', { limit: 24, sfw: 'true' }, 3);
    res.json({ data: (data.data || []).map(normalizeAnime).filter(Boolean) });
  }),
);

router.get(
  '/random',
  wrap(async (req, res) => {
    // Jikan /random is the flakiest endpoint — 3 attempts with fixed 1500ms gaps.
    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const data = await jikan('/random/anime', {}, 0);
        return res.json({ data: normalizeAnime(data.data) });
      } catch (err) {
        lastError = err;
        if (attempt < 3) await sleep(1500);
      }
    }
    logger.error(`[anime] /random failed after 3 attempts: ${lastError?.message}`);
    return res.status(502).json({ error: `Jikan unavailable: ${lastError?.message || 'unknown error'}` });
  }),
);

router.get(
  '/:id',
  wrap(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid anime id' });
    }
    let data;
    try {
      data = await jikan(`/anime/${id}/full`, {}, 2);
    } catch (err) {
      if (err instanceof ProviderError && (err.status === 404 || err.status === 400)) {
        return res.status(404).json({ error: 'Anime not found' });
      }
      throw err;
    }
    if (!data?.data) return res.status(404).json({ error: 'Anime not found' });
    const item = normalizeAnime(data.data);
    res.json({
      data: {
        ...item,
        status: data.data.status || null,
        episodes: data.data.episodes ?? null,
        studios: (data.data.studios || []).map((s) => s.name),
      },
    });
  }),
);

export default router;
