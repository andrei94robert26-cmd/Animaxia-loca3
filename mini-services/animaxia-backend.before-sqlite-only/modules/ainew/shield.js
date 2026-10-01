/**
 * modules/ainew/shield.js — FAZA 35 (WS5): AI Spoiler Shield — detecție de
 * spoilere în texte (comentarii/recenzii) CU limitări oneste:
 *  - pasul 1 este un HEURISTIC DETERMINIST (cuvinte-cheie RO+EN ponderate,
 *    fără NER — numele personajelor nu pot fi detectate fără un model
 *    dedicat; documentat onest);
 *  - pasul 2 este o rafinare z-ai OPȚIONALĂ doar pentru cazurile la limită
 *    (confidence 0.3–0.7), bounded (max 8 texte trimise) ca latența totală
 *    să rămână previzibilă;
 *  - confidence ∈ [0,1] = suma ponderilor cuvintelor potrivite.
 */

import { zaiComplete, nowIso } from './common.js';

const MAX_TEXTS = 50;
const MAX_BODY = 2000;
const BORDERLINE_REFINE_LIMIT = 8;

/** Cuvinte-cheie ponderate (RO + EN). Ponderi: 0.5+ = puternic, 0.15–0.3 = slab. */
const SPOILER_PATTERNS = [
  { pattern: 'moare', weight: 0.5 },
  { pattern: 'este ucis', weight: 0.5 },
  { pattern: 'dies', weight: 0.5 },
  { pattern: 'killed', weight: 0.45 },
  { pattern: 'spoiler', weight: 0.6 },
  { pattern: 'era viu', weight: 0.4 },
  { pattern: 'trădător', weight: 0.35 },
  { pattern: 'tradator', weight: 0.35 }, // varianta fără diacritice, onest întâlnită
  { pattern: 'villain', weight: 0.3 },
  { pattern: 'twist', weight: 0.3 },
  { pattern: 'reveals', weight: 0.3 },
  { pattern: 'dezvăluie', weight: 0.3 },
  { pattern: 'dezvaluie', weight: 0.3 },
  { pattern: 'se termină', weight: 0.2 },
  { pattern: 'se termina', weight: 0.2 },
  { pattern: 'final', weight: 0.2 },
  { pattern: 'ending', weight: 0.2 },
  { pattern: 'de fapt', weight: 0.15 },
];

const SPOILER_THRESHOLD = 0.5;

/** Escape pentru potrivirea literală (fără regex injection din dicționar). */
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Pasul 1 — euristic determinist: potriviri + confidence. */
function heuristicScan(body) {
  const text = String(body).toLowerCase();
  const matched = [];
  let score = 0;
  for (const { pattern, weight } of SPOILER_PATTERNS) {
    const re = new RegExp(`(^|[^a-zăâîșțáéíóú])${escapeRe(pattern.toLowerCase())}([^a-zăâîșțáéíóú]|$)`, 'i');
    if (re.test(text)) {
      matched.push(pattern);
      score += weight;
    }
  }
  return { matched, confidence: Math.min(1, Math.round(score * 100) / 100) };
}

/** Pasul 2 — rafinare z-ai pentru cazurile la limită (bounded, best-effort).
 * Întoarce map id → { spoiler } | null (indisponibil). */
async function aiRefine(batch) {
  const listing = batch.map((t, i) => `${i + 1}. ${String(t.body).slice(0, 300)}`).join('\n');
  const reply = await zaiComplete([
    { role: 'system', content: 'Ești un detector de spoilere. Răspunzi EXCLUSIV cu JSON.' },
    {
      role: 'user',
      content: `Pentru fiecare text de mai jos, decide dacă dezvăluie spoilere (evenimente-cheie din intrigă, deznodământ, morți, trădări).\nRăspunde STRICT cu un JSON: {"results":[{"i":<număr>,"spoiler":true|false}]}\n\n${listing}`,
    },
  ]);
  if (!reply) return null;
  const m = reply.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[0]);
    const map = new Map();
    for (const r of parsed?.results ?? []) {
      const i = Number(r?.i);
      if (Number.isInteger(i) && i >= 1 && i <= batch.length && typeof r?.spoiler === 'boolean') {
        map.set(batch[i - 1].id, { spoiler: r.spoiler });
      }
    }
    return map;
  } catch {
    return null;
  }
}

/**
 * shieldFilter({ contentId, texts, mode }) — texts = [{id, body}] max 50,
 * body max 2000 caractere fiecare (400 onest la abatere).
 * mode: 'tag' (implicit) → action 'etichetat' | 'block' → 'ascuns'/'vizibil'.
 */
export async function shieldFilter({ contentId = null, texts, mode = 'tag' }) {
  if (mode !== 'tag' && mode !== 'block') {
    return { status: 400, error: "mode trebuie 'tag' sau 'block'" };
  }
  if (!Array.isArray(texts) || texts.length === 0) {
    return { status: 400, error: 'texts (array de {id, body}) este obligatoriu' };
  }
  if (texts.length > MAX_TEXTS) {
    return { status: 400, error: `Maximum ${MAX_TEXTS} texte per cerere (ai trimis ${texts.length})` };
  }
  for (const t of texts) {
    if (!t || typeof t !== 'object' || t.id === undefined || t.id === null) {
      return { status: 400, error: 'fiecare text trebuie { id, body }' };
    }
    if (typeof t.body !== 'string' || t.body.trim().length === 0) {
      return { status: 400, error: 'body trebuie un string nevid' };
    }
    if (t.body.length > MAX_BODY) {
      return { status: 400, error: `body depășește ${MAX_BODY} de caractere (textul cu id ${String(t.id)})` };
    }
  }

  /* Pasul 1 — euristic pentru toate textele (determinist, instant). */
  const scanned = texts.map((t) => {
    const { matched, confidence } = heuristicScan(t.body);
    return { id: t.id, body: t.body, matched, confidence };
  });

  /* Pasul 2 — rafinare z-ai DOAR pentru cazurile la limită (0.3–0.7), bounded. */
  const borderline = scanned.filter((s) => s.confidence >= 0.3 && s.confidence <= 0.7).slice(0, BORDERLINE_REFINE_LIMIT);
  let aiVerifiedCount = 0;
  let provider = 'heuristic';
  if (borderline.length > 0) {
    const refined = await aiRefine(borderline);
    if (refined) {
      provider = 'mixed';
      for (const s of scanned) {
        if (refined.has(s.id)) {
          s.aiVerified = true;
          aiVerifiedCount += 1;
          const aiSpoiler = refined.get(s.id).spoiler;
          /* z-ai confirmă/infirmă doar cazurile la limită — decizia finală
           * combină: euristică puternică (>= threshold) SAU confirmare AI. */
          s.spoiler = s.confidence >= SPOILER_THRESHOLD || aiSpoiler;
          if (s.spoiler && s.confidence < SPOILER_THRESHOLD) s.confidence = SPOILER_THRESHOLD + 0.05; // confirmat AI
        }
      }
    }
  }
  for (const s of scanned) {
    if (s.spoiler === undefined) s.spoiler = s.confidence >= SPOILER_THRESHOLD;
  }

  const results = scanned.map((s) => ({
    id: s.id,
    body: s.body,
    spoiler: Boolean(s.spoiler),
    confidence: s.confidence,
    matched: s.matched,
    action: mode === 'block' ? (s.spoiler ? 'ascuns' : 'vizibil') : 'etichetat',
    ...(s.aiVerified ? { aiVerified: true } : {}),
  }));

  return {
    ok: true,
    ...(contentId != null ? { contentId } : {}),
    mode,
    provider,
    results,
    stats: {
      total: results.length,
      spoilers: results.filter((r) => r.spoiler).length,
      aiVerified: aiVerifiedCount,
    },
    /* Limitare onestă: fără NER, numele personajelor nu pot fi detectate. */
    limitations: 'detecție euristică pe cuvinte-cheie RO+EN (fără recunoașterea numelor de personaje); rafinarea AI se aplică doar cazurilor la limită',
    generatedAt: nowIso(),
  };
}
