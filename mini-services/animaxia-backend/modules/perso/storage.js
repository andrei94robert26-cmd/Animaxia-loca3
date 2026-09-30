/**
 * modules/perso/storage.js — FAZA 36-R (PLAN 100X · WS6): stratul de
 * persistență file-based al modulului de personalizare (ZERO schemă DB).
 *
 * Pattern copiat identic din modules/playerx/index.js (FAZA 34): cache
 * in-memory + scrieri atomice debounced (tmp+rename — un cititor nu vede
 * niciodată jumătate de fișier), fișiere create LENEȘ la prima mutație,
 * fișier corupt ⇒ pornire de la zero cu avertisment (recoverable, onest).
 *
 * Fișiere (data/perso/):
 *   profiles.json    — { [userId]: { list:[{id,name,emoji,pinHash,isMain,
 *                       createdAt,updatedAt}], nextSeq } }   profile multiple
 *   events.json      — { [userId]: [{type,contentId,weight,term,at}] } (≤200/user)
 *   dismissals.json  — { [userId]: { [contentId]: dismissedAt } } (TTL 30 zile)
 *   resets.json      — { [userId]: { resetAt } }   marker POST /profile/reset
 *   stats.json       — contoare durabile (supraviețuiesc restarturilor --watch)
 *
 * Cache profil (ÎNVĂȚAT): profileCache — Map LRU-lite (cap PERSO_CACHE_MAX)
 * cu TTL 10 min; invalidat per-user la POST /events și POST /profile/reset.
 * ZERO setInterval cu DB/fetch (regula NEON FREE PLAN) — expirarea e leneșă,
 * la citire; cache-ul are un scor onest în /status.
 *
 * Config env (opțional, default sigur):
 *   PERSO_CACHE_TTL_MS (600000) · PERSO_CACHE_MAX (500)
 *   PERSO_WRITE_DEBOUNCE_MS (300) · PERSO_EVENTS_PER_USER (200)
 *   PERSO_DISMISSAL_TTL_MS (30 zile) · PERSO_TOKEN_SECRET (fallback constantă)
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../../utils/logger.js';

/* ------------------------------- configuration ------------------------------ */

export const CACHE_TTL_MS = Math.max(30_000, parseInt(process.env.PERSO_CACHE_TTL_MS || '600000', 10) || 600_000);
export const CACHE_MAX = Math.max(1, parseInt(process.env.PERSO_CACHE_MAX || '500', 10) || 500);
const WRITE_DEBOUNCE_MS = Math.max(50, parseInt(process.env.PERSO_WRITE_DEBOUNCE_MS || '300', 10) || 300);
export const EVENTS_PER_USER = Math.max(20, parseInt(process.env.PERSO_EVENTS_PER_USER || '200', 10) || 200);
export const DISMISSAL_TTL_MS =
  Math.max(86_400_000, parseInt(process.env.PERSO_DISMISSAL_TTL_MS || String(30 * 86_400_000), 10) || 30 * 86_400_000);
/** Secretul token-ului de sesiune profil: AUTHSECRET (partajat cu users/auth)
 * → PERSO_TOKEN_SECRET → constantă documentată onest (sandbox/dev). */
export const TOKEN_SECRET =
  process.env.PERSO_TOKEN_SECRET || process.env.AUTHSECRET || 'animaxia-perso-token-secret-v1';
/** Salt-ul PIN-urilor: process.env sau constantă (PIN-urile nu sunt secrete
 * de nivel parolă — sunt gardă de copil pe profil; hash-uit sha256+salt). */
export const PIN_SALT = process.env.PERSO_PIN_SALT || 'animaxia-perso-pin-salt-v1';
/** Token de sesiune profil: valabilitate 2h (contract FAZA 36). */
export const PROFILE_TOKEN_TTL_MS = 2 * 3_600_000;

/* modules/perso → două nivele sus = rădăcina backend-ului → data/perso
 * (aceeași convenție ca playerx → data/playerx). */
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const STORAGE_DIR = join(MODULE_DIR, '..', '..', 'data', 'perso');
export const STORAGE_DIR_LABEL = 'data/perso'; // calea relativă raportată în /status

/* ------------------------ file-based JSON store (zero DB) -------------------- */

export class JsonFileStore {
  constructor(name) {
    this.file = join(STORAGE_DIR, `${name}.json`);
    this.name = name;
    this.data = undefined; // undefined = neîncărcat; {} = încărcat/gol
    this.writeTimer = null;
  }

  /** Încarcă o singură dată (sincron, la prima nevoie); corupt ⇒ {} + warn. */
  load() {
    if (this.data !== undefined) return this.data;
    try {
      const raw = readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      this.data = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        this.data = {}; // nu există încă — creat leneș la prima scriere
      } else {
        logger.warn(`[perso] ${this.name}.json corupt/ineligibil — pornesc de la zero (${err?.message ?? err})`);
        this.data = {};
      }
    }
    return this.data;
  }

  /** Programează o scriere atomică (debounce) după o mutație in-memory. */
  scheduleSave() {
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      this.flush();
    }, WRITE_DEBOUNCE_MS);
    if (typeof this.writeTimer.unref === 'function') this.writeTimer.unref();
  }

  /** Scriere atomică: tmp + rename. Niciodată throw. */
  flush() {
    if (this.data === undefined) return; // nimic încărcat ⇒ nimic de persistat
    try {
      mkdirSync(STORAGE_DIR, { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`);
      renameSync(tmp, this.file);
    } catch (err) {
      logger.warn(`[perso] persistența ${basename(this.file)} a eșuat (non-fatal): ${err?.message ?? err}`);
    }
  }

  /** Numărul de înregistrări de nivel-1 (pentru /status onest). */
  recordCount() {
    if (this.data === undefined) return null; // niciodată încărcat — necunoscut
    return Object.keys(this.data).length;
  }
}

export const profilesStore = new JsonFileStore('profiles'); // { [userId]: { list, nextSeq } }
export const eventsStore = new JsonFileStore('events'); // { [userId]: [event…] }
export const dismissalsStore = new JsonFileStore('dismissals'); // { [userId]: { [contentId]: iso } }
export const resetsStore = new JsonFileStore('resets'); // { [userId]: { resetAt: iso } }
export const statsStore = new JsonFileStore('stats'); // contoare durabile

const ALL_STORES = [profilesStore, eventsStore, dismissalsStore, resetsStore, statsStore];

/* Flush la ieșirea procesului (SIGTERM → shutdown → 'exit'). Debounce-ul de
 * 300ms poate pierde, în cel mai rău caz, o mutație din fereastra finală —
 * onest, acceptat (identic playerx). */
function flushAllStores() {
  for (const store of ALL_STORES) store.flush();
}
process.on('exit', flushAllStores);
process.on('beforeExit', flushAllStores);

/* ----------------------------- durable counters ----------------------------- */

const STAT_FIELDS = [
  'eventsTracked', 'profileRequests', 'profileResets', 'feedRequests', 'profilesCreated',
  'profilesUpdated', 'profilesDeleted', 'profileVerifications', 'verificationFails',
  'remindersRequests', 'remindersDismissed', 'affinitiesRequests', 'explainRequests',
];
const EVENT_TYPES = ['view', 'like', 'complete', 'search'];

export function statsData() {
  const data = statsStore.load();
  for (const field of STAT_FIELDS) {
    if (typeof data[field] !== 'number') data[field] = 0;
  }
  if (!data.eventsByType || typeof data.eventsByType !== 'object') {
    data.eventsByType = { view: 0, like: 0, complete: 0, search: 0 };
  }
  for (const t of EVENT_TYPES) {
    if (typeof data.eventsByType[t] !== 'number') data.eventsByType[t] = 0;
  }
  return data;
}

export function bumpStat(field, by = 1) {
  const data = statsData();
  data[field] = (data[field] ?? 0) + by;
  statsStore.scheduleSave();
}

export function bumpEventStat(type) {
  const data = statsData();
  data.eventsByType[type] = (data.eventsByType[type] ?? 0) + 1;
  statsStore.scheduleSave();
}

/* ------------------------- perso events (file-based) ------------------------ */

/** Lista evenimentelor unui user (cea mai recentă prima), bounded la
 * EVENTS_PER_USER — adăugarea face trim la coadă (ring onest, determinist). */
export function eventsStorePerUser(store, userId) {
  const all = store.load();
  const key = String(Number(userId));
  if (!Array.isArray(all[key])) return [];
  return all[key].filter((e) => e && typeof e === 'object');
}

/** Adaugă un eveniment validat în fața listei userului + trim la coadă. */
export function pushEvent(store, userId, event) {
  const all = store.load();
  const key = String(Number(userId));
  const list = Array.isArray(all[key]) ? all[key] : [];
  list.unshift(event);
  if (list.length > EVENTS_PER_USER) list.length = EVENTS_PER_USER;
  all[key] = list;
  store.scheduleSave();
  return event;
}

/* ------------------------- profile aggregation cache ------------------------ */
/* Profilul de gust e scump de calculat (semnale DB + agregare) ⇒ cache în
 * memorie TTL 10 min, invalidat la POST /events (per user) și la reset.
 * LRU-lite: la depășirea plafonului se curăță tot (onst, simplu, determinist —
 * calculul e idempotent, pierderea cache-ului doar re-interoghează). */

const profileCache = new Map(); // userId → { value, computedAt, hits }

export const profileCacheApi = {
  get(userId) {
    const entry = profileCache.get(Number(userId));
    if (!entry) return null;
    if (Date.now() - entry.computedAt > CACHE_TTL_MS) {
      profileCache.delete(Number(userId));
      return null;
    }
    entry.hits += 1;
    return entry.value;
  },
  set(userId, value) {
    const key = Number(userId);
    if (profileCache.has(key)) profileCache.delete(key);
    else if (profileCache.size >= CACHE_MAX) profileCache.clear();
    profileCache.set(key, { value, computedAt: Date.now(), hits: 0 });
    return value;
  },
  invalidate(userId) {
    return profileCache.delete(Number(userId));
  },
  clear() {
    profileCache.clear();
  },
  size() {
    return profileCache.size;
  },
  /** Statistici oneste pentru /status (fără DB query). */
  stats() {
    let totalHits = 0;
    let oldest = null;
    for (const entry of profileCache.values()) {
      totalHits += entry.hits;
      if (oldest === null || entry.computedAt < oldest) oldest = entry.computedAt;
    }
    return {
      entries: profileCache.size,
      maxEntries: CACHE_MAX,
      totalHits,
      oldestEntryAgeSec: oldest ? Math.round((Date.now() - oldest) / 1000) : null,
    };
  },
};
