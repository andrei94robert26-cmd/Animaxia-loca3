/**
 * modules/discover/discover.js — LIVE category feeds backing every sidebar
 * menu. GET /api/discover/:slug returns real TMDB items (MediaItem shape,
 * identical to /api/movies/* and /api/tv/*) so the frontend can reuse
 * mediaToItem() and the external content path (ext:movie:{id}).
 *
 * Slug catalog (verified live against TMDB):
 *   kids             movie 16,10751 + tv 16,10762
 *   telenovelas      tv 10766 (Soap)
 *   fun              movie 35 (Comedy)
 *   blockbusters     movie 28|12|878 sort revenue.desc
 *   marvel           movie|tv companies 420|7505 (Marvel Studios/Entertainment)
 *   dc               movie|tv companies 184898|9993 (DC Studios/Entertainment)
 *   disney           movie company 2 (Walt Disney Pictures) + tv network 54 (Disney Channel)
 *   jetix            tv network 142 (Toon Disney/Jetix block) + companies 11296|203278|95853
 *   foxkids          tv company 2106 (Saban Entertainment — the Fox Kids library)
 *   cartoon-network  tv network 56
 *   boomerang        tv companies 1353|300342 (Hanna-Barbera classics)
 *   minimax          tv origin HU|CZ|SK|RO + genres 16,10762 (Central-European kids)
 *   europa .. oceania tv with_origin_country + movie with_original_language
 *
 * NOTE (curățare utilizator): slug-urile music, docs, gaming, entertainment,
 * showbiz și reality au fost eliminate complet din platformă, împreună cu
 * meniurile aferente (Muzică, Documentare, Gaming, Divertisment, Show-biz,
 * Reality TV), la cererea explicită a utilizatorului.
 *
 * Every leg flows through the shared fetcher (circuit breaker + retry +
 * provider cache) and responses are additionally cached by cacheMiddleware.
 */

import express from 'express';
import { tmdbFetch, getGenreMap } from '../movies/tmdb.js';

const IMAGE_BASE = 'https://image.tmdb.org/t/p';

/* ------------------------------- slug catalog ------------------------------ */

const LANGS_EUROPE = 'fr|de|es|it|pl|sv|nl|cs|hu|ro|pt|ru|el|da|fi|no|tr|uk|ga|bg|hr';
const COUNTRIES_EUROPE =
  'FR|DE|ES|IT|GB|PL|NL|SE|NO|DK|FI|CZ|HU|RO|PT|IE|AT|CH|BE|GR|RU|UA|TR';

export const SLUG_CATALOG = {
  kids: {
    title: 'Copii & Desene',
    legs: [
      { type: 'movie', params: { with_genres: '16,10751' } },
      { type: 'tv', params: { with_genres: '16,10762' } },
    ],
  },
  telenovelas: {
    title: 'Telenovele',
    legs: [{ type: 'tv', params: { with_genres: 10766 } }],
    voteMin: 0,
  },
  fun: {
    title: 'Distracție',
    legs: [{ type: 'movie', params: { with_genres: 35 } }],
  },
  blockbusters: {
    title: 'Blockbustere',
    legs: [{ type: 'movie', params: { with_genres: '28|12|878', sort_by: 'revenue.desc' } }],
  },
  marvel: {
    title: 'Marvel',
    legs: [
      { type: 'movie', params: { with_companies: '420|7505' } },
      { type: 'tv', params: { with_companies: '420|7505' } },
    ],
  },
  dc: {
    title: 'DC',
    legs: [
      { type: 'movie', params: { with_companies: '184898|9993' } },
      { type: 'tv', params: { with_companies: '184898|9993' } },
    ],
  },
  disney: {
    title: 'Disney',
    legs: [
      { type: 'movie', params: { with_companies: 2 } },
      { type: 'tv', params: { with_networks: 54 } },
    ],
  },
  jetix: {
    title: 'Jetix',
    legs: [
      { type: 'tv', params: { with_networks: 142 } },
      { type: 'tv', params: { with_companies: '11296|203278|95853' } },
    ],
    voteMin: 0,
  },
  foxkids: {
    title: 'Fox Kids',
    legs: [{ type: 'tv', params: { with_companies: 2106 } }],
    voteMin: 0,
  },
  'cartoon-network': {
    title: 'Cartoon Network',
    legs: [{ type: 'tv', params: { with_networks: 56 } }],
  },
  boomerang: {
    title: 'Boomerang',
    legs: [{ type: 'tv', params: { with_companies: '1353|300342' } }],
  },
  minimax: {
    title: 'Minimax',
    legs: [
      { type: 'tv', params: { with_origin_country: 'HU|CZ|SK|RO', with_genres: '16,10762' } },
    ],
    voteMin: 0,
  },
  /* FAZA 32 (Canale Kids ×8 — cerință utilizator): slugs noi, 100% aditive.
   * ID-uri de rețea TMDB verificate live la 2026-09-26 prin /network/{id}
   * și /discover: Nickelodeon=13, Disney Channel=54, Nicktoons=224,
   * Disney Junior=281, Nick Jr.=35. Cartoonito nu are rețea distinctă în
   * TMDB (emisiunile sale sunt etichetate Cartoon Network/WB) ⇒ picioare
   * oneste companie+gen (Hanna-Barbera/WB + preșcolar). JimJam (canal
   * european de preșcolar) și Duck TV (muzică pentru bebeluși) nu au
   * rețea TMDB ⇒ aproximări oneste etichetate în liveSource. */
  nickelodeon: {
    title: 'Nickelodeon',
    legs: [{ type: 'tv', params: { with_networks: 13 } }],
  },
  'disney-channel': {
    title: 'Disney Channel',
    legs: [{ type: 'tv', params: { with_networks: 54 } }],
  },
  nicktoons: {
    title: 'Nicktoons',
    legs: [{ type: 'tv', params: { with_networks: 224 } }],
    voteMin: 0,
  },
  cartoonito: {
    title: 'Cartoonito',
    legs: [
      { type: 'tv', params: { with_companies: '1353|300342', with_genres: 10762 } },
    ],
    voteMin: 0,
  },
  'disney-junior': {
    title: 'Disney Junior',
    legs: [{ type: 'tv', params: { with_networks: 281 } }],
  },
  'nick-jr': {
    title: 'Nick Jr.',
    legs: [{ type: 'tv', params: { with_networks: 35 } }],
    voteMin: 0,
  },
  jimjam: {
    title: 'JimJam',
    legs: [
      { type: 'tv', params: { with_genres: 10762, with_origin_country: 'HU|CZ|SK|RO|PL' } },
    ],
    voteMin: 0,
  },
  'duck-tv': {
    title: 'Duck TV',
    legs: [
      { type: 'tv', params: { with_genres: '10751,10762' } },
      { type: 'movie', params: { with_genres: '10402,10751' } },
    ],
    voteMin: 0,
  },
  europa: {
    title: 'Europa',
    legs: [
      { type: 'tv', params: { with_origin_country: COUNTRIES_EUROPE } },
      { type: 'movie', params: { with_original_language: LANGS_EUROPE } },
    ],
  },
  'america-nord': {
    title: 'America de Nord',
    legs: [
      { type: 'tv', params: { with_origin_country: 'US|CA|MX' } },
      { type: 'movie', params: { with_original_language: 'en' } },
    ],
  },
  'america-sud': {
    title: 'America de Sud',
    legs: [
      { type: 'tv', params: { with_origin_country: 'BR|AR|CO|CL|PE|UY|VE|EC|BO|PY' } },
      { type: 'movie', params: { with_original_language: 'es|pt' } },
    ],
  },
  asia: {
    title: 'Asia',
    legs: [
      { type: 'tv', params: { with_origin_country: 'JP|KR|CN|TW|HK|TH|IN|VN|ID|PH|MY|SG' } },
      { type: 'movie', params: { with_original_language: 'ja|ko|zh|hi|th|te|ta|vi|id' } },
    ],
  },
  africa: {
    title: 'Africa',
    legs: [
      { type: 'tv', params: { with_origin_country: 'NG|ZA|EG|KE|MA|GH|TZ|ET|DZ|TN' } },
      { type: 'movie', params: { with_original_language: 'ar|sw|af|zu|ha|yo' } },
    ],
    voteMin: 0,
  },
  oceania: {
    title: 'Oceania',
    legs: [{ type: 'tv', params: { with_origin_country: 'AU|NZ|FJ|PG' } }],
  },
};

/* ------------------------------ normalization ------------------------------ */

function normalizeMediaItem(item, mediaType, genreMap) {
  if (!item || !item.id) return null;
  const genreNames = (item.genre_ids || []).map((id) => genreMap[id]).filter(Boolean);
  return {
    id: item.id,
    title: item.title || item.name || 'Untitled',
    image: item.poster_path ? `${IMAGE_BASE}/w500${item.poster_path}` : null,
    backdrop: item.backdrop_path ? `${IMAGE_BASE}/w780${item.backdrop_path}` : null,
    overview: item.overview || '',
    rating: item.vote_average ?? null,
    year: (item.release_date || item.first_air_date || '').slice(0, 4) || null,
    mediaType,
    genres:
      Array.isArray(item.genres) && item.genres.length
        ? item.genres.map((g) => g.name)
        : genreNames,
    source: 'tmdb',
  };
}

/* --------------------------------- router ---------------------------------- */

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export const discoverRouter = express.Router();

discoverRouter.get(
  '/catalog',
  wrap(async (req, res) => {
    res.json({
      data: Object.entries(SLUG_CATALOG).map(([slug, spec]) => ({
        slug,
        title: spec.title,
        legs: spec.legs.map((leg) => ({ type: leg.type, params: leg.params })),
      })),
    });
  }),
);

discoverRouter.get(
  '/:slug',
  wrap(async (req, res) => {
    const slug = String(req.params.slug || '').trim();
    const spec = SLUG_CATALOG[slug];
    if (!spec) {
      return res
        .status(404)
        .json({ error: `Unknown discover slug '${slug}'`, known: Object.keys(SLUG_CATALOG) });
    }
    const page = Math.min(Math.max(parseInt(req.query.page, 10) || 1, 1), 500);
    const voteMin = spec.voteMin !== undefined ? spec.voteMin : 30;
    const includeAdult = 'false';

    // Fan out over legs (movie/tv) — each fetch is cached by the provider cache.
    const settled = await Promise.allSettled(
      spec.legs.map((leg) => {
        const params = {
          include_adult: includeAdult,
          language: 'en-US',
          page: String(page),
          ...leg.params,
        };
        if (!params.sort_by) params.sort_by = 'popularity.desc';
        if (voteMin > 0) params['vote_count.gte'] = String(voteMin);
        return tmdbFetch(`/discover/${leg.type}`, params);
      }),
    );

    const perLeg = [];
    let totalPages = 0;
    let totalResults = 0;
    let firstError = null;
    let okLegs = 0;

    for (let i = 0; i < spec.legs.length; i += 1) {
      const leg = spec.legs[i];
      const outcome = settled[i];
      if (outcome.status !== 'fulfilled') {
        firstError ||= outcome.reason?.message || 'TMDB discover failed';
        perLeg.push([]);
        continue;
      }
      okLegs += 1;
      const payload = outcome.value || {};
      const genreMap = await getGenreMap(leg.type);
      const items = (payload.results || [])
        .map((row) => normalizeMediaItem(row, leg.type, genreMap))
        .filter(Boolean);
      perLeg.push(items);
      totalPages = Math.max(totalPages, Math.min(payload.total_pages || 1, 500));
      totalResults = Math.max(totalResults, payload.total_results || items.length);
    }

    if (okLegs === 0) {
      return res.status(502).json({
        error: `TMDB discover failed for '${slug}': ${firstError || 'unknown error'}`,
      });
    }

    // Interleave legs (movie, tv, movie, tv...) and dedupe by type-id.
    const merged = [];
    const seen = new Set();
    const maxLen = Math.max(0, ...perLeg.map((list) => list.length));
    for (let i = 0; i < maxLen; i += 1) {
      for (const list of perLeg) {
        const item = list[i];
        if (!item) continue;
        const key = `${item.mediaType}-${item.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(item);
      }
    }

    res.json({
      slug,
      title: spec.title,
      page,
      total: totalResults,
      totalPages,
      legs: spec.legs.length,
      legsOk: okLegs,
      data: merged,
    });
  }),
);
