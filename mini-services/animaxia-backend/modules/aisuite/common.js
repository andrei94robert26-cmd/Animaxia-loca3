/**
 * modules/aisuite/common.js — FAZA 32 (AI SUITE 100X): fundația comună a
 * celor 18 motoare AI noi (/api/ai/suite/*). 100% aditiv — nu atinge niciun
 * modul protejat (FAZA 15/16/18/20/21/23/24/25/28, Neon FTS, player;
 * AR10M: fostul 30B simulat a fost eliminat din platformă).
 *
 * Convenții (moștenite de la FAZA 16-b hub.js, respectate onest):
 *  - persistența toggle-urilor: tabela EXISTENTĂ `aisettings`, chei
 *    `suite:<key>` (rânduri noi — zero schimbări de schemă);
 *  - logarea utilizării AI: tabela EXISTENTĂ `aiusagelogs`
 *    (feature='ai-suite:<engine>', INSERT aditiv);
 *  - fiecare răspuns etichetează providerul real: 'sql' | 'z-ai' |
 *    'heuristic' | 'mixed' — fallback determinist mereu disponibil;
 *  - cache memo in-process cu TTL per motor (nicio componentă exterioară).
 */

import crypto from 'node:crypto';
import ZAI from 'z-ai-web-dev-sdk';
import { rows, one, jsonb, parseJsonb } from '../platform/sql.js';
import { logger } from '../../utils/logger.js';

/* ------------------------------ z-ai singleton ----------------------------- */

let zaiInstance = null;

async function getZai() {
  if (!zaiInstance) zaiInstance = await ZAI.create();
  return zaiInstance;
}

/**
 * One z-ai chat completion (Romanian output, thinking disabled, timeout via
 * Promise.race, 1 retry). Returns null on failure so every caller degrades
 * to its deterministic heuristic path — identical contract to hub.js.
 */
export async function zaiComplete(messages, { timeoutMs = 20000 } = {}) {
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
      if (typeof text === 'string' && text.trim().length > 0) return text.trim();
      throw new Error('z-ai returned an empty completion');
    } catch (err) {
      if (attempt >= 2) {
        logger.warn(`[ai-suite] z-ai completion failed (${err.message}) — heuristic fallback`);
        return null;
      }
    }
  }
  return null;
}

/* ------------------------------ in-process memo ----------------------------- */

const memoStore = new Map();

/** TTL memo — engines store their computed payloads under `ai-suite:<key>`. */
export const memo = {
  get(key) {
    const hit = memoStore.get(key);
    if (hit && Date.now() - hit.at < hit.ttl) return hit.value;
    if (hit) memoStore.delete(key);
    return undefined;
  },
  set(key, value, ttlMs = 60000) {
    memoStore.set(key, { at: Date.now(), ttl: ttlMs, value });
    return value;
  },
  drop(key) {
    memoStore.delete(key);
  },
  dropPrefix(prefix) {
    for (const key of memoStore.keys()) if (key.startsWith(prefix)) memoStore.delete(key);
  },
};

/** Route wrapper — same contract as every other module. */
export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* ------------------------------ usage logging ------------------------------ */

/** Fire-and-forget aiusagelogs INSERT (feature 'ai-suite:<engine>'). */
export async function logUsage(engine, { provider = 'heuristic', latencyMs = 0, status = 'ok', degraded = false, mode = 'engine', tokens = 0, snippet = '' } = {}) {
  try {
    await rows(
      `INSERT INTO aiusagelogs (traceid, userid, feature, mode, provider, model, prompttokens,
         completiontokens, costusd, latencyms, status, degraded, errormessage, promptsnippet)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        crypto.randomUUID(),
        null,
        `ai-suite:${engine}`,
        mode,
        provider,
        provider === 'z-ai' ? 'glm' : null,
        tokens,
        0,
        0,
        Math.round(latencyMs),
        status,
        degraded,
        null,
        String(snippet).slice(0, 180),
      ],
    );
  } catch {
    /* usage logging must never break an engine */
  }
}

/* ------------------------------ suite settings ------------------------------ */

const SETTINGS_PREFIX = 'suite:';
const settingsCache = { at: 0, map: new Map() };

export async function loadSuiteSettings() {
  if (Date.now() - settingsCache.at < 15000) return settingsCache.map;
  const map = new Map();
  try {
    const stored = await rows(`SELECT key, value FROM aisettings WHERE key LIKE 'suite:%'`);
    for (const row of stored) {
      const key = String(row.key).slice(SETTINGS_PREFIX.length);
      const value = parseJsonb(row.value, {});
      if (typeof value.enabled === 'boolean') map.set(key, value.enabled);
    }
  } catch (err) {
    logger.warn(`[ai-suite] aisettings read failed (${err.message}) — defaults (all ON)`);
  }
  settingsCache.at = Date.now();
  settingsCache.map = map;
  return map;
}

export async function setEngineEnabled(key, enabled) {
  const value = { enabled, updatedAt: new Date().toISOString() };
  await rows(
    `INSERT INTO aisettings (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updatedat = NOW()`,
    [`${SETTINGS_PREFIX}${key}`, jsonb(value)],
  );
  settingsCache.at = 0; // invalidate
  memo.drop('ai-suite:status'); // status must reflect toggles immediately
}

/** Per-engine runtime stats (last run, provider, counters) — volatile by design. */
const runtime = new Map();

export function recordRun(key, { provider = 'sql', ms = 0, ok = true } = {}) {
  const prev = runtime.get(key) || { runs: 0, errors: 0, lastRunAt: null, lastMs: 0, lastProvider: null };
  prev.runs += 1;
  if (!ok) prev.errors += 1;
  prev.lastRunAt = new Date().toISOString();
  prev.lastMs = Math.round(ms);
  prev.lastProvider = provider;
  runtime.set(key, prev);
  return prev;
}

export function runtimeOf(key) {
  return runtime.get(key) || { runs: 0, errors: 0, lastRunAt: null, lastMs: 0, lastProvider: null };
}

/* ------------------------------ engine registry ----------------------------- */

/** The 18 engines of the AI SUITE (FAZA 32). Order = sidebar order. */
export const ENGINES = [
  { key: 'miner', name: 'AI Miner', emoji: '⛏️', description: 'Motorul complet de minat conținut — job-uri, surse, provideri, dry-run real.' },
  { key: 'metadata', name: 'AI Metadata Dashboard', emoji: '🏷️', description: 'Acoperirea metadatelor din catalog — completeness per câmp, goluri, narațiune AI.' },
  { key: 'analyzer', name: 'AI Analyzer Dashboard', emoji: '🔬', description: 'Analiza calității conținutului — scoruri compozite, distribuții, outlieri.' },
  { key: 'news', name: 'AI News Hub', emoji: '📰', description: 'Știri externe reale (BBC/CNN/NHK/Al Jazeera) clasificate și rezumate de AI.' },
  { key: 'social', name: 'AI Social Hub', emoji: '👥', description: 'Pulsul social al platformei — comentarii, review-uri, sentiment, digest AI.' },
  { key: 'watchparty', name: 'AI Watch Party', emoji: '🍿', description: 'Camera de veghe a party-urilor — statistici live + alegeri AI pentru grup.' },
  { key: 'recommendations', name: 'AI Recommendation Engine', emoji: '🎯', description: 'Motorul complet de recomandări multi-semnal, explicabil, cu motive reale.' },
  { key: 'franchise', name: 'AI Franchise Engine', emoji: '🔗', description: 'Francizele catalogului — detectare, ranking AI, ordine cronologică, next-watch.' },
  { key: 'taxonomy', name: 'AI Taxonomy Generator', emoji: '🌳', description: 'Generatorul de taxonomie — clustere de genuri, cuvinte-cheie, categorii propuse.' },
  { key: 'stats', name: 'AI Statistics Dashboard', emoji: '📊', description: 'Statistica completă a consumului AI — apeluri, tokeni, cost, latență, erori.' },
  { key: 'infinite', name: 'AI Infinite Scroll Engine', emoji: '♾️', description: 'Feed-ul infinit rankat AI — cursor stabil, diversitate, scor determinist.' },
  { key: 'scanner', name: 'AI Content Scanner', emoji: '🩺', description: 'Scanarea de sănătate a catalogului — issue-uri, severitate, eșantioane reale.' },
  { key: 'discovery', name: 'AI Source Discovery Engine', emoji: '🧭', description: 'Descoperirea surselor — registru contentsources, sonde provideri, propuneri.' },
  { key: 'duplicates', name: 'AI Duplicate Detector', emoji: '🧬', description: 'Detecția duplicatelor fuzzy — Jaccard + Levenshtein pe titluri normalizate.' },
  { key: 'poster', name: 'AI Poster Scanner', emoji: '🖼️', description: 'Scanarea posterelor — disponibilitate HTTP reală + descrieri VLM pe eșantion.' },
  { key: 'trends', name: 'AI Trend Analyzer', emoji: '📈', description: 'Analiza trendurilor — viewevents 7d vs 7d anterior, momentum, narațiune AI.' },
  { key: 'feeds', name: 'AI External Feed Engine', emoji: '📡', description: 'Motorul de feed-uri externe — catalog RSS, fetch real, categorizare AI.' },
  { key: 'admin', name: 'Dashboard Administrare AI', emoji: '🛠️', description: 'Panoul unificat de administrare — 18 motoare, toggle-uri, sănătate, acțiuni.' },
];

export const ENGINE_BY_KEY = new Map(ENGINES.map((e) => [e.key, e]));

export { rows, one, jsonb, parseJsonb };
