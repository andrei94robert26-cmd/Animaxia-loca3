/**
 * modules/player/hub.js — FAZA 19 (Task 19-1): Player Hub API.
 *
 * The server-side backbone of the advanced player: user playlists (ordered,
 * deduped, capped), unified watch progress/resume (REUSES the Phase-2
 * watchhistory table — the very same rows served by /api/users/me/history),
 * continue-watching, WebVTT subtitle tracks (public read, admin write) and
 * public platform stats. 100% REAL data in Neon (playlists, playlistitems,
 * subtitletracks tables — see modules/platform/migrations.js).
 *
 * modules/player/player.js (the REAL external playback resolver) is NEVER
 * touched — this module only sits next to it under /api/playerhub.
 *
 * Mount: app.use('/api/playerhub', playerHubRouter) — attachUser is global,
 * so req.user is present whenever a valid Bearer token is supplied (null
 * otherwise). /status, the subtitle listing/tracks and /stats stay public;
 * user routes enforce auth per-route via requireAuthLocal.
 *
 * Routes:
 *   GET    /status                              → hub contract + live totals (public)
 *   GET    /continue-watching                   → last 12 watchhistory entries + resume (auth)
 *   GET    /playlists                           → user playlists + itemsCount + cover (auth)
 *   POST   /playlists          { title, description? } → create (max 20/user) (auth)
 *   GET    /playlists/:id                       → playlist detail + ordered items (auth, owner)
 *   PATCH  /playlists/:id      { title?, description? } → update (auth, owner)
 *   DELETE /playlists/:id                       → delete (auth, owner)
 *   POST   /playlists/:id/items { contentId }   → add item (max 200, dedupe) (auth, owner)
 *   DELETE /playlists/:id/items/:contentId      → remove item + renumber (auth, owner)
 *   POST   /playlists/:id/reorder { contentIds } → full reorder (auth, owner)
 *   GET    /progress/:contentId                 → { contentId, progress, watchedat } (auth)
 *   POST   /progress           { contentId, seconds, duration? } → upsert (auth)
 *   DELETE /progress/:contentId                 → reset resume (auth)
 *   GET    /subtitles/:contentId                → tracks [{ id, label, lang }] (public)
 *   GET    /subtitles/:contentId/:trackId       → raw VTT (public, cached 1h, CORS *)
 *   POST   /subtitles/:contentId { label, lang, vtt } → attach (admin, max 8)
 *   DELETE /subtitles/:contentId/:trackId       → detach (admin)
 *   GET    /stats                               → totals + top continue-watching (public)
 *
 * Mutations emit 'playlist:changed' { userid, playlistid? } on the platform
 * bus; admin subtitle writes are audit-logged ('playerhub.subtitle.*').
 */

import express from 'express';
import { rows, one, parseJsonb, isoOrNull, num } from '../platform/sql.js';
import { emitPlatform } from '../platform/events.js';
import { auditLog, clientIpOf } from '../security/security.js';
import { planLimits } from '../premium/plans.js';

/* --------------------------------- helpers --------------------------------- */

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Per-route auth guard (the router is mounted WITHOUT requireAuth so the
 *  public endpoints — /status, subtitle reads, /stats — stay anonymous). */
const requireAuthLocal = (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  next();
};

/** Per-route admin guard (401 anonymous / 403 authenticated non-admin). */
const requireAdminLocal = (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
};

/** Parse a positive integer route/body param; null when invalid. */
function intParam(raw) {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Normalize a raw content row (from a JOIN) into the public content shape
 *  (same contract as modules/users/profile.js contentRow). */
function contentRow(row) {
  if (!row) return null;
  return {
    id: num(row.id),
    externalid: row.externalid ?? null,
    type: row.type ?? null,
    title: row.title ?? null,
    metadata: parseJsonb(row.metadata, {}),
    thumbnail: row.thumbnail ?? null,
    createdat: isoOrNull(row.createdat),
  };
}

/** Number of playable sources on a content row (metadata.player.sources,
 *  falling back to metadata.sources — same lookup as resolvePlayer). */
function sourcesCountOf(metadata) {
  const sources = metadata?.player?.sources || metadata?.sources;
  return Array.isArray(sources) ? sources.length : 0;
}

/** Serialize a playlist row (+ optional aggregated extras). */
function playlistRow(row, extra = {}) {
  return {
    id: num(row.id),
    title: row.title ?? '',
    description: row.description ?? null,
    createdat: isoOrNull(row.createdat),
    updatedat: isoOrNull(row.updatedat),
    ...extra,
  };
}

/** Load one playlist owned by the caller; responds (400/404) and returns
 *  null when the id is invalid, missing or owned by someone else. */
async function ownPlaylistOrRespond(req, res) {
  const id = intParam(req.params.id);
  if (!id) {
    res.status(400).json({ error: 'Invalid playlist id' });
    return null;
  }
  const playlist = await one(
    `SELECT id, userid, title, description, createdat, updatedat
     FROM playlists WHERE id = $1 AND userid = $2`,
    [id, req.user.id],
  );
  if (!playlist) {
    // 404 both for missing and foreign playlists (no ownership leak).
    res.status(404).json({ error: 'Playlist not found' });
    return null;
  }
  return playlist;
}

/** Validate an optional playlist description; returns { error } or { value }. */
function validateDescription(raw) {
  if (raw === undefined || raw === null) return { value: null };
  if (typeof raw !== 'string') return { error: 'description must be a string (max 500 characters)' };
  const trimmed = raw.trim();
  if (!trimmed) return { value: null };
  if (trimmed.length > 500) return { error: 'description must be at most 500 characters' };
  return { value: trimmed };
}

/* ---------------------------------- limits ---------------------------------- */

const MAX_PLAYLISTS_PER_USER = 20;
const MAX_ITEMS_PER_PLAYLIST = 200;
const MAX_SUBTITLE_TRACKS_PER_CONTENT = 8;
const MAX_VTT_CHARS = 256 * 1024; // 256KB
const MAX_PROGRESS_SECONDS = 24 * 60 * 60; // 24h
const CONTINUE_WATCHING_LIMIT = 12;
const LANG_RE = /^[a-zA-Z-]{2,10}$/;

/* ---------------------------------- router ---------------------------------- */

export const playerHubRouter = express.Router();

/* -------------------------------- A. status -------------------------------- */

/** GET /status — hub contract + live totals (public). */
playerHubRouter.get('/status', wrap(async (req, res) => {
  const totals = await one(
    `SELECT
       (SELECT COUNT(*) FROM playlists) AS playlists,
       (SELECT COUNT(*) FROM playlistitems) AS playlistitems,
       (SELECT COUNT(*) FROM subtitletracks) AS subtitletracks`,
  );
  let user = null;
  if (req.user) {
    const mine = await one(`SELECT COUNT(*) AS count FROM playlists WHERE userid = $1`, [req.user.id]);
    user = { id: req.user.id, playlistsCount: num(mine?.count) };
  }
  res.json({
    ok: true,
    hub: 'playerhub',
    version: '19.1',
    features: ['playlists', 'progress', 'resume', 'continue-watching', 'subtitles', 'stats'],
    authRequired: {
      'continue-watching': true,
      playlists: true,
      'progress-read': true,
      'progress-write': true,
      'subtitles-list': false,
      'subtitles-track': false,
      'subtitles-write': 'admin',
      stats: false,
    },
    user,
    totals: {
      playlists: num(totals?.playlists),
      playlistItems: num(totals?.playlistitems),
      subtitleTracks: num(totals?.subtitletracks),
    },
  });
}));

/* ------------------------- B. continue watching ---------------------------- */

/** GET /continue-watching — the caller's last 12 watched titles with resume
 *  info (auth). Sorted by watchedat DESC — the natural "pick up where you
 *  left off" shelf. */
playerHubRouter.get('/continue-watching', requireAuthLocal, wrap(async (req, res) => {
  const data = await rows(
    `SELECT c.id, c.externalid, c.type, c.title, c.metadata, c.thumbnail, c.createdat,
            h.watchedat, h.progress
     FROM watchhistory h
     JOIN content c ON c.id = h.contentid
     WHERE h.userid = $1
     ORDER BY h.watchedat DESC, h.id DESC
     LIMIT $2`,
    [req.user.id, CONTINUE_WATCHING_LIMIT],
  );
  res.json({
    data: data.map((r) => {
      const content = contentRow(r);
      const progress = num(r.progress);
      return {
        content,
        watchedat: isoOrNull(r.watchedat),
        progress,
        sourcesCount: sourcesCountOf(content?.metadata),
        hasResume: progress > 10,
      };
    }),
  });
}));

/* ------------------------------ C. playlists -------------------------------- */

/** GET /playlists — the caller's playlists with item counts + the first
 *  item's thumbnail as cover (auth), most recently updated first. */
playerHubRouter.get('/playlists', requireAuthLocal, wrap(async (req, res) => {
  const data = await rows(
    `SELECT p.id, p.title, p.description, p.createdat, p.updatedat,
            (SELECT COUNT(*) FROM playlistitems pi WHERE pi.playlistid = p.id) AS itemscount,
            (SELECT c.thumbnail
               FROM playlistitems pi
               JOIN content c ON c.id = pi.contentid
              WHERE pi.playlistid = p.id
              ORDER BY pi.position ASC, pi.addedat ASC, pi.id ASC
              LIMIT 1) AS firstitemthumbnail
     FROM playlists p
     WHERE p.userid = $1
     ORDER BY p.updatedat DESC, p.id DESC`,
    [req.user.id],
  );
  res.json({
    data: data.map((r) =>
      playlistRow(r, {
        itemsCount: num(r.itemscount),
        firstItemThumbnail: r.firstitemthumbnail ?? null,
      }),
    ),
  });
}));

/** POST /playlists — create a playlist (max 20 per user). */
playerHubRouter.post('/playlists', requireAuthLocal, wrap(async (req, res) => {
  const body = req.body || {};
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (title.length < 2 || title.length > 120) {
    return res.status(400).json({ error: 'title must be 2-120 characters (non-blank)' });
  }
  const description = validateDescription(body.description);
  if (description.error) return res.status(400).json({ error: description.error });

  const countRow = await one(`SELECT COUNT(*) AS count FROM playlists WHERE userid = $1`, [req.user.id]);
  if (num(countRow?.count) >= MAX_PLAYLISTS_PER_USER) {
    return res.status(409).json({
      error: `Playlist limit reached — max ${MAX_PLAYLISTS_PER_USER} playlists per user`,
      limit: MAX_PLAYLISTS_PER_USER,
    });
  }

  const created = await one(
    `INSERT INTO playlists (userid, title, description) VALUES ($1, $2, $3) RETURNING *`,
    [req.user.id, title, description.value],
  );
  emitPlatform('playlist:changed', { userid: req.user.id, playlistid: num(created?.id) });
  return res.status(201).json({ ok: true, playlist: playlistRow(created, { itemsCount: 0 }) });
}));

/** GET /playlists/:id — playlist detail with ordered items (owner only). */
playerHubRouter.get('/playlists/:id', requireAuthLocal, wrap(async (req, res) => {
  const playlist = await ownPlaylistOrRespond(req, res);
  if (!playlist) return undefined;

  const items = await rows(
    `SELECT c.id, c.externalid, c.type, c.title, c.metadata, c.thumbnail, c.createdat,
            pi.position, pi.addedat
     FROM playlistitems pi
     JOIN content c ON c.id = pi.contentid
     WHERE pi.playlistid = $1
     ORDER BY pi.position ASC, pi.addedat ASC, pi.id ASC`,
    [playlist.id],
  );
  return res.json({
    playlist: playlistRow(playlist),
    items: items.map((r) => ({
      content: contentRow(r),
      position: num(r.position),
      addedat: isoOrNull(r.addedat),
    })),
  });
}));

/** PATCH /playlists/:id — partial update (owner only); bumps updatedat. */
playerHubRouter.patch('/playlists/:id', requireAuthLocal, wrap(async (req, res) => {
  const playlist = await ownPlaylistOrRespond(req, res);
  if (!playlist) return undefined;

  const body = req.body || {};
  const sets = [];
  const params = [];

  if (Object.prototype.hasOwnProperty.call(body, 'title')) {
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (title.length < 2 || title.length > 120) {
      return res.status(400).json({ error: 'title must be 2-120 characters (non-blank)' });
    }
    params.push(title);
    sets.push(`title = $${params.length}`);
  }

  if (Object.prototype.hasOwnProperty.call(body, 'description')) {
    const description = validateDescription(body.description);
    if (description.error) return res.status(400).json({ error: description.error });
    params.push(description.value);
    sets.push(`description = $${params.length}`);
  }

  if (!sets.length) {
    return res.json({ ok: true, playlist: playlistRow(playlist) }); // idempotent no-op
  }

  sets.push(`updatedat = CURRENT_TIMESTAMP`);
  params.push(playlist.id);
  const updated = await one(
    `UPDATE playlists SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
    params,
  );
  emitPlatform('playlist:changed', { userid: req.user.id, playlistid: playlist.id });
  return res.json({ ok: true, playlist: playlistRow(updated) });
}));

/** DELETE /playlists/:id — delete a playlist (items cascade, owner only). */
playerHubRouter.delete('/playlists/:id', requireAuthLocal, wrap(async (req, res) => {
  const playlist = await ownPlaylistOrRespond(req, res);
  if (!playlist) return undefined;

  await one(`DELETE FROM playlists WHERE id = $1`, [playlist.id]);
  emitPlatform('playlist:changed', { userid: req.user.id, playlistid: playlist.id });
  return res.json({ ok: true, deleted: true });
}));

/** POST /playlists/:id/items — append a content item (dedupe, max 200). */
playerHubRouter.post('/playlists/:id/items', requireAuthLocal, wrap(async (req, res) => {
  const playlist = await ownPlaylistOrRespond(req, res);
  if (!playlist) return undefined;

  const contentId = intParam(req.body?.contentId);
  if (!contentId) return res.status(400).json({ error: 'Invalid content id' });

  const content = await one(`SELECT id, title FROM content WHERE id = $1`, [contentId]);
  if (!content) return res.status(404).json({ error: 'Content not found' });

  // Dedupe on (playlistid, contentid) — a duplicate is a 200 no-op.
  const existing = await one(
    `SELECT id, position, addedat FROM playlistitems WHERE playlistid = $1 AND contentid = $2`,
    [playlist.id, contentId],
  );
  if (existing) {
    return res.json({ ok: true, added: false, duplicate: true });
  }

  const countRow = await one(
    `SELECT COUNT(*) AS count FROM playlistitems WHERE playlistid = $1`,
    [playlist.id],
  );
  if (num(countRow?.count) >= MAX_ITEMS_PER_PLAYLIST) {
    return res.status(409).json({
      error: `Playlist item limit reached — max ${MAX_ITEMS_PER_PLAYLIST} items per playlist`,
      limit: MAX_ITEMS_PER_PLAYLIST,
    });
  }

  // position = max(position)+1; ON CONFLICT DO NOTHING keeps concurrent adds race-safe.
  const inserted = await one(
    `INSERT INTO playlistitems (playlistid, contentid, position)
     VALUES ($1, $2, (SELECT COALESCE(MAX(position), -1) + 1 FROM playlistitems WHERE playlistid = $1))
     ON CONFLICT (playlistid, contentid) DO NOTHING
     RETURNING id, position, addedat`,
    [playlist.id, contentId],
  );
  if (!inserted) {
    return res.json({ ok: true, added: false, duplicate: true });
  }

  await one(`UPDATE playlists SET updatedat = CURRENT_TIMESTAMP WHERE id = $1`, [playlist.id]);
  emitPlatform('playlist:changed', { userid: req.user.id, playlistid: playlist.id });
  return res.status(201).json({
    ok: true,
    added: true,
    duplicate: false,
    item: {
      contentId,
      position: num(inserted.position),
      addedat: isoOrNull(inserted.addedat),
    },
  });
}));

/** DELETE /playlists/:id/items/:contentId — remove an item and renumber the
 *  remaining positions 0..n-1 (owner only). */
playerHubRouter.delete('/playlists/:id/items/:contentId', requireAuthLocal, wrap(async (req, res) => {
  const playlist = await ownPlaylistOrRespond(req, res);
  if (!playlist) return undefined;

  const contentId = intParam(req.params.contentId);
  if (!contentId) return res.status(400).json({ error: 'Invalid content id' });

  const removed = await one(
    `DELETE FROM playlistitems WHERE playlistid = $1 AND contentid = $2 RETURNING id`,
    [playlist.id, contentId],
  );
  if (!removed) return res.status(404).json({ error: 'Item not found in this playlist' });

  // Renumber the remaining items 0..n-1 (single statement, parameterized).
  await rows(
    `WITH ordered AS (
       SELECT id, (ROW_NUMBER() OVER (ORDER BY position ASC, id ASC) - 1) AS newpos
       FROM playlistitems
       WHERE playlistid = $1
     )
     UPDATE playlistitems pi
     SET position = ordered.newpos
     FROM ordered
     WHERE pi.id = ordered.id AND pi.position <> ordered.newpos`,
    [playlist.id],
  );
  await one(`UPDATE playlists SET updatedat = CURRENT_TIMESTAMP WHERE id = $1`, [playlist.id]);
  emitPlatform('playlist:changed', { userid: req.user.id, playlistid: playlist.id });
  return res.json({ ok: true, removed: true });
}));

/** POST /playlists/:id/reorder — full reorder: the submitted contentIds must
 *  be EXACTLY the set of current items; each becomes position = array index. */
playerHubRouter.post('/playlists/:id/reorder', requireAuthLocal, wrap(async (req, res) => {
  const playlist = await ownPlaylistOrRespond(req, res);
  if (!playlist) return undefined;

  const contentIds = req.body?.contentIds;
  if (!Array.isArray(contentIds) || !contentIds.every((v) => intParam(v) !== null)) {
    return res.status(400).json({ error: 'contentIds must be an array of positive integer content ids' });
  }
  const ids = contentIds.map((v) => Number(v));

  const current = await rows(
    `SELECT contentid FROM playlistitems WHERE playlistid = $1`,
    [playlist.id],
  );
  const currentSet = new Set(current.map((r) => num(r.contentid)));
  const requestedSet = new Set(ids);

  const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
  const missing = [...currentSet].filter((id) => !requestedSet.has(id)); // in DB, not sent
  const unexpected = [...requestedSet].filter((id) => !currentSet.has(id)); // sent, not in DB
  if (duplicates.length || missing.length || unexpected.length) {
    return res.status(400).json({
      error: 'Reorder payload does not match the playlist items exactly',
      duplicateIds: duplicates,
      missingIds: missing,
      unexpectedIds: unexpected,
    });
  }

  if (ids.length > 0) {
    // position = index in the submitted array (unnest keeps the pairs aligned).
    await rows(
      `UPDATE playlistitems pi
         SET position = u.pos
       FROM unnest($2[], $3[]) AS u(cid, pos)
       WHERE pi.playlistid = $1 AND pi.contentid = u.cid`,
      [playlist.id, ids, ids.map((_, i) => i)],
    );
  }
  await one(`UPDATE playlists SET updatedat = CURRENT_TIMESTAMP WHERE id = $1`, [playlist.id]);
  emitPlatform('playlist:changed', { userid: req.user.id, playlistid: playlist.id });
  return res.json({ ok: true, reordered: true, count: ids.length });
}));

/* --------------------------- D. progress / resume --------------------------- */

/** GET /progress/:contentId — the caller's saved progress (seconds) for a
 *  title; 0 when never watched. The content must exist. */
playerHubRouter.get('/progress/:contentId', requireAuthLocal, wrap(async (req, res) => {
  const contentId = intParam(req.params.contentId);
  if (!contentId) return res.status(400).json({ error: 'Invalid content id' });

  const content = await one(`SELECT id FROM content WHERE id = $1`, [contentId]);
  if (!content) return res.status(404).json({ error: 'Content not found' });

  const entry = await one(
    `SELECT progress, watchedat FROM watchhistory WHERE userid = $1 AND contentid = $2`,
    [req.user.id, contentId],
  );
  return res.json({
    contentId,
    progress: num(entry?.progress),
    watchedat: isoOrNull(entry?.watchedat),
  });
}));

/** POST /progress — upsert playback progress into the SAME watchhistory table
 *  as /api/users/me/history (unified history). The player pings every ~10s;
 *  no extra throttle by design. `duration` is validated but intentionally
 *  NOT persisted (no new columns on Phase-2 schemas — golden rule). */
playerHubRouter.post('/progress', requireAuthLocal, wrap(async (req, res) => {
  const body = req.body || {};
  const contentId = intParam(body.contentId);
  if (!contentId) return res.status(400).json({ error: 'Invalid content id' });

  const seconds = Number(body.seconds);
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > MAX_PROGRESS_SECONDS) {
    return res.status(400).json({
      error: `seconds must be an integer between 0 and ${MAX_PROGRESS_SECONDS} (24h)`,
    });
  }
  if (body.duration !== undefined && body.duration !== null) {
    const duration = Number(body.duration);
    if (!Number.isInteger(duration) || duration <= 0) {
      return res.status(400).json({ error: 'duration must be a positive integer (seconds)' });
    }
  }

  const content = await one(`SELECT id FROM content WHERE id = $1`, [contentId]);
  if (!content) return res.status(404).json({ error: 'Content not found' });

  await one(
    `INSERT INTO watchhistory (userid, contentid, progress, watchedat)
     VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
     ON CONFLICT (userid, contentid)
     DO UPDATE SET progress = EXCLUDED.progress, watchedat = CURRENT_TIMESTAMP`,
    [req.user.id, contentId, seconds],
  );

  // Rolling-window eviction, identical to POST /api/users/me/history — keeps
  // the unified history bounded by the caller's plan (-1 = unlimited → skip).
  const limit = planLimits(req.user.plan).history;
  if (limit >= 0) {
    await rows(
      `DELETE FROM watchhistory
       WHERE userid = $1 AND id NOT IN (
         SELECT id FROM watchhistory WHERE userid = $1
         ORDER BY watchedat DESC, id DESC
         LIMIT $2
       )`,
      [req.user.id, limit],
    );
  }

  return res.json({ ok: true, saved: true, progress: seconds });
}));

/** DELETE /progress/:contentId — reset the resume point (idempotent). */
playerHubRouter.delete('/progress/:contentId', requireAuthLocal, wrap(async (req, res) => {
  const contentId = intParam(req.params.contentId);
  if (!contentId) return res.status(400).json({ error: 'Invalid content id' });

  const removed = await one(
    `DELETE FROM watchhistory WHERE userid = $1 AND contentid = $2 RETURNING id`,
    [req.user.id, contentId],
  );
  return res.json({ ok: true, deleted: Boolean(removed) });
}));

/* ------------------------------- E. subtitles ------------------------------- */

/** GET /subtitles/:contentId — public track listing (no VTT payloads). */
playerHubRouter.get('/subtitles/:contentId', wrap(async (req, res) => {
  const contentId = intParam(req.params.contentId);
  if (!contentId) return res.status(400).json({ error: 'Invalid content id' });

  const content = await one(`SELECT id FROM content WHERE id = $1`, [contentId]);
  if (!content) return res.status(404).json({ error: 'Content not found' });

  const tracks = await rows(
    `SELECT id, label, lang FROM subtitletracks WHERE contentid = $1 ORDER BY lang ASC, id ASC`,
    [contentId],
  );
  return res.json({
    data: tracks.map((t) => ({ id: num(t.id), label: t.label, lang: t.lang })),
  });
}));

/** GET /subtitles/:contentId/:trackId — serve the raw WebVTT payload
 *  (public, 1h cache, permissive CORS — ready for <track src>). */
playerHubRouter.get('/subtitles/:contentId/:trackId', wrap(async (req, res) => {
  const contentId = intParam(req.params.contentId);
  const trackId = intParam(req.params.trackId);
  if (!contentId || !trackId) return res.status(400).json({ error: 'Invalid content or track id' });

  const track = await one(
    `SELECT vtt FROM subtitletracks WHERE id = $1 AND contentid = $2`,
    [trackId, contentId],
  );
  if (!track) return res.status(404).json({ error: 'Subtitle track not found for this content' });

  res.set('Content-Type', 'text/vtt; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=3600');
  res.set('Access-Control-Allow-Origin', '*');
  return res.send(track.vtt);
}));

/** POST /subtitles/:contentId — attach a WebVTT track (admin only, max 8). */
playerHubRouter.post('/subtitles/:contentId', requireAdminLocal, wrap(async (req, res) => {
  const contentId = intParam(req.params.contentId);
  if (!contentId) return res.status(400).json({ error: 'Invalid content id' });

  const body = req.body || {};
  const label = typeof body.label === 'string' ? body.label.trim() : '';
  if (label.length < 1 || label.length > 120) {
    return res.status(400).json({ error: 'label must be 1-120 characters (non-blank)' });
  }
  const lang = typeof body.lang === 'string' ? body.lang.trim() : '';
  if (!LANG_RE.test(lang)) {
    return res.status(400).json({ error: 'lang must be 2-10 letters/hyphens (e.g. "en", "ro", "pt-BR")' });
  }
  if (typeof body.vtt !== 'string' || !body.vtt.trim().startsWith('WEBVTT')) {
    return res.status(400).json({ error: 'vtt must be a WebVTT document starting with "WEBVTT"' });
  }
  if (body.vtt.length > MAX_VTT_CHARS) {
    return res.status(400).json({
      error: `vtt too large — ${Math.round(body.vtt.length / 1024)}KB, limit is 256KB`,
    });
  }

  const content = await one(`SELECT id, title FROM content WHERE id = $1`, [contentId]);
  if (!content) return res.status(404).json({ error: 'Content not found' });

  const countRow = await one(
    `SELECT COUNT(*) AS count FROM subtitletracks WHERE contentid = $1`,
    [contentId],
  );
  if (num(countRow?.count) >= MAX_SUBTITLE_TRACKS_PER_CONTENT) {
    return res.status(409).json({
      error: `Subtitle track limit reached — max ${MAX_SUBTITLE_TRACKS_PER_CONTENT} tracks per content`,
      limit: MAX_SUBTITLE_TRACKS_PER_CONTENT,
    });
  }

  const created = await one(
    `INSERT INTO subtitletracks (contentid, label, lang, vtt) VALUES ($1, $2, $3, $4) RETURNING id, label, lang`,
    [contentId, label, lang, body.vtt],
  );
  await auditLog({
    userid: req.user.id,
    action: 'playerhub.subtitle.attach',
    ip: clientIpOf(req),
    meta: { contentid: contentId, trackid: num(created?.id), label, lang },
  });
  return res.status(201).json({
    ok: true,
    track: { id: num(created?.id), label: created?.label, lang: created?.lang },
  });
}));

/** DELETE /subtitles/:contentId/:trackId — detach a track (admin only). */
playerHubRouter.delete('/subtitles/:contentId/:trackId', requireAdminLocal, wrap(async (req, res) => {
  const contentId = intParam(req.params.contentId);
  const trackId = intParam(req.params.trackId);
  if (!contentId || !trackId) return res.status(400).json({ error: 'Invalid content or track id' });

  const removed = await one(
    `DELETE FROM subtitletracks WHERE id = $1 AND contentid = $2 RETURNING id, label, lang`,
    [trackId, contentId],
  );
  if (!removed) return res.status(404).json({ error: 'Subtitle track not found for this content' });

  await auditLog({
    userid: req.user.id,
    action: 'playerhub.subtitle.detach',
    ip: clientIpOf(req),
    meta: { contentid: contentId, trackid: trackId, label: removed.label, lang: removed.lang },
  });
  return res.json({ ok: true, deleted: true });
}));

/* --------------------------------- F. stats --------------------------------- */

/** GET /stats — public hub totals + top-5 continue-watching titles (by
 *  distinct watchers); admins additionally get activePlaylistsLast7d. */
playerHubRouter.get('/stats', wrap(async (req, res) => {
  const totals = await one(
    `SELECT
       (SELECT COUNT(*) FROM playlists) AS playlists,
       (SELECT COUNT(*) FROM playlistitems) AS playlistitems,
       (SELECT COUNT(*) FROM subtitletracks) AS subtitletracks,
       (SELECT COUNT(*) FROM watchhistory) AS watchentries`,
  );
  const top = await rows(
    `SELECT c.id, c.title, c.thumbnail, c.type
     FROM watchhistory h
     JOIN content c ON c.id = h.contentid
     GROUP BY c.id, c.title, c.thumbnail, c.type
     ORDER BY COUNT(DISTINCT h.userid) DESC, c.id ASC
     LIMIT 5`,
  );

  const payload = {
    totals: {
      playlists: num(totals?.playlists),
      playlistItems: num(totals?.playlistitems),
      subtitleTracks: num(totals?.subtitletracks),
      watchEntries: num(totals?.watchentries),
    },
    topContinueWatching: top.map((r) => ({
      id: num(r.id),
      title: r.title ?? null,
      thumbnail: r.thumbnail ?? null,
      type: r.type ?? null,
    })),
  };

  if (req.user?.role === 'admin') {
    const active = await one(
      `SELECT COUNT(DISTINCT userid) AS count
       FROM playlists
       WHERE updatedat > datetime('now','-7 days')`,
    );
    payload.admin = { activePlaylistsLast7d: num(active?.count) };
  }
  return res.json(payload);
}));

export default playerHubRouter;
