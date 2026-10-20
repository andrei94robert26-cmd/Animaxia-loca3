/**
 * Six fixed-origin, non-executable JSON provider drivers.
 * JSON metadata only; media playback rights and streaming are separate.
 * No user-supplied URL, dynamic JS, unsafe redirects or direct HTML rendering.
 */
import crypto from 'node:crypto';
import { getProviderDefinition } from './catalog.js';
import { EXTRA_DRIVER_IDS, buildExtraProviderRequest, mapExtraProviderItems } from './extra-fetch.js';
import { COMMUNITY_DRIVER_IDS, buildCommunityProviderRequest, mapCommunityProviderItems } from './community-fetch.js';

const isoYear = (v) => {
  const m = /^([12]\d{3})/.exec(String(v || ''));
  return m ? Number(m[1]) : undefined;
};
const text = (v, max = 1200) => typeof v === 'string' ? v.trim().slice(0, max) : '';
const names = (v) => Array.isArray(v)
  ? v.slice(0, 30).map((x) => text(typeof x === 'object' ? x?.name : x, 90)).filter(Boolean)
  : [];
const hashId = (v) => crypto.createHash('sha256').update(String(v)).digest('hex').slice(0, 24);
const params = (base, entries) => {
  const u = new URL(base);
  for (const [key, val] of Object.entries(entries)) if (val != null && val !== '') {
    u.searchParams.set(key, String(val));
  }
  return u;
};
const safeString = (q) => text(q, 120).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
const sourceItem = (id, title, category, more = {}) => ({
  id: String(id), title: text(title, 300), category, ...more,
});

export function buildProviderRequest(providerId, { q = '', page = 1 } = {}) {
  const query = safeString(q);
  const pageNo = Math.max(1, Math.min(10, Number.parseInt(page, 10) || 1));
  const keyed = process.env.TMDB_API_KEY || process.env.TMDBAPIKEY;
  const queryRequired = ['itunes', 'cheapshark', 'gdelt'].includes(providerId);
  if (queryRequired && query.length < 2) {
    throw Object.assign(new Error('This provider requires a query of at least 2 characters'), { status: 400 });
  }
  let url;
  switch (providerId) {
    case 'tmdb':
      if (!keyed) throw Object.assign(new Error('TMDB credentials not configured'), { status: 503 });
      url = params(query
        ? 'https://api.themoviedb.org/3/search/multi'
        : 'https://api.themoviedb.org/3/trending/all/day',
        { api_key: keyed, ...(query ? { query } : {}), page: pageNo });
      break;
    case 'jikan':
      url = params(query ? 'https://api.jikan.moe/v4/anime' : 'https://api.jikan.moe/v4/top/anime',
        { ...(query ? { q: query } : {}), page: pageNo, limit: 25 });
      break;
    case 'tvmaze':
      url = query
        ? params('https://api.tvmaze.com/search/shows', { q: query })
        : params('https://api.tvmaze.com/shows', { page: pageNo - 1 });
      break;
    case 'itunes':
      url = params('https://itunes.apple.com/search',
        { term: query, media: 'music', limit: 25, offset: (pageNo - 1) * 25 });
      break;
    case 'cheapshark':
      url = params('https://www.cheapshark.com/api/1.0/games',
        { title: query, limit: 25, exact: 0 });
      break;
    case 'gdelt':
      url = params('https://api.gdeltproject.org/api/v2/doc/doc',
        { query, mode: 'artlist', format: 'json', maxrecords: 25 });
      break;
    default:
      if (EXTRA_DRIVER_IDS.includes(providerId)) {
        url = buildExtraProviderRequest(providerId, query, pageNo);
        break;
      }
      if (COMMUNITY_DRIVER_IDS.includes(providerId)) {
        url = buildCommunityProviderRequest(providerId, query, pageNo);
        break;
      }
      throw Object.assign(new Error('No verified fetch driver is installed for this provider'), { status: 501 });
  }
  return { url, page: pageNo, query };
}
const arrays = (value) => Array.isArray(value) ? value : [];
export function mapProviderItems(id, json) {
  let mapped = [];
  switch (id) {
    case 'tmdb':
      mapped = arrays(json?.results).filter((x) => x && (x.media_type === 'movie' || x.media_type === 'tv'))
        .map((x) => sourceItem(x.id, x.title || x.name,
          x.media_type === 'tv' ? 'seriale' : 'filme', {
            year: isoYear(x.release_date || x.first_air_date),
            description: text(x.overview, 3000), posterId: String(x.poster_path || x.id),
            thumbnail: x.poster_path ? 'https://image.tmdb.org/t/p/w500' + x.poster_path : undefined,
            rating: Number(x.vote_average) || undefined,
          }));
      break;
    case 'jikan':
      mapped = arrays(json?.data).map((x) => sourceItem(x?.mal_id, x?.title, 'anime', {
        year: Number(x?.year) || isoYear(x?.aired?.from),
        description: text(x?.synopsis, 3000),
        genres: names(x?.genres), studios: names(x?.studios),
        thumbnail: x?.images?.jpg?.image_url, rating: Number(x?.score) || undefined,
      }));
      break;
    case 'tvmaze':
      mapped = arrays(json).map((r) => r?.show || r).map((x) => sourceItem(
        x?.id, x?.name, 'seriale', {
          year: isoYear(x?.premiered), genres: arrays(x?.genres),
          studios: x?.network?.name ? [x.network.name] : [],
          description: text(x?.summary, 3000).replace(/<[^>]*>/g, ' '),
          thumbnail: x?.image?.medium || x?.image?.original,
          rating: Number(x?.rating?.average) || undefined,
        }));
      break;
    case 'itunes':
      mapped = arrays(json?.results).map((x) => sourceItem(
        x?.trackId || x?.collectionId, x?.trackName || x?.collectionName,
        'muzica', {
          year: isoYear(x?.releaseDate), actors: x?.artistName ? [x.artistName] : [],
          studios: x?.collectionName ? [x.collectionName] : [],
          genres: x?.primaryGenreName ? [x.primaryGenreName] : [],
          thumbnail: x?.artworkUrl100 || x?.artworkUrl60,
        }));
      break;
    case 'cheapshark':
      mapped = arrays(json).map((x) => sourceItem(x?.gameID, x?.external, 'gaming', {
        thumbnail: x?.thumb,
      }));
      break;
    case 'gdelt':
      mapped = arrays(json?.articles).map((x) => sourceItem(
        'url-' + hashId(x?.url), x?.title, 'stiri', {
          year: isoYear(x?.seendate),
          description: text(x?.domain, 200),
          thumbnail: x?.socialimage,
        }));
      break;
    default:
      return EXTRA_DRIVER_IDS.includes(id) ? mapExtraProviderItems(id, json)
        : COMMUNITY_DRIVER_IDS.includes(id) ? mapCommunityProviderItems(id, json) : [];
  }
  return mapped.slice(0, 25).filter((x) => x.id && x.id !== 'undefined' &&
    x.id !== 'null' && x.title && x.category);
}
async function boundedJsonResponse(res, maxBytes = 1_000_000) {
  if (!res.ok) throw Object.assign(new Error('Provider returned HTTP ' + res.status), { status: 502 });
  const type = res.headers?.get?.('content-type') || '';
  if (!/(?:^|[\/+])json\b/i.test(type)) {
    throw Object.assign(new Error('Provider returned non-JSON response'), { status: 502 });
  }
  const length = Number(res.headers?.get?.('content-length') || 0);
  if (length > maxBytes) throw Object.assign(new Error('Provider JSON response too large'), { status: 502 });
  const reader = res.body?.getReader?.();
  if (!reader) {
    const body = await res.text();
    if (Buffer.byteLength(body) > maxBytes) throw new Error('Provider JSON response too large');
    return JSON.parse(body);
  }
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error('Provider JSON response too large');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { reader.releaseLock(); }
}

// MusicBrainz requires <=1 request/sec/client. Reserve slots atomically
// within this one-node backend. Multi-replica deployment needs Redis limits.
let nextMusicBrainzSlot = 0;
export async function respectProviderRateLimit(id) {
  if (id !== 'musicbrainz') return;
  const slot = Math.max(Date.now(), nextMusicBrainzSlot);
  nextMusicBrainzSlot = slot + 1150;
  const delay = slot - Date.now();
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
}

export async function fetchProviderMetadata(providerId, options = {}, fetchImpl = globalThis.fetch) {
  const def = getProviderDefinition(providerId);
  if (!def || !def.driverImplemented) {
    throw Object.assign(new Error('Provider has catalog metadata only (no active driver)'), { status: 501 });
  }
  const { url, page, query } = buildProviderRequest(providerId, options);
  await respectProviderRateLimit(providerId);
  const response = await fetchImpl(url.toString(), {
    method: 'GET', redirect: 'error',
    headers: { Accept: 'application/json', 'User-Agent': 'AnimaxiaMetadataBot/1.0 (https://github.com/andrei94robert26-cmd/Animaxia-loca3)' },
    signal: AbortSignal.timeout(12000),
  });
  const payload = await boundedJsonResponse(response);
  const items = mapProviderItems(providerId, payload);
  return {
    source: { type: 'api', id: providerId },
    providerId, page, query,
    count: items.length,
    items, fetchedAt: new Date().toISOString(),
    liveFetch: true,
  };
}
