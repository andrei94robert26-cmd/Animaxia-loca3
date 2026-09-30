/**
 * modules/ainew/dubbing.js — FAZA 35 (WS5): AI Dublare & Subtitrări.
 *
 * Flux ADMIN complet (rutele aplică requireAuth + requireAdmin):
 *   1. GET  /dubbing/missing      — titlurile care au subtitrare 'en' dar NU 'ro'
 *   2. POST /dubbing/generate     — traducere AI (z-ai) a cue-urilor VTT EN →
 *                                    ciornă RO (max 200 cue-uri, loturi de ~25,
 *                                    păstrăm originalul onest când un lot
 *                                    eșuează — rezultat „mixed" onest)
 *   3. GET  /dubbing/draft/:id    — citirea ciornei
 *   4. PUT  /dubbing/draft/:id    — corecturile adminului (cues validate)
 *   5. POST /dubbing/publish/:id  — publicare prin LOOPBACK către serviciul
 *                                    PROTEJAT /api/player/subtitles (FAZA 21,
 *                                    doar consumat — identic ca pattern cu
 *                                    searchux/playerx; user-agent STRICT ASCII:
 *                                    Bun fetch respinge headerele non-ASCII!)
 *
 * Stocare: file-based data/ainew/dubbing/<contentId>.json (zero schemă DB —
 * linie roșie), scriere atomică tmp+rename, directoare create leneș.
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rows, one, zaiComplete, nowIso } from './common.js';
import { logger } from '../../utils/logger.js';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const STORAGE_DIR = join(MODULE_DIR, '..', '..', 'data', 'ainew', 'dubbing');

const MAX_CUES = 200;
const CUE_TEXT_MAX = 500;
const BATCH_SIZE = 25;
const BATCH_TIMEOUT_MS = 10000; // per lot — 2 încercări ≤ 20s, sub bugetul de request
const TRANSLATE_BUDGET_MS = 20000; // buget total traducere; depășit → original onest
const LOOPBACK_TIMEOUT_MS = 8000;
const SELF_PORT = parseInt(process.env.PORT || '4000', 10);
const SELF_BASE = `http://127.0.0.1:${SELF_PORT}`;

/* ------------------------------ file store (atomic) ------------------------- */

function draftPath(contentId) {
  return join(STORAGE_DIR, `${contentId}.json`);
}

function readDraft(contentId) {
  try {
    return JSON.parse(readFileSync(draftPath(contentId), 'utf8'));
  } catch {
    return null;
  }
}

/** Scriere atomică (tmp+rename) cu director creat leneș. Niciodată throw. */
function writeDraft(contentId, draft) {
  try {
    mkdirSync(STORAGE_DIR, { recursive: true });
    const file = draftPath(contentId);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(draft, null, 2)}\n`);
    renameSync(tmp, file);
    return true;
  } catch (err) {
    logger.warn(`[ai-lab] dubbing: salvarea ciornei ${contentId} a eșuat: ${err?.message ?? err}`);
    return false;
  }
}

/* ------------------------------ WebVTT parsing ------------------------------ */

const TS_RE = /(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[.,](\d{3})/;

/** „01:02:03.500" | „02:03.500" → secunde (number) sau null. */
export function parseTimestamp(ts) {
  const m = TS_RE.exec(String(ts ?? '').trim());
  if (!m) return null;
  const h = Number(m[1] || 0);
  const min = Number(m[2]);
  const s = Number(m[3]);
  const ms = Number(m[4]);
  return h * 3600 + min * 60 + s + ms / 1000;
}

/** secunde → „hh:mm:ss.mmm" (format WebVTT). */
export function formatTimestamp(totalSec) {
  const t = Math.max(0, Number(totalSec) || 0);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const ms = Math.round((t - Math.floor(t)) * 1000);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(s)}.${p(ms, 3)}`;
}

/** Parse WebVTT → [{start, end, text}] (max 200; onest: truncated flag). */
export function parseVttCues(vtt) {
  const cues = [];
  let truncated = false;
  const blocks = String(vtt ?? '').replace(/\r\n/g, '\n').split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n').filter((l, i, arr) => !(i === arr.length - 1 && l.trim() === ''));
    const timingIdx = lines.findIndex((l) => l.includes('-->'));
    if (timingIdx === -1) continue;
    const [rawStart, rawEnd] = lines[timingIdx].split('-->');
    const start = parseTimestamp(rawStart);
    const end = parseTimestamp(rawEnd);
    if (start === null || end === null) continue;
    const text = lines.slice(timingIdx + 1).join('\n').trim();
    if (!text) continue;
    if (cues.length >= MAX_CUES) {
      truncated = true;
      break;
    }
    cues.push({ start, end, text: text.slice(0, CUE_TEXT_MAX) });
  }
  return { cues, truncated };
}

/** Construiește corpul WebVTT din cue-urile ciornei. */
export function buildVtt(cues) {
  const body = cues
    .map((c, i) => `${i + 1}\n${formatTimestamp(c.start)} --> ${formatTimestamp(c.end)}\n${c.text}`)
    .join('\n\n');
  return `WEBVTT\n\n${body}\n`;
}

/* ------------------------------ capability API ------------------------------ */

/** Titluri cu subtitrare EN dar fără RO (READ-ONLY). */
export async function dubbingMissing({ limit = 20 } = {}) {
  const safeLimit = Math.min(100, Math.max(1, Number.isInteger(Number(limit)) ? Number(limit) : 20));
  const items = await rows(
    `SELECT s.id AS en_subtitle_id, s.contentid, c.title, c.type,
            c.metadata->>'year' AS year
       FROM subtitles s
       JOIN content c ON c.id = s.contentid
      WHERE s.lang = 'en'
        AND NOT EXISTS (
          SELECT 1 FROM subtitles s2
           WHERE s2.contentid = s.contentid AND s2.lang = 'ro'
        )
      ORDER BY s.id DESC
      LIMIT $1`,
    [safeLimit],
  );
  return {
    ok: true,
    items: items.map((r) => ({
      contentId: Number(r.contentid),
      title: r.title,
      type: r.type ?? null,
      year: r.year ?? null,
      hasEn: true,
      enSubtitleId: Number(r.en_subtitle_id),
    })),
    generatedAt: nowIso(),
  };
}

/** Traducerea propriu-zisă: loturi de ~25 cue-uri, listă numerotată,
 * răspuns așteptat numerotat, parsare lejeră; originalul se păstrează
 * onest când un cue/lot lipsește. Întoarce { cues, translated, untranslated }. */
async function translateCues(cues, { title }) {
  const out = cues.map((c) => ({ ...c, source: c.text }));
  let translated = 0;
  const notes = [];
  const t0 = Date.now();

  for (let i = 0; i < cues.length; i += BATCH_SIZE) {
    if (Date.now() - t0 > TRANSLATE_BUDGET_MS) {
      notes.push(`bugetul de timp atins după ${translated} cue-uri traduse — restul rămâne în engleză (onest)`);
      break;
    }
    const batch = cues.slice(i, i + BATCH_SIZE);
    const listing = batch.map((c, j) => `${i + j + 1}. ${c.text.replace(/\n/g, ' ')}`).join('\n');
    const reply = await zaiComplete(
      [
        { role: 'system', content: 'Ești un traducător profesionist de subtitrări. Răspunzi EXCLUSIV cu lista numerotată a traducerilor, fără alte explicații.' },
        {
          role: 'user',
          content: `Tradu în română fiecare replică de subtitrare de mai jos (păstrează numele propriile tonul și lungimea aproximativă). Context: titlul „${title}".\nRăspunde cu listă numerotată, o linie per replică, exact în ordinea dată:\n\n${listing}`,
        },
      ],
      { timeoutMs: BATCH_TIMEOUT_MS },
    );
    if (!reply) {
      notes.push(`lotul ${Math.floor(i / BATCH_SIZE) + 1} nu a putut fi tradus — originalul englezesc a fost păstrat`);
      continue;
    }
    /* Parsare lejeră: linii „N. text" (N = numărul replicii globale). */
    const lines = reply.split('\n');
    for (const line of lines) {
      const m = /^\s*(\d{1,3})\s*[.)]:]?\s+(.*)$/.exec(line);
      if (!m) continue;
      const idx = Number(m[1]) - 1;
      const text = m[2].trim();
      if (idx < 0 || idx >= cues.length || !text) continue;
      if (out[idx].text !== out[idx].source) continue; // deja tradus (numere duplicate)
      out[idx].text = text.slice(0, CUE_TEXT_MAX);
      translated += 1;
    }
  }

  return { cues: out, translated, untranslated: cues.length - translated, notes };
}

/** POST /dubbing/generate — admin (ruta aplică garda). */
export async function dubbingGenerate({ contentId, user = null }) {
  let row;
  try {
    row = await one(
      `SELECT s.id, s.vtt, c.title FROM subtitles s JOIN content c ON c.id = s.contentid
        WHERE s.contentid = $1 AND s.lang = 'en' ORDER BY s.id ASC LIMIT 1`,
      [contentId],
    );
  } catch (err) {
    return { status: 503, error: 'Sursa de subtitrări este momentan indisponibilă (PostgreSQL necesar)' , detail: String(err.message || '').slice(0, 120) };
  }
  if (!row) return { status: 404, error: 'Nu există subtitrare în engleză pentru acest titlu' };

  const { cues, truncated } = parseVttCues(row.vtt);
  if (cues.length === 0) {
    return { status: 422, error: 'Subtitrarea EN nu conține cue-uri valide (WebVTT)' };
  }

  const { cues: translatedCues, translated, untranslated, notes } = await translateCues(cues, { title: row.title });

  const draft = {
    contentId,
    title: row.title,
    cues: translatedCues,
    corrected: false,
    generatedAt: nowIso(),
    provider: translated === 0 ? 'untranslated' : untranslated === 0 ? 'z-ai' : 'mixed',
    translated,
    untranslated,
    notes: [...(truncated ? [`fișierul EN are mai mult de ${MAX_CUES} cue-uri — ciorna a fost trunchiată la ${MAX_CUES} (onest)`] : []), ...notes],
    ...(user ? { createdBy: user.id } : {}),
  };
  const saved = writeDraft(contentId, draft);

  return {
    ok: true,
    contentId,
    title: draft.title,
    cues: draft.cues.length,
    translated,
    untranslated,
    provider: draft.provider,
    truncated,
    notes: draft.notes,
    saved,
    generatedAt: draft.generatedAt,
  };
}

/** GET /dubbing/draft/:contentId — admin. */
export function dubbingDraft(contentId) {
  const draft = readDraft(contentId);
  if (!draft) return { status: 404, error: 'Nu există o ciornă pentru acest titlu' };
  return { ok: true, draft };
}

/** Validare cues pentru corectură: start/end numerice, text 1..500, max 200. */
function validateCues(rawCues) {
  if (!Array.isArray(rawCues) || rawCues.length === 0) return { error: 'cues (array nevid de {start, end, text}) este obligatoriu' };
  if (rawCues.length > MAX_CUES) return { error: `maximum ${MAX_CUES} cue-uri (ai trimis ${rawCues.length})` };
  const cues = [];
  for (let i = 0; i < rawCues.length; i += 1) {
    const c = rawCues[i];
    if (!c || typeof c !== 'object') return { error: `cues[${i}] trebuie un obiect` };
    const start = Number(c.start);
    const end = Number(c.end);
    if (!Number.isFinite(start) || start < 0) return { error: `cues[${i}].start trebuie un număr ≥ 0` };
    if (!Number.isFinite(end) || end <= start) return { error: `cues[${i}].end trebuie un număr > start` };
    if (typeof c.text !== 'string' || c.text.trim().length === 0 || c.text.length > CUE_TEXT_MAX) {
      return { error: `cues[${i}].text trebuie un string nevid de max ${CUE_TEXT_MAX} caractere` };
    }
    cues.push({ start, end, text: c.text.trim() });
  }
  return { cues };
}

/** PUT /dubbing/draft/:contentId — corecturile adminului. */
export function dubbingSave({ contentId, cues, user = null }) {
  const existing = readDraft(contentId);
  if (!existing) return { status: 404, error: 'Nu există o ciornă pentru acest titlu — genereaz-o întâi' };
  const { cues: valid, error } = validateCues(cues);
  if (error) return { status: 400, error };

  const draft = {
    ...existing,
    cues: valid.map((c) => ({ ...c, source: c.text })),
    corrected: true,
    correctedAt: nowIso(),
    correctedBy: user?.id ?? null,
  };
  const saved = writeDraft(contentId, draft);
  return { ok: true, contentId, cues: draft.cues.length, corrected: true, saved, correctedAt: draft.correctedAt };
}

/** POST /dubbing/publish/:contentId — admin; loopback către FAZA 21 protejat. */
export async function dubbingPublish({ contentId, authHeader, user = null }) {
  const draft = readDraft(contentId);
  if (!draft) return { status: 404, error: 'Nu există o ciornă pentru acest titlu — genereaz-o întâi' };
  if (!Array.isArray(draft.cues) || draft.cues.length === 0) {
    return { status: 422, error: 'Ciorna nu are cue-uri de publicat' };
  }

  const vtt = buildVtt(draft.cues);
  if (vtt.length < 8 || vtt.length > 512 * 1024) {
    return { status: 422, error: 'Corpul WebVTT rezultat nu respectă limitele serviciului de subtitrări (8..512KB)' };
  }

  /* LOOPBACK către serviciul PROTEJAT /api/player/subtitles (FAZA 21) —
   * doar consumat; user-agent STRICT ASCII (Bun fetch respinge non-ASCII!). */
  let res;
  try {
    res = await fetch(`${SELF_BASE}/api/player/subtitles`, {
      method: 'POST',
      signal: AbortSignal.timeout(LOOPBACK_TIMEOUT_MS),
      headers: {
        'content-type': 'application/json',
        'user-agent': 'animaxia-ailab/1.0 (FAZA 35; publishes via protected subtitles service loopback)',
        ...(authHeader ? { authorization: authHeader } : {}),
      },
      body: JSON.stringify({ contentId, lang: 'ro', label: 'Română (AI)', vtt }),
    });
  } catch (err) {
    logger.warn(`[ai-lab] dubbing publish loopback a eșuat: ${err?.name ?? '?'} ${err?.message ?? err}`);
    return { status: 503, error: 'Serviciul de subtitrări este momentan indisponibil' };
  }
  const body = await res.json().catch(() => ({}));
  if (res.status === 200 && body?.ok === true && body?.subtitle?.id) {
    return {
      ok: true,
      published: true,
      contentId,
      subtitleId: Number(body.subtitle.id),
      label: 'Română (AI)',
      lang: 'ro',
      cues: draft.cues.length,
      created: Boolean(body.created),
      publishedAt: nowIso(),
    };
  }
  if (res.status === 400 || res.status === 404) {
    return { status: res.status, error: body?.error ?? 'Publicarea a fost respinsă de serviciul de subtitrări' };
  }
  return { status: 502, error: `Serviciul de subtitrări a răspuns ${res.status}`, detail: String(body?.error ?? '').slice(0, 140) };
}
