/**
 * modules/ainew/recap.js — FAZA 35 (WS5): AI Recap — „Ce ai ratat / pe unde
 * ai rămas": istoricul vizionărilor ACELEIAȘI francize/serii din
 * watchhistory (READ-ONLY — tabela FAZA 2/19 existentă), narațiune AI cu
 * fallback determinist onest, fără spoilere dincolo de progresul vizionat.
 */

import { getContentById } from '../../db.js';
import { rows, zaiComplete, nowIso } from './common.js';

const HISTORY_LIMIT = 20;

/** Normalizează un titlu: diacritice→ascii, lowercase, fără sufixe de
 * sezon/episod/parte — baza potrivirii de franciză (determinist). */
export function normalizeTitle(title) {
  const base = String(title ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[“”"'’]/g, '')
    .replace(/\(.*?\)/g, ' ') // (2024), (Dub), (OVA)…
    .replace(/\b(sezonul|season|s)\s*\d+\b/g, ' ')
    .replace(/\b(?:episodul|episode|ep|partea|part|vol\.?)\s*\d+\b/g, ' ')
    .replace(/\b\s*\d+\s*(sezon|season)\b/g, ' ')
    .replace(/\s*[:\-–—]\s*(sezonul|season|partea|part)\s*\d+.*/g, ' ')
    .replace(/\s*[:\-–—]\s*final\b.*/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return base;
}

/** Franciză din metadata reală: collection/franchise/franchiseName (orice
 * formă existentă în catalog — citite onest, fără a inventa una). */
function franchiseOf(metadata) {
  const meta = metadata && typeof metadata === 'object' ? metadata : {};
  return (
    meta.collection ??
    meta.franchise ??
    meta.franchiseName ??
    meta.belongsToCollection ??
    null
  );
}

/** Aceeași franciză? (id identic | titlu de bază identic | collection egal) */
function sameFranchise(target, candidate) {
  if (target.content.id === candidate.id) return true;
  const tf = franchiseOf(target.content.metadata);
  const cf = franchiseOf(candidate.metadata);
  if (tf && cf && String(tf).toLowerCase() === String(cf).toLowerCase()) return true;
  const tt = normalizeTitle(target.content.title);
  const ct = normalizeTitle(candidate.title);
  if (!tt || !ct) return false;
  /* prefix de titlu de bază comun (minim 4 caractere, ca să nu matchuim
   * orice pe un cuvânt scurt): „dragon ball z" vs „dragon ball" → franciză. */
  const shorter = tt.length <= ct.length ? tt : ct;
  if (shorter.length >= 4 && (tt.startsWith(`${ct} `) || ct.startsWith(`${tt} `) || tt === ct)) return true;
  return false;
}

/** Durata în secunde din metadata reală (convențiile catalogului:
 * duration=secunde string, runtime=minute number — identic cu playerx). */
function durationSecOf(metadata) {
  const meta = metadata && typeof metadata === 'object' ? metadata : {};
  const dur = Number(meta.duration);
  if (Number.isFinite(dur) && dur > 0) return dur;
  const rt = Number(meta.runtime);
  if (Number.isFinite(rt) && rt > 0) return rt * 60;
  return null;
}

/**
 * recapData({ contentId, userId }) — READ-ONLY. Guest → 401 la nivel de rută.
 * Fără istoric pentru franciză → { ok, recap: null, note } (contract onest).
 */
export async function recapData({ contentId, userId }) {
  const content = await getContentById(contentId);
  if (!content) return { status: 404, error: 'Conținut inexistent' };

  let historyRows = [];
  try {
    historyRows = await rows(
      `SELECT contentid, progress, watchedat FROM watchhistory
        WHERE userid = $1 ORDER BY watchedat DESC LIMIT ${HISTORY_LIMIT}`,
      [userId],
    );
  } catch {
    /* sursa SQL indisponibilă (local fallback) → onest fără istoric */
  }

  /* Detaliile de conținut pentru fiecare intrare de istoric (batch read). */
  const candidates = [];
  for (const h of historyRows) {
    const c = await getContentById(Number(h.contentid));
    if (c) candidates.push({ content: c, progress: Number(h.progress), watchedat: h.watchedat });
  }

  const watched = candidates
    .filter((c) => sameFranchise({ content }, c.content))
    .map((c) => {
      const dur = durationSecOf(c.content.metadata);
      const pct = dur && dur > 0 ? Math.min(100, Math.round((c.progress / dur) * 100)) : null;
      return {
        contentId: c.content.id,
        title: c.content.title,
        progressSec: c.progress,
        progressPct: pct,
        watchedAt: c.watchedat instanceof Date ? c.watchedat.toISOString() : String(c.watchedat ?? null),
      };
    });

  if (watched.length === 0) {
    return { ok: true, contentId, title: content.title, recap: null, note: 'Nu ai istoric pentru acest titlu încă.' };
  }

  /* Narațiunea „pe unde ai rămas" — fără spoilere dincolo de progres. */
  const watchedLines = watched
    .map((w) => `- ${w.title}: ${w.progressPct !== null ? `${w.progressPct}% din episod` : `${w.progressSec}s vizionate`}${w.watchedAt ? ` (ultima dată: ${String(w.watchedAt).slice(0, 10)})` : ''}`)
    .join('\n');
  const prompt = [
    'Ești AI Recap pentru platforma Animaxia. Scrii ÎN ROMÂNEȚĂ un rezumat scurt (maxim 120 de cuvinte) de tip „Ce ai ratat / pe unde ai rămas" pentru utilizator, înainte să pornească noul episod.',
    `Titlul țintă: ${content.title}.`,
    `Episoadele/titlurile din franciză vizionate deja (cu progres):\n${watchedLines}`,
    'Reguli oneste: NU dezvălui evenimente de după punctul unde s-a oprit utilizatorul (procentele arată până unde a ajuns). Nu inventa evenimente. Formulează prietenos, cu un scurt „pe unde ai rămas" și ce urmează (fără spoilere).',
  ].join('\n\n');

  const aiRecap = await zaiComplete([
    { role: 'system', content: 'Răspunzi în română, concis, prietenos, zero spoilere.' },
    { role: 'user', content: prompt },
  ]);

  if (aiRecap) {
    return {
      ok: true,
      contentId,
      title: content.title,
      recap: aiRecap,
      provider: 'z-ai',
      watched,
      generatedAt: nowIso(),
    };
  }

  /* Fallback DETERMINIST: lista de propoziții construită din istoric — onest. */
  const sentences = watched.map(
    (w) => `Ai văzut „${w.title}" — ${w.progressPct !== null ? `${w.progressPct}% din episod` : `${w.progressSec} secunde`} .`,
  );
  return {
    ok: true,
    contentId,
    title: content.title,
    recap: `Pe unde ai rămas:\n${sentences.join('\n')}\n(Notă: rezumat generat determinist din istoricul tău — serviciul AI este momentan indisponibil.)`,
    provider: 'heuristic',
    watched,
    generatedAt: nowIso(),
  };
}
