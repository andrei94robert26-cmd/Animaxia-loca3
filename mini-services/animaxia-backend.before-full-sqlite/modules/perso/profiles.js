/**
 * modules/perso/profiles.js — FAZA 36-R (PLAN 100X · WS6): profile multiple
 * per cont (max 5) cu opțional PIN de 4 cifre și token de sesiune profil.
 *
 *   · PIN: 4 cifre, stocate DOAR ca sha256(salt + pin) — niciodată plaintext;
 *     salt din process.env.PERSO_PIN_SALT sau constantă documentată.
 *   · Profilul MAIN = primul profil creat al contului; nu poate fi șters
 *     (contract onest: „nu pe cel principal").
 *   · Token sesiune profil: JWT-lite (header.payload.signature, HS256) semnat
 *     cu PERSO_TOKEN_SECRET / AUTHSECRET, expiră în 2h — verificabil prin
 *     verifyProfileToken() fără stare (stateless, la fel ca JWT).
 *
 * Stocare: data/perso/profiles.json (scrieri atomice debounced — storage.js).
 */

import crypto from 'node:crypto';
import { profilesStore, PIN_SALT, TOKEN_SECRET, PROFILE_TOKEN_TTL_MS } from './storage.js';

export const MAX_PROFILES = 5;
const NAME_MIN = 2;
const NAME_MAX = 30;
const EMOJI_WHITELIST = ['🧑', '👩', '👨', '🧒', '👧', '👦', '🦊', '🐼', '🦄', '🐯', '🍿', '🎬', '⭐', '🌙', '🚀', '🎸'];
export const DEFAULT_EMOJI = '🧑';

/* ------------------------------ PIN (sha256+salt) --------------------------- */

export function isValidPin(pin) {
  return typeof pin === 'string' && /^\d{4}$/.test(pin);
}

/** Hash-ul PIN-ului — sha256(salt + ':' + pin), hex. */
export function hashPin(pin) {
  return crypto.createHash('sha256').update(`${PIN_SALT}:${pin}`).digest('hex');
}

/** Verifică un PIN brut contra hash-ului stocat (timing-safe). */
export function pinMatches(pin, storedHash) {
  if (!isValidPin(pin) || typeof storedHash !== 'string' || storedHash.length !== 64) return false;
  const a = Buffer.from(hashPin(pin), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ---------------------------- JWT-lite (HS256, 2h) -------------------------- */

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlJson(obj) {
  return b64url(JSON.stringify(obj));
}

function fromB64url(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function hmac(data) {
  return b64url(crypto.createHmac('sha256', TOKEN_SECRET).update(data).digest());
}

/** Semnează un token de sesiune profil: header.payload.signature (JWT-lite). */
export function signProfileToken({ profileId, userId, name }) {
  const now = Date.now();
  const header = { alg: 'HS256', typ: 'JWT-lite' };
  const payload = {
    sub: String(profileId),
    acc: Number(userId),
    name: String(name ?? ''),
    iat: Math.floor(now / 1000),
    exp: Math.floor((now + PROFILE_TOKEN_TTL_MS) / 1000),
  };
  const head = b64urlJson(header);
  const body = b64urlJson(payload);
  return `${head}.${body}.${hmac(`${head}.${body}`)}`;
}

/** Verifică semnătura + expirarea. Returnează { ok, payload } | { ok:false, reason }. */
export function verifyProfileToken(token) {
  if (typeof token !== 'string') return { ok: false, reason: 'token lipsă' };
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'format invalid (3 părți așteptate)' };
  const [head, body, sig] = parts;
  const expected = hmac(`${head}.${body}`);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: 'semnătură invalidă' };
  }
  let payload;
  try {
    payload = JSON.parse(fromB64url(body).toString('utf8'));
  } catch {
    return { ok: false, reason: 'payload ilegibil' };
  }
  if (typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now()) {
    return { ok: false, reason: 'token expirat' };
  }
  return { ok: true, payload };
}

/* ------------------------------ profiles CRUD ------------------------------- */

function accountOf(store, userId) {
  const all = store.load();
  const key = String(Number(userId));
  if (!all[key] || typeof all[key] !== 'object' || !Array.isArray(all[key].list)) {
    return { list: [], nextSeq: 1 };
  }
  const acc = all[key];
  if (typeof acc.nextSeq !== 'number' || acc.nextSeq < 1) acc.nextSeq = 1;
  return acc;
}

/** Lista publică a profilelor contului (fără hash-uri — niciodată). */
export function listProfiles(userId) {
  const acc = accountOf(profilesStore, userId);
  return acc.list.map((p) => ({
    id: p.id,
    name: p.name,
    emoji: p.emoji ?? DEFAULT_EMOJI,
    isMain: Boolean(p.isMain),
    hasPin: Boolean(p.pinHash),
    createdAt: p.createdAt ?? null,
    updatedAt: p.updatedAt ?? null,
  }));
}

export function findProfile(userId, profileId) {
  const acc = accountOf(profilesStore, userId);
  return acc.list.find((p) => p.id === profileId) ?? null;
}

/** Validare nume profil: 2..30 caractere, curățat onest. */
export function validateName(raw) {
  if (typeof raw !== 'string') return { error: 'name trebuie un string (2-30 caractere)' };
  const name = raw.trim().replace(/\s+/g, ' ');
  if (name.length < NAME_MIN || name.length > NAME_MAX) {
    return { error: `name trebuie între ${NAME_MIN} și ${NAME_MAX} caractere` };
  }
  return { value: name };
}

/** Validare emoji avatar (whitelist onest — zero injectare). */
export function validateEmoji(raw) {
  if (raw === undefined || raw === null || raw === '') return { value: DEFAULT_EMOJI };
  if (typeof raw !== 'string' || !EMOJI_WHITELIST.includes(raw)) {
    return { error: `emoji trebuie unul dintre: ${EMOJI_WHITELIST.join(' ')}` };
  }
  return { value: raw };
}

/**
 * Creează un profil. Primul profil al contului devine MAIN (oneste — nu poate
 * fi șters). Al 6-lea profil → { error } (max 5/cont).
 */
export function createProfile(userId, { name, emoji, pin }) {
  const n = validateName(name);
  if (n.error) return { error: n.error, status: 400 };
  const e = validateEmoji(emoji);
  if (e.error) return { error: e.error, status: 400 };
  let pinHash = null;
  if (pin !== undefined && pin !== null && pin !== '') {
    if (!isValidPin(pin)) return { error: 'PIN trebuie exact 4 cifre', status: 400 };
    pinHash = hashPin(pin);
  }
  const all = profilesStore.load();
  const key = String(Number(userId));
  const acc = accountOf(profilesStore, userId);
  if (acc.list.length >= MAX_PROFILES) {
    return { error: `Limită atinsă: maxim ${MAX_PROFILES} profiluri per cont`, status: 400 };
  }
  const isMain = acc.list.length === 0; // primul profil = principal
  const now = new Date().toISOString();
  const profile = {
    id: `p${acc.nextSeq}`,
    name: n.value,
    emoji: e.value,
    pinHash,
    isMain,
    createdAt: now,
    updatedAt: now,
  };
  acc.list.push(profile);
  acc.nextSeq += 1;
  all[key] = acc;
  profilesStore.scheduleSave();
  return {
    profile: {
      id: profile.id,
      name: profile.name,
      emoji: profile.emoji,
      isMain: profile.isMain,
      hasPin: Boolean(profile.pinHash),
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
    },
  };
}

/**
 * Actualizare profil: nume, emoji și/sau PIN. Dacă profilul ARE PIN, orice
 * actualizare cere `oldPin` corect (gardă standard de profil cu PIN).
 * pin: null / '' elimină PIN-ul (tot cu oldPin corect).
 */
export function updateProfile(userId, profileId, { name, emoji, pin, oldPin }) {
  const all = profilesStore.load();
  const key = String(Number(userId));
  const acc = accountOf(profilesStore, userId);
  const profile = acc.list.find((p) => p.id === profileId);
  if (!profile) return { error: 'Profil inexistent', status: 404 };

  if (profile.pinHash) {
    if (!oldPin || !pinMatches(oldPin, profile.pinHash)) {
      return { error: 'PIN vechi incorect — necesar pentru actualizarea unui profil cu PIN', status: 403 };
    }
  }

  if (name !== undefined) {
    const n = validateName(name);
    if (n.error) return { error: n.error, status: 400 };
    profile.name = n.value;
  }
  if (emoji !== undefined) {
    const e = validateEmoji(emoji);
    if (e.error) return { error: e.error, status: 400 };
    profile.emoji = e.value;
  }
  if (pin !== undefined) {
    if (pin === null || pin === '') {
      profile.pinHash = null; // elimină PIN-ul (a cerut oldPin corect dacă exista)
    } else {
      if (!isValidPin(pin)) return { error: 'PIN trebuie exact 4 cifre', status: 400 };
      profile.pinHash = hashPin(pin);
    }
  }
  profile.updatedAt = new Date().toISOString();
  all[key] = acc;
  profilesStore.scheduleSave();
  return {
    profile: {
      id: profile.id,
      name: profile.name,
      emoji: profile.emoji,
      isMain: profile.isMain,
      hasPin: Boolean(profile.pinHash),
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
    },
  };
}

/** Ștergere profil — refuză profilul principal (400 onest). */
export function deleteProfile(userId, profileId) {
  const all = profilesStore.load();
  const key = String(Number(userId));
  const acc = accountOf(profilesStore, userId);
  const idx = acc.list.findIndex((p) => p.id === profileId);
  if (idx === -1) return { error: 'Profil inexistent', status: 404 };
  if (acc.list[idx].isMain) {
    return { error: 'Profilul principal nu poate fi șters', status: 400 };
  }
  const removed = acc.list.splice(idx, 1)[0];
  all[key] = acc;
  profilesStore.scheduleSave();
  return { removedId: removed.id, remaining: acc.list.length };
}

/**
 * Verificare PIN → token de sesiune profil (2h). PIN greșit → 403 onest.
 * Profil fără PIN → token emis direct (garda e opțională, onest).
 */
export function verifyProfile(userId, profileId, pin) {
  const profile = findProfile(userId, profileId);
  if (!profile) return { error: 'Profil inexistent', status: 404 };
  if (profile.pinHash) {
    if (!isValidPin(pin)) return { error: 'PIN lipsă sau invalid (4 cifre)', status: 403 };
    if (!pinMatches(pin, profile.pinHash)) return { error: 'PIN incorect', status: 403 };
  }
  const token = signProfileToken({ profileId: profile.id, userId: Number(userId), name: profile.name });
  return {
    token,
    tokenType: 'Bearer',
    expiresInSec: Math.floor(PROFILE_TOKEN_TTL_MS / 1000),
    profile: {
      id: profile.id,
      name: profile.name,
      emoji: profile.emoji ?? DEFAULT_EMOJI,
      isMain: Boolean(profile.isMain),
    },
  };
}
