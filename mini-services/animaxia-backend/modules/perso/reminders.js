/**
 * modules/perso/reminders.js — FAZA 36-R (PLAN 100X · WS6): memento-uri de
 * încheiere — titluri ÎNCEPUTE și abandonate (progres 20-90%, nedeschise de
 * peste 3 zile), cu minute rămase estimate și memento „finalizează serialul"
 * (sezoane, doar dacă metadata reală le are).
 *
 * Semnale: watchhistory JOIN content (read-only prin rows() din
 * modules/platform/sql.js — wrapper peste query() exportat de db.js, identic
 * ainew/recap). Dismiss-urile sunt file-based (data/perso/dismissals.json)
 * cu TTL 30 de zile — expirate se ignoră leneș la citire și se curăță.
 */

import { rows } from '../platform/sql.js';
import { logger } from '../../utils/logger.js';
import { dismissalsStore, resetsStore, DISMISSAL_TTL_MS } from './storage.js';

const STALE_AFTER_MS = 3 * 86_400_000; // 3 zile fără progres
const REMINDERS_LIMIT = 20;
const MIN_PCT = 20;
const MAX_PCT = 90;

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

/** Durata în secunde din metadata reală (duration=secunde string tv,
 * runtime=minute number — convențiile catalogului, identic playerx). */
function durationSecOf(meta) {
  const dur = Number(meta.duration);
  if (Number.isFinite(dur) && dur > 0) return dur;
  const rt = Number(meta.runtime);
  if (Number.isFinite(rt) && rt > 0) return rt * 60;
  const ert = Number(meta.episodeRunTime ?? meta.episode_runtime);
  if (Number.isFinite(ert) && ert > 0) return ert * 60;
  return null;
}

/** Sezoanele din metadata reală — onest: null când catalogul nu le are. */
function seasonsOf(meta) {
  const raw = meta.seasons ?? meta.numberOfSeasons ?? meta.number_of_seasons;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/* ------------------------------- dismissals -------------------------------- */

/** Set cu contentId-urile respinse ACTIVE (< 30 zile) + prune leneș. */
function activeDismissals(userId) {
  const all = dismissalsStore.load();
  const key = String(Number(userId));
  const map = all[key] && typeof all[key] === 'object' ? all[key] : {};
  const now = Date.now();
  const active = new Set();
  let pruned = false;
  for (const [contentId, at] of Object.entries(map)) {
    const t = parseDate(at);
    if (t !== null && now - t < DISMISSAL_TTL_MS) {
      active.add(Number(contentId));
    } else {
      delete map[contentId];
      pruned = true;
    }
  }
  if (pruned) dismissalsStore.scheduleSave();
  return active;
}

/** Respinge un memento (idempotent — re-dismiss reîmprospătează data). */
export function dismissReminder(userId, contentId) {
  const all = dismissalsStore.load();
  const key = String(Number(userId));
  if (!all[key] || typeof all[key] !== 'object') all[key] = {};
  all[key][String(Number(contentId))] = new Date().toISOString();
  dismissalsStore.scheduleSave();
  return { userId: Number(userId), contentId: Number(contentId), dismissedAt: all[key][String(Number(contentId))] };
}

/** Câte respingeri ACTIVE are userul (pentru /status și teste). */
export function activeDismissalCount(userId) {
  return activeDismissals(userId).size;
}

/* ------------------------------ the reminders ------------------------------- */

/**
 * buildReminders({ userId }) — READ-ONLY, determinist. Titluri cu progres
 * 20-90% (sau bandă onestă pe secunde când durata lipsește), nedeschise de
 * >3 zile, fără cele respinse (<30 zile). Fiecare item: remainingMin estimat
 * + seasonFinish {totalSeasons} când metadata reală are sezoane.
 */
export async function buildReminders({ userId }) {
  const uid = Number(userId);
  const since = resetAtOf(uid);
  const dismissed = activeDismissals(uid);
  const now = Date.now();

  const candidates = [];
  try {
    const watchRows = await rows(
      `SELECT h.contentid, h.progress, h.watchedat, c.id, c.type, c.title, c.thumbnail, c.metadata
         FROM watchhistory h JOIN content c ON c.id = h.contentid
        WHERE h.userid = $1
        ORDER BY h.watchedat DESC
        LIMIT 100`,
      [uid],
    );
    for (const r of watchRows) {
      const watchedAt = parseDate(r.watchedat);
      if (watchedAt === null || watchedAt < since) continue;
      const idleMs = now - watchedAt;
      if (idleMs < STALE_AFTER_MS) continue; // deschis recent — nu e un memento
      const meta = parseMeta(r.metadata);
      const dur = durationSecOf(meta);
      const progressSec = Number(r.progress) || 0;
      let pct = null;
      if (dur && dur > 0) pct = Math.min(100, Math.round((progressSec / dur) * 100));
      const inBand = (pct !== null && pct >= MIN_PCT && pct <= MAX_PCT)
        || (pct === null && progressSec >= 300 && progressSec <= 3 * 3600);
      if (!inBand) continue;
      const contentId = Number(r.contentid);
      if (dismissed.has(contentId)) continue;
      candidates.push({ r, meta, pct, progressSec, dur, watchedAt, idleDays: Math.floor(idleMs / 86_400_000) });
    }
  } catch (err) {
    logger.debug(`[perso] reminders watchhistory read failed for user ${uid}: ${err?.message ?? err}`);
    return {
      ok: true,
      userId: uid,
      items: [],
      dismissedActive: dismissed.size,
      note: 'istoricul nu a putut fi citit (sursă SQL indisponibilă) — listă onest goală',
      generatedAt: new Date().toISOString(),
    };
  }

  candidates.sort((a, b) => (b.watchedAt ?? 0) - (a.watchedAt ?? 0)); // cel mai recent abandonat primul
  const items = candidates.slice(0, REMINDERS_LIMIT).map((c) => {
    const seasons = seasonsOf(c.meta);
    return {
      contentId: Number(c.r.contentid),
      title: c.r.title,
      type: c.r.type ?? 'mined',
      thumbnail: c.r.thumbnail ?? null,
      progressPct: c.pct,
      progressSec: c.progressSec,
      remainingMin: c.dur && c.dur > c.progressSec ? Math.round((c.dur - c.progressSec) / 60) : null,
      idleDays: c.idleDays,
      lastWatchedAt: c.watchedAt !== null ? new Date(c.watchedAt).toISOString() : null,
      seasonFinish: seasons && String(c.r.type) === 'tv'
        ? { totalSeasons: seasons, note: `${seasons} ${seasons === 1 ? 'sezon' : 'sezoane'} în total — finalizează serialul` }
        : null,
      reason: c.pct !== null
        ? `Ai lăsat ${c.r.title} la ${c.pct}% — mai ai ${c.dur && c.dur > c.progressSec ? `~${Math.round((c.dur - c.progressSec) / 60)} min` : 'puțin'}`
        : `Ai început ${c.r.title} acum ${c.idleDays} ${c.idleDays === 1 ? 'zi' : 'zile'} și nu l-ai terminat`,
    };
  });

  return {
    ok: true,
    userId: uid,
    items,
    dismissedActive: dismissed.size,
    criteria: {
      progressBand: `${MIN_PCT}-${MAX_PCT}%`,
      staleAfterDays: 3,
      dismissalTtlDays: Math.round(DISMISSAL_TTL_MS / 86_400_000),
    },
    method: {
      engine: 'euristică deterministă',
      ml: false,
      note: 'memento-uri calculate din istoricul real de vizionare — zero ML extern',
    },
    note: items.length === 0
      ? 'Nicio vizionare abandonată recent — totul e la zi. 👌'
      : null,
    generatedAt: new Date().toISOString(),
  };
}
