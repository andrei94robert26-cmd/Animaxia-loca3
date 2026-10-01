/**
 * modules/ai/hub.js — FAZA 16-b: AI Hub — 6 AI-uri NOI, toate reale, cu
 * toggle on/off persistent în Neon (tabela `aisettings`, key `hub:{key}`).
 *
 * Mount: app.use('/api/ai/hub', hubAiRouter) — ÎNAINTE de /api/ai (vezi
 * server.js). Răspunsurile sunt JSON; z-ai LLM are mereu fallback heuristic
 * real, cu provider etichetat onest ('z-ai' | 'heuristic' | 'sql' |
 * 'hashed-bow' | 'passthrough' | 'tmdb' | 'jikan').
 *
 * Endpoint-uri comune (funcționează mereu, chiar și cu AI-urile oprite):
 *   GET  /status             → { ais: [ {key,name,emoji,description,enabled,
 *                                        provider,lastRunAt,stats} ×6 ],
 *                                existing: [ {key,name,emoji,enabled:null,note} ] }
 *   POST /settings {key,enabled} → { ok, key, enabled }   (persistă în aisettings)
 *
 * AI 1 — Curator (curator):
 *   GET  /curator/scan       → { duplicates, completeness, avgScore, scanned }
 *   POST /curator/enrich     (requireAuth) → { ok, enriched, provider }
 *   POST /curator/merge      (requireAdmin) → { ok }
 *
 * AI 2 — Trend Forecaster (forecaster):
 *   GET  /trends/forecast?window=1d|7d|30d → { window, eventsAnalyzed, source,
 *                                              rising, top, narrative, provider, generatedAt }
 *
 * AI 3 — Semantic Search (semantic):
 *   POST /semantic/query {query, limit?}  → { ok, results, provider, embeddedDocs }
 *   GET  /semantic/similar/:contentId     → { ok, results }
 *   GET  /semantic/status                 → { embedded, total, provider, dims, lastEmbedAt }
 *
 * AI 4 — Watchdog (watchdog):
 *   GET  /watchdog/health    → { ok, score, alerts, checks, diagnosis, provider, checkedAt }
 *
 * AI 5 — Marathon Builder (marathon):
 *   GET  /marathon/suggestions → { suggestions: [ {key,title,emoji,count,items,rationale} ] }
 *   POST /marathon/create {key} (requireAuth) → { ok, marathon }
 *   GET  /marathon/list        → { data: [ {...marathon, items, mine} ] }
 *
 * AI 6 — Translator (translator):
 *   POST /translate {contentId, lang} (requireAuth + 10/min) → { ok, contentId, lang, translation, provider }
 *   GET  /translate/status → { coverage: { total, withTranslations, byLang } }
 *
 * Când un AI este oprit, endpoint-urile lui principale returnează
 * 503 {error: 'AI <Name> is disabled', disabled: true}. /status, /settings
 * și endpoint-urile de status per AI rămân mereu disponibile.
 *
 * Semantic embeddings: încearcă z-ai embeddings la runtime; SDK-ul actual nu
 * expune `embeddings`, deci rulează fallback-ul determinist hashed-bow
 * (256-dim, sha256(token)%256, tf sublinear, L2-normalizat) stocat în tabela
 * `aisemantic` (externalid PK, embedding JSONB, provider per rând). Cosine
 * similarity se calculează în JS — OK pentru mii de documente; calea de
 * scalare documentată: coloană pgvector + operatorul `<=>` când tabelul crește.
 */

import express from 'express';
import crypto from 'node:crypto';
import ZAI from 'z-ai-web-dev-sdk';
import { rows, one, jsonb, parseJsonb } from '../platform/sql.js';
import { query, getContentById, deleteContent } from '../../db.js';
import { requireAuth, requireAdmin } from '../users/auth.js';
import { userRateLimit, auditLog, clientIpOf } from '../security/security.js';
import { events } from '../platform/events.js';
import { tmdbFetch } from '../movies/tmdb.js';
import { fetchProviderJson, breakerStats } from '../../utils/fetcher.js';
import { cache } from '../../cache.js';
import { rateLimitStats } from '../../rateLimit.js';
import { getFranchiseHub, getTrilogyHub } from '../discover/collections.js';
import { logger } from '../../utils/logger.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const JIKAN_BASE = process.env.JIKANBASEURL || 'https://api.jikan.moe/v4';
const ENRICH_PACING_MS = 300;
const EMBED_DIMS = 256;
const EMBED_BATCH = 25;

/* ------------------------------ z-ai singleton ------------------------------ */

let zaiInstance = null;

async function getZai() {
  if (!zaiInstance) zaiInstance = await ZAI.create();
  return zaiInstance;
}

/**
 * One z-ai chat completion (assistant system + user messages, thinking
 * disabled, timeout via Promise.race, 1 retry). Returns null on failure so
 * every caller can degrade to its heuristic path. Romanian output prompts.
 */
async function complete(messages, { timeoutMs = 20000 } = {}) {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const zai = await getZai();
      const completion = await Promise.race([
        zai.chat.completions.create({ messages, thinking: { type: 'disabled' } }),
        new Promise((_, reject) => {
          const timer = setTimeout(
            () => reject(new Error(`z-ai completion timed out after ${timeoutMs}ms`)),
            timeoutMs,
          );
          if (typeof timer.unref === 'function') timer.unref();
        }),
      ]);
      const text = completion?.choices?.[0]?.message?.content;
      if (typeof text === 'string' && text.trim().length > 0) {
        return text.trim();
      }
      throw new Error('z-ai returned an empty completion');
    } catch (err) {
      if (attempt >= 2) {
        logger.warn(`[ai-hub] z-ai completion failed (${err.message}) — heuristic fallback`);
        return null;
      }
    }
  }
  return null;
}

/* ------------------------------ in-process memo ----------------------------- */

const memoStore = new Map(); // key → { at, value, promise }

/** TTL memo with concurrent-call coalescing (never throws by itself). */
function memo(key, ttlMs, producer) {
  const hit = memoStore.get(key);
  if (hit && Date.CURRENT_TIMESTAMP - hit.at < ttlMs) return Promise.resolve(hit.value);
  if (hit && hit.promise) return hit.promise;
  const promise = Promise.resolve()
    .then(producer)
    .then((value) => {
      memoStore.set(key, { at: Date.CURRENT_TIMESTAMP, value, promise: null });
      return value;
    })
    .catch((err) => {
      memoStore.delete(key);
      throw err;
    });
  memoStore.set(key, { at: 0, value: null, promise });
  return promise;
}

/* --------------------------------- registry -------------------------------- */

const AIS = [
  {
    key: 'curator',
    name: 'Curator',
    emoji: '🧹',
    description: 'Detectare duplicate (trigram pe titluri + surse comune), scor de completitudine metadata și auto-enrich real TMDB/Jikan cu merge administrator.',
  },
  {
    key: 'forecaster',
    name: 'Trend Forecaster',
    emoji: '📈',
    description: 'Predicție trend-uri din evenimente reale de vizionare (momentum SQL) cu narativ generat de LLM în română.',
  },
  {
    key: 'semantic',
    name: 'Semantic Search',
    emoji: '🧠',
    description: 'Căutare semantică prin embeddings (hashed-bow 256-dim determinist, cu suport z-ai embeddings dacă devin disponibile) + vecini similari per conținut.',
  },
  {
    key: 'watchdog',
    name: 'Watchdog',
    emoji: '🛡️',
    description: 'Monitorizare anomalii: provideri externi, latență DB, cache, rate-limit, erori ingest, sincronizare index — cu scor și diagnostic LLM.',
  },
  {
    key: 'marathon',
    name: 'Marathon Builder',
    emoji: '🏁',
    description: 'Maratoane ordonate automat din francize și trilogii reale TMDB + maratoane din biblioteca ta (rating, noutăți), salvabile per user.',
  },
  {
    key: 'translator',
    name: 'Translator',
    emoji: '🌐',
    description: 'Traduceri multi-limbă (ro/en/es/fr/de) ale descrierilor prin LLM, salvate în metadata.translations.',
  },
];
const AI_BY_KEY = new Map(AIS.map((ai) => [ai.key, ai]));

const lastRuns = new Map(); // key → ISO timestamp of the last main-endpoint call

/* ------------------------------ hub settings ------------------------------- */
/*
 * Toggles persist in the Neon `aisettings` table — one row per AI,
 * key `hub:{key}`, value {enabled: boolean, updatedAt: ISO}. Default ON.
 * In-memory cache (30s) keeps the per-request guard cheap.
 */

let settingsCache = { at: 0, map: new Map() };

async function loadHubSettings() {
  if (Date.CURRENT_TIMESTAMP - settingsCache.at < 30000) return settingsCache.map;
  const map = new Map();
  try {
    const stored = await rows(`SELECT key, value FROM aisettings WHERE key LIKE 'hub:%'`);
    for (const row of stored) {
      const key = String(row.key).slice(4); // strip 'hub:'
      const value = parseJsonb(row.value, {});
      if (typeof value.enabled === 'boolean') map.set(key, value.enabled);
    }
  } catch (err) {
    logger.warn(`[ai-hub] aisettings read failed (${err.message}) — defaults (all ON)`);
  }
  settingsCache = { at: Date.CURRENT_TIMESTAMP, map };
  return map;
}

async function setAiEnabled(key, enabled) {
  const value = { enabled, updatedAt: new Date().toISOString() };
  await rows(
    `INSERT INTO aisettings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updatedat = CURRENT_TIMESTAMP`,
    [`hub:${key}`, jsonb(value)],
  );
  settingsCache = { at: 0, map: new Map() }; // invalidate
  memoStore.delete('hub:status'); // FAZA 16-d fix: /status must reflect the new toggle immediately
}

/** 503 guard for an AI's main endpoints; records lastRunAt when enabled. */
function guard(key) {
  return wrap(async (req, res, next) => {
    const settings = await loadHubSettings();
    if (settings.get(key) === false) {
      const ai = AI_BY_KEY.get(key);
      return res.status(503).json({ error: `AI ${ai ? ai.name : key} is disabled`, disabled: true });
    }
    lastRuns.set(key, new Date().toISOString());
    return next();
  });
}

/* --------------------------------- helpers --------------------------------- */

/** Coerce a metadata value to a clean string array (strings or {name} objects). */
function toNameArray(value) {
  if (value == null) return [];
  const list = Array.isArray(value) ? value : [value];
  const out = [];
  for (const item of list) {
    if (typeof item === 'string') {
      const name = item.trim();
      if (name) out.push(name);
    } else if (item && typeof item === 'object') {
      const name = String(item.name ?? '').trim();
      if (name) out.push(name);
    }
  }
  return out;
}

const toIntOrNull = (value) => {
  const n = parseInt(value, 10);
  return Number.isInteger(n) ? n : null;
};

/** Normalize a raw SQL content row (metadata jsonb → object). */
function normalizeContentRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    externalid: row.externalid ?? null,
    type: row.type ?? null,
    title: row.title ?? '',
    metadata: parseJsonb(row.metadata, {}),
    thumbnail: row.thumbnail ?? null,
    createdat: row.createdat instanceof Date ? row.createdat.toISOString() : String(row.createdat ?? ''),
  };
}

function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'x';
}

/** Announce a content mutation exactly like server.js invalidateHttpCache():
 *  clear the HTTP response cache prefix + emit the platform event (which
 *  drives the searchdocs resync, advancedCache invalidation and the semantic
 *  re-embed debounce). */
function contentMutated() {
  try {
    cache.clearPrefix('http:');
  } catch {
    /* best-effort */
  }
  events.emit('content:changed');
}

/* ==================================================================== */
/* AI 1 — CURATOR: dedup inteligent + completitudine + auto-enrich       */
/* ==================================================================== */

const FIELD_WEIGHTS = { title: 15, year: 10, genres: 15, description: 20, thumbnail: 15, trailer: 10, actors: 8, studio: 7 };

/** Completeness over 7 canonical fields (title 15, year 10, genres 15,
 *  description 20, thumbnail 15, trailer 10, actors+studio 15 → 100). */
function completenessOf(row) {
  const meta = row.metadata || {};
  const missing = [];
  let score = 0;

  score += FIELD_WEIGHTS.title; // title is NOT NULL in the content table
  if (meta.year == null || String(meta.year).trim() === '') missing.push('year');
  else score += FIELD_WEIGHTS.year;

  const genres = toNameArray(meta.genres);
  if (genres.length === 0) missing.push('genres');
  else score += FIELD_WEIGHTS.genres;

  const description = String(meta.overview || meta.synopsis || meta.description || '').trim();
  if (!description) missing.push('description');
  else score += FIELD_WEIGHTS.description;

  if (row.thumbnail || meta.thumbnail) score += FIELD_WEIGHTS.thumbnail;
  else missing.push('thumbnail');

  const hasTrailer = Boolean(
    meta.trailer || meta.trailerKey || meta.youtube ||
    (Array.isArray(meta.sources) && meta.sources.some((s) => {
      if (typeof s !== 'object' || !s) return false;
      return s.kind === 'youtube' || /youtube|youtu\.be/i.test(String(s.src || ''));
    })),
  );
  if (hasTrailer) score += FIELD_WEIGHTS.trailer;
  else missing.push('trailer');

  const actors = toNameArray(meta.actors ?? meta.cast);
  const studios = toNameArray(meta.studios ?? meta.studio);
  if (actors.length > 0) score += FIELD_WEIGHTS.actors;
  else missing.push('actors');
  if (studios.length > 0) score += FIELD_WEIGHTS.studio;
  else missing.push('studio');

  return { score, missing };
}

/** Union-find grouping of duplicate pairs into id clusters. */
function groupDuplicatePairs(pairs) {
  const parent = new Map();
  const titleById = new Map();
  const find = (x) => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root);
    while (parent.get(x) !== root) {
      const next = parent.get(x);
      parent.set(x, root);
      x = next;
    }
    return root;
  };
  const union = (x, y) => {
    const rx = find(x);
    const ry = find(y);
    if (rx !== ry) parent.set(rx, ry);
  };
  for (const p of pairs) {
    for (const side of [p.a, p.b]) {
      if (!parent.has(side.id)) {
        parent.set(side.id, side.id);
        titleById.set(side.id, side.title);
      }
    }
    union(p.a.id, p.b.id);
  }
  const groups = new Map(); // root → { ids: Set, simByReason: Map }
  for (const p of pairs) {
    const root = find(p.a.id);
    if (!groups.has(root)) groups.set(root, { ids: new Set(), simByReason: new Map() });
    const g = groups.get(root);
    g.ids.add(p.a.id);
    g.ids.add(p.b.id);
    g.simByReason.set(p.reason, Math.max(g.simByReason.get(p.reason) ?? 0, p.similarity));
  }
  return [...groups.values()]
    .map((g) => {
      const ids = [...g.ids].sort((a, b) => a - b);
      const reason = g.simByReason.has('same-source') ? 'same-source' : 'similar-title';
      return {
        ids,
        titles: ids.map((id) => titleById.get(id)),
        reason,
        similarity: Number(Number(g.simByReason.get(reason) ?? 0).toFixed(4)),
      };
    })
    .sort((a, b) => b.ids.length - a.ids.length || b.similarity - a.similarity);
}

/** Full curator scan — duplicates (similar titles + shared sources) and
 *  metadata completeness for every content row. Cached 60s. */
async function curatorScan() {
  return memo('hub:curator:scan', 60000, async () => {
    // 1a. Similar-title pairs from the searchdocs trigram index.
    const similarPairs = await rows(
      `SELECT a.contentid AS ida, a.title AS ta, b.contentid AS idb, b.title AS tb,
              similarity(a.title, b.title) AS sim
       FROM searchdocs a
       JOIN searchdocs b ON a.contentid < b.contentid
       WHERE similarity(a.title, b.title) > 0.45
       ORDER BY sim DESC
       LIMIT 20`,
    );

    // 1b. Same-source pairs: two content rows sharing the same canonical URL
    //     (metadata.url / metadata.finalUrl), or a URL held by one row that the
    //     global contentsources registry links to a different content row.
    let sameSourcePairs = await rows(
      `SELECT a.id AS ida, a.title AS ta, b.id AS idb, b.title AS tb
       FROM content a
       JOIN content b ON a.id < b.id
       WHERE COALESCE(a.metadata->>'url', '') <> ''
         AND (a.metadata->>'url' = b.metadata->>'url'
           OR a.metadata->>'url' = b.metadata->>'finalUrl'
           OR a.metadata->>'finalUrl' = b.metadata->>'url'
           OR (COALESCE(a.metadata->>'finalUrl','') <> '' AND a.metadata->>'finalUrl' = b.metadata->>'finalUrl'))
       LIMIT 20`,
    ).catch(() => []);

    if (sameSourcePairs.length === 0) {
      sameSourcePairs = await rows(
        `SELECT DISTINCT cs.contentid AS linkedid, cl.title AS linkedtitle,
               c.id AS ida, c.title AS ta, cs.url AS url
        FROM contentsources cs
        JOIN content cl ON cl.id = cs.contentid
        JOIN content c ON (c.metadata->>'url' = cs.url OR c.metadata->>'finalUrl' = cs.url)
        WHERE cs.contentid IS NOT NULL AND c.id <> cs.contentid
        LIMIT 20`,
      ).catch(() => []);
      sameSourcePairs = sameSourcePairs.map((r) => ({ ida: r.ida, ta: r.ta, idb: r.linkedid, tb: r.linkedtitle }));
    }

    const pairs = [
      ...similarPairs.map((r) => ({
        a: { id: Number(r.ida), title: r.ta },
        b: { id: Number(r.idb), title: r.tb },
        reason: 'similar-title',
        similarity: Number(r.sim ?? 0),
      })),
      ...sameSourcePairs.map((r) => ({
        a: { id: Number(r.ida), title: r.ta },
        b: { id: Number(r.idb), title: r.tb },
        reason: 'same-source',
        similarity: 1,
      })),
    ];
    const duplicates = groupDuplicatePairs(pairs);

    // 2. Completeness for every row (JS scoring over metadata JSONB).
    const raw = await rows('SELECT id, externalid, type, title, metadata, thumbnail, createdat FROM content');
    let sum = 0;
    const completeness = [];
    for (const row of raw) {
      const normalized = normalizeContentRow(row);
      const { score, missing } = completenessOf(normalized);
      sum += score;
      completeness.push({ contentId: normalized.id, title: normalized.title, score, missing });
    }
    completeness.sort((x, y) => x.score - y.score || y.contentId - x.contentId);
    const avgScore = raw.length ? Number((sum / raw.length).toFixed(1)) : 0;

    return {
      duplicates,
      completeness,
      avgScore,
      scanned: raw.length,
      generatedAt: new Date().toISOString(),
    };
  });
}

/* ------------------------- curator: auto-enrich ----------------------------- */

const hasField = {
  year: (meta) => meta.year != null && String(meta.year).trim() !== '',
  genres: (meta) => toNameArray(meta.genres).length > 0,
  description: (meta) => Boolean(String(meta.overview || meta.synopsis || meta.description || '').trim()),
  actors: (meta) => toNameArray(meta.actors ?? meta.cast).length > 0,
  studios: (meta) => toNameArray(meta.studios ?? meta.studio).length > 0,
};

/** TMDB detail (append_to_response=credits) → only-missing field additions. */
function tmdbAdditions(detail, meta) {
  const add = {};
  if (!hasField.year(meta)) {
    const year = String(detail.release_date || detail.first_air_date || '').slice(0, 4);
    if (year) add.year = year;
  }
  if (!hasField.genres(meta) && Array.isArray(detail.genres)) {
    const genres = detail.genres.map((g) => g.name).filter(Boolean);
    if (genres.length) add.genres = genres;
  }
  if (!hasField.description(meta) && detail.overview) add.overview = String(detail.overview);
  if (!hasField.actors(meta) && Array.isArray(detail.credits?.cast)) {
    const actors = detail.credits.cast.slice(0, 6).map((c) => c.name).filter(Boolean);
    if (actors.length) add.actors = actors;
  }
  if (!hasField.studios(meta) && Array.isArray(detail.production_companies)) {
    const studios = detail.production_companies.slice(0, 3).map((c) => c.name).filter(Boolean);
    if (studios.length) add.studios = studios;
  }
  return add;
}

/** Jikan anime detail → only-missing field additions. */
function jikanAdditions(item, meta) {
  const add = {};
  if (!hasField.year(meta)) {
    const year = item.year || (item.aired?.from ? String(item.aired.from).slice(0, 4) : null);
    if (year) add.year = Number(year) || String(year);
  }
  if (!hasField.genres(meta)) {
    const genres = [...(item.genres || []), ...(item.themes || []), ...(item.demographics || [])]
      .map((g) => g.name)
      .filter(Boolean);
    if (genres.length) add.genres = genres;
  }
  if (!hasField.description(meta) && item.synopsis) add.synopsis = String(item.synopsis);
  if (!hasField.studios(meta)) {
    const studios = (item.studios || []).map((s) => s.name).filter(Boolean);
    if (studios.length) add.studios = studios;
  }
  return add;
}

function jikanFetch(path, params = {}, retries = 2) {
  return fetchProviderJson('jikan', `${JIKAN_BASE}${path}`, { params, retries, timeoutMs: 10000 });
}

/** Field key → canonical "added" label (overview/synopsis → description). */
const ADDED_LABEL = { year: 'year', genres: 'genres', overview: 'description', synopsis: 'description', actors: 'actors', studios: 'studios', description: 'description' };

/** Enrich one content row from its structured source (or LLM describe). */
async function enrichOne(row) {
  const ext = String(row.externalid || '');
  let m = null;
  try {
    if ((m = /^tmdb:(movie|tv):(\d+)$/.exec(ext))) {
      const detail = await tmdbFetch(`/${m[1]}/${m[2]}`, { append_to_response: 'credits' });
      if (!detail || !detail.id) throw new Error('tmdb detail empty');
      const add = tmdbAdditions(detail, row.metadata);
      return { add, provider: 'tmdb' };
    }
    if ((m = /^jikan:anime:(\d+)$/.exec(ext))) {
      const payload = await jikanFetch(`/anime/${m[1]}`);
      const item = Array.isArray(payload?.data) ? payload.data[0] : payload?.data;
      if (!item || !item.mal_id) throw new Error('jikan detail empty');
      const add = jikanAdditions(item, row.metadata);
      return { add, provider: 'jikan' };
    }
  } catch (err) {
    logger.warn(`[ai-hub] curator enrich fetch failed for ${ext}: ${err.message}`);
    return { add: {}, provider: null, error: err.message };
  }

  // No structured source (miner/demo/manual rows) → LLM description (RO).
  if (!hasField.description(row.metadata)) {
    const genres = toNameArray(row.metadata.genres).slice(0, 4);
    const text = await complete(
      [
        {
          role: 'assistant',
          content:
            'Ești scenaristul platformei de streaming Animaxia. Scrii descrieri scurte și atrăgătoare (2-3 propoziții) în limba română, fără spoilere, fără pretext. Răspunde DOAR cu textul descrierii.',
        },
        {
          role: 'user',
          content: `Titlu: ${row.title}\nTip: ${row.type || 'necunoscut'}${genres.length ? `\nGenuri: ${genres.join(', ')}` : ''}`,
        },
      ],
      { timeoutMs: 12000 },
    );
    if (text) return { add: { description: text }, provider: 'z-ai' };
    return { add: {}, provider: null, error: 'llm-unavailable' };
  }
  return { add: {}, provider: null, skipped: 'complete-or-unsupported' };
}

/* ==================================================================== */
/* AI 2 — TREND FORECASTER: momentum din viewevents + narativ LLM        */
/* ==================================================================== */

const WINDOW_DAYS = { '1d': 1, '24h': 1, '7d': 7, '30d': 30 };

function heuristicNarrative(days, eventsAnalyzed, top, rising, source) {
  const parts = [];
  if (source === 'library-heuristic') {
    parts.push(
      `Baza de evenimente de vizionare este încă săracă (${eventsAnalyzed} evenimente), așa că tendințele de mai jos sunt sintetizate din adăugările recente și rating-urile bibliotecii.`,
    );
    if (top[0]) parts.push(`${top[0].title} (nota ${top[0].rating ?? '—'}) conduce topul bibliotecii.`);
    if (rising[0]) parts.push(`${rising[0].title} este una dintre cele mai recente adăugiri.`);
  } else {
    parts.push(`În ultimele ${days} ${days === 1 ? 'zi' : 'zile'} au fost înregistrate ${eventsAnalyzed} evenimente de vizionare.`);
    if (top[0]) parts.push(`${top[0].title} conduce cu ${top[0].recentViews} vizionări.`);
    if (rising[0]) {
      const pct = Math.round((rising[0].momentum ?? 0) * 100);
      parts.push(`${rising[0].title} are cea mai puternică creștere (+${pct}% momentum).`);
    }
    if (!top[0] && !rising[0]) parts.push('Nu există încă suficiente date pentru un clasament.');
  }
  return parts.join(' ');
}

/** Real momentum analysis over viewevents (cached 5 min per window). */
async function buildForecast(days) {
  return memo(`hub:forecast:${days}`, 300000, async () => {
    const recentP = `${days} days`;
    const previousP = `${days * 2} days`;

    const [perContent, eventsRow] = await Promise.all([
      rows(
        `SELECT c.id, c.title, c.thumbnail, c.type,
                COALESCE(r.n, 0) AS recent, COALESCE(p.n, 0) AS previous
         FROM content c
         LEFT JOIN (
           SELECT contentid, COUNT(*) AS n FROM viewevents
           WHERE createdat > datetime('now', '-' || $1) GROUP BY contentid
         ) r ON r.contentid = c.id
         LEFT JOIN (
           SELECT contentid, COUNT(*) AS n FROM viewevents
           WHERE createdat <= datetime('now', '-' || $1) AND createdat > datetime('now', '-' || $2)
           GROUP BY contentid
         ) p ON p.contentid = c.id
         WHERE COALESCE(r.n, 0) > 0 OR COALESCE(p.n, 0) > 0`,
        [recentP, previousP],
      ),
      one(`SELECT COUNT(*) AS n FROM viewevents WHERE createdat > datetime('now', '-' || $1)`, [previousP]),
    ]);

    const eventsAnalyzed = Number(eventsRow?.n ?? 0);
    let source = 'viewevents';
    let rising = [];
    let top = [];

    if (eventsAnalyzed >= 10 && perContent.length > 0) {
      // Real momentum: recent window vs the previous window of the same length.
      const items = perContent.map((r) => {
        const recentViews = Number(r.recent);
        const previousViews = Number(r.previous);
        const momentum = (recentViews - previousViews) / Math.max(previousViews, 1);
        return {
          contentId: Number(r.id),
          title: r.title,
          thumbnail: r.thumbnail ?? null,
          type: r.type ?? null,
          recentViews,
          previousViews,
          momentum: Number(momentum.toFixed(4)),
          score: Number((momentum * (1 + Math.log10(1 + recentViews))).toFixed(4)),
        };
      });
      rising = items
        .filter((i) => i.recentViews > i.previousViews)
        .sort((a, b) => b.score - a.score || b.recentViews - a.recentViews)
        .slice(0, 10);
      top = [...items].sort((a, b) => b.recentViews - a.recentViews || b.momentum - a.momentum).slice(0, 10);
    } else {
      // Honest fallback: synthesize from library additions + ratings.
      source = 'library-heuristic';
      const [recentAdds, topRated] = await Promise.all([
        rows(
          `SELECT id, title, thumbnail, type, metadata->>'rating' AS rating, metadata->>'score' AS score
           FROM content ORDER BY createdat DESC, id DESC LIMIT 10`,
        ),
        rows(
          `SELECT id, title, thumbnail, type, metadata->>'rating' AS rating, metadata->>'score' AS score
           FROM content
           WHERE COALESCE(metadata->>'rating','') ~ '^[0-9.]+$' OR COALESCE(metadata->>'score','') ~ '^[0-9.]+$'
           ORDER BY GREATEST(
             COALESCE(NULLIF(metadata->>'rating',''), 0),
             COALESCE(NULLIF(metadata->>'score',''), 0)
           ) DESC
           LIMIT 10`,
        ),
      ]);
      rising = recentAdds.map((r) => ({
        contentId: Number(r.id),
        title: r.title,
        thumbnail: r.thumbnail ?? null,
        type: r.type ?? null,
        recentViews: null,
        previousViews: null,
        momentum: null,
        score: Number((parseFloat(r.rating ?? r.score) || 0).toFixed(2)),
      }));
      top = topRated.map((r) => ({
        contentId: Number(r.id),
        title: r.title,
        thumbnail: r.thumbnail ?? null,
        type: r.type ?? null,
        recentViews: null,
        previousViews: null,
        momentum: null,
        score: Number((parseFloat(r.rating ?? r.score) || 0).toFixed(2)),
        rating: parseFloat(r.rating ?? r.score) || null,
      }));
    }

    // Narrative: z-ai LLM (Romanian, 2-3 sentences) with heuristic fallback.
    const compact = (list) =>
      list
        .slice(0, 5)
        .map((i) => `${i.title} (${i.recentViews != null ? `${i.recentViews} vizionări recente` : `scor ${i.score}`})`)
        .join(', ');
    const raw = await complete(
      [
        {
          role: 'assistant',
          content:
            'Ești analistul de trend-uri al platformei de streaming Animaxia. Răspunzi în limba română, clar și concis (2-3 fraze), strict pe baza datelor reale primite, fără listări și fără pretext.',
        },
        {
          role: 'user',
          content:
            `Fereastră de analiză: ${days} ${days === 1 ? 'zi' : 'zile'}. Sursă date: ${source === 'viewevents' ? 'evenimente reale de vizionare' : 'bibotecă (euristic — prea puține evenimente)'}. ` +
            `Total evenimente: ${eventsAnalyzed}. Top vizionări: ${compact(top) || '—'}. În creștere: ${compact(rising) || '—'}. ` +
            'Scrie un narativ scurt despre ce se uită lumea pe platformă și ce urcă.',
        },
      ],
      { timeoutMs: 10000 },
    );
    const narrative = raw || heuristicNarrative(days, eventsAnalyzed, top, rising, source);
    const provider = raw ? 'z-ai' : 'heuristic';

    return {
      window: days === 1 ? '1d' : `${days}d`,
      days,
      eventsAnalyzed,
      source,
      rising,
      top,
      narrative,
      provider,
      generatedAt: new Date().toISOString(),
    };
  });
}

/* ==================================================================== */
/* AI 3 — SEMANTIC SEARCH: embeddings + cosine similarity                */
/* ==================================================================== */

let embeddingProvider = null; // 'z-ai-embeddings' | 'hashed-bow' (probed once)
let embeddingDims = EMBED_DIMS;
let lastEmbedAt = null;
let embedLock = null;
let embedDebounce = null;

function l2Normalize(vec) {
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm > 0) return vec.map((v) => v / norm);
  return vec;
}

/** Deterministic hashed bag-of-words: token → sha256(token) % 256 index,
 *  sublinear tf weight, L2-normalized. Works always, honestly labeled. */
function hashBowEmbed(text) {
  const vec = new Array(EMBED_DIMS).fill(0);
  const tokens = String(text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1);
  const counts = new Map();
  for (const token of tokens) counts.set(token, (counts.get(token) || 0) + 1);
  for (const [token, tf] of counts) {
    const digest = crypto.createHash('sha256').update(token, 'utf8').digest('hex');
    const idx = parseInt(digest.slice(0, 8), 16) % EMBED_DIMS;
    vec[idx] += 1 + Math.log(tf); // sublinear tf (idf-ish damping)
  }
  return l2Normalize(vec);
}

/** Probe the z-ai SDK for embeddings support exactly once per process. */
async function resolveEmbeddingProvider() {
  if (embeddingProvider) return embeddingProvider;
  try {
    const zai = await getZai();
    if (zai?.embeddings && typeof zai.embeddings.create === 'function') {
      embeddingProvider = 'z-ai-embeddings';
      return embeddingProvider;
    }
  } catch (err) {
    logger.warn(`[ai-hub] z-ai probe failed (${err.message}) — hashed-bow embeddings`);
  }
  embeddingProvider = 'hashed-bow';
  return embeddingProvider;
}

/** Embed one text with the active provider (z-ai if exposed, else hashed-bow). */
async function embedText(text) {
  const provider = await resolveEmbeddingProvider();
  if (provider === 'z-ai-embeddings') {
    try {
      const zai = await getZai();
      const res = await Promise.race([
        zai.embeddings.create({ input: String(text) }),
        new Promise((_, reject) => {
          const timer = setTimeout(() => reject(new Error('z-ai embeddings timed out')), 15000);
          if (typeof timer.unref === 'function') timer.unref();
        }),
      ]);
      const vec = res?.data?.[0]?.embedding;
      if (Array.isArray(vec) && vec.length > 0) {
        return { vector: l2Normalize(vec.map(Number)), provider, dims: vec.length };
      }
      throw new Error('z-ai embeddings returned no vector');
    } catch (err) {
      logger.warn(`[ai-hub] z-ai embeddings failed (${err.message}) — hashed-bow fallback`);
      return { vector: hashBowEmbed(text), provider: 'hashed-bow', dims: EMBED_DIMS };
    }
  }
  return { vector: hashBowEmbed(text), provider: 'hashed-bow', dims: EMBED_DIMS };
}

/** Document text for embedding: title (×2 weight) + genres + description +
 *  actors + studios + type. */
function semanticDocText(row) {
  const meta = row.metadata || {};
  const genres = toNameArray(meta.genres).join(' ');
  const actors = toNameArray(meta.actors ?? meta.cast).join(' ');
  const studios = toNameArray(meta.studios ?? meta.studio).join(' ');
  const description = String(meta.overview || meta.synopsis || meta.description || '').slice(0, 1200);
  return [row.title, row.title, genres, description, actors, studios, row.type || ''].join(' ').trim();
}

/** Embed missing/stale content rows into aisemantic (max 500 per run,
 *  incremental, batched upserts). Async lock coalesces concurrent callers. */
function ensureEmbedded() {
  if (embedLock) return embedLock;
  embedLock = (async () => {
    const pending = await rows(
      `SELECT c.id,
               ('content:' || c.id) AS externalid,
               c.title,
               json_object('year', c.year) AS metadata
       FROM content c
       LEFT JOIN aisemantic s ON s.contentid = c.id
       WHERE s.contentid IS NULL OR s.title <> c.title
       ORDER BY c.id
       LIMIT 500`,
    );
    let embedded = 0;
    for (let i = 0; i < pending.length; i += EMBED_BATCH) {
      const slice = pending.slice(i, i + EMBED_BATCH);
      // Sequential embed (cheap local hash or paced API) then one batched upsert.
      const embeddedRows = [];
      for (const row of slice) {
        const normalized = normalizeContentRow(row);
        const emb = await embedText(semanticDocText(normalized));
        embeddedRows.push({ normalized, emb });
      }
      const params = [];
      const valueSql = embeddedRows.map((entry, j) => {
        const base = j * 6;
        params.push(
          entry.normalized.externalid,
          entry.normalized.id,
          entry.normalized.title,
          JSON.stringify(entry.emb.vector),
          entry.emb.dims,
          entry.emb.provider,
        );
        return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},CURRENT_TIMESTAMP)`;
      });
      await rows(
        `INSERT INTO aisemantic (externalid, contentid, title, embedding, dims, provider, updatedat)
         VALUES ${valueSql.join(', ')}
         ON CONFLICT (externalid) DO UPDATE SET
           contentid = EXCLUDED.contentid,
           title = EXCLUDED.title,
           embedding = EXCLUDED.embedding,
           dims = EXCLUDED.dims,
           provider = EXCLUDED.provider,
           updatedat = CURRENT_TIMESTAMP`,
        params,
      );
      embedded += embeddedRows.length;
    }
    if (embedded > 0) {
      lastEmbedAt = new Date().toISOString();
      logger.info(`[ai-hub] semantic index: embedded ${embedded} docs (${embeddingProvider})`);
    }
    return embedded;
  })().finally(() => {
    embedLock = null;
  });
  return embedLock;
}

// content:changed → debounced background incremental re-embed (best-effort).
events.on('content:changed', () => {
  if (embedDebounce) clearTimeout(embedDebounce);
  embedDebounce = setTimeout(() => {
    embedDebounce = null;
    ensureEmbedded().catch((err) => logger.warn(`[ai-hub] background re-embed failed: ${err.message}`));
  }, 10000);
  if (typeof embedDebounce.unref === 'function') embedDebounce.unref();
});

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || b.length === 0) return 0;
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < len; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Score every aisemantic doc against a query vector; the query must use the
 *  same provider as the stored docs (rows with a different provider are
 *  skipped — documented, honest mixed-provider safety). */
async function semanticSearch(vector, { excludeContentId = null, limit = 12 }) {
  const docs = await rows('SELECT externalid, contentid, title, embedding, provider FROM aisemantic');
  const providerCounts = new Map();
  for (const d of docs) providerCounts.set(d.provider, (providerCounts.get(d.provider) || 0) + 1);
  let dominant = null;
  let maxCount = 0;
  for (const [provider, count] of providerCounts) {
    if (count > maxCount) {
      dominant = provider;
      maxCount = count;
    }
  }
  const scored = [];
  for (const doc of docs) {
    if (doc.provider !== dominant) continue;
    const contentId = Number(doc.contentid);
    if (excludeContentId != null && contentId === excludeContentId) continue;
    const score = cosineSimilarity(vector, Array.isArray(doc.embedding) ? doc.embedding : parseJsonb(doc.embedding, []));
    if (score > 0.02) scored.push({ contentId, externalid: doc.externalid, title: doc.title, score: Number(score.toFixed(6)) });
  }
  scored.sort((a, b) => b.score - a.score || a.contentId - b.contentId);
  const top = scored.slice(0, limit);
  if (top.length === 0) return { results: [], dominant };
  // Hydrate type/thumbnail from content in one query.
  const ids = top.map((t) => t.contentId);
  const info = await rows('SELECT id, type, thumbnail FROM content WHERE id IN (SELECT value FROM json_each($1))', [JSON.stringify(ids)]);
  const infoById = new Map(info.map((r) => [Number(r.id), r]));
  return {
    results: top.map((t) => ({
      contentId: t.contentId,
      externalid: t.externalid,
      title: t.title,
      type: infoById.get(t.contentId)?.type ?? null,
      thumbnail: infoById.get(t.contentId)?.thumbnail ?? null,
      score: t.score,
    })),
    dominant,
  };
}

/* ==================================================================== */
/* AI 4 — WATCHDOG: health checks + scor + diagnostic LLM                */
/* ==================================================================== */

const WATCHDOG_ALERTS = {
  providers: {
    warning: { message: 'Unii provideri externi au circuite deschise sau în test', hint: 'Verifică /api/health → providers; circuitele se închid automat după retragere.' },
    critical: { message: 'Provideri externi indisponibili (circuit open)', hint: 'Investighează conectivitatea către TMDB/Jikan și ultimele erori din breakerStats.' },
  },
  db: {
    warning: { message: 'Latență bază de date ridicată', hint: 'Verifică pool-ul Neon (poolStats) și eventuale query-uri lente.' },
    critical: { message: 'Latență bază de date critică', hint: 'Baza de date răspunde greu — consultă /api/scale/report pentru estimări de capacitate.' },
  },
  cache: {
    warning: { message: 'Rata de hit a cache-ului este sub 20%', hint: 'Crește CACHETTLMS sau verifică invalidările frecvente ale prefixului http:.' },
    critical: { message: 'Rata de hit a cache-ului este sub 20%', hint: 'Crește CACHETTLMS sau verifică invalidările frecvente ale prefixului http:.' },
  },
  ratelimit: {
    warning: { message: 'Cereri blocate de rate-limit', hint: 'Verifică /api/security/status — posibil abuz sau un client cu buclă strânsă.' },
    critical: { message: 'Cereri blocate de rate-limit', hint: 'Verifică /api/security/status — posibil abuz sau un client cu buclă strânsă.' },
  },
  ingest: {
    warning: { message: 'Job-uri de ingest eșuate în coada miner', hint: 'Inspectează /api/miner jobs cu status failed și relansează-le.' },
    critical: { message: 'Job-uri de ingest eșuate în coada miner', hint: 'Inspectează /api/miner jobs cu status failed și relansează-le.' },
  },
  searchsync: {
    warning: { message: 'Indexul de căutare este desincronizat de conținut', hint: 'Rulează POST /api/search/index pentru un resync complet.' },
    critical: { message: 'Indexul de căutare este desincronizat de conținut', hint: 'Rulează POST /api/search/index pentru un resync complet.' },
  },
  uptime: {
    info: { message: 'Backend-ul a fost repornit recent', hint: 'Informativ — verifică backend.log dacă repornirile sunt neașteptate.' },
  },
};

/** Run the 7 real checks (no LLM) — fast enough for /status stats too. */
async function watchdogChecks() {
  const checks = [];

  // 1. External providers (circuit-breaker state).
  const providers = breakerStats();
  const openCount = providers.filter((p) => p.state === 'open').length;
  const halfCount = providers.filter((p) => p.state === 'half-open').length;
  checks.push({
    name: 'providers',
    status: openCount > 0 ? 'fail' : halfCount > 0 ? 'warn' : 'pass',
    detail: `${providers.length - openCount - halfCount}/${providers.length} circuite închise (sănătoase)${openCount ? `, ${openCount} open` : ''}${halfCount ? `, ${halfCount} half-open` : ''}`,
  });

  // 2. DB latency (SELECT 1 timing).
  let dbMs = -1;
  try {
    const t0 = Date.CURRENT_TIMESTAMP;
    await query('SELECT 1');
    dbMs = Date.CURRENT_TIMESTAMP - t0;
  } catch (err) {
    dbMs = -1;
  }
  checks.push({
    name: 'db',
    status: dbMs < 0 ? 'fail' : dbMs > 500 ? 'fail' : dbMs > 200 ? 'warn' : 'pass',
    detail: dbMs >= 0 ? `SELECT 1 în ${dbMs}ms` : 'interogare eșuată',
  });

  // 3. Cache hit rate (needs ≥20 samples to judge).
  const cacheStats = cache.stats();
  const cacheTotal = Number(cacheStats.hits || 0) + Number(cacheStats.misses || 0);
  const hitRate = cacheTotal > 0 ? Number(cacheStats.hits || 0) / cacheTotal : 0;
  checks.push({
    name: 'cache',
    status: cacheTotal >= 20 && hitRate < 0.2 ? 'warn' : 'pass',
    detail: `hit rate ${(hitRate * 100).toFixed(1)}% din ${cacheTotal} accesări (${cacheStats.keys} chei)`,
  });

  // 4. Rate-limit blocks.
  const rl = rateLimitStats();
  checks.push({
    name: 'ratelimit',
    status: Number(rl.totalLimited || 0) > 0 ? 'warn' : 'pass',
    detail: `${rl.totalLimited} cereri blocate (limită ${rl.max}/${Math.round(rl.windowMs / 1000)}s, ${rl.trackedClients} clienți)`,
  });

  // 5. Ingest errors (miner_jobs failed) — best-effort.
  let failedJobs = null;
  try {
    const row = await one(`SELECT COUNT(*) AS n FROM miner_jobs WHERE status = 'failed'`);
    failedJobs = Number(row?.n ?? 0);
    checks.push({
      name: 'ingest',
      status: failedJobs > 0 ? 'warn' : 'pass',
      detail: `${failedJobs} job-uri eșuate în coada miner`,
    });
  } catch {
    checks.push({ name: 'ingest', status: 'pass', detail: 'tabela miner_jobs indisponibilă (n/a)' });
  }

  // 6. searchdocs ↔ content sync.
  let desync = null;
  try {
    const row = await one(
      `SELECT (SELECT COUNT(*) FROM content) AS contentcount, (SELECT COUNT(*) FROM searchdocs) AS docscount`,
    );
    desync = Math.abs(Number(row?.contentcount ?? 0) - Number(row?.docscount ?? 0));
    checks.push({
      name: 'searchsync',
      status: desync > 5 ? 'warn' : 'pass',
      detail: `${row?.docscount} docs / ${row?.contentcount} conținuturi (desincronizare ${desync})`,
    });
  } catch {
    checks.push({ name: 'searchsync', status: 'pass', detail: 'numărătoare indisponibilă (n/a)' });
  }

  // 7. Uptime (informational — recent restarts surface as an info alert only).
  const uptimeSec = Math.floor(process.uptime());
  checks.push({
    name: 'uptime',
    status: 'pass',
    detail: `${Math.floor(uptimeSec / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m de la ultima pornire`,
  });

  // Alerts + score (fail −25, warn −10, info −2; floor 0).
  const alerts = [];
  for (const check of checks) {
    if (check.status === 'pass') continue;
    const severity = check.status === 'fail' ? 'critical' : 'warning';
    const preset = WATCHDOG_ALERTS[check.name]?.[severity] ?? { message: `Verificarea ${check.name} a relevat o problemă`, hint: 'Consultă detaliile verificării.' };
    alerts.push({ severity, area: check.name, message: preset.message, hint: preset.hint });
  }
  if (uptimeSec < 300) {
    alerts.push({ severity: 'info', area: 'uptime', ...WATCHDOG_ALERTS.uptime.info });
  }
  const score = Math.max(
    0,
    100 -
      25 * checks.filter((c) => c.status === 'fail').length -
      10 * checks.filter((c) => c.status === 'warn').length -
      2 * alerts.filter((a) => a.severity === 'info').length,
  );
  return { checks, alerts, score };
}

/** Full watchdog health (checks + LLM diagnosis), cached 60s. */
async function watchdogHealth() {
  return memo('hub:watchdog:health', 60000, async () => {
    const { checks, alerts, score } = await watchdogChecks();
    const raw = await complete(
      [
        {
          role: 'assistant',
          content:
            'Ești watchdog-ul platformei Animaxia. Primești rezultatele unor verificări de sănătate și scrii, în limba română, un diagnostic de maximum 3 propoziții: ce nu este în regulă (dacă e ceva) și ce ar trebui făcut. Fără listări, fără pretext.',
        },
        {
          role: 'user',
          content:
            `Scor sănătate: ${score}/100.\n` +
            `Verificări: ${checks.map((c) => `${c.name}=${c.status} (${c.detail})`).join('; ')}.\n` +
            `Alerte: ${alerts.map((a) => `[${a.severity}] ${a.area}: ${a.message}`).join('; ') || 'niciuna'}.\n` +
            'Scrie diagnosticul.',
        },
      ],
      { timeoutMs: 10000 },
    );
    const diagnosis =
      raw ||
      (alerts.length
        ? `Sistemul funcționează cu scor ${score}/100. Probleme detectate: ${alerts.map((a) => a.message).join('; ')}.`
        : `Toate verificările au trecut — sistemul este sănătos (scor ${score}/100).`);
    return {
      ok: true,
      score,
      alerts,
      checks,
      diagnosis,
      provider: raw ? 'z-ai' : 'heuristic',
      checkedAt: new Date().toISOString(),
    };
  });
}

/* ==================================================================== */
/* AI 5 — MARATHON BUILDER: maratoane ordonate din hub-uri reale          */
/* ==================================================================== */

/** Build 6-10 ordered marathon suggestions (cached 10 min). */
async function buildMarathonSuggestions() {
  return memo('hub:marathon:suggestions', 600000, async () => {
    const suggestions = [];
    const usedTitles = new Set();

    // 1. Top franchises by part count (real TMDB collections).
    try {
      const hub = await getFranchiseHub();
      for (const f of (hub.data || [])) {
        if (suggestions.length >= 6) break;
        const parts = Array.isArray(f.parts) ? f.parts : [];
        if (parts.length < 3) continue;
        usedTitles.add(f.name);
        suggestions.push({
          key: `franchise:${slugify(f.name)}`,
          title: f.name,
          emoji: '🍿',
          count: parts.length,
          items: parts.map((p, i) => ({
            contentId: null,
            externalId: `tmdb:movie:${p.id}`,
            title: p.title,
            thumbnail: p.image ?? null,
            year: p.year ? Number(p.year) : null,
            order: i + 1,
          })),
          rationale: `${parts.length} filme în ordinea cronologică a lansării — maratonul complet «${f.name}», de la primul film până la ultimul.`,
        });
      }
    } catch (err) {
      logger.warn(`[ai-hub] franchise hub unavailable for marathons: ${err.message}`);
    }

    // 2. Exact trilogies not already covered by a franchise entry.
    try {
      const hub = await getTrilogyHub();
      for (const t of (hub.data || [])) {
        if (suggestions.length >= 8) break;
        const parts = Array.isArray(t.parts) ? t.parts : [];
        if (parts.length !== 3 || usedTitles.has(t.name)) continue;
        usedTitles.add(t.name);
        suggestions.push({
          key: `trilogy:${slugify(t.name)}`,
          title: t.name,
          emoji: '🎬',
          count: 3,
          items: parts.map((p, i) => ({
            contentId: null,
            externalId: `tmdb:movie:${p.id}`,
            title: p.title,
            thumbnail: p.image ?? null,
            year: p.year ? Number(p.year) : null,
            order: i + 1,
          })),
          rationale: `Trilogia completă «${t.name}» — trei părți, o singură poveste, în ordinea corectă de vizionare.`,
        });
      }
    } catch (err) {
      logger.warn(`[ai-hub] trilogy hub unavailable for marathons: ${err.message}`);
    }

    // 3. Library marathon: top 12 by rating (metadata.rating ?? score).
    try {
      const topRated = await rows(
        `SELECT id, externalid, title, thumbnail, metadata->>'year' AS year, metadata->>'rating' AS rating, metadata->>'score' AS score
         FROM content
         WHERE COALESCE(metadata->>'rating','') ~ '^[0-9.]+$' OR COALESCE(metadata->>'score','') ~ '^[0-9.]+$'
         ORDER BY GREATEST(
           COALESCE(NULLIF(metadata->>'rating',''), 0),
           COALESCE(NULLIF(metadata->>'score',''), 0)
         ) DESC
         LIMIT 12`,
      );
      if (topRated.length >= 3) {
        suggestions.push({
          key: 'library:top-rated',
          title: 'Biblioteca ta după rating',
          emoji: '⭐',
          count: topRated.length,
          items: topRated.map((r, i) => ({
            contentId: Number(r.id),
            externalId: r.externalid,
            title: r.title,
            thumbnail: r.thumbnail ?? null,
            year: toIntOrNull(r.year),
            order: i + 1,
          })),
          rationale: 'Cele mai bine notate 12 titluri din biblioteca Animaxia — un maraton de calitate garantată.',
        });
      }
    } catch (err) {
      logger.warn(`[ai-hub] top-rated marathon failed: ${err.message}`);
    }

    // 4. Recent-years marathon (the two most recent years present).
    try {
      const yearRows = await rows(
        `SELECT DISTINCT metadata->>'year' AS y FROM content
         WHERE metadata->>'year' ~ '^[0-9]{4}$' ORDER BY y DESC LIMIT 2`,
      );
      if (yearRows.length === 2) {
        const [yNew, yOld] = yearRows.map((r) => Number(r.y));
        const recent = await rows(
          `SELECT id, externalid, title, thumbnail, metadata->>'year' AS year,
                  GREATEST(
                    COALESCE(NULLIF(metadata->>'rating',''), 0),
                    COALESCE(NULLIF(metadata->>'score',''), 0)
                  ) AS rank
           FROM content
           WHERE metadata->>'year' IN ($1, $2)
           ORDER BY rank DESC, id ASC
           LIMIT 12`,
          [String(yNew), String(yOld)],
        );
        if (recent.length >= 3) {
          suggestions.push({
            key: `library:fresh-${yOld}-${yNew}`,
            title: `Noutăți ${yOld}–${yNew}`,
            emoji: '🆕',
            count: recent.length,
            items: recent.map((r, i) => ({
              contentId: Number(r.id),
              externalId: r.externalid,
              title: r.title,
              thumbnail: r.thumbnail ?? null,
              year: toIntOrNull(r.year),
              order: i + 1,
            })),
            rationale: `Cele mai bine notate premieri ${yOld}–${yNew} din bibliotecă — ce e mai nou, ordonat după rating.`,
          });
        }
      }
    } catch (err) {
      logger.warn(`[ai-hub] fresh marathon failed: ${err.message}`);
    }

    return suggestions.slice(0, 10);
  });
}

/* ==================================================================== */
/* AI 6 — TRANSLATOR: traduceri LLM salvate în metadata.translations      */
/* ==================================================================== */

const TRANSLATE_LANGS = new Set(['ro', 'en', 'es', 'fr', 'de']);
const LANG_NAMES = { ro: 'română', en: 'engleză', es: 'spaniolă', fr: 'franceză', de: 'germană' };

const translateLimiter = userRateLimit({ scope: 'user', max: 10, windowMs: 60000, key: 'hub-translate' });

/** Translator coverage across the library (cheap metadata scan). */
async function translatorCoverage() {
  const [totalRow, translationRows] = await Promise.all([
    one('SELECT COUNT(*) AS n FROM content'),
    rows(`SELECT metadata->'translations' AS t FROM content WHERE metadata ? 'translations' AND metadata->'translations' <> '{}'`),
  ]);
  const byLang = {};
  let entries = 0;
  for (const row of translationRows) {
    const t = parseJsonb(row.t, {});
    for (const lang of Object.keys(t)) {
      if (t[lang] != null && String(t[lang]).trim() !== '') {
        byLang[lang] = (byLang[lang] || 0) + 1;
        entries += 1;
      }
    }
  }
  return { total: Number(totalRow?.n ?? 0), withTranslations: translationRows.length, byLang, entries };
}

/* ==================================================================== */
/* HUB STATUS                                                             */
/* ==================================================================== */

async function buildHubStatus() {
  return memo('hub:status', 30000, async () => {
    const settings = await loadHubSettings();
    const [
      curatorData,
      forecast,
      semanticCountRow,
      semanticTotalRow,
      watchdog,
      marathonCountRow,
      translatorCov,
    ] = await Promise.all([
      curatorScan().catch(() => null),
      buildForecast(7).catch(() => null),
      one('SELECT COUNT(*) AS n FROM aisemantic').catch(() => null),
      one('SELECT COUNT(*) AS n FROM content').catch(() => null),
      watchdogChecks().catch(() => null),
      one('SELECT COUNT(*) AS n FROM marathons').catch(() => null),
      translatorCoverage().catch(() => null),
    ]);

    const stats = {
      curator: curatorData
        ? { duplicates: curatorData.duplicates.length, avgCompleteness: curatorData.avgScore }
        : { duplicates: 0, avgCompleteness: 0 },
      forecaster: forecast ? { eventsAnalyzed: forecast.eventsAnalyzed } : { eventsAnalyzed: 0 },
      semantic: { embedded: Number(semanticCountRow?.n ?? 0), total: Number(semanticTotalRow?.n ?? 0) },
      watchdog: watchdog ? { alerts: watchdog.alerts.length, score: watchdog.score } : { alerts: 0, score: null },
      marathon: { marathons: Number(marathonCountRow?.n ?? 0) },
      translator: translatorCov ? { translations: translatorCov.entries } : { translations: 0 },
    };
    const providers = {
      curator: 'sql',
      forecaster: forecast ? forecast.provider : 'heuristic',
      semantic: embeddingProvider || 'hashed-bow',
      watchdog: 'sql',
      marathon: 'tmdb',
      translator: 'z-ai',
    };

    return {
      ais: AIS.map((ai) => ({
        key: ai.key,
        name: ai.name,
        emoji: ai.emoji,
        description: ai.description,
        enabled: settings.get(ai.key) !== false,
        provider: providers[ai.key] ?? 'heuristic',
        lastRunAt: lastRuns.get(ai.key) ?? null,
        stats: stats[ai.key] ?? {},
      })),
      existing: [
        {
          key: 'home',
          name: 'AI Home Engine',
          emoji: '🏠',
          enabled: null,
          note: 'Feed infinit AI, taxonomie auto, narțiune, analiză externă, extractor metadata, trailere — /api/ai/home/* (toggle-uri proprii în /api/ai/home/settings).',
        },
        {
          key: 'core',
          name: 'AI Core',
          emoji: '✨',
          enabled: null,
          note: 'Recomandări, rezumate, descrieri, chat asistent — /api/ai/* (ai/ai.js).',
        },
      ],
      generatedAt: new Date().toISOString(),
    };
  });
}

/* ==================================================================== */
/* ROUTER                                                                 */
/* ==================================================================== */

export const hubAiRouter = express.Router();

/* ------------------------------ common routes ------------------------------ */

hubAiRouter.get('/status', wrap(async (req, res) => {
  res.json(await buildHubStatus());
}));

hubAiRouter.post('/settings', wrap(async (req, res) => {
  const { key, enabled } = req.body || {};
  if (!AI_BY_KEY.has(String(key))) {
    return res.status(400).json({ error: `Unknown AI key: ${key} (valid: ${AIS.map((a) => a.key).join(', ')})` });
  }
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'Field "enabled" must be a boolean' });
  }
  await setAiEnabled(String(key), enabled);
  await auditLog({
    userid: req.user?.id ?? null,
    action: 'hub.settings',
    ip: clientIpOf(req),
    meta: { key, enabled },
  }).catch(() => {});
  logger.info(`[ai-hub] AI "${key}" ${enabled ? 'enabled' : 'disabled'} by user ${req.user?.id ?? 'anon'}`);
  return res.json({ ok: true, key: String(key), enabled });
}));

/* ------------------------------ AI 1: curator ------------------------------ */

hubAiRouter.get('/curator/scan', guard('curator'), wrap(async (req, res) => {
  res.json(await curatorScan());
}));

hubAiRouter.post('/curator/enrich', requireAuth, guard('curator'), wrap(async (req, res) => {
  const body = req.body || {};
  const contentId = Number.isInteger(Number(body.contentId)) && Number(body.contentId) > 0 ? Number(body.contentId) : null;
  const missingOnly = body.missing !== false; // default true
  const limit = Math.min(14, Math.max(1, parseInt(body.limit, 10) || 5));

  // Candidate selection: explicit id, else incomplete rows (worst first).
  let candidates = [];
  if (contentId) {
    const row = await getContentById(contentId);
    if (!row) return res.status(404).json({ error: 'Content not found' });
    candidates = [row];
  } else {
    const all = await rows('SELECT id, externalid, type, title, metadata, thumbnail, createdat FROM content ORDER BY createdat DESC, id DESC');
    candidates = all
      .map((raw) => {
        const row = normalizeContentRow(raw);
        return { row, ...completenessOf(row) };
      })
      .filter((c) => (missingOnly ? c.missing.length > 0 : true))
      .sort((a, b) => a.score - b.score || b.row.id - a.row.id)
      .slice(0, limit)
      .map((c) => c.row);
  }

  const enriched = [];
  const providersUsed = new Set();
  for (const row of candidates) {
    if (enriched.length >= limit) break;
    const { add, provider, error, skipped } = await enrichOne(row);
    const keys = Object.keys(add);
    if (keys.length === 0) {
      if (error) logger.debug(`[ai-hub] enrich skipped ${row.externalid}: ${error}`);
      continue;
    }
    // Shallow-merge ONLY the missing fields (existing values always win).
    await rows(
      `UPDATE content SET metadata = metadata || $2 WHERE id = $1 RETURNING id`,
      [row.id, jsonb(add)],
    );
    // Invalidate the semantic row so the debounced re-embed picks up the new
    // text (change detection is externalid/title-based).
    await rows('DELETE FROM aisemantic WHERE contentid = $1', [row.id]).catch(() => {});
    if (provider) providersUsed.add(provider);
    enriched.push({
      contentId: row.id,
      title: row.title,
      added: [...new Set(keys.map((k) => ADDED_LABEL[k] ?? k))],
    });
    if (providersUsed.has('tmdb') || providersUsed.has('jikan')) await sleep(ENRICH_PACING_MS);
  }

  if (enriched.length > 0) {
    contentMutated(); // searchdocs resync (debounced) + semantic re-embed
  }
  return res.json({
    ok: true,
    enriched,
    provider: providersUsed.size ? [...providersUsed].sort().join('+') : 'none',
    scanned: candidates.length,
    generatedAt: new Date().toISOString(),
  });
}));

hubAiRouter.post('/curator/merge', requireAuth, requireAdmin, guard('curator'), wrap(async (req, res) => {
  const keepId = Number(req.body?.keepId);
  const mergeId = Number(req.body?.mergeId);
  if (!Number.isInteger(keepId) || keepId <= 0 || !Number.isInteger(mergeId) || mergeId <= 0) {
    return res.status(400).json({ error: 'Fields keepId and mergeId must be positive integers' });
  }
  if (keepId === mergeId) {
    return res.status(400).json({ error: 'keepId and mergeId must differ' });
  }
  const [keep, merge] = await Promise.all([getContentById(keepId), getContentById(mergeId)]);
  if (!keep) return res.status(404).json({ error: `Content ${keepId} not found` });
  if (!merge) return res.status(404).json({ error: `Content ${mergeId} not found` });

  // 1. Re-point the global source registry to the surviving row.
  await rows('UPDATE contentsources SET contentid = $1 WHERE contentid = $2', [keepId, mergeId]);

  // 2. Best-effort: keep user data (watchlist/history/views/likes/comments).
  const userDataMoves = [
    `INSERT INTO watchlist (userid, contentid, createdat)
     SELECT userid, $1, CURRENT_TIMESTAMP FROM watchlist WHERE contentid = $2
     ON CONFLICT (userid, contentid) DO NOTHING`,
    `INSERT INTO watchhistory (userid, contentid, progress, watchedat)
     SELECT userid, $1, progress, watchedat FROM watchhistory WHERE contentid = $2
     ON CONFLICT (userid, contentid) DO UPDATE SET progress = GREATEST(watchhistory.progress, EXCLUDED.progress)`,
    `UPDATE viewevents SET contentid = $1 WHERE contentid = $2`,
    `INSERT INTO contentlikes (contentid, userid, value, createdat)
     SELECT $1, userid, value, createdat FROM contentlikes WHERE contentid = $2
     ON CONFLICT (contentid, userid) DO NOTHING`,
    `UPDATE comments SET contentid = $1 WHERE contentid = $2`,
  ];
  for (const sql of userDataMoves) {
    try {
      await rows(sql, [keepId, mergeId]);
    } catch (err) {
      logger.warn(`[ai-hub] merge user-data move skipped: ${err.message}`);
    }
  }

  // 3. Delete the merged row + audit + platform event.
  await deleteContent(mergeId);
  await auditLog({
    userid: req.user.id,
    action: 'curator.merge',
    ip: clientIpOf(req),
    meta: { keepId, mergeId, keptTitle: keep.title, mergedTitle: merge.title },
  });
  contentMutated();
  logger.info(`[ai-hub] curator merge: #${mergeId} «${merge.title}» → #${keepId} «${keep.title}»`);
  return res.json({ ok: true, keepId, merged: mergeId });
}));

/* ---------------------------- AI 2: forecaster ----------------------------- */

hubAiRouter.get('/trends/forecast', guard('forecaster'), wrap(async (req, res) => {
  const windowKey = String(req.query.window || '7d');
  const days = WINDOW_DAYS[windowKey] ?? 7;
  const normalizedKey = days === 1 ? '1d' : `${days}d`;
  res.json(await buildForecast(days, normalizedKey));
}));

/* ----------------------------- AI 3: semantic ------------------------------ */

hubAiRouter.post('/semantic/query', guard('semantic'), wrap(async (req, res) => {
  const text = String(req.body?.query || '').trim();
  if (!text) return res.status(400).json({ error: 'Missing required field: query' });
  const limit = Math.min(24, Math.max(1, parseInt(req.body?.limit, 10) || 12));

  await ensureEmbedded(); // first call embeds the library (max 500, incremental)
  const { vector, provider } = await embedText(text);
  const { results, dominant } = await semanticSearch(vector, { limit });
  const countRow = await one('SELECT COUNT(*) AS n FROM aisemantic').catch(() => null);
  return res.json({
    ok: true,
    results,
    provider: dominant ?? provider,
    queryProvider: provider,
    embeddedDocs: Number(countRow?.n ?? results.length),
  });
}));

hubAiRouter.get('/semantic/similar/:contentId', guard('semantic'), wrap(async (req, res) => {
  const contentId = parseInt(req.params.contentId, 10);
  if (!Number.isInteger(contentId) || contentId <= 0) {
    return res.status(400).json({ error: 'Invalid contentId' });
  }
  await ensureEmbedded();
  const doc = await one('SELECT contentid, title, embedding, provider FROM aisemantic WHERE contentid = $1', [contentId]);
  if (!doc) return res.status(404).json({ error: 'Content not found in the semantic index (embed it via /semantic/query first)' });
  const vector = Array.isArray(doc.embedding) ? doc.embedding : parseJsonb(doc.embedding, []);
  const { results } = await semanticSearch(vector, { excludeContentId: contentId, limit: 12 });
  return res.json({ ok: true, contentId, results, provider: doc.provider });
}));

hubAiRouter.get('/semantic/status', wrap(async (req, res) => {
  // Best-effort auto-embed so embedded > 0 as soon as the index is inspected.
  await ensureEmbedded().catch((err) => logger.warn(`[ai-hub] status embed failed: ${err.message}`));
  const [embeddedRow, totalRow] = await Promise.all([
    one('SELECT COUNT(*) AS n FROM aisemantic').catch(() => null),
    one('SELECT COUNT(*) AS n FROM content').catch(() => null),
  ]);
  let lastAt = lastEmbedAt;
  if (!lastAt) {
    // In-memory timestamp is lost on restart — fall back to the last row write.
    const row = await one('SELECT MAX(updatedat) AS last FROM aisemantic').catch(() => null);
    lastAt = row?.last instanceof Date ? row.last.toISOString() : row?.last ? String(row.last) : null;
  }
  const provider = await resolveEmbeddingProvider();
  return res.json({
    embedded: Number(embeddedRow?.n ?? 0),
    total: Number(totalRow?.n ?? 0),
    provider,
    dims: provider === 'hashed-bow' ? EMBED_DIMS : embeddingDims,
    lastEmbedAt: lastAt,
  });
}));

/* ----------------------------- AI 4: watchdog ------------------------------ */

hubAiRouter.get('/watchdog/health', guard('watchdog'), wrap(async (req, res) => {
  res.json(await watchdogHealth());
}));

/* ----------------------------- AI 5: marathon ------------------------------ */

hubAiRouter.get('/marathon/suggestions', guard('marathon'), wrap(async (req, res) => {
  res.json({ suggestions: await buildMarathonSuggestions() });
}));

hubAiRouter.post('/marathon/create', requireAuth, guard('marathon'), wrap(async (req, res) => {
  const key = String(req.body?.key || '').trim();
  if (!key) return res.status(400).json({ error: 'Missing required field: key' });
  const suggestions = await buildMarathonSuggestions();
  const suggestion = suggestions.find((s) => s.key === key);
  if (!suggestion) {
    return res.status(404).json({ error: `Unknown marathon key: ${key} (see /marathon/suggestions)` });
  }
  const marathonKey = `${req.user.id}:${suggestion.key}`;
  const saved = await one(
    `INSERT INTO marathons (key, userid, title, description, items)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (key) DO UPDATE SET
       title = EXCLUDED.title,
       description = EXCLUDED.description,
       items = EXCLUDED.items
     RETURNING id, key, userid, title, description, items, createdat`,
    [marathonKey, req.user.id, suggestion.title, suggestion.rationale, jsonb(suggestion.items)],
  );
  return res.json({
    ok: true,
    marathon: {
      id: Number(saved.id),
      key: saved.key,
      userid: Number(saved.userid),
      title: saved.title,
      description: saved.description,
      items: parseJsonb(saved.items, []),
      createdat: saved.createdat instanceof Date ? saved.createdat.toISOString() : String(saved.createdat),
    },
  });
}));

hubAiRouter.get('/marathon/list', wrap(async (req, res) => {
  const all = await rows('SELECT id, key, userid, title, description, items, createdat FROM marathons ORDER BY createdat DESC, id DESC');
  return res.json({
    data: all.map((r) => ({
      id: Number(r.id),
      key: r.key,
      userid: r.userid == null ? null : Number(r.userid),
      title: r.title,
      description: r.description,
      items: parseJsonb(r.items, []),
      createdat: r.createdat instanceof Date ? r.createdat.toISOString() : String(r.createdat),
      mine: Boolean(req.user && Number(r.userid) === Number(req.user.id)),
    })),
  });
}));

/* ---------------------------- AI 6: translator ----------------------------- */

hubAiRouter.post('/translate', requireAuth, translateLimiter, guard('translator'), wrap(async (req, res) => {
  const contentId = Number(req.body?.contentId);
  const lang = String(req.body?.lang || '').trim().toLowerCase();
  if (!Number.isInteger(contentId) || contentId <= 0) {
    return res.status(400).json({ error: 'Missing or invalid contentId' });
  }
  if (!TRANSLATE_LANGS.has(lang)) {
    return res.status(400).json({ error: `lang must be one of: ${[...TRANSLATE_LANGS].join(', ')}` });
  }

  const content = await getContentById(contentId);
  if (!content) return res.status(404).json({ error: 'Content not found' });
  const meta = content.metadata || {};
  let text = String(meta.overview || meta.synopsis || meta.description || '').trim();

  // No description at all → generate one first (AI describe pattern, EN),
  // then translate it.
  let generatedFirst = false;
  if (!text) {
    const genres = toNameArray(meta.genres).slice(0, 4);
    const generated = await complete(
      [
        {
          role: 'assistant',
          content:
            'You are the copywriter for the Animaxia streaming platform. Write a short, engaging 2-3 sentence description in English, no spoilers, no preamble. Answer ONLY with the description text.',
        },
        {
          role: 'user',
          content: `Title: ${content.title}\nType: ${content.type || 'unknown'}${genres.length ? `\nGenres: ${genres.join(', ')}` : ''}`,
        },
      ],
      { timeoutMs: 15000 },
    );
    if (!generated) {
      return res.status(503).json({ error: 'No description available for this title and the AI writer is offline — try again shortly' });
    }
    text = generated.trim();
    generatedFirst = true;
  }

  // Translate via z-ai LLM (faithful, no new spoilers, max 400 words).
  const translated = await complete(
    [
      {
        role: 'assistant',
        content:
          'Ești translator profesionist de descrieri pentru filme, seriale și anime pentru platforma Animaxia. Traduci fidel textul primit în limba țintă, fără să adaugi detalii, păreri sau spoilere noi, maximum 400 de cuvinte. Răspunde DOAR cu textul tradus.',
      },
      {
        role: 'user',
        content: `Limba țintă: ${LANG_NAMES[lang]}.\n\nText de tradus:\n${text}`,
      },
    ],
    { timeoutMs: 15000 },
  );

  let provider;
  let translation;
  if (translated) {
    provider = 'z-ai';
    translation = translated;
  } else if (lang === 'en') {
    // Honest passthrough: target is English — return the original text.
    provider = 'passthrough';
    translation = text;
  } else {
    return res.status(503).json({ error: 'Translation service unavailable (z-ai offline) — try again shortly' });
  }

  // Save into metadata.translations[lang] (nested jsonb merge, existing kept).
  await rows(
    `UPDATE content
       SET metadata = metadata || jsonb_build_object(
         'translations',
         COALESCE(metadata->'translations', '{}') || jsonb_build_object($2, $3)
       )
     WHERE id = $1 RETURNING id`,
    [contentId, lang, translation],
  );
  // Translations do not change the title — drop the semantic row so the
  // debounced re-embed refreshes the document text.
  await rows('DELETE FROM aisemantic WHERE contentid = $1', [contentId]).catch(() => {});
  contentMutated();
  if (generatedFirst) {
    // Also keep the generated EN description so the title is no longer bare.
    await rows(
      `UPDATE content SET metadata = metadata || jsonb_build_object('description', $2) WHERE id = $1 AND NOT (metadata ? 'overview' OR metadata ? 'synopsis' OR metadata ? 'description')`,
      [contentId, text],
    ).catch(() => {});
  }
  return res.json({ ok: true, contentId, lang, translation, provider });
}));

hubAiRouter.get('/translate/status', wrap(async (req, res) => {
  const cov = await translatorCoverage();
  return res.json({ coverage: { total: cov.total, withTranslations: cov.withTranslations, byLang: cov.byLang } });
}));

/* Fire-and-forget warm-up: probe the embedding provider + prime the semantic
 * index a few seconds after boot so the first user query is already fast. */
setTimeout(() => {
  resolveEmbeddingProvider()
    .then((provider) => {
      logger.info(`[ai-hub] semantic embedding provider: ${provider}`);
      return ensureEmbedded().catch((err) => logger.warn(`[ai-hub] boot warm-up embed failed: ${err.message}`));
    })
    .catch(() => {});
}, 8000).unref?.();

export default hubAiRouter;
