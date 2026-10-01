/**
 * modules/playerx/ — FAZA 34 (PLAN 100X · WS4): Player Experience — strat aditiv
 * (contract API înghețat cu FAZA-34-b/c).
 *
 * Player-ul REAL (FAZA 17 — modules/player/*) rămâne 100% NEATINS; acest modul
 * doar construiește ÎN JURUL lui: markeri de episod (skip-intro / skip-outro /
 * recap), setări de stilizare subtitrări (subtitle studio) și votul „următorul
 * episod" pentru watch-party (FAZA 10 protejat — doar consumat prin loopback,
 * identic ca pattern cu searchux FAZA 33). ZERO bytes modificați în componentele
 * protejate, ZERO schimbări de schemă DB — tot stocul e file-based (data/playerx).
 *
 * Rutare (mount: app.use('/api/playerx', playerxRouter) — namespace NOU):
 *   GET    /status                        → stats onest + contract storage      (public)
 *   GET    /markers/:contentId            → markeri episod estimați+curați     (public, cache 60s)
 *   POST   /markers/:contentId            → upsert marker curat (override)     (auth)
 *   DELETE /markers/:contentId/:kind      → înlătură override-ul pentru kind   (auth)
 *   POST   /markers/use                   → contor utilizare skip (KPI WS4)    (public, 30/min per IP)
 *   GET    /subtitle-settings             → setările de subtitrări ale userului (auth)
 *   PUT    /subtitle-settings             → salvează setările (validare strictă)(auth)
 *   GET    /party/:partyId/votes          → stare vot + tally + votanți        (public)
 *   POST   /party/:partyId/vote           → votează / schimbă votul (membru)   (auth)
 *   DELETE /party/:partyId/votes          → închide votul, calculează câștig.  (auth, DOAR gazda)
 *
 * MARKERI — estimare DETERMINISTĂ pe tip + durată (câmpuri reale citite din
 * metadata, inspectate pe rândurile reale Neon din 2026-09-26, 18.925 itemi):
 *   • metadata.duration   — SECUNDE, string numeric (ex. "120") — 469 rânduri tv;
 *   • metadata.runtime    — MINUTE, number (ex. 30/60) — 14.055 rânduri tv + 41 movie;
 *   • metadata.episodeRunTime / metadata.episode_runtime — MINUTE (convenție TMDB;
 *     ZERO rânduri azi — citite pentru compatibilitate viitoare, documentat onest).
 *   anime → intro {2s..90s}; tv → recap {0..42s} + intro {48s..110s}; dacă
 *   durationSec>300 se adaugă outro {max(180|170, dur-90) .. dur-6}. Pentru
 *   movie/mined/video/page/featured și orice alt tip: [] (onest — fără markeri
 *   inventați pentru filme). Override-urile curate din markers.json înlocuiesc
 *   estimarea per-kind și adaugă kind-uri noi; markerii curați invalizi
 *   (startsec≥endsec sau durată în afara intervalului 5..600s) sunt săriți la
 *   citire, iar la POST sunt respinși cu 400.
 *
 * STOCARE (file-based, zero DB — linie roșie FAZA 34): data/playerx/ cu
 * markers.json (override-uri curate), settings.json (setări subtitrări per
 * userid), votes.json (înregistrări vot party), stats.json (contoare durabile —
 * supraviețuiesc restarturilor --watch). Cache in-memory + scrieri atomice
 * debounced (tmp+rename); fișiere create leneș; fișier corupt ⇒ pornire de la
 * zero cu avertisment în log (recoverable, onest).
 *
 * AUTH: pattern requireAuthLocal copiat identic din modules/player/hub.js
 * (FAZA 19) — attachUser e global în server.js (verifyJwt cu AUTHSECRET /
 * secret derivat per-tenant), deci req.user e prezent la fiecare Bearer valid;
 * garda per-rută doar refuză 401 când lipsește, exact ca în hub.js.
 *
 * PARTY: validarea petrecerii se face prin LOOPBACK
 * http://127.0.0.1:${PORT}/api/social/party/:partyId (timeout 4s, ca la searchux)
 * — watchparty.js (FAZA 10, protejat) nu e atins; eșec de fetch ⇒ 503 onest.
 * Petrecere lipsă/încheiată ⇒ 404 + curățare leneșă a voturilor stocate.
 *
 * Config env (opțional, default sigur):
 *   PLAYERX_CACHE_TTL_MS (60000) · PLAYERX_CACHE_MAX_KEYS (500)
 *   PLAYERX_RATE_PER_MIN (30) · PLAYERX_WRITE_DEBOUNCE_MS (300)
 *   PLAYERX_LOOPBACK_TIMEOUT_MS (4000) · PORT (4000)
 */

import express from 'express';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getContentById } from '../../db.js';
import { clientIpOf } from '../security/security.js';
import { logger } from '../../utils/logger.js';

/* ------------------------------- configuration ------------------------------ */

const CACHE_TTL_MS = Math.max(5_000, parseInt(process.env.PLAYERX_CACHE_TTL_MS || '60000', 10) || 60_000);
const CACHE_MAX_KEYS = Math.max(1, parseInt(process.env.PLAYERX_CACHE_MAX_KEYS || '500', 10) || 500);
const RATE_PER_MIN = Math.max(5, parseInt(process.env.PLAYERX_RATE_PER_MIN || '30', 10) || 30);
const WRITE_DEBOUNCE_MS = Math.max(50, parseInt(process.env.PLAYERX_WRITE_DEBOUNCE_MS || '300', 10) || 300);
const LOOPBACK_TIMEOUT_MS = Math.max(1_000, parseInt(process.env.PLAYERX_LOOPBACK_TIMEOUT_MS || '4000', 10) || 4_000);
const SELF_PORT = parseInt(process.env.PORT || '4000', 10);
const SELF_BASE = `http://127.0.0.1:${SELF_PORT}`;

/* modules/playerx → două nivele sus = rădăcina backend-ului → data/playerx
 * (aceeași convenție ca modules/workers → data/thumbnails, modules/search → data/). */
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const STORAGE_DIR = join(MODULE_DIR, '..', '..', 'data', 'playerx');
const STORAGE_DIR_LABEL = 'data/playerx'; // contract înghețat: calea relativă raportată în /status

const MARKER_KINDS = ['intro', 'outro', 'recap'];
const KIND_LABELS = { intro: 'Intro', outro: 'Final', recap: 'Recapitulare' };
const MARKER_NOTE = 'markeri estimați determinist — confirmă-i pentru a-i salva';
const LABEL_MAX = 40;

const FONT_FAMILIES = ['sans-serif', 'serif', 'monospace', 'Trebuchet MS', 'Verdana', 'Georgia', 'Comic Sans MS'];
const EDGES = ['none', 'shadow', 'outline'];
const POSITIONS = ['bottom', 'top'];
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

const bootAt = Date.now();

/* ------------------------ file-based JSON store (zero DB) -------------------- */
/* Cache in-memory + scriere atomică debounced (tmp+rename — un cititor nu vede
 * niciodată jumătate de fișier). Fișierele sunt create LENEȘ (la prima mutație);
 * un fișier corupt ⇒ pornim de la zero + avertisment (recoverable). */

class JsonFileStore {
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
        logger.warn(`[playerx] ${this.name}.json corupt/ineligibil — pornesc de la zero (${err?.message ?? err})`);
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
      logger.warn(`[playerx] persistența ${basename(this.file)} a eșuat (non-fatal): ${err?.message ?? err}`);
    }
  }
}

const markersStore = new JsonFileStore('markers'); // { [contentId]: { intro?:{startsec,endsec,label}, outro?, recap? } }
const settingsStore = new JsonFileStore('settings'); // { [userid]: {fontFamily, fontSizePct, ...} }
const votesStore = new JsonFileStore('votes'); // { [partyId]: {contentId, status, votes:{[userid]:{username,contentId,votedAt,seq}}, winner, createdAt, updatedAt, nextSeq} }
const statsStore = new JsonFileStore('stats'); // contoare durabile (supraviețuiesc --watch)

/* Flush la ieșirea procesului (SIGTERM → shutdown server.js → process.exit(0) →
 * 'exit'). Debounce-ul de 300ms poate pierde, în cel mai rău caz, o mutație
 * făcută în fereastra dintre ultimul flush și terminare — onest, acceptat. */
function flushAllStores() {
  for (const store of [markersStore, settingsStore, votesStore, statsStore]) store.flush();
}
process.on('exit', flushAllStores);
process.on('beforeExit', flushAllStores);

/* ----------------------------- durable counters ----------------------------- */
/* Contoarele din /status trebuie să supraviețuiască restarturilor --watch ⇒
 * sunt ținute în stats.json (nu doar în memorie). markersCurated și activeVotes
 * sunt derivate live din celelalte stocuri. skipUsesByKind e ținut pentru
 * analiza KPI (fișier), dar NU în răspunsul /status — forma e înghețată. */

function statsData() {
  const data = statsStore.load();
  if (typeof data.markersRequests !== 'number') data.markersRequests = 0;
  if (typeof data.skipUses !== 'number') data.skipUses = 0;
  if (!data.skipUsesByKind || typeof data.skipUsesByKind !== 'object') data.skipUsesByKind = { intro: 0, outro: 0, recap: 0 };
  if (typeof data.settingsSaved !== 'number') data.settingsSaved = 0;
  if (typeof data.votesCast !== 'number') data.votesCast = 0;
  if (typeof data.votesClosed !== 'number') data.votesClosed = 0;
  return data;
}

function bumpStat(field, by = 1) {
  const data = statsData();
  data[field] = (data[field] ?? 0) + by;
  statsStore.scheduleSave();
}

/* ------------------------------ generic LRU cache --------------------------- */

function makeLru(limit) {
  return {
    map: new Map(), // key → { value, storedAt } · Map = insertion order = LRU
    get(key) {
      const entry = this.map.get(key);
      if (!entry) return null;
      if (Date.now() - entry.storedAt > CACHE_TTL_MS) {
        this.map.delete(key);
        return null;
      }
      this.map.delete(key);
      this.map.set(key, entry); // refresh recency
      return entry.value;
    },
    set(key, value) {
      if (this.map.has(key)) this.map.delete(key);
      else if (this.map.size >= limit) {
        const oldest = this.map.keys().next().value;
        if (oldest !== undefined) this.map.delete(oldest);
      }
      this.map.set(key, { value, storedAt: Date.now() });
    },
    invalidate(key) {
      this.map.delete(key);
    },
    size() {
      return this.map.size;
    },
  };
}

const markerCache = makeLru(CACHE_MAX_KEYS); // contentId → payload-ul răspunsului GET /markers/:id

/* ------------------------- rate limit per IP (markers/use) ------------------ */

const useBuckets = new Map(); // ip → { count, windowStart }

function useRateAllowed(ip) {
  const now = Date.now();
  let bucket = useBuckets.get(ip);
  if (!bucket || now - bucket.windowStart >= 60_000) {
    bucket = { count: 0, windowStart: now };
    useBuckets.set(ip, bucket);
  }
  bucket.count += 1;
  if (bucket.count > RATE_PER_MIN) return false;
  if (useBuckets.size > 5000) useBuckets.clear();
  return true;
}

const useSweeper = setInterval(() => {
  const now = Date.now();
  for (const [ip, bucket] of useBuckets) {
    if (now - bucket.windowStart >= 120_000) useBuckets.delete(ip);
  }
}, 60_000);
if (typeof useSweeper.unref === 'function') useSweeper.unref();

/* --------------------------------- helpers ---------------------------------- */

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Per-route auth guard — pattern copiat identic din modules/player/hub.js:
 * attachUser e global (server.js), deci req.user e setat pentru orice Bearer
 * valid (JWT verificat cu AUTHSECRET / secret derivat per-tenant); aici doar
 * refuzăm 401 când lipsește. */
const requireAuthLocal = (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  next();
};

/** Positive integer route/body param; null when invalid. */
function intParam(raw) {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Loopback către watchparty-ul PROTEJAT (FAZA 10) — doar consumat, identic ca
 * pattern cu searchux (FAZA 33). Returnează { ok:true, party, members } |
 * { ok:false, missing:true } | { ok:false, unavailable:true }. */
async function fetchPartyDetail(partyId) {
  let res;
  try {
    // NOTĂ: user-agent STRICT ASCII (Bun fetch validează headerele și respinge
    // valorile non-ASCII — ex. diacritice — cu TypeError instant; păstrăm ca la
    // searchux: identificare onestă, doar caractere ASCII).
    res = await fetch(`${SELF_BASE}/api/social/party/${partyId}`, {
      signal: AbortSignal.timeout(LOOPBACK_TIMEOUT_MS),
      headers: { 'user-agent': 'animaxia-playerx/1.0 (FAZA 34; consumes protected watchparty via loopback)' },
    });
  } catch (err) {
    // Diagnostic onest (ops): distinguishes timeout vs reset vs altceva.
    logger.warn(`[playerx] loopback party ${partyId} a eșuat: ${err?.name ?? '?'} ${err?.message ?? err}`);
    return { ok: false, unavailable: true }; // timeout / rețea / server oprit
  }
  const body = await res.json().catch(() => ({}));
  if (res.status === 200 && body?.party) {
    return { ok: true, party: body.party, members: Array.isArray(body.members) ? body.members : [] };
  }
  if (res.status === 404) return { ok: false, missing: true };
  return { ok: false, unavailable: true }; // 410/503/500 de la social ⇒ indisponibil, onest
}

/** Curățare leneșă: voturile stocate pentru o petrecere dispărută/încheiată. */
function prunePartyVotes(partyId) {
  const votes = votesStore.load();
  if (Object.prototype.hasOwnProperty.call(votes, partyId)) {
    delete votes[partyId];
    votesStore.scheduleSave();
  }
}

/* --------------------------- marker estimation (determinist) ---------------- */

/** Durata în secunde din metadata reală. Câmpuri citite (inspectate pe rândurile
 * reale Neon, 2026-09-26): duration (secunde, string numeric — tv), runtime
 * (minute, number — tv/movie), episodeRunTime/episode_runtime (minute, convenție
 * TMDB — zero rânduri azi, citite pentru compatibilitate viitoare). */
function durationSecOf(metadata) {
  const meta = metadata && typeof metadata === 'object' ? metadata : {};
  const dur = Number(meta.duration);
  if (Number.isFinite(dur) && dur > 0) return dur; // secunde
  const rt = Number(meta.runtime);
  if (Number.isFinite(rt) && rt > 0) return rt * 60; // minute → secunde
  const ert = Number(meta.episodeRunTime ?? meta.episode_runtime);
  if (Number.isFinite(ert) && ert > 0) return ert * 60; // minute → secunde
  return null;
}

/** Estimări DETERMINISTE per tip (contract înghețat FAZA-34-b/c). movie/mined/
 * video/page/featured și orice alt tip ⇒ [] — onest, fără markeri inventați. */
function estimateMarkers(type, durationSec) {
  const out = {};
  if (type === 'anime') {
    out.intro = { startsec: 2, endsec: 90 };
    if (durationSec !== null && durationSec > 300) {
      out.outro = { startsec: Math.max(180, durationSec - 90), endsec: durationSec - 6 };
    }
  } else if (type === 'tv') {
    out.recap = { startsec: 0, endsec: 42 };
    out.intro = { startsec: 48, endsec: 110 };
    if (durationSec !== null && durationSec > 300) {
      out.outro = { startsec: Math.max(170, durationSec - 90), endsec: durationSec - 6 };
    }
  }
  return out;
}

/** Un marker e valid doar cu startsec/endsec întregi, startsec<endsec, startsec≥0
 * și o durată (endsec-startsec) între 5 și 600 de secunde. */
function validMarkerSpan(startsec, endsec) {
  return (
    Number.isInteger(startsec) && Number.isInteger(endsec) &&
    startsec >= 0 && startsec < endsec &&
    endsec - startsec >= 5 && endsec - startsec <= 600
  );
}

/** Merge estimări + override-uri curate: un kind curat ÎNLOCUIEȘTE estimatul
 * aceluiași kind; kind-urile curate noi se ADAUGĂ. Sortate pe startsec.
 * anyEstimated = cel puțin un marker ESTIMAT supraviețuiește în rezultatul
 * final (dacă toate kind-urile estimate au override curat, nota dispare —
 * contractul leagă nota de source, nu de existența estimărilor). */
function computeMarkers(contentId, content) {
  const estimated = estimateMarkers(content?.type, durationSecOf(content?.metadata));
  const curatedAll = markersStore.load()[contentId] ?? {};
  const byKind = {};
  for (const [kind, marker] of Object.entries(estimated)) {
    byKind[kind] = { ...marker, kind, source: 'estimated' };
  }
  for (const kind of MARKER_KINDS) {
    const curated = curatedAll[kind];
    if (!curated) continue;
    const { startsec, endsec } = curated;
    if (!validMarkerSpan(startsec, endsec)) {
      logger.warn(`[playerx] marker curat sărit pentru content ${contentId} kind ${kind} (interval invalid: ${startsec}..${endsec})`);
      continue;
    }
    byKind[kind] = {
      startsec,
      endsec,
      kind,
      label: typeof curated.label === 'string' && curated.label.trim()
        ? curated.label.trim().slice(0, LABEL_MAX)
        : KIND_LABELS[kind],
      source: 'curated',
    };
  }
  const data = Object.values(byKind)
    .map((m) => ({
      id: m.kind,
      kind: m.kind,
      startsec: m.startsec,
      endsec: m.endsec,
      label: m.source === 'estimated' ? KIND_LABELS[m.kind] : m.label,
      source: m.source,
    }))
    .sort((a, b) => a.startsec - b.startsec || a.endsec - b.endsec);
  return { data, anyEstimated: data.some((m) => m.source === 'estimated') };
}

/* ---------------------------------- router ---------------------------------- */

const router = express.Router();

/** GET /status — contract înghețat FAZA-34-b/c: stats onest (stats.json durabil
 * + contoare live derivate) fără câmpuri în plus. */
router.get('/status', (req, res) => {
  const stats = statsData();
  const markers = markersStore.load();
  const votes = votesStore.load();
  let markersCurated = 0;
  for (const byKind of Object.values(markers)) {
    for (const kind of MARKER_KINDS) {
      if (byKind && typeof byKind === 'object' && byKind[kind]) markersCurated += 1;
    }
  }
  let activeVotes = 0;
  for (const record of Object.values(votes)) {
    if (record && typeof record === 'object' && record.status === 'open') activeVotes += 1;
  }
  res.json({
    ok: true,
    service: 'playerx',
    phase: 'faza-34',
    uptimeSec: Math.round((Date.now() - bootAt) / 1000),
    storage: 'file',
    storageDir: STORAGE_DIR_LABEL,
    stats: {
      markersCurated,
      markersRequests: stats.markersRequests,
      skipUses: stats.skipUses,
      settingsSaved: stats.settingsSaved,
      votesCast: stats.votesCast,
      votesClosed: stats.votesClosed,
      activeVotes,
    },
    generatedAt: new Date().toISOString(),
  });
});

/* ------------------------------- B. markers --------------------------------- */

/** GET /markers/:contentId — public, cache LRU 60s per contentId + header
 * Cache-Control public max-age=60. Estimări deterministe + override-uri curate. */
router.get('/markers/:contentId', wrap(async (req, res) => {
  const contentId = intParam(req.params.contentId);
  if (!contentId) return res.status(400).json({ error: 'ID invalid' });
  bumpStat('markersRequests');

  const cached = markerCache.get(contentId);
  if (cached) {
    res.set('Cache-Control', 'public, max-age=60');
    return res.json({ ok: true, contentId, ...cached });
  }

  let content;
  try {
    content = await getContentById(contentId); // clientul DB partajat (Neon: SELECT by id; local fallback), ca la /api/content/:id
  } catch (err) {
    logger.warn(`[playerx] markers: citirea contentului ${contentId} a eșuat: ${err?.message ?? err}`);
    return res.status(503).json({ error: 'Sursa de conținut este momentan indisponibilă' });
  }
  if (!content) return res.status(404).json({ error: 'Conținut inexistent' });

  const { data, anyEstimated } = computeMarkers(contentId, content);
  const payload = { data };
  if (anyEstimated) payload.note = MARKER_NOTE;
  markerCache.set(contentId, payload);
  res.set('Cache-Control', 'public, max-age=60');
  return res.json({ ok: true, contentId, ...payload });
}));

/** POST /markers/use — contor anonim de utilizare skip (KPI WS4 „utilizare
 * skip-intro"). Public, per-IP 30/min în-modul. NU atinge DB — contor analitic
 * (validează doar forma body-ului, contract înghețat). ATENȚIE: înregistrat
 * ÎNAINTE de POST /markers/:contentId ca literalul „use" să nu fie prins de
 * parametrul :contentId. */
router.post('/markers/use', (req, res) => {
  const ip = clientIpOf(req);
  if (!useRateAllowed(ip)) {
    return res.status(429).json({ error: 'Prea multe utilizări skip — încearcă din nou într-un minut', retryAfterSec: 60 });
  }
  const body = req.body ?? {};
  const contentId = intParam(body.contentId);
  const { kind } = body;
  if (!contentId) return res.status(400).json({ error: 'contentId (întreg pozitiv) este obligatoriu' });
  if (!MARKER_KINDS.includes(kind)) return res.status(400).json({ error: 'kind trebuie intro|outro|recap' });

  const stats = statsData();
  stats.skipUses += 1;
  if (!Number.isFinite(stats.skipUsesByKind[kind])) stats.skipUsesByKind[kind] = 0;
  stats.skipUsesByKind[kind] += 1;
  statsStore.scheduleSave();
  return res.json({ ok: true, skipUses: stats.skipUses });
});

/** POST /markers/:contentId — upsert override curat (auth). Înlocuiește un
 * eventual marker curat pentru același kind; invalidează cache-ul acelui
 * contentId; validare completă a intervalului (aceleași reguli ca la citire). */
router.post('/markers/:contentId', requireAuthLocal, wrap(async (req, res) => {
  const contentId = intParam(req.params.contentId);
  if (!contentId) return res.status(400).json({ error: 'ID invalid' });

  const body = req.body ?? {};
  const { kind, startsec, endsec } = body;
  if (!MARKER_KINDS.includes(kind)) {
    return res.status(400).json({ error: 'kind trebuie intro|outro|recap' });
  }
  if (!Number.isInteger(startsec) || startsec < 0) {
    return res.status(400).json({ error: 'startsec trebuie un întreg ≥ 0' });
  }
  if (!Number.isInteger(endsec) || endsec <= startsec) {
    return res.status(400).json({ error: 'endsec trebuie un întreg > startsec' });
  }
  if (endsec - startsec < 5 || endsec - startsec > 600) {
    return res.status(400).json({ error: 'durata markerului (endsec-startsec) trebuie între 5 și 600 de secunde' });
  }
  const label = typeof body.label === 'string' && body.label.trim()
    ? body.label.trim().slice(0, LABEL_MAX)
    : KIND_LABELS[kind];

  let content;
  try {
    content = await getContentById(contentId);
  } catch (err) {
    logger.warn(`[playerx] markers upsert: citirea contentului ${contentId} a eșuat: ${err?.message ?? err}`);
    return res.status(503).json({ error: 'Sursa de conținut este momentan indisponibilă' });
  }
  if (!content) return res.status(404).json({ error: 'Conținut inexistent' });

  const markers = markersStore.load();
  const entry = markers[contentId] ?? {};
  entry[kind] = { startsec, endsec, label };
  markers[contentId] = entry;
  markersStore.scheduleSave();
  markerCache.invalidate(contentId);

  return res.json({ ok: true, marker: { id: kind, kind, startsec, endsec, label, source: 'curated' } });
}));

/** DELETE /markers/:contentId/:kind — înlătură override-ul curat (auth). */
router.delete('/markers/:contentId/:kind', requireAuthLocal, (req, res) => {
  const contentId = intParam(req.params.contentId);
  if (!contentId) return res.status(400).json({ error: 'ID invalid' });
  const { kind } = req.params;
  if (!MARKER_KINDS.includes(kind)) return res.status(400).json({ error: 'kind trebuie intro|outro|recap' });

  const markers = markersStore.load();
  const entry = markers[contentId];
  if (!entry || !entry[kind]) return res.status(404).json({ error: 'Marker curat inexistent' });
  delete entry[kind];
  if (Object.keys(entry).length === 0) delete markers[contentId]; // ținem fișierul curat
  markersStore.scheduleSave();
  markerCache.invalidate(contentId);
  return res.json({ ok: true });
});

/* --------------------------- C. subtitle settings ---------------------------- */

/** Validează STRICT toate cele 8 câmpuri (contract subtitle-studio FAZA-34-b).
 * Returnează { value } sau { error } — mesajul numește câmpul vinovat. */
function validateSubtitleSettings(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'body-ul trebuie un obiect cu cele 8 câmpuri de setări' };
  }
  if (typeof raw.fontFamily !== 'string' || !FONT_FAMILIES.includes(raw.fontFamily)) {
    return { error: `fontFamily trebuie unul dintre: ${FONT_FAMILIES.join(', ')}` };
  }
  if (!Number.isInteger(raw.fontSizePct) || raw.fontSizePct < 50 || raw.fontSizePct > 250) {
    return { error: 'fontSizePct trebuie un întreg între 50 și 250' };
  }
  if (typeof raw.textColor !== 'string' || !HEX_RE.test(raw.textColor)) {
    return { error: 'textColor trebuie un cod hex (#rrggbb)' };
  }
  if (typeof raw.bgColor !== 'string' || !HEX_RE.test(raw.bgColor)) {
    return { error: 'bgColor trebuie un cod hex (#rrggbb)' };
  }
  if (typeof raw.bgOpacity !== 'number' || !Number.isFinite(raw.bgOpacity) || raw.bgOpacity < 0 || raw.bgOpacity > 1) {
    return { error: 'bgOpacity trebuie un număr între 0 și 1' };
  }
  if (typeof raw.edge !== 'string' || !EDGES.includes(raw.edge)) {
    return { error: `edge trebuie unul dintre: ${EDGES.join(', ')}` };
  }
  if (typeof raw.position !== 'string' || !POSITIONS.includes(raw.position)) {
    return { error: `position trebuie una dintre: ${POSITIONS.join(', ')}` };
  }
  if (typeof raw.marginPct !== 'number' || !Number.isFinite(raw.marginPct) || raw.marginPct < 0 || raw.marginPct > 20) {
    return { error: 'marginPct trebuie un număr între 0 și 20' };
  }
  return {
    value: {
      fontFamily: raw.fontFamily,
      fontSizePct: raw.fontSizePct,
      textColor: raw.textColor,
      bgColor: raw.bgColor,
      bgOpacity: raw.bgOpacity,
      edge: raw.edge,
      position: raw.position,
      marginPct: raw.marginPct,
    },
  };
}

/** GET /subtitle-settings — setările userului curent (auth); null dacă nu are. */
router.get('/subtitle-settings', requireAuthLocal, (req, res) => {
  const settings = settingsStore.load();
  const mine = settings[req.user.id];
  return res.json({ ok: true, settings: mine ? { ...mine } : null });
});

/** PUT /subtitle-settings — salvare per userid (auth). Validare strictă pe
 * TOATE câmpurile; settingsSaved++ doar la PRIMA salvare a userului. */
router.put('/subtitle-settings', requireAuthLocal, (req, res) => {
  const { value, error } = validateSubtitleSettings(req.body ?? {});
  if (error) return res.status(400).json({ error });
  const settings = settingsStore.load();
  const { id: userid } = req.user;
  const isFirstSave = !Object.prototype.hasOwnProperty.call(settings, userid);
  settings[userid] = value;
  settingsStore.scheduleSave();
  if (isFirstSave) bumpStat('settingsSaved');
  return res.json({ ok: true });
});

/* ------------------------------ D. party votes ------------------------------- */

/** Tally + votanți în ordinea în care au votat (seq incremental — determinist,
 * supraviețuiește și round-trip-ului JSON, care păstrează ordinea cheilor). */
function tallyOf(record) {
  const tally = {};
  const voters = [];
  const entries = Object.entries(record?.votes ?? {}).slice().sort((a, b) => (a[1]?.seq ?? 0) - (b[1]?.seq ?? 0));
  for (const [userid, vote] of entries) {
    const cid = Number(vote?.contentId);
    tally[cid] = (tally[cid] ?? 0) + 1;
    voters.push({ userid: Number(userid), username: vote?.username, contentId: cid });
  }
  return { tally, voters };
}

/** Câștigător = contentId cu cele mai multe voturi; la egalitate, contentId-ul
 * votului cel mai devreme exprimat dintre cele la egalitate (determinist). */
function computeWinner(record) {
  const { tally, voters } = tallyOf(record);
  const counts = Object.entries(tally);
  if (counts.length === 0) return null;
  let max = 0;
  for (const [, count] of counts) max = Math.max(max, count);
  const tied = counts.filter(([, count]) => count === max).map(([cid]) => Number(cid));
  if (tied.length === 1) return tied[0];
  const firstVotePos = new Map(); // contentId → prima poziție în ordinea votării
  for (let i = 0; i < voters.length; i += 1) {
    if (!firstVotePos.has(voters[i].contentId)) firstVotePos.set(voters[i].contentId, i);
  }
  let winner = null;
  let bestPos = Infinity;
  for (const cid of tied) {
    const pos = firstVotePos.get(cid);
    if (pos !== undefined && pos < bestPos) {
      bestPos = pos;
      winner = cid;
    }
  }
  return winner;
}

/** GET /party/:partyId/votes — public. Petrecerea trebuie să existe și să fie
 * activă (validare prin loopback contra FAZA 10 protejat); altfel 404 + curățare
 * leneșă a voturilor stocate pentru ea. */
router.get('/party/:partyId/votes', wrap(async (req, res) => {
  const partyId = intParam(req.params.partyId);
  if (!partyId) return res.status(400).json({ error: 'ID petrecere invalid' });

  const fetched = await fetchPartyDetail(partyId);
  if (fetched.unavailable) return res.status(503).json({ error: 'Serviciul de party indisponibil' });
  if (fetched.missing || fetched.party?.status !== 'active') {
    prunePartyVotes(partyId);
    return res.status(404).json({ error: 'Petrecere inexistentă sau încheiată' });
  }

  const record = votesStore.load()[partyId];
  if (!record) {
    // Nicio înregistrare încă — votul e implicit deschis, totul gol, onest.
    return res.json({
      ok: true,
      partyId,
      contentId: Number(fetched.party.content?.id),
      status: 'open',
      winner: null,
      tally: {},
      voters: [],
      createdAt: null,
      updatedAt: null,
    });
  }
  const { tally, voters } = tallyOf(record);
  return res.json({
    ok: true,
    partyId,
    contentId: Number(fetched.party.content?.id),
    status: record.status === 'closed' ? 'closed' : 'open',
    winner: record.status === 'closed' ? record.winner ?? null : null,
    tally,
    voters,
    createdAt: record.createdAt ?? null,
    updatedAt: record.updatedAt ?? null,
  });
}));

/** POST /party/:partyId/vote — auth, doar membri (gazda e mereu membru). Un vot
 * per user, care poate fi schimbat cât timp votul e deschis; votesCast++ doar
 * la voturi NOI (schimbarea votului nu se numără dublu). */
router.post('/party/:partyId/vote', requireAuthLocal, wrap(async (req, res) => {
  const partyId = intParam(req.params.partyId);
  if (!partyId) return res.status(400).json({ error: 'ID petrecere invalid' });
  const contentId = intParam(req.body?.contentId);
  if (!contentId) return res.status(400).json({ error: 'contentId (întreg pozitiv) este obligatoriu' });

  const fetched = await fetchPartyDetail(partyId);
  if (fetched.unavailable) return res.status(503).json({ error: 'Serviciul de party indisponibil' });
  if (fetched.missing || fetched.party?.status !== 'active') {
    prunePartyVotes(partyId);
    return res.status(404).json({ error: 'Petrecere inexistentă sau încheiată' });
  }

  const userid = Number(req.user.id);
  const isHost = Number(fetched.party.host?.id) === userid;
  const isMember = isHost || fetched.members.some((m) => Number(m?.userid) === userid);
  if (!isMember) return res.status(403).json({ error: 'Doar membrii pot vota' });

  const votes = votesStore.load();
  let record = votes[partyId];
  if (record && record.status === 'closed') {
    return res.status(410).json({ error: 'Votul s-a încheiat' });
  }
  const now = new Date().toISOString();
  if (!record) {
    record = {
      contentId: Number(fetched.party.content?.id),
      status: 'open',
      votes: {},
      winner: null,
      createdAt: now,
      updatedAt: now,
      nextSeq: 1,
    };
    votes[partyId] = record;
  }
  const prev = record.votes[String(userid)];
  record.votes[String(userid)] = {
    username: req.user.username,
    contentId,
    votedAt: now,
    seq: prev ? prev.seq : record.nextSeq ?? 1,
  };
  if (!prev) {
    record.nextSeq = (record.nextSeq ?? 1) + 1;
    bumpStat('votesCast');
  }
  record.updatedAt = now;
  votesStore.scheduleSave();

  const { tally, voters } = tallyOf(record);
  return res.json({ ok: true, tally, voters });
}));

/** DELETE /party/:partyId/votes — auth, DOAR gazda: închide votul și calculează
 * câștigătorul (egalitate ⇒ contentId-ul cel mai devreme votat dintre cei la
 * egalitate — determinist). Idempotent: re-închiderea returnează aceeași decizie
 * fără a dubla contorul votesClosed. */
router.delete('/party/:partyId/votes', requireAuthLocal, wrap(async (req, res) => {
  const partyId = intParam(req.params.partyId);
  if (!partyId) return res.status(400).json({ error: 'ID petrecere invalid' });

  const fetched = await fetchPartyDetail(partyId);
  if (fetched.unavailable) return res.status(503).json({ error: 'Serviciul de party indisponibil' });
  if (fetched.missing || fetched.party?.status !== 'active') {
    prunePartyVotes(partyId);
    return res.status(404).json({ error: 'Petrecere inexistentă sau încheiată' });
  }

  if (Number(fetched.party.host?.id) !== Number(req.user.id)) {
    return res.status(403).json({ error: 'Doar gazda poate încheia votul' });
  }

  const votes = votesStore.load();
  const record = votes[partyId];
  if (!record) return res.status(404).json({ error: 'Nu există voturi pentru această petrecere' });

  const { tally } = tallyOf(record);
  if (record.status !== 'closed') {
    record.status = 'closed';
    record.winner = computeWinner(record);
    record.updatedAt = new Date().toISOString();
    votesStore.scheduleSave();
    bumpStat('votesClosed');
  }
  return res.json({ ok: true, winner: record.winner ?? null, tally });
}));

export default router;
