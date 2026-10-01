/**
 * modules/discover/collections.js — Franchise & Trilogy hubs backed by REAL
 * TMDB collections (curated names resolved at runtime via /search/collection,
 * then hydrated with /collection/{id} parts).
 *
 *   GET /api/franchises  → curated franchise collections (Star Wars, Harry
 *                           Potter, Marvel-adjacent sagas, …) with parts
 *   GET /api/trilogies   → curated trilogy-first collections (LOTR, The Dark
 *                           Knight, The Godfather, …)
 *
 * Parts use the MediaItem shape (mediaType 'movie') so the frontend can open
 * them straight through the external content path (ext:movie:{id}).
 *
 * Reliability: the whole hub payload is cached in-process for 12h; failed
 * lookups are skipped and reported in `failed`; a warm-up runs shortly after
 * boot so the first user hit is already cached.
 */

import express from 'express';
import { tmdbFetch } from '../movies/tmdb.js';
import { cache } from '../../cache.js';
import { logger } from '../../utils/logger.js';

const IMAGE_BASE = 'https://image.tmdb.org/t/p';
const HUB_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const RESOLVE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/* ------------------------------ curated names ------------------------------ */

export const FRANCHISE_NAMES = [
  'Star Wars Collection',
  'Harry Potter Collection',
  'James Bond Collection',
  'The Lord of the Rings Collection',
  'The Fast and the Furious Collection',
  'Mission: Impossible Collection',
  'Jurassic Park Collection',
  'Pirates of the Caribbean Collection',
  'The Matrix Collection',
  'Mad Max Collection',
  'Spider-Man Collection',
  'Batman Collection',
  'X-Men Collection',
  'Indiana Jones Collection',
  'The Terminator Collection',
  'Alien Collection',
  'John Wick Collection',
  'Toy Story Collection',
  'Shrek Collection',
  'The Hobbit Collection',
  'The Dark Knight Collection',
  'The Godfather Collection',
  'Back to the Future Collection',
];

export const TRILOGY_NAMES = [
  'The Lord of the Rings Collection',
  'The Dark Knight Collection',
  'The Godfather Collection',
  'Back to the Future Collection',
  'The Matrix Collection',
  'Three Colors Collection',
  'Apu Collection',
  'Spider-Man Collection',
  'Toy Story Collection',
  'Mad Max Collection',
];

/* ------------------------------- resolution -------------------------------- */

async function resolveCollectionId(name) {
  const key = `tmdb:collId:v2:${name}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const payload = await tmdbFetch('/search/collection', { query: name, include_adult: 'false' });
  const results = payload?.results || [];
  // TMDB search relevance can surface lookalikes ("Jurassic Shark Collection"
  // for "Jurassic Park Collection") — prefer an exact (case-insensitive) name
  // match, then a startsWith match, then the first result.
  const lower = name.toLowerCase();
  const exact = results.find((r) => String(r.name || '').toLowerCase() === lower);
  const starts = exact || results.find((r) => String(r.name || '').toLowerCase().startsWith(lower));
  const chosen = starts || results[0];
  const id = chosen ? Number(chosen.id) : null;
  cache.set(key, id, RESOLVE_CACHE_TTL_MS);
  return id;
}

function normalizePart(p) {
  if (!p || !p.id) return null;
  return {
    id: p.id,
    title: p.title || p.name || 'Untitled',
    image: p.poster_path ? `${IMAGE_BASE}/w500${p.poster_path}` : null,
    overview: p.overview || '',
    rating: p.vote_average ?? null,
    year: (p.release_date || '').slice(0, 4) || null,
    mediaType: 'movie',
    source: 'tmdb',
  };
}

async function buildCollection(name) {
  const id = await resolveCollectionId(name);
  if (!id) return null;
  const detail = await tmdbFetch(`/collection/${id}`, {});
  const parts = (detail?.parts || [])
    .filter((p) => p && p.id && !p.adult)
    .map(normalizePart)
    .filter(Boolean)
    .sort((a, b) => String(a.year).localeCompare(String(b.year)));
  if (parts.length === 0) return null;
  const ratings = parts.map((p) => p.rating).filter((r) => typeof r === 'number' && r > 0);
  return {
    id,
    name: detail?.name || name,
    overview: detail?.overview || '',
    poster: detail?.poster_path ? `${IMAGE_BASE}/w500${detail.poster_path}` : null,
    backdrop: detail?.backdrop_path ? `${IMAGE_BASE}/w780${detail.backdrop_path}` : null,
    partCount: parts.length,
    avgRating: ratings.length ? Number((ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(1)) : null,
    years: parts.length
      ? { first: parts[0].year || null, last: parts[parts.length - 1].year || null }
      : null,
    parts,
  };
}

async function buildHub(names, cacheKey, { trilogiesFirst = false } = {}) {
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  const settled = await Promise.allSettled(names.map((name) => buildCollection(name)));
  const data = [];
  const failed = [];
  for (let i = 0; i < names.length; i += 1) {
    const outcome = settled[i];
    if (outcome.status === 'fulfilled' && outcome.value) data.push(outcome.value);
    else failed.push(names[i]);
  }
  if (trilogiesFirst) {
    // Trilogies first (exactly 3 parts), then bigger sagas; then alphabetical.
    data.sort((a, b) => {
      const aTrio = a.partCount === 3 ? 0 : 1;
      const bTrio = b.partCount === 3 ? 0 : 1;
      if (aTrio !== bTrio) return aTrio - bTrio;
      return a.name.localeCompare(b.name);
    });
  } else {
    // Franchise hub: biggest sagas first, then alphabetical.
    data.sort((a, b) => {
      if (b.partCount !== a.partCount) return b.partCount - a.partCount;
      return a.name.localeCompare(b.name);
    });
  }
  const payload = { total: data.length, failed, data };
  cache.set(cacheKey, payload, HUB_CACHE_TTL_MS);
  return payload;
}

/* --------------------------------- routers --------------------------------- */

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export const franchiseRouter = express.Router();

franchiseRouter.get(
  '/',
  wrap(async (req, res) => {
    res.json(await buildHub(FRANCHISE_NAMES, 'hub:franchises'));
  }),
);

franchiseRouter.get(
  '/trilogies',
  wrap(async (req, res) => {
    res.json(await buildHub(TRILOGY_NAMES, 'hub:trilogies', { trilogiesFirst: true }));
  }),
);

export const trilogyRouter = express.Router();

trilogyRouter.get(
  '/',
  wrap(async (req, res) => {
    res.json(await buildHub(TRILOGY_NAMES, 'hub:trilogies'));
  }),
);

/* FAZA 15: programmatic access for the AI home engine (metadata extraction). */
export function getFranchiseHub() {
  return buildHub(FRANCHISE_NAMES, 'hub:franchises');
}
export function getTrilogyHub() {
  return buildHub(TRILOGY_NAMES, 'hub:trilogies', { trilogiesFirst: true });
}

/* Fire-and-forget warm-up so the first user visit is already cached. */
setTimeout(() => {
  buildHub(FRANCHISE_NAMES, 'hub:franchises')
    .then((r) => logger.info(`[collections] franchises warm-up: ${r.total} collections, ${r.failed.length} failed`))
    .catch((err) => logger.warn(`[collections] franchises warm-up failed: ${err.message}`));
  buildHub(TRILOGY_NAMES, 'hub:trilogies', { trilogiesFirst: true })
    .then((r) => logger.info(`[collections] trilogies warm-up: ${r.total} collections, ${r.failed.length} failed`))
    .catch((err) => logger.warn(`[collections] trilogies warm-up failed: ${err.message}`));
}, 4000).unref?.();
