/**
 * modules/perso/feed.js — FAZA 36-R (PLAN 100X · WS6): feed-ul „Pentru Tine"
 * cu SECȚIUNI EXPLICITE și motive lizibile. Fără ML extern — euristică
 * deterministă onestă, etichetată ca atare în fiecare răspuns.
 *
 * Secțiuni (în ordinea randării):
 *   1. „Continuă să urmărești"  — watchhistory cu progres <90%        (reason
 *      „Continuă să urmărești · rămas de la X%")
 *   2. „Pentru că ai văzut X"   — titluri care împart genuri cu titlul
 *      preferat cu cea mai mare greutate din profil                  (reason
 *      „Pentru că ai văzut <titlu>")
 *   3. „Gen favorit: <g>"       — genuri favorite căutate în content prin
 *      listContent + filtrare locală pe metadata.genres              (reason
 *      „Gen favorit: <g> (<pct>%)")
 *
 * Surse de date: profilul de gust (modules/perso/profile.js), watchhistory
 * (read-only prin rows() — wrapper peste query() din db.js) și catalogul
 * (listContent din db.js — exact ca în contractul modulului). Deduplicare
 * strictă pe contentId în întregul feed; limită default 24 (max 48).
 */

import { listContent } from '../../db.js';
import { rows } from '../platform/sql.js';
import { logger } from '../../utils/logger.js';
import { computeProfile, genresOf, yearOf, WEIGHTS } from './profile.js';
import { resetsStore } from './storage.js';

const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 48;
const CATALOG_PAGES = 2; // page 1..2 × limit 100 = până la 200 itemi per gen
const CATALOG_PAGE_SIZE = 100;
const SECTION_KEYS = ['continue', 'similar', 'genre'];

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

function resetAtOf(userId) {
  const resets = resetsStore.load();
  const marker = resets[String(Number(userId))];
  const t = marker ? parseDate(marker.resetAt) : null;
  return Number.isFinite(t) && t !== null ? t : 0;
}

/** Pictogramă content → item de feed (formă înghețată cu types.ts). */
function toFeedItem(row, section, reason, score, extra = {}) {
  const meta = parseMeta(row.metadata);
  return {
    contentId: Number(row.id),
    title: row.title,
    type: row.type ?? 'mined',
    year: yearOf(meta),
    rating: Number.isFinite(Number(meta.rating)) && Number(meta.rating) > 0 ? Number(meta.rating) : null,
    thumbnail: row.thumbnail ?? null,
    genres: genresOf(meta),
    section,
    reason,
    score: Math.round(score * 100) / 100,
    ...extra,
  };
}

/** Overlap de genuri între două seturi (jaccard simplu, determinist). */
function genreOverlap(a, b) {
  const setA = new Set(a.map((g) => g.toLowerCase()));
  const setB = new Set(b.map((g) => g.toLowerCase()));
  if (setA.size === 0 || setB.size === 0) return 0;
  let shared = 0;
  for (const g of setA) if (setB.has(g)) shared += 1;
  return shared / (setA.size + setB.size - shared);
}

/**
 * buildFeed({ userId, limit }) — READ-ONLY, determinist. Returnează feed-ul
 * complet (secțiuni + itemi) cu note oneste pentru profil gol.
 */
export async function buildFeed({ userId, limit }) {
  const uid = Number(userId);
  const safeLimit = Math.min(MAX_LIMIT, Math.max(1, Number.parseInt(limit, 10) || DEFAULT_LIMIT));
  const since = resetAtOf(uid);

  /* 0. Profilul de gust (necesar pentru secțiunile similar/genre). */
  const profile = await computeProfile(uid);

  const items = [];
  const seen = new Set(); // dedupe pe întregul feed
  const pushItem = (item) => {
    if (!item || seen.has(item.contentId)) return false;
    seen.add(item.contentId);
    items.push(item);
    return true;
  };

  /* 1. „Continuă să urmărești" — progres <90%, semnale ≥ resetAt. */
  const continueRows = [];
  try {
    const watchRows = await rows(
      `SELECT h.contentid, h.progress, h.watchedat, c.id, c.type, c.title, c.metadata, c.thumbnail
         FROM watchhistory h JOIN content c ON c.id = h.contentid
        WHERE h.userid = $1
        ORDER BY h.watchedat DESC
        LIMIT 60`,
      [uid],
    );
    for (const r of watchRows) {
      const watchedAt = parseDate(r.watchedat);
      if (watchedAt === null || watchedAt < since) continue;
      const meta = parseMeta(r.metadata);
      const progressSec = Number(r.progress) || 0;
      const dur = Number(meta.duration) > 0
        ? Number(meta.duration)
        : Number(meta.runtime) > 0
          ? Number(meta.runtime) * 60
          : null;
      let pct = null;
      if (dur && dur > 0) pct = Math.min(100, Math.round((progressSec / dur) * 100));
      const inProgress = (pct !== null && pct >= 5 && pct < 90) || (pct === null && progressSec >= 60 && progressSec <= 3 * 3600);
      if (!inProgress) continue;
      continueRows.push(r);
    }
  } catch (err) {
    logger.debug(`[perso] feed watchhistory read failed for user ${uid}: ${err?.message ?? err}`);
  }
  continueRows.sort((a, b) => (parseDate(b.watchedat) ?? 0) - (parseDate(a.watchedat) ?? 0));
  for (const r of continueRows.slice(0, Math.max(4, Math.ceil(safeLimit / 3)))) {
    const meta = parseMeta(r.metadata);
    const progressSec = Number(r.progress) || 0;
    const dur = Number(meta.duration) > 0
      ? Number(meta.duration)
      : Number(meta.runtime) > 0
        ? Number(meta.runtime) * 60
        : null;
    const pct = dur && dur > 0 ? Math.min(100, Math.round((progressSec / dur) * 100)) : null;
    const reason = pct !== null
      ? `Continuă să urmărești · oprit la ${pct}%`
      : 'Continuă să urmărești';
    const watchedAt = parseDate(r.watchedat);
    pushItem(toFeedItem(r, 'continue', reason, WEIGHTS.partial + 1, {
      progressPct: pct,
      progressSec,
      remainingMin: dur && dur > progressSec ? Math.round((dur - progressSec) / 60) : null,
      lastWatchedAt: watchedAt ? new Date(watchedAt).toISOString() : null,
    }));
  }

  /* Pool de catalog comun secțiunilor similar/genre: primele CATALOG_PAGES
   * pagini sortate după titlu (determinist; sortarea pe createdat ar aduce
   * ultimele batch-uri de ingestie, care adesea nu au genuri încă). */
  const catalogPool = [];
  for (let page = 1; page <= CATALOG_PAGES; page += 1) {
    try {
      const res = await listContent({ page, limit: CATALOG_PAGE_SIZE, sort: 'title' });
      for (const c of res?.data ?? []) catalogPool.push(c);
    } catch (err) {
      logger.debug(`[perso] feed listContent page ${page} failed: ${err?.message ?? err}`);
    }
  }

  /* 2. „Pentru că ai văzut X" — similar cu titlul preferat (overlap genuri
   *    + bonus deceniu apropiat). Filtrare locală pe pool-ul de catalog. */
  const anchor = profile.favoriteTitles[0] ?? null;
  if (anchor && anchor.genres.length > 0 && catalogPool.length > 0) {
    const candidates = catalogPool;
    const anchorGenres = anchor.genres.map((g) => g.toLowerCase());
    const anchorYear = anchor.year ?? null;
    const similar = candidates
      .filter((c) => c.id !== anchor.contentId && !seen.has(c.id))
      .map((c) => {
        const meta = parseMeta(c.metadata);
        const cg = genresOf(meta);
        const shared = cg.filter((g) => anchorGenres.includes(g.toLowerCase()));
        const overlap = genreOverlap(anchor.genres, cg);
        const cy = yearOf(meta);
        const decadeBonus = anchorYear && cy && Math.abs(anchorYear - cy) <= 10 ? 0.1 : 0;
        return { row: c, shared, overlap, decadeBonus, score: overlap + 0.05 * shared.length + decadeBonus };
      })
      .filter((s) => s.shared.length >= 1 && s.score > 0.15)
      .sort((a, b) => b.score - a.score || a.row.id - b.row.id)
      .slice(0, Math.max(4, Math.ceil(safeLimit / 3)));
    for (const s of similar) {
      pushItem(toFeedItem(s.row, 'similar', `Pentru că ai văzut ${anchor.title}`, s.score, {
        matchedGenres: s.shared.slice(0, 3),
      }));
    }
  }

  /* 3. „Gen favorit: <g>" — top genuri din profil, căutate în catalog prin
   *    listContent și filtrate local pe metadata.genres. */
  const topGenres = profile.topGenres.filter((g) => g.score > 0).slice(0, 3);
  if (topGenres.length > 0 && catalogPool.length > 0) {
    const wanted = topGenres.map((g) => ({ ...g, lower: g.value.toLowerCase() }));
    const candidates = catalogPool;
    const genreItems = candidates
      .filter((c) => !seen.has(c.id))
      .map((c) => {
        const meta = parseMeta(c.metadata);
        const cg = genresOf(meta);
        if (cg.length === 0) return null;
        let best = null;
        for (const g of wanted) {
          if (cg.some((x) => x.toLowerCase() === g.lower)) {
            const affinity = g.pct / 100;
            const rating = Number(meta.rating) > 0 ? Math.min(Number(meta.rating) / 10, 1) : 0.5;
            const score = 0.6 * affinity + 0.25 * rating + 0.15 * (cg.length >= 2 ? 1 : 0.5);
            if (!best || score > best.score) best = { genre: g, score };
          }
        }
        return best ? { row: c, best } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.best.score - a.best.score || a.row.id - b.row.id);
    const perGenre = new Map(); // rotunjire onestă: maxim ~60% din limită per gen
    const genreCap = Math.max(3, Math.ceil((safeLimit * 0.6) / wanted.length));
    for (const gi of genreItems) {
      const used = perGenre.get(gi.best.genre.value) ?? 0;
      if (used >= genreCap) continue;
      pushItem(toFeedItem(gi.row, 'genre', `Gen favorit: ${gi.best.genre.value} (${gi.best.genre.pct}%)`, gi.best.score, {
        matchedGenre: gi.best.genre.value,
      }));
      perGenre.set(gi.best.genre.value, used + 1);
      if (items.length >= safeLimit) break;
    }
  }

  const sections = SECTION_KEYS.map((key) => ({
    key,
    label:
      key === 'continue' ? 'Continuă să urmărești'
        : key === 'similar' ? (anchor ? `Pentru că ai văzut ${anchor.title}` : 'Similare cu preferatele tale')
          : 'Din genurile tale favorite',
    count: items.filter((i) => i.section === key).length,
  })).filter((s) => s.count > 0 || s.key === 'genre'); // secțiunea genre rămâne listată onest chiar și goală

  const empty = items.length === 0;
  return {
    ok: true,
    userId: uid,
    limit: safeLimit,
    items: items.slice(0, safeLimit),
    sections,
    profileSummary: {
      empty: profile.empty,
      topGenres: profile.topGenres.slice(0, 3).map((g) => g.value),
      signals: profile.signals.total,
    },
    anchorTitle: anchor?.title ?? null,
    method: {
      engine: 'euristică deterministă',
      ml: false,
      note: 'secțiuni explicite construite din semnale reale (istoric + profil de gust) — zero ML extern',
    },
    note: empty
      ? 'Profil gol — feed-ul se populatează onest pe măsură ce vizionezi, apreciezi sau notezi titluri.'
      : null,
    generatedAt: new Date().toISOString(),
  };
}
