/**
 * modules/perso/profile.js — FAZA 36-R (PLAN 100X · WS6): profilul de gust
 * al utilizatorului, ÎNVĂȚAT PASIV din semnale reale (read-only):
 *
 *   · watchhistory  (FAZA 2/19 — progres + watchedat)
 *   · contentlikes  (FAZA 2 — like/dislike per titlu)
 *   · reviews       (FAZA 10 — rating 1..10 per titlu)
 *   · evenimente perso (POST /events — view/like/complete/search, file-based)
 *
 * Agregare DETERMINISTĂ (zero ML extern, etichetat onest): fiecare semnal
 * contribuie cu o greutate la afinitățile pe genuri / tipuri / decenii;
 * scorurile sunt normalizate 0-100 relativ la maximul intern. Un reset
 * (POST /profile/reset) marchează un `resetAt` — semnalele anterioare markerului
 * rămân în istoric (nu ștergem nimic din tabelele altor module) dar nu mai
 * contează la agregare: profilul învățat se reia de la zero.
 *
 * Citirea DB se face DOAR prin `rows()` din modules/platform/sql.js (wrapper
 * subțire peste `query()` exportat de db.js) — identic ca pattern cu ainew
 * (FAZA 35, recap/curation/companion). Local-fallback ⇒ semnale DB goale,
 * profil onest doar din evenimentele perso.
 */

import { rows } from '../platform/sql.js';
import { logger } from '../../utils/logger.js';
import { eventsStore, resetsStore, eventsStorePerUser, profileCacheApi } from './storage.js';

/* ------------------------------ signal weights ------------------------------ */
/* Ponderi deterministe, documentate onest (nu sunt „învățate" — sunt alese):
 *   vizionare <20%   → „aruncată o privire"   +0.6
 *   vizionare 20-90% → „începută, neterminată" +1.5
 *   vizionare ≥90%   → „terminată"             +3.0
 *   like (+1)        → +4.0 · dislike (−1) → −3.0
 *   recenzie ≥7      → +3.0 · recenzie ≤4 → −2.0 (celelalte: +1.0)
 *   evenimente perso → view +0.8 · like +2.5 · complete +3.0 · search +0.4
 * Greutatea `weight` din POST /events e un MULTIPLICATOR 0.5..3 (clamp onest). */
export const WEIGHTS = {
  glance: 0.6,
  partial: 1.5,
  complete: 3.0,
  like: 4.0,
  dislike: -3.0,
  reviewHigh: 3.0,
  reviewLow: -2.0,
  reviewMid: 1.0,
  evView: 0.8,
  evLike: 2.5,
  evComplete: 3.0,
  evSearch: 0.4,
};

const HISTORY_LIMIT = 120; // ultimele N intrări watchhistory luate în calcul
const LIKES_LIMIT = 120;
const REVIEWS_LIMIT = 80;
const FAVORITE_TITLES_LIMIT = 8;
const TOP_N = 10;

/* --------------------------------- helpers ---------------------------------- */

/** Genurile din metadata reală a catalogului (md.genres — array de stringuri). */
export function genresOf(metadata) {
  const meta = metadata && typeof metadata === 'object' ? metadata : {};
  return Array.isArray(meta.genres) ? meta.genres.map((g) => String(g).trim()).filter(Boolean) : [];
}

/** Anul din metadata reală (string sau număr). */
export function yearOf(metadata) {
  const meta = metadata && typeof metadata === 'object' ? metadata : {};
  const y = Number(meta.year);
  return Number.isInteger(y) && y >= 1900 && y <= 2100 ? y : null;
}

/** Deceniul lizibil al unui an („1990", „2020" → „anii 1990/2020"). */
export function decadeOf(year) {
  if (!year) return null;
  return `${Math.floor(year / 10) * 10}s`;
}

/** Parsează metadata JSONB venită din SQL (string sau obiect). */
function parseMeta(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function parseDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value.getTime();
  const t = Date.parse(String(value));
  return Number.isFinite(t) ? t : null;
}

/** Momentul după care semnalele contează (reset marker), sau 0 (de la început). */
function resetAtOf(userId) {
  const resets = resetsStore.load();
  const marker = resets[String(userId)];
  const t = marker ? parseDate(marker.resetAt) : null;
  return Number.isFinite(t) && t !== null ? t : 0;
}

/* ------------------------------ the aggregation ----------------------------- */

function emptyDims() {
  return { genres: new Map(), types: new Map(), decades: new Map(), years: new Map() };
}

function addSignal(dims, meta, type, weight, at) {
  if (weight === 0) return;
  const bump = (map, key) => {
    if (!key) return;
    const cur = map.get(key) ?? { score: 0, lastAt: 0, titles: 0 };
    cur.score += weight;
    cur.lastAt = Math.max(cur.lastAt, at ?? 0);
    cur.titles += 1;
    map.set(key, cur);
  };
  for (const g of genresOf(meta)) bump(dims.genres, g);
  if (type) bump(dims.types, String(type));
  const year = yearOf(meta);
  if (year) {
    bump(dims.years, String(year));
    bump(dims.decades, decadeOf(year));
  }
}

/** Sortează o dimensiune desc după scor și normalizează 0-100 față de maxim. */
function dimToList(map, topN = TOP_N) {
  const entries = [...map.entries()].sort((a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0]));
  if (entries.length === 0) return [];
  const max = Math.max(...entries.map(([, v]) => Math.abs(v.score)), 1);
  return entries.slice(0, topN).map(([value, v]) => ({
    value,
    score: Math.round(v.score * 100) / 100,
    pct: Math.max(0, Math.min(100, Math.round((v.score / max) * 100))),
    titles: v.titles,
  }));
}

/** Scor de diversitate 0-100 onest: câte genuri distincte alimentează
 * profilul (10 genuri distincte ⇒ 100; liniar sub). */
function diversityScore(genreMap) {
  return Math.min(100, Math.round((genreMap.size / 10) * 100));
}

/**
 * computeProfile(userId) — READ-ONLY, determinist. Întoarce agregarea completă
 * (folosită de /profile, /affinities, /feed, /explain). Eșecuri SQL ⇒ semnale
 * goale + `sources` onest (profilul poate rula doar pe evenimente perso).
 */
export async function computeProfile(userId) {
  const uid = Number(userId);
  const since = resetAtOf(uid);
  const dims = emptyDims();
  const sources = { watchhistory: 0, contentlikes: 0, reviews: 0, persoEvents: 0 };
  const titleWeights = new Map(); // contentId → { title, weight, type, meta }
  let lastSignalAt = null;

  const noteSignal = (at) => {
    const t = parseDate(at);
    if (t !== null && (!lastSignalAt || t > lastSignalAt)) lastSignalAt = t;
  };

  /* 1. watchhistory JOIN content — progres real + metadata (un singur query). */
  try {
    const watchRows = await rows(
      `SELECT h.contentid, h.progress, h.watchedat, c.type, c.title, c.metadata
         FROM watchhistory h JOIN content c ON c.id = h.contentid
        WHERE h.userid = $1
        ORDER BY h.watchedat DESC
        LIMIT ${HISTORY_LIMIT}`,
      [uid],
    );
    for (const r of watchRows) {
      const watchedAt = parseDate(r.watchedat);
      if (watchedAt === null || watchedAt < since) continue;
      const meta = parseMeta(r.metadata);
      const progressSec = Number(r.progress) || 0;
      let kind = 'glance';
      let weight = WEIGHTS.glance;
      const dur = Number(meta.duration) > 0
        ? Number(meta.duration)
        : Number(meta.runtime) > 0
          ? Number(meta.runtime) * 60
          : null;
      if (dur && dur > 0) {
        const pct = (progressSec / dur) * 100;
        if (pct >= 90) { kind = 'complete'; weight = WEIGHTS.complete; }
        else if (pct >= 20) { kind = 'partial'; weight = WEIGHTS.partial; }
      } else if (progressSec >= 20 * 60) { // fără durată → prag onest pe secunde
        kind = 'partial';
        weight = WEIGHTS.partial;
      }
      addSignal(dims, meta, r.type, weight, watchedAt);
      sources.watchhistory += 1;
      noteSignal(r.watchedat);
      const tw = titleWeights.get(Number(r.contentid)) ?? { title: r.title, type: r.type, meta, weight: 0, kinds: [] };
      tw.weight += weight;
      tw.kinds.push(kind);
      titleWeights.set(Number(r.contentid), tw);
    }
  } catch (err) {
    logger.debug(`[perso] watchhistory read failed for user ${uid}: ${err?.message ?? err}`);
  }

  /* 2. contentlikes JOIN content — like (+1) / dislike (−1). */
  try {
    const likeRows = await rows(
      `SELECT l.contentid, l.value, l.createdat, c.type, c.title, c.metadata
         FROM contentlikes l JOIN content c ON c.id = l.contentid
        WHERE l.userid = $1
        ORDER BY l.createdat DESC
        LIMIT ${LIKES_LIMIT}`,
      [uid],
    );
    for (const r of likeRows) {
      const createdAt = parseDate(r.createdat);
      if (createdAt === null || createdAt < since) continue;
      const value = Number(r.value);
      const meta = parseMeta(r.metadata);
      addSignal(dims, meta, r.type, value > 0 ? WEIGHTS.like : WEIGHTS.dislike, createdAt);
      sources.contentlikes += 1;
      noteSignal(r.createdat);
      const tw = titleWeights.get(Number(r.contentid)) ?? { title: r.title, type: r.type, meta, weight: 0, kinds: [] };
      tw.weight += value > 0 ? WEIGHTS.like : WEIGHTS.dislike;
      tw.kinds.push(value > 0 ? 'like' : 'dislike');
      titleWeights.set(Number(r.contentid), tw);
    }
  } catch (err) {
    logger.debug(`[perso] contentlikes read failed for user ${uid}: ${err?.message ?? err}`);
  }

  /* 3. reviews JOIN content — rating-ul propriu (1..10). */
  try {
    const reviewRows = await rows(
      `SELECT r.contentid, r.rating, r.createdat, c.type, c.title, c.metadata
         FROM reviews r JOIN content c ON c.id = r.contentid
        WHERE r.userid = $1
        ORDER BY r.createdat DESC
        LIMIT ${REVIEWS_LIMIT}`,
      [uid],
    );
    for (const r of reviewRows) {
      const createdAt = parseDate(r.createdat);
      if (createdAt === null || createdAt < since) continue;
      const rating = Number(r.rating);
      const meta = parseMeta(r.metadata);
      const weight = rating >= 7 ? WEIGHTS.reviewHigh : rating <= 4 ? WEIGHTS.reviewLow : WEIGHTS.reviewMid;
      addSignal(dims, meta, r.type, weight, createdAt);
      sources.reviews += 1;
      noteSignal(r.createdat);
      const tw = titleWeights.get(Number(r.contentid)) ?? { title: r.title, type: r.type, meta, weight: 0, kinds: [] };
      tw.weight += weight;
      tw.kinds.push(`review:${rating}`);
      titleWeights.set(Number(r.contentid), tw);
    }
  } catch (err) {
    logger.debug(`[perso] reviews read failed for user ${uid}: ${err?.message ?? err}`);
  }

  /* 4. Evenimente perso (file-based, ≤ EVENTS_PER_USER per user). */
  const persoEvents = eventsStorePerUser(eventsStore, uid).filter((e) => {
    const t = parseDate(e.at);
    return t !== null && t >= since;
  });
  for (const ev of persoEvents) {
    const w = (Number(ev.weight) || 1) * (
      ev.type === 'view' ? WEIGHTS.evView
        : ev.type === 'like' ? WEIGHTS.evLike
          : ev.type === 'complete' ? WEIGHTS.evComplete
            : WEIGHTS.evSearch
    );
    const meta = ev.contentId != null ? (titleWeights.get(Number(ev.contentId))?.meta ?? {}) : {};
    addSignal(dims, meta, null, w, parseDate(ev.at));
    sources.persoEvents += 1;
    noteSignal(ev.at);
    if (ev.contentId != null) {
      const known = titleWeights.get(Number(ev.contentId));
      if (known) {
        known.weight += w;
        known.kinds.push(`event:${ev.type}`);
      }
    }
  }

  /* Agregarea finală, onestă. */
  const topGenres = dimToList(dims.genres);
  const topTypes = dimToList(dims.types);
  const topDecades = dimToList(dims.decades);
  const topYears = dimToList(dims.years, 5);
  const favoriteTitles = [...titleWeights.entries()]
    .filter(([, v]) => v.weight > 0)
    .sort((a, b) => b[1].weight - a[1].weight || a[0] - b[0])
    .slice(0, FAVORITE_TITLES_LIMIT)
    .map(([contentId, v]) => ({
      contentId,
      title: v.title,
      type: v.type ?? null,
      genres: genresOf(v.meta),
      year: yearOf(v.meta),
      weight: Math.round(v.weight * 100) / 100,
      signals: v.kinds,
    }));

  const totalSignals = sources.watchhistory + sources.contentlikes + sources.reviews + sources.persoEvents;
  const empty = topGenres.length === 0 && topTypes.length === 0 && topDecades.length === 0 && totalSignals === 0;

  return {
    userId: uid,
    empty,
    learnedAt: new Date().toISOString(),
    since: since > 0 ? new Date(since).toISOString() : null,
    lastSignalAt: lastSignalAt ? new Date(lastSignalAt).toISOString() : null,
    sources,
    signals: {
      watched: sources.watchhistory,
      liked: sources.contentlikes,
      reviewed: sources.reviews,
      events: sources.persoEvents,
      total: totalSignals,
    },
    topGenres,
    topTypes,
    topDecades,
    topYears,
    diversity: {
      score: diversityScore(dims.genres),
      distinctGenres: dims.genres.size,
      note: 'scor onest: numărul de genuri distincte care alimentează profilul (10 ⇒ 100)',
    },
    favoriteTitles,
    method: {
      engine: 'euristică deterministă',
      ml: false,
      note: 'agregare ponderată de semnale reale (vizionări, aprecieri, recenzii, evenimente) — zero ML extern',
    },
  };
}

/** Profil cu cache TTL 10 min (invalidat la /events și /reset). */
export async function getProfileCached(userId) {
  const uid = Number(userId);
  const hit = profileCacheApi.get(uid);
  if (hit) return { profile: hit, cached: true };
  const profile = await computeProfile(uid);
  profileCacheApi.set(uid, profile);
  return { profile, cached: false };
}
