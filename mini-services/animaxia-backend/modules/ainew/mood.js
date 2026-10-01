/**
 * modules/ainew/mood.js — FAZA 35 (WS5): AI Mood Playlists — playlist generat
 * din dispoziție peste biblioteca reală. Lista de dispoziții e PREDEFINITĂ
 * și deterministă; selectia = scor de suprapunere cu genurile reale din
 * metadata->genres, amestec determinist cu seed; fallback onest pe top-rated
 * când genurile dispoziției au prea puține potriviri.
 */

import { rows, zaiComplete, memo, nowIso } from './common.js';

/* ------------------------------ moods registry ------------------------------ */

export const MOODS = [
  {
    key: 'relaxat',
    emoji: '😌',
    genres: ['Documentar', 'Muzică', 'Family', 'Animation'],
    description: 'Titluri liniștite pentru o seară calmă — familiale, documentare, animate.',
  },
  {
    key: 'captivant',
    emoji: '🔥',
    genres: ['Thriller', 'Crime', 'Mystery', 'Action'],
    description: 'Povești care te țin cu sufletul la gură — thriller, crime, mister.',
  },
  {
    key: 'nostalgic',
    emoji: '🕰️',
    genres: ['Drama', 'Romance', 'History'],
    description: 'Povești care duc cu gândul înapoi — dramă, romantism, istorie.',
  },
  {
    key: 'energic',
    emoji: '⚡',
    genres: ['Action', 'Adventure', 'Sport'],
    description: 'Adrenalină pură — acțiune, aventură, sport.',
  },
  {
    key: 'misterios',
    emoji: '🌙',
    genres: ['Mystery', 'Sci-Fi', 'Horror'],
    description: 'Enigme și întunecat — mister, science-fiction, horror.',
  },
  {
    key: 'romantic',
    emoji: '💗',
    genres: ['Romance', 'Drama'],
    description: 'Povești de dragoste — romantism și dramă.',
  },
];

export const MOOD_BY_KEY = new Map(MOODS.map((m) => [m.key, m]));

/** moodData() — lista deterministă (memo 300s la nivel de rută). */
export function moodData() {
  return {
    ok: true,
    moods: MOODS.map(({ key, emoji, genres, description }) => ({ key, emoji, genres, description })),
    generatedAt: nowIso(),
  };
}

/* ------------------------------ deterministic rng ---------------------------- */

/** mulberry32 — PRNG determinist pentru seed shuffle (aceeași seed ⇒ aceeași ordine). */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFrom(seedRaw) {
  const s = String(seedRaw ?? 'animaxia');
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Fisher-Yates cu PRNG seed-uit — determinist. */
function seededShuffle(list, seed) {
  const rand = mulberry32(seed);
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/* --------------------------------- generate --------------------------------- */

/** Normalizează un rând content → cardul public al playlistului. */
function toCard(r) {
  const meta = r.metadata && typeof r.metadata === 'object' ? r.metadata : {};
  return {
    id: Number(r.id),
    title: r.title,
    type: r.type ?? null,
    year: meta.year != null ? meta.year : null,
    rating: meta.rating != null ? Number(meta.rating) : null,
    genres: Array.isArray(meta.genres) ? meta.genres.slice(0, 6) : [],
    posterPath: r.thumbnail ?? null,
  };
}

function parseMeta(r) {
  try {
    return typeof r.metadata === 'string' ? JSON.parse(r.metadata) : (r.metadata ?? {});
  } catch {
    return {};
  }
}

/**
 * moodGenerate({ mood, limit, seed }) — validare, scor pe genuri (SQL real),
 * seed shuffle determinist, fallback top-rated, narațiune 1 propoziție.
 */
export async function moodGenerate({ mood, limit = 12, seed = 'animaxia' }) {
  const moodDef = MOOD_BY_KEY.get(String(mood ?? '').toLowerCase());
  if (!moodDef) {
    return { status: 400, error: `Dispoziție necunoscută: ${mood} (valide: ${MOODS.map((m) => m.key).join(', ')})` };
  }
  const safeLimit = Math.min(48, Math.max(1, Number.isInteger(Number(limit)) ? Number(limit) : 12));

  let matched = [];
  let fallbackUsed = false;
  try {
    matched = await rows(
      `SELECT id, title, type, thumbnail, metadata
         FROM content
        WHERE metadata->'genres' ?| $1[]
        ORDER BY (metadata->>'rating') DESC NULLS LAST, id ASC
        LIMIT $2`,
      [moodDef.genres, Math.max(safeLimit * 3, 36)],
    );
  } catch {
    matched = [];
  }

  let picked = matched.map((r) => ({ row: r, meta: parseMeta(r) }));
  if (picked.length < safeLimit) {
    /* Fallback onest: completăm cu top-rated din catalog (fără duplicate). */
    fallbackUsed = true;
    const have = new Set(picked.map((p) => Number(p.row.id)));
    let top = [];
    try {
      top = await rows(
        `SELECT id, title, type, thumbnail, metadata
           FROM content
          WHERE metadata->>'rating' IS NOT NULL
          ORDER BY (metadata->>'rating') DESC, id ASC
          LIMIT $1`,
        [safeLimit * 2],
      );
    } catch {
      top = [];
    }
    for (const r of top) {
      if (picked.length >= safeLimit) break;
      if (have.has(Number(r.id))) continue;
      picked.push({ row: r, meta: parseMeta(r) });
      have.add(Number(r.id));
    }
  }

  picked = seededShuffle(picked, seedFrom(seed)).slice(0, safeLimit);

  /* Narațiune de o propoziție (z-ai cu fallback determinist onest). */
  const titles = picked.slice(0, 5).map((p) => p.row.title);
  const narrative = await zaiComplete([
    { role: 'system', content: 'Răspunzi în română cu O SINGURĂ propoziție scurtă.' },
    {
      role: 'user',
      content: `Generează o propoziție scurtă pentru un playlist de dispoziție „${moodDef.key}" (stil: ${moodDef.description}). Titluri din playlist: ${titles.join(', ')}. O singură propoziție, fără enumerări.`,
    },
  ]);

  return {
    ok: true,
    mood: moodDef.key,
    emoji: moodDef.emoji,
    seed: String(seed),
    narrative: narrative ?? `Un playlist ${moodDef.key} cu ${picked.length} titluri alese pentru dispoziția ta — ${moodDef.description.toLowerCase()}`,
    provider: narrative ? 'z-ai' : 'heuristic',
    fallbackUsed,
    items: picked.map((p) => toCard({ ...p.row, metadata: p.meta })),
    generatedAt: nowIso(),
  };
}
