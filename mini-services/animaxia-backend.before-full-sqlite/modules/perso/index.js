/**
 * modules/perso/index.js — FAZA 36-R (PLAN 100X · WS6): Personalizare &
 * Recomandări 2.0 — routerul /api/perso/* (14 rute). 100% ADITIV.
 *
 * Recomandările existente (hub FAZA 20, ai/home FAZA 15) rămân NEATINSE —
 * acest modul e un strat NOU care învață pasiv din semnale reale (istoric,
 * aprecieri, recenzii, evenimente) și construiește feed „Pentru Tine" cu
 * secțiuni explicite + profile multiple cu PIN + memento-uri de încheiere.
 * ZERO schemă DB (stocare file-based data/perso/), ZERO ML extern (euristică
 * deterministă onestă, etichetată ca atare), ZERO setInterval cu DB/fetch
 * (regula NEON FREE PLAN — totul on-demand, cache în memorie cu TTL).
 *
 * Rutare (mount: app.use('/api/perso', persoRouter) — namespace NOU):
 *   GET    /status                        → stats onest + cache + storage     (public)
 *   GET    /profile?user=ID               → profilul de gust învățat pasiv    (public, cache 10 min)
 *   POST   /profile/reset                 → șterge agregarea (păstrează semnale) (auth sau ?user=)
 *   GET    /feed?user=ID&limit=24         → feed „Pentru Tine" cu secțiuni    (public)
 *   GET    /profiles?user=ID              → profilele contului (fără hash-uri)(public)
 *   POST   /profiles {name, emoji?, pin?} → creează profil (max 5/cont)      (auth sau body.userId)
 *   PUT    /profiles/:id {name?, pin?, oldPin?} → actualizare (PIN vechi dacă are PIN)
 *   DELETE /profiles/:id                  → șterge (nu pe cel principal)
 *   POST   /profiles/:id/verify {pin}     → token sesiune profil (JWT-lite 2h)
 *   GET    /reminders?user=ID             → memento-uri de încheiere          (public)
 *   POST   /reminders/:contentId/dismiss  → respinge memento (TTL 30 zile)   (auth sau ?user=)
 *   GET    /affinities?user=ID            → breakdown detaliat afinități     (public)
 *   GET    /explain/:contentId?user=ID    → de ce e recomandat un item       (public)
 *   POST   /events {type, contentId?, weight?, userId?} → semnal (60/min/IP)
 *
 * AUTH: pattern requireAuthLocal din playerx (FAZA 34) — attachUser e global
 * în server.js, deci req.user e prezent la orice Bearer valid; identity
 * resolution onestă: req.user.id → ?user= (query) → body.userId (POST).
 *
 * Config env: PERSO_* din storage.js (TTL cache, debounce, limite).
 */

import express from 'express';
import { getContentById } from '../../db.js';
import { userRateLimit } from '../security/security.js';
import { logger } from '../../utils/logger.js';
import {
  statsData, bumpStat, bumpEventStat, profileCacheApi, STORAGE_DIR_LABEL,
  profilesStore, eventsStore, dismissalsStore, resetsStore, statsStore,
  eventsStorePerUser, pushEvent, CACHE_TTL_MS, EVENTS_PER_USER, DISMISSAL_TTL_MS,
  PROFILE_TOKEN_TTL_MS,
} from './storage.js';
import { computeProfile, getProfileCached, genresOf, yearOf, WEIGHTS } from './profile.js';
import { buildFeed } from './feed.js';
import {
  listProfiles, createProfile, updateProfile, deleteProfile, verifyProfile,
  verifyProfileToken, MAX_PROFILES,
} from './profiles.js';
import { buildReminders, dismissReminder } from './reminders.js';

export const persoRouter = express.Router();

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Positive integer param; null when invalid. */
function intParam(raw) {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Identitatea onestă: req.user (Bearer, global attachUser) → ?user= → body.userId.
 * Returnează { userId, via } sau null (rutele răspund 401 cu mesaj clar).
 */
function identityOf(req) {
  if (req.user?.id != null && Number.isInteger(Number(req.user.id))) {
    return { userId: Number(req.user.id), via: 'auth' };
  }
  const q = intParam(req.query?.user);
  if (q) return { userId: q, via: 'query' };
  const b = intParam(req.body?.userId);
  if (b) return { userId: b, via: 'body' };
  return null;
}

function requireIdentity(req, res) {
  const identity = identityOf(req);
  if (!identity) {
    res.status(401).json({ error: 'Autentificare necesară (Bearer) sau ?user=<id> onest' });
    return null;
  }
  return identity;
}

/** Cache-Control onest: datele per-user nu trebuie cache-uite public. */
const PRIVATE_CACHE = 'private, max-age=30';

/* Rate limit POST /events: 60/min/IP (bucket dedicat, expirare leneșă). */
const eventsRateLimit = userRateLimit({ scope: 'ip', max: 60, windowMs: 60_000, key: 'perso-events' });

const bootAt = Date.now();

/* ------------------------------- 1. GET /status ----------------------------- */

persoRouter.get('/status', (req, res) => {
  const stats = statsData();
  res.set('Cache-Control', 'public, max-age=10');
  return res.json({
    ok: true,
    module: 'perso',
    faza: 'FAZA 36-R (PLAN 100X · WS6) — Personalizare & Recomandări 2.0',
    uptimeSec: Math.round((Date.now() - bootAt) / 1000),
    routes: 14,
    storage: {
      dir: STORAGE_DIR_LABEL,
      files: {
        profiles: profilesStore.recordCount(),
        events: eventsStore.recordCount(),
        dismissals: dismissalsStore.recordCount(),
        resets: resetsStore.recordCount(),
      },
      note: 'scrieri atomice debounced (tmp+rename); contoarele în stats.json supraviețuiesc restarturilor',
    },
    cache: {
      profileTtlSec: Math.round(CACHE_TTL_MS / 1000),
      ...profileCacheApi.stats(),
      note: 'invalidat on-demand la POST /events și POST /profile/reset — zero polling',
    },
    limits: {
      maxProfilesPerAccount: MAX_PROFILES,
      eventsPerUser: EVENTS_PER_USER,
      eventsRatePerMinPerIp: 60,
      dismissalTtlDays: Math.round(DISMISSAL_TTL_MS / 86_400_000),
      profileTokenTtlSec: Math.round(PROFILE_TOKEN_TTL_MS / 1000),
    },
    counters: {
      eventsTracked: stats.eventsTracked,
      eventsByType: { ...stats.eventsByType },
      profileRequests: stats.profileRequests,
      profileResets: stats.profileResets,
      feedRequests: stats.feedRequests,
      profilesCreated: stats.profilesCreated,
      profilesUpdated: stats.profilesUpdated,
      profilesDeleted: stats.profilesDeleted,
      profileVerifications: stats.profileVerifications,
      verificationFails: stats.verificationFails,
      remindersRequests: stats.remindersRequests,
      remindersDismissed: stats.remindersDismissed,
      affinitiesRequests: stats.affinitiesRequests,
      explainRequests: stats.explainRequests,
    },
    method: {
      engine: 'euristică deterministă',
      ml: false,
      note: 'personalizare onestă din semnale reale — zero ML extern, zero interogări periodice',
    },
    generatedAt: new Date().toISOString(),
  });
});

/* --------------------------- 2. GET /profile?user= -------------------------- */

persoRouter.get('/profile', wrap(async (req, res) => {
  const identity = requireIdentity(req, res);
  if (!identity) return undefined;
  bumpStat('profileRequests');
  const { profile, cached } = await getProfileCached(identity.userId);
  res.set('Cache-Control', PRIVATE_CACHE);
  res.set('X-Perso-Cache', cached ? 'hit' : 'miss');
  return res.json({
    ok: true,
    userId: identity.userId,
    identity: identity.via,
    cached,
    profile,
    note: profile.empty
      ? 'Profil gol onest — încă nicio vizionare, apreciere, recenzie sau eveniment care să conteze.'
      : null,
  });
}));

/* ---------------------------- 3. POST /profile/reset ------------------------ */

persoRouter.post('/profile/reset', wrap(async (req, res) => {
  const identity = requireIdentity(req, res);
  if (!identity) return undefined;
  const resets = resetsStore.load();
  resets[String(identity.userId)] = { resetAt: new Date().toISOString() };
  resetsStore.scheduleSave();
  profileCacheApi.invalidate(identity.userId);
  bumpStat('profileResets');
  logger.info(`[perso] profil resetat pentru user ${identity.userId} (via ${identity.via})`);
  return res.json({
    ok: true,
    userId: identity.userId,
    resetAt: resets[String(identity.userId)].resetAt,
    effect: 'agregarea învățată a fost ștearsă; semnalele istorice rămân în tabelele sursă (doar markerul resetAt le exclude de acum înainte)',
  });
}));

/* ---------------------------- 4. GET /feed?user=&limit ---------------------- */

persoRouter.get('/feed', wrap(async (req, res) => {
  const identity = requireIdentity(req, res);
  if (!identity) return undefined;
  const limitRaw = req.query?.limit;
  const limit = limitRaw === undefined ? undefined : intParam(limitRaw);
  if (limitRaw !== undefined && !limit) {
    return res.status(400).json({ error: 'limit trebuie un întreg pozitiv (1-48)' });
  }
  bumpStat('feedRequests');
  const feed = await buildFeed({ userId: identity.userId, limit: limit ?? 24 });
  res.set('Cache-Control', PRIVATE_CACHE);
  return res.json({ ok: true, identity: identity.via, ...feed });
}));

/* --------------------------- 5. GET /profiles?user= ------------------------- */

persoRouter.get('/profiles', (req, res) => {
  const identity = requireIdentity(req, res);
  if (!identity) return undefined;
  const list = listProfiles(identity.userId);
  return res.json({
    ok: true,
    userId: identity.userId,
    identity: identity.via,
    profiles: list,
    max: MAX_PROFILES,
    note: list.length === 0
      ? 'Niciun profil creat încă pentru acest cont — creează primul (devine profilul principal).'
      : null,
  });
});

/* ------------------------------ 6. POST /profiles --------------------------- */

persoRouter.post('/profiles', (req, res) => {
  const identity = requireIdentity(req, res);
  if (!identity) return undefined;
  const body = req.body ?? {};
  const result = createProfile(identity.userId, { name: body.name, emoji: body.emoji, pin: body.pin });
  if (result.error) {
    return res.status(result.status ?? 400).json({ error: result.error });
  }
  bumpStat('profilesCreated');
  logger.info(`[perso] profil ${result.profile.id} creat pentru user ${identity.userId}`);
  return res.status(201).json({ ok: true, profile: result.profile, remaining: MAX_PROFILES - listProfiles(identity.userId).length });
});

/* ------------------------------ 7. PUT /profiles/:id ------------------------ */

persoRouter.put('/profiles/:id', (req, res) => {
  const identity = requireIdentity(req, res);
  if (!identity) return undefined;
  const profileId = String(req.params.id ?? '');
  if (!profileId) return res.status(400).json({ error: 'ID profil lipsă' });
  const body = req.body ?? {};
  const result = updateProfile(identity.userId, profileId, {
    name: body.name,
    emoji: body.emoji,
    pin: body.pin,
    oldPin: body.oldPin ?? body.verifyPin,
  });
  if (result.error) {
    if (result.status === 403) bumpStat('verificationFails');
    return res.status(result.status ?? 400).json({ error: result.error });
  }
  bumpStat('profilesUpdated');
  return res.json({ ok: true, profile: result.profile });
});

/* ---------------------------- 8. DELETE /profiles/:id ----------------------- */

persoRouter.delete('/profiles/:id', (req, res) => {
  const identity = requireIdentity(req, res);
  if (!identity) return undefined;
  const profileId = String(req.params.id ?? '');
  const result = deleteProfile(identity.userId, profileId);
  if (result.error) return res.status(result.status ?? 400).json({ error: result.error });
  bumpStat('profilesDeleted');
  return res.json({ ok: true, ...result });
});

/* -------------------------- 9. POST /profiles/:id/verify -------------------- */

persoRouter.post('/profiles/:id/verify', (req, res) => {
  const identity = requireIdentity(req, res);
  if (!identity) return undefined;
  const profileId = String(req.params.id ?? '');
  const body = req.body ?? {};
  const result = verifyProfile(identity.userId, profileId, body.pin);
  if (result.error) {
    bumpStat('verificationFails');
    return res.status(result.status ?? 400).json({ error: result.error });
  }
  bumpStat('profileVerifications');
  return res.json({ ok: true, ...result });
});

/* ---------------------------- 10. GET /reminders?user= ---------------------- */

persoRouter.get('/reminders', wrap(async (req, res) => {
  const identity = requireIdentity(req, res);
  if (!identity) return undefined;
  bumpStat('remindersRequests');
  const reminders = await buildReminders({ userId: identity.userId });
  res.set('Cache-Control', PRIVATE_CACHE);
  return res.json({ ok: true, identity: identity.via, ...reminders });
}));

/* ---------------------- 11. POST /reminders/:contentId/dismiss -------------- */

persoRouter.post('/reminders/:contentId/dismiss', (req, res) => {
  const identity = requireIdentity(req, res);
  if (!identity) return undefined;
  const contentId = intParam(req.params.contentId);
  if (!contentId) return res.status(400).json({ error: 'contentId (întreg pozitiv) invalid' });
  const record = dismissReminder(identity.userId, contentId);
  bumpStat('remindersDismissed');
  return res.json({
    ok: true,
    ...record,
    ttlDays: Math.round(DISMISSAL_TTL_MS / 86_400_000),
    effect: 'memento ascuns 30 de zile — apoi reapare onest dacă titlul rămâne abandonat',
  });
});

/* --------------------------- 12. GET /affinities?user= ---------------------- */

persoRouter.get('/affinities', wrap(async (req, res) => {
  const identity = requireIdentity(req, res);
  if (!identity) return undefined;
  bumpStat('affinitiesRequests');
  const { profile, cached } = await getProfileCached(identity.userId);
  res.set('Cache-Control', PRIVATE_CACHE);
  return res.json({
    ok: true,
    userId: identity.userId,
    identity: identity.via,
    cached,
    signals: profile.signals,
    topGenres: profile.topGenres,
    topTypes: profile.topTypes,
    topDecades: profile.topDecades,
    topYears: profile.topYears,
    diversity: profile.diversity,
    favoriteTitles: profile.favoriteTitles,
    method: profile.method,
    note: profile.empty
      ? 'Nicio afinitate încă — vizionează, apreciază sau notează titluri ca să se construiască profilul.'
      : null,
  });
}));

/* ------------------------- 13. GET /explain/:contentId ---------------------- */

persoRouter.get('/explain/:contentId', wrap(async (req, res) => {
  const contentId = intParam(req.params.contentId);
  if (!contentId) return res.status(400).json({ error: 'contentId (întreg pozitiv) invalid' });
  const identity = identityOf(req); // explicarea e publică — fără profil, recomandăm onest neutru
  const content = await getContentById(contentId);
  if (!content) return res.status(404).json({ error: 'Conținut inexistent' });
  bumpStat('explainRequests');

  const userId = identity?.userId ?? null;
  const profile = userId ? await computeProfile(userId) : null;
  const meta = content.metadata && typeof content.metadata === 'object' ? content.metadata : {};
  const genres = genresOf(meta);
  const year = yearOf(meta);
  const type = content.type ?? 'mined';

  const reasons = [];
  let score = 0;
  if (profile && !profile.empty) {
    const genreMap = new Map(profile.topGenres.map((g) => [g.value.toLowerCase(), g]));
    const matchedGenres = genres.filter((g) => genreMap.has(g.toLowerCase()));
    if (matchedGenres.length > 0) {
      /* Cel mai puternic gen comun (determinist: pct desc, apoi alfabetic). */
      let best = null;
      for (const g of matchedGenres) {
        const entry = genreMap.get(g.toLowerCase());
        if (!best || entry.pct > best.pct || (entry.pct === best.pct && entry.value < best.value)) best = entry;
      }
      reasons.push({
        key: 'genre',
        label: `Gen favorit: ${best.value}`,
        detail: `${best.pct}% afinitate · ${best.titles} titluri văzute cu acest gen`,
        points: Math.round(best.pct * 0.5),
      });
      score += best.pct * 0.5;
    }
    const typeHit = profile.topTypes.find((t) => t.value === type);
    if (typeHit) {
      reasons.push({
        key: 'type',
        label: `Tip preferat: ${type}`,
        detail: `${typeHit.pct}% afinitate pe tipul de conținut`,
        points: Math.round(typeHit.pct * 0.25),
      });
      score += typeHit.pct * 0.25;
    }
    if (year) {
      const decade = `${Math.floor(year / 10) * 10}s`;
      const decadeHit = profile.topDecades.find((d) => d.value === decade);
      if (decadeHit) {
        reasons.push({
          key: 'decade',
          label: `Perioadă preferată: ${decade}`,
          detail: `${decadeHit.pct}% afinitate · ${decadeHit.titles} titluri din această perioadă`,
          points: Math.round(decadeHit.pct * 0.2),
        });
        score += decadeHit.pct * 0.2;
      }
    }
    /* Similar cu un titlu preferat: overlap de genuri cu favoritele. */
    let anchor = null;
    for (const fav of profile.favoriteTitles) {
      const shared = fav.genres.filter((g) => genres.some((x) => x.toLowerCase() === g.toLowerCase()));
      if (shared.length >= 1 && fav.genres.length > 0 && shared.length / Math.max(fav.genres.length, 1) >= 0.25) {
        anchor = { fav, shared };
        break;
      }
    }
    if (anchor) {
      reasons.push({
        key: 'similar',
        label: `Pentru că ai văzut ${anchor.fav.title}`,
        detail: `genuri comune: ${anchor.shared.slice(0, 3).join(', ')}`,
        points: 25,
      });
      score += 25;
    }
  }

  const rating = Number(meta.rating);
  if (Number.isFinite(rating) && rating > 0) {
    reasons.push({
      key: 'quality',
      label: 'Calitate din catalog',
      detail: `rating ${Math.round(rating * 10) / 10}/10 în metadata reală`,
      points: Math.round(Math.min(rating, 10) * 2),
    });
    score += Math.min(rating, 10) * 2;
  }

  const finalScore = Math.max(0, Math.min(100, Math.round(score)));
  return res.json({
    ok: true,
    contentId,
    title: content.title,
    type,
    genres,
    year,
    userId,
    identity: identity?.via ?? 'anonim',
    recommended: finalScore >= 40,
    score: finalScore,
    reasons,
    profileEmpty: !profile || profile.empty,
    method: {
      engine: 'euristică deterministă',
      ml: false,
      note: 'explicație calculată onest din profilul de gust + metadata catalogului — zero ML extern',
    },
    note: !profile || profile.empty
      ? 'Profil de gust gol — scorul reflectă doar calitatea din catalog, nu personalizarea.'
      : null,
  });
}));

/* ------------------------------- 14. POST /events --------------------------- */

const EVENT_TYPES = ['view', 'like', 'complete', 'search'];

persoRouter.post('/events', eventsRateLimit, (req, res) => {
  const identity = requireIdentity(req, res);
  if (!identity) return undefined;
  const body = req.body ?? {};
  const type = String(body.type ?? '');
  if (!EVENT_TYPES.includes(type)) {
    return res.status(400).json({ error: `type trebuie unul dintre: ${EVENT_TYPES.join(', ')}` });
  }
  let contentId = null;
  if (body.contentId !== undefined && body.contentId !== null) {
    contentId = intParam(body.contentId);
    if (!contentId) return res.status(400).json({ error: 'contentId trebuie un întreg pozitiv' });
  } else if (type !== 'search') {
    return res.status(400).json({ error: `contentId e obligatoriu pentru tipul ${type}` });
  }
  let weight = 1;
  if (body.weight !== undefined && body.weight !== null) {
    const w = Number(body.weight);
    if (!Number.isFinite(w)) return res.status(400).json({ error: 'weight trebuie un număr 0.5-3 (multiplicator)' });
    weight = Math.min(3, Math.max(0.5, Math.round(w * 100) / 100)); // clamp onest
  }
  let term = null;
  if (body.term !== undefined && body.term !== null) {
    if (typeof body.term !== 'string') return res.status(400).json({ error: 'term trebuie un string (max 80 caractere)' });
    term = body.term.trim().slice(0, 80) || null;
  }

  const event = {
    type,
    ...(contentId ? { contentId } : {}),
    weight,
    ...(term ? { term } : {}),
    at: new Date().toISOString(),
  };
  pushEvent(eventsStore, identity.userId, event);
  bumpStat('eventsTracked');
  bumpEventStat(type);
  /* Actualizare incrementală onest: profilul utilizatorului se invalidează —
   * recompute la următoarea citire (on-demand, zero polling). */
  const invalidated = profileCacheApi.invalidate(identity.userId);

  return res.status(201).json({
    ok: true,
    userId: identity.userId,
    identity: identity.via,
    event,
    stored: eventsStorePerUser(eventsStore, identity.userId).length,
    profileCacheInvalidated: invalidated,
    note: 'semnal înregistrat file-based — profilul se reînvață on-demand la următorul GET /profile|/feed|/affinities',
  });
});

/* -------------------- bonus onest: verificare token sesiune ----------------- */
/* GET /verify-token?token=… — verifică un token de sesiune profil (semnătură
 * + expirare). Nu e în contractul celor 14 rute — e utilitar de debug onest,
 * aditiv, public (tokenul e deja un secret purtător — verificarea nu divulgă nimic). */

persoRouter.get('/verify-token', (req, res) => {
  const token = String(req.query?.token ?? '');
  if (!token) return res.status(400).json({ error: 'token lipsă (?token=)' });
  const result = verifyProfileToken(token);
  if (!result.ok) return res.status(401).json({ ok: false, error: result.reason });
  return res.json({
    ok: true,
    payload: {
      profileId: result.payload.sub,
      userId: result.payload.acc,
      name: result.payload.name,
      expiresAt: new Date(result.payload.exp * 1000).toISOString(),
    },
  });
});

/* Exporturi pentru teste/montaj: mount helper + piese interne documentate. */
export function mountPerso(app, path = '/api/perso') {
  app.use(path, persoRouter);
  return persoRouter;
}

export {
  computeProfile,
  buildFeed,
  buildReminders,
  listProfiles,
  verifyProfileToken,
  WEIGHTS as PERSO_WEIGHTS,
};
