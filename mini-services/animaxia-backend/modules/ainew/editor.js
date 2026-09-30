/**
 * modules/ainew/editor.js — FAZA 35 (WS5): AI Editor de Liste — transformă o
 * descriere liberă („thrillere coreene lungi") într-un playlist REAL din
 * catalog. Interpretare z-ai (JSON lenient) cu fallback DETERMINIST pe
 * dicționar cuvinte-cheie→gen; selectia SQL reală pe metadata->genres și
 * title ILIKE; salvare file-based data/ainew/playlists/<userId>.json
 * (max 20 playlist-uri per user, id uuid) — zero schemă DB.
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rows, zaiComplete, nowIso } from './common.js';
import { logger } from '../../utils/logger.js';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const STORAGE_DIR = join(MODULE_DIR, '..', '..', 'data', 'ainew', 'playlists');

const DESCRIPTION_MIN = 3;
const DESCRIPTION_MAX = 400;
const MAX_PLAYLISTS = 20;
const MAX_ITEMS = 50;

/* --------------------------- interpretation (AI) ----------------------------- */

/** Dicționar DETERMINIST cuvinte-cheie → gen/chei de căutare (fallback onest). */
const KEYWORD_MAP = [
  { words: ['romantic', 'romantice', 'dragoste', 'love'], genres: ['Romance'] },
  { words: ['thriller', 'thrillere', 'suspans'], genres: ['Thriller'] },
  { words: ['coreean', 'coreene', 'coreeni', 'korean', 'k-drama', 'kdrama'], genres: [], keywords: ['korean', 'korea'] },
  { words: ['comedie', 'comice', 'funny', 'amuzante'], genres: ['Comedy'] },
  { words: ['actiune', 'acțiune', 'action'], genres: ['Action'] },
  { words: ['horror', 'groaza', 'groază'], genres: ['Horror'] },
  { words: ['anima', 'anime', 'desene'], genres: ['Animation', 'Anime'] },
  { words: ['drama', 'dramă', 'drame'], genres: ['Drama'] },
  { words: ['sf', 'stiinta', 'știință', 'sci-fi', 'space'], genres: ['Science-Fiction', 'Sci-Fi & Fantasy'] },
  { words: ['documentar', 'documentare'], genres: ['Documentary', 'Documentar'] },
  { words: ['istoric', 'istorie', 'istorice'], genres: ['History'] },
  { words: ['crima', 'crimă', 'crime', 'politi', 'poliți'], genres: ['Crime'] },
  { words: ['mister', 'mystery', 'enigma'], genres: ['Mystery'] },
  { words: ['familie', 'family', 'copii'], genres: ['Family', 'Children'] },
  { words: ['aventura', 'aventură', 'adventure'], genres: ['Adventure'] },
  { words: ['razboi', 'război', 'war'], genres: ['War'] },
  { words: ['muzica', 'muzică', 'music'], genres: ['Music'] },
  { words: ['sport'], genres: ['Sports'] },
  { words: ['fantasy', 'fantastice', 'fantezie'], genres: ['Fantasy'] },
];

const STOP_WORDS = new Set([
  'si', 'și', 'de', 'la', 'cu', 'pe', 'in', 'în', 'pentru', 'un', 'o', 'niște', 'niste',
  'lungi', 'lung', 'scurte', 'scurt', 'serii', 'serie', 'filme', 'film', 'seriale',
  'serial', 'vreau', 'vreau', 'da-mi', 'dă-mi', 'listă', 'lista', 'playlist', 'make', 'me',
  'show', 'shows', 'movies', 'series', 'long', 'short', 'vreo', 'care', 'ce', 'cum',
]);

function heuristicInterpret(description) {
  const text = String(description).toLowerCase();
  const genres = new Set();
  const keywords = new Set();
  for (const entry of KEYWORD_MAP) {
    for (const w of entry.words) {
      if (text.includes(w)) {
        for (const g of entry.genres) genres.add(g);
        for (const k of entry.keywords ?? []) keywords.add(k);
      }
    }
  }
  for (const word of text.split(/[^a-zăâîșț0-9]+/)) {
    if (word.length >= 3 && !STOP_WORDS.has(word) && !/^\d+$/.test(word)) keywords.add(word);
  }
  const types = [];
  if (/anime|desene/.test(text)) types.push('anime');
  if (/film|movie/.test(text)) types.push('movie');
  if (/serial|serie|tv/.test(text)) types.push('tv');
  const mood = /romantic|dragoste/.test(text) ? 'romantic'
    : /thriller|suspans|groaza|groază|horror/.test(text) ? 'captivant'
    : /comedie|amuzante/.test(text) ? 'relaxat'
    : null;
  const words = String(description).trim().split(/\s+/);
  return {
    title: null, // derivat onest din descriere mai jos
    genres: [...genres],
    types,
    keywords: [...keywords].slice(0, 8),
    mood,
    maxItems: null,
    provider: 'heuristic',
  };
}

/** Extrage primul bloc {...} dintr-un răspuns LLM (parsare lejenă). */
function extractJson(text) {
  const m = String(text ?? '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

/** editorInterpret({ description }) — z-ai JSON cu fallback dicționar. */
export async function editorInterpret({ description }) {
  const desc = typeof description === 'string' ? description.trim() : '';
  if (desc.length < DESCRIPTION_MIN || desc.length > DESCRIPTION_MAX) {
    return { status: 400, error: `description trebuie un string între ${DESCRIPTION_MIN} și ${DESCRIPTION_MAX} de caractere` };
  }

  const fallback = heuristicInterpret(desc);
  const ai = await zaiComplete([
    { role: 'system', content: 'Ești un interpret de intenții pentru o platformă de streaming. Răspunzi EXCLUSIV cu JSON valid.' },
    {
      role: 'user',
      content: `Utilizatorul descrie ce playlist vrea: „${desc}".
Interpretează și răspunde STRICT cu JSON:
{"title": <string scurt sau null>, "genres": [<genuri din catalog: Drama, Comedy, Action, Thriller, Romance, Animation, Anime, Mystery, Crime, Horror, History, War, Music, Sports, Fantasy, Science-Fiction, Family>], "types": [<subset din "movie","tv","anime">], "keywords": [<max 5 cuvinte de căultat în titluri>], "mood": <"relaxat"|"captivant"|"nostalgic"|"energic"|"misterios"|"romantic"|null>, "maxItems": <număr sau null>}`,
    },
  ]);

  const parsed = ai ? extractJson(ai) : null;
  if (parsed && typeof parsed === 'object') {
    const genreWhitelist = KEYWORD_MAP.flatMap((k) => k.genres);
    const genres = Array.isArray(parsed.genres)
      ? parsed.genres.filter((g) => typeof g === 'string' && g.length > 0).slice(0, 6)
      : [];
    const mergedGenres = [...new Set([...genres, ...fallback.genres])]; // onest: heuristic merge
    return {
      title: typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title.trim().slice(0, 60) : null,
      genres: mergedGenres.length > 0 ? mergedGenres.slice(0, 6) : fallback.genres,
      types: Array.isArray(parsed.types)
        ? parsed.types.filter((t) => ['movie', 'tv', 'anime'].includes(t))
        : fallback.types,
      keywords: Array.isArray(parsed.keywords)
        ? parsed.keywords.filter((k) => typeof k === 'string' && k.length > 1).slice(0, 6)
        : fallback.keywords,
      mood: typeof parsed.mood === 'string' ? parsed.mood : fallback.mood,
      maxItems: Number.isInteger(parsed.maxItems) && parsed.maxItems > 0 ? Math.min(48, parsed.maxItems) : null,
      provider: 'z-ai',
    };
  }
  return fallback;
}

/* --------------------------------- generate --------------------------------- */

function parseMeta(r) {
  try {
    return typeof r.metadata === 'string' ? JSON.parse(r.metadata) : (r.metadata ?? {});
  } catch {
    return {};
  }
}

function toCard(r, meta) {
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

/** editorGenerate({ description, limit, userId }) — interpret → SQL real → playlist. */
export async function editorGenerate({ description, limit = 12, userId = null }) {
  if (typeof description !== 'string' || description.trim().length < DESCRIPTION_MIN || description.trim().length > DESCRIPTION_MAX) {
    return { status: 400, error: `description trebuie un string între ${DESCRIPTION_MIN} și ${DESCRIPTION_MAX} de caractere` };
  }
  const desc = description.trim();
  const safeLimit = Math.min(48, Math.max(1, Number.isInteger(Number(limit)) ? Number(limit) : 12));

  const interpreted = await editorInterpret({ description: desc });
  if (interpreted.status) return interpreted; // 400

  let candidates = [];
  try {
    candidates = await rows(
      `SELECT id, title, type, thumbnail, metadata FROM content
        WHERE (
          ${interpreted.genres.length > 0 ? `metadata->'genres' ?| $1::text[] OR` : ''}
          ${interpreted.keywords.length > 0 ? `title ILIKE ANY($2::text[]) OR` : ''}
          false
        )
        ${interpreted.types.length > 0 ? 'AND type = ANY($3::text[])' : ''}
        ORDER BY (metadata->>'rating') DESC NULLS LAST, id ASC
        LIMIT $4`,
      [
        interpreted.genres.length > 0 ? interpreted.genres : ['__none__'],
        interpreted.keywords.length > 0 ? interpreted.keywords.map((k) => `%${k}%`) : ['%__none__%'],
        interpreted.types.length > 0 ? interpreted.types : ['movie', 'tv', 'anime', 'video', 'mined'],
        safeLimit * 2,
      ],
    );
  } catch {
    candidates = [];
  }

  /* Dacă genurile/keywords nu au nimic: relaxăm onest la tot catalogul top-rated. */
  let relaxed = false;
  if (candidates.length === 0) {
    relaxed = true;
    try {
      candidates = await rows(
        `SELECT id, title, type, thumbnail, metadata FROM content
          WHERE metadata->>'rating' IS NOT NULL
          ORDER BY (metadata->>'rating') DESC, id ASC LIMIT $1`,
        [safeLimit * 2],
      );
    } catch {
      candidates = [];
    }
  }

  const items = candidates
    .map((r) => toCard(r, parseMeta(r)))
    .filter((c) => (interpreted.types.length > 0 ? interpreted.types.includes(c.type) : true))
    .slice(0, safeLimit);

  const playlistTitle = interpreted.title ?? `Playlist: ${desc.slice(0, 40)}${desc.length > 40 ? '…' : ''}`;
  return {
    ok: true,
    description: desc,
    interpreted: {
      title: interpreted.title,
      genres: interpreted.genres,
      types: interpreted.types,
      keywords: interpreted.keywords,
      mood: interpreted.mood,
      maxItems: interpreted.maxItems,
      provider: interpreted.provider,
    },
    playlist: {
      title: playlistTitle,
      description: desc,
      itemCount: items.length,
    },
    items,
    relaxed,
    provider: interpreted.provider,
    ...(userId ? { userId } : {}),
    generatedAt: nowIso(),
  };
}

/* ------------------------------ save / list (file) --------------------------- */

function playlistsPath(userId) {
  return join(STORAGE_DIR, `${userId}.json`);
}

function readPlaylists(userId) {
  try {
    const parsed = JSON.parse(readFileSync(playlistsPath(userId), 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Scriere atomică (tmp+rename), director creat leneș. Niciodată throw. */
function writePlaylists(userId, list) {
  try {
    mkdirSync(STORAGE_DIR, { recursive: true });
    const file = playlistsPath(userId);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(list, null, 2)}\n`);
    renameSync(tmp, file);
    return true;
  } catch (err) {
    logger.warn(`[ai-lab] editor: salvarea playlist-urilor userului ${userId} a eșuat: ${err?.message ?? err}`);
    return false;
  }
}

/** editorSave({ playlist, itemIds, user }) — AUTH la nivel de rută. */
export function editorSave({ playlist, itemIds, user }) {
  if (!playlist || typeof playlist !== 'object') {
    return { status: 400, error: 'playlist (obiect {title, description?}) este obligatoriu' };
  }
  const title = typeof playlist.title === 'string' ? playlist.title.trim() : '';
  if (title.length < 1 || title.length > 60) {
    return { status: 400, error: 'playlist.title trebuie un string de 1..60 caractere' };
  }
  const description = typeof playlist.description === 'string' ? playlist.description.trim().slice(0, 300) : '';
  if (!Array.isArray(itemIds) || itemIds.length === 0) {
    return { status: 400, error: 'itemIds (array nevid de id-uri de conținut) este obligatoriu' };
  }
  if (itemIds.length > MAX_ITEMS) {
    return { status: 400, error: `maximum ${MAX_ITEMS} itemi per playlist (ai trimis ${itemIds.length})` };
  }
  const ids = [];
  for (const raw of itemIds) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) return { status: 400, error: 'itemIds trebuie întregi pozitivi' };
    if (!ids.includes(n)) ids.push(n); // dedup onest
  }

  const list = readPlaylists(user.id);
  if (list.length >= MAX_PLAYLISTS) {
    return { status: 400, error: `Ai atins limita de ${MAX_PLAYLISTS} playlist-uri — șterge unul întâi` };
  }
  const entry = {
    id: randomUUID(),
    title,
    ...(description ? { description } : {}),
    itemIds: ids,
    createdAt: nowIso(),
  };
  list.push(entry);
  const saved = writePlaylists(user.id, list);
  return { ok: true, playlist: entry, total: list.length, saved };
}

/** editorLists(user) — playlist-urile salvate ale userului. */
export function editorLists(user) {
  const lists = readPlaylists(user.id);
  return { ok: true, playlists: lists, total: lists.length };
}
