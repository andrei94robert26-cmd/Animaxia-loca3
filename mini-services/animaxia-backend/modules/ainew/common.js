/**
 * modules/ainew/common.js — FAZA 35 (PLAN 100X · WS5): fundația comună a
 * AI LAB-ului — cele 8 capabilități AI noi (/api/ai/lab/*). 100% aditiv, cu
 * namespace PROPRIU (prefixe 'lab:' în aisettings, feature 'ai-lab:<cap>' în
 * aiusagelogs, chei memo 'ai-lab:*') — zero coliziuni cu aisuite ('suite:').
 *
 * Convenții moștenite onest de la aisuite/common.js (FAZA 32), care la rândul
 * ei le moștenește din hub.js (FAZA 16-b):
 *  - persistența toggle-urilor: tabela EXISTENTĂ `aisettings`, chei `lab:<key>`
 *    (rânduri noi — zero schimbări de schemă);
 *  - logarea utilizării AI: tabela EXISTENTĂ `aiusagelogs`
 *    (feature='ai-lab:<cap>', INSERT aditiv, aceleași coloane ca aisuite);
 *  - fiecare răspuns etichetează providerul real: 'z-ai' | 'heuristic' |
 *    'mixed' | 'sql' — fallback determinist mereu disponibil (EXCEPȚIE onestă:
 *    voice/asr nu are fallback — 503 onest, niciodată text fals);
 *  - cache memo in-process cu TTL per capabilitate.
 *
 * z-ai voice (FAZA 35): SDK-ul expune zai.audio.asr.create({ file_base64 })
 * (→ JSON cu .text) și zai.audio.tts.create({ input, voice, speed,
 * response_format, stream }) (→ raw Response cu arrayBuffer).
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

/** Timeout-race helper (unref-ed timer — never keeps the process alive). */
function withTimeout(promise, timeoutMs, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    }),
  ]);
}

/**
 * One z-ai chat completion (thinking disabled, 2 attempts, timeout via
 * Promise.race). Returns null on failure so every caller degrades to its
 * deterministic heuristic path — identical contract to aisuite/hub.
 * Default 15s/attempt: 2 attempts fit inside the platform request budget
 * (REQUESTTIMEOUTMS=30000, resilienceMiddleware) — documented, honest.
 */
export async function zaiComplete(messages, { timeoutMs = 15000 } = {}) {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const zai = await getZai();
      const completion = await withTimeout(
        zai.chat.completions.create({ messages, thinking: { type: 'disabled' } }),
        timeoutMs,
        'z-ai completion',
      );
      const text = completion?.choices?.[0]?.message?.content;
      if (typeof text === 'string' && text.trim().length > 0) return text.trim();
      throw new Error('z-ai returned an empty completion');
    } catch (err) {
      if (attempt >= 2) {
        logger.warn(`[ai-lab] z-ai completion failed (${err.message}) — heuristic fallback`);
        return null;
      }
    }
  }
  return null;
}

/**
 * Speech-to-text: zai.audio.asr.create({ file_base64 }) → response.text.
 * Returns the transcribed string or null on ANY failure (callers answer an
 * honest 503 — the AI Lab NEVER fabricates a transcript).
 */
export async function zaiAsr(audioBase64, { timeoutMs = 25000 } = {}) {
  try {
    const zai = await getZai();
    const response = await withTimeout(
      zai.audio.asr.create({ file_base64: audioBase64 }),
      timeoutMs,
      'z-ai asr',
    );
    const text = response?.text;
    if (typeof text === 'string') return text;
    if (typeof response?.result === 'string') return response.result; // lenient shape
    return null;
  } catch (err) {
    logger.warn(`[ai-lab] z-ai asr failed (${err.message})`);
    return null;
  }
}

/**
 * Text-to-speech: zai.audio.tts.create({ input, voice, speed,
 * response_format:'wav', stream:false }) → raw fetch Response → wav Buffer.
 * Returns a Buffer or null on any failure (honest 503 upstream).
 */
export async function zaiTts(text, { voice = 'tongtong', speed = 1.0, timeoutMs = 25000 } = {}) {
  try {
    const zai = await getZai();
    const response = await withTimeout(
      zai.audio.tts.create({
        input: text,
        voice,
        speed,
        response_format: 'wav',
        stream: false,
      }),
      timeoutMs,
      'z-ai tts',
    );
    if (!response || typeof response.arrayBuffer !== 'function') return null;
    const buffer = Buffer.from(new Uint8Array(await response.arrayBuffer()));
    if (buffer.length === 0) return null;
    return buffer;
  } catch (err) {
    logger.warn(`[ai-lab] z-ai tts failed (${err.message})`);
    return null;
  }
}

/* ------------------------------ in-process memo ----------------------------- */

const memoStore = new Map();

/** TTL memo — capabilities store payloads under `ai-lab:<key>`. */
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

/** Positive integer route/body param; null when invalid. */
export function intParam(raw) {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** ISO "now" for payloads. */
export const nowIso = () => new Date().toISOString();

/* ------------------------------ usage logging ------------------------------ */

/**
 * Fire-and-forget aiusagelogs INSERT (feature 'ai-lab:<cap>') — same columns
 * as the aisuite inserts, additive rows only.
 */
export async function logUsage(cap, { provider = 'heuristic', latencyMs = 0, status = 'ok', degraded = false, mode = 'capability', tokens = 0, snippet = '' } = {}) {
  try {
    await rows(
      `INSERT INTO aiusagelogs (traceid, userid, feature, mode, provider, model, prompttokens,
         completiontokens, costusd, latencyms, status, degraded, errormessage, promptsnippet)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        crypto.randomUUID(),
        null,
        `ai-lab:${cap}`,
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
    /* usage logging must never break a capability */
  }
}

/* ------------------------------- lab settings ------------------------------- */

const SETTINGS_PREFIX = 'lab:';
const settingsCache = { at: 0, map: new Map() };

/** Load `lab:<key>` toggles (default ON when absent) — own 15s cache. */
export async function loadLabSettings() {
  if (Date.now() - settingsCache.at < 15000) return settingsCache.map;
  const map = new Map();
  try {
    const stored = await rows(`SELECT key, value FROM aisettings WHERE key LIKE 'lab:%'`);
    for (const row of stored) {
      const key = String(row.key).slice(SETTINGS_PREFIX.length);
      const value = parseJsonb(row.value, {});
      if (typeof value.enabled === 'boolean') map.set(key, value.enabled);
    }
  } catch (err) {
    logger.warn(`[ai-lab] aisettings read failed (${err.message}) — defaults (all ON)`);
  }
  settingsCache.at = Date.now();
  settingsCache.map = map;
  return map;
}

export async function setLabEnabled(key, enabled) {
  const value = { enabled, updatedAt: new Date().toISOString() };
  await rows(
    `INSERT INTO aisettings (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updatedat = NOW()`,
    [`${SETTINGS_PREFIX}${key}`, jsonb(value)],
  );
  settingsCache.at = 0; // invalidate — toggles must apply immediately
  memo.drop('ai-lab:status');
}

/* ------------------------------ runtime stats ------------------------------- */

/** Per-capability runtime stats (last run, provider, counters) — volatile. */
const runtime = new Map();

export function recordLabRun(key, { provider = 'heuristic', ms = 0, ok = true } = {}) {
  const prev = runtime.get(key) || { runs: 0, errors: 0, lastRunAt: null, lastMs: 0, lastProvider: null };
  prev.runs += 1;
  if (!ok) prev.errors += 1;
  prev.lastRunAt = new Date().toISOString();
  prev.lastMs = Math.round(ms);
  prev.lastProvider = provider;
  runtime.set(key, prev);
  return prev;
}

export function labRuntimeOf(key) {
  return runtime.get(key) || { runs: 0, errors: 0, lastRunAt: null, lastMs: 0, lastProvider: null };
}

/* ----------------------------- capability registry --------------------------- */

/** The 8 capabilities of the AI LAB (FAZA 35, WS5). Order = sidebar order. */
export const CAPS = [
  { key: 'companion', name: 'AI Companion', emoji: '🤝', description: 'Chat contextual pe titlu — RAG peste sinopsis și recenzii.' },
  { key: 'recap', name: 'AI Recap', emoji: '📜', description: '„Ce ai ratat" — rezumatul episoadelor vizionate înainte de episodul nou.' },
  { key: 'mood', name: 'AI Mood Playlists', emoji: '🌈', description: 'Playlist generat din dispoziție peste bibliotecă.' },
  { key: 'shield', name: 'AI Spoiler Shield', emoji: '🛡️', description: 'Filtrează comentariile și recenziile cu spoilere.' },
  { key: 'dubbing', name: 'AI Dublare & Subtitrări', emoji: '🎙️', description: 'Subtitrări traduse RO generate AI + editor de corectură.' },
  { key: 'curation', name: 'AI Curation Notes', emoji: '💡', description: '„De ce îți recomandăm" — explicația de pe cardul de recomandare.' },
  { key: 'voice', name: 'AI Voice', emoji: '🎤', description: 'Căutare și comenzi vocale (ASR) + descriere audio (TTS).' },
  { key: 'editor', name: 'AI Editor de Liste', emoji: '✍️', description: 'Transformă o descriere liberă într-un playlist real.' },
];

export const CAP_BY_KEY = new Map(CAPS.map((c) => [c.key, c]));

export { rows, one, jsonb, parseJsonb };
