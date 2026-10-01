/**
 * modules/users/playlists.js — FAZA 21: real user playlists (DB-backed).
 *
 * Mount: app.use('/api/playlists', requireAuth, playlistsRouter) — auth is
 * enforced at MOUNT level (same pattern as profile.js), so every route below
 * assumes req.user is a fresh publicUser() snapshot.
 *
 * Routes:
 *   GET    /                       → { ok, data: [{ id, title, description,
 *                                          itemCount, firstThumbnail, firstTitle,
 *                                          createdat, updatedat }] }  (updatedat DESC)
 *   POST   /  { title, description? }     → 201 { ok, playlist }
 *   GET    /:id                    → { ok, playlist, items }   (owner only, else 404)
 *   PATCH  /:id  { title?, description? } → { ok, playlist }  (bumps updatedat)
 *   DELETE /:id                    → { ok, deleted }           (items cascade)
 *   POST   /:id/items  { contentId }       → 201 { ok, added: true, item } |
 *                                            200 { ok, added: false }  (dedup)
 *   DELETE /:id/items/:contentId           → { ok, removed }  (+ renumbering)
 *   GET    /:id/play?pos=          → { ok, playlist, items, startPos }
 *
 * Ownership: every /:id route resolves the row with `userid = req.user.id` —
 * a foreign playlist is indistinguishable from a missing one (404, no
 * existence leak). All mutations write an auditlogs entry (security.js).
 */

import express from 'express';
import { rows, one, parseJsonb, isoOrNull, num } from '../platform/sql.js';
import { auditLog, clientIpOf } from '../security/security.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* -------------------------------- validation -------------------------------- */

const TITLE_MIN = 1;
const TITLE_MAX = 120;
const DESCRIPTION_MAX = 2000;

/** Validate a playlist title (required, 1-120 chars after trim). Returns the
 *  normalized title, or null when invalid. */
function normalizeTitle(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length < TITLE_MIN || trimmed.length > TITLE_MAX) return null;
  return trimmed;
}

/** Validate/normalize an optional description (string, trimmed, ≤2000 chars).
 *  Returns { value } on success or { error } when invalid. */
function normalizeDescription(raw) {
  if (raw === undefined || raw === null) return { value: '' };
  if (typeof raw !== 'string') return { error: 'description must be a string' };
  const trimmed = raw.trim().slice(0, DESCRIPTION_MAX);
  return { value: trimmed };
}

/** Parse a positive-integer route param → number, or NaN when invalid. */
function parseId(value) {
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) && n > 0 ? n : NaN;
}

/** Serialize a playlist row into the public playlist shape. */
function playlistRow(row) {
  if (!row) return null;
  return {
    id: num(row.id),
    title: row.title,
    description: row.description || '',
    itemCount: num(row.itemcount),
    firstThumbnail: row.firstthumbnail ?? null,
    firstTitle: row.firsttitle ?? null,
    createdat: isoOrNull(row.createdat),
    updatedat: isoOrNull(row.updatedat),
  };
}

/** Serialize a playlist-items JOIN row (playlistitems × content) — the rating
 *  and year come from the content metadata JSONB. */
function itemRow(row) {
  if (!row) return null;
  const metadata = parseJsonb(row.metadata, {});
  return {
    contentId: num(row.contentid),
    title: row.title ?? null,
    thumbnail: row.thumbnail ?? null,
    type: row.type ?? null,
    rating: metadata.rating ?? null,
    year: metadata.year ?? null,
    position: num(row.position),
    addedat: isoOrNull(row.addedat),
  };
}

/** Load one playlist owned by the user (null when missing/foreign). */
function ownedPlaylist(id, userid) {
  return one(`SELECT * FROM playlists WHERE id = $1 AND userid = $2`, [id, userid]);
}

/* ---------------------------------- router ---------------------------------- */

const router = express.Router();

/** GET / — the user's playlists with item counts + first-item preview. */
router.get('/', wrap(async (req, res) => {
  const data = await rows(
    `SELECT p.id, p.title, p.description, p.createdat, p.updatedat,
            (SELECT COUNT(*) FROM playlistitems pi WHERE pi.playlistid = p.id) AS itemcount,
            f.firstthumbnail, f.firsttitle
     FROM playlists p
     LEFT JOIN LATERAL (
       SELECT c.title AS firsttitle, c.thumbnail AS firstthumbnail
       FROM playlistitems pi
       JOIN content c ON c.id = pi.contentid
       WHERE pi.playlistid = p.id
       ORDER BY pi.position ASC, pi.addedat ASC, pi.id ASC
       LIMIT 1
     ) f ON TRUE
     WHERE p.userid = $1
     ORDER BY p.updatedat DESC, p.id DESC`,
    [req.user.id],
  );
  return res.json({ ok: true, data: data.map(playlistRow) });
}));

/** POST / — create a playlist. */
router.post('/', wrap(async (req, res) => {
  const title = normalizeTitle(req.body?.title);
  if (!title) {
    return res.status(400).json({ error: `title is required (${TITLE_MIN}-${TITLE_MAX} characters, trimmed)` });
  }
  const description = normalizeDescription(req.body?.description);
  if (description.error) return res.status(400).json({ error: description.error });

  const created = await one(
    `INSERT INTO playlists (userid, title, description) VALUES ($1, $2, $3) RETURNING *`,
    [req.user.id, title, description.value],
  );
  await auditLog({
    userid: req.user.id,
    action: 'playlist.create',
    ip: clientIpOf(req),
    meta: { playlistId: num(created.id), title },
  });
  return res.status(201).json({ ok: true, playlist: playlistRow(created) });
}));

/** GET /:id — playlist detail + ordered items (owner only; 404 for anyone
 *  else so a foreign playlist's existence is never leaked). */
router.get('/:id', wrap(async (req, res) => {
  const id = parseId(req.params.id);
  if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid playlist id' });

  const playlist = await ownedPlaylist(id, req.user.id);
  if (!playlist) return res.status(404).json({ error: 'Playlist not found' });

  const items = await rows(
    `SELECT pi.contentid, pi.position, pi.addedat, c.title, c.thumbnail, c.type, c.metadata
     FROM playlistitems pi
     JOIN content c ON c.id = pi.contentid
     WHERE pi.playlistid = $1
     ORDER BY pi.position ASC, pi.addedat ASC, pi.id ASC`,
    [id],
  );
  return res.json({ ok: true, playlist: playlistRow(playlist), items: items.map(itemRow) });
}));

/** PATCH /:id — rename and/or re-describe (bumps updatedat). */
router.patch('/:id', wrap(async (req, res) => {
  const id = parseId(req.params.id);
  if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid playlist id' });

  const playlist = await ownedPlaylist(id, req.user.id);
  if (!playlist) return res.status(404).json({ error: 'Playlist not found' });

  const sets = [];
  const params = [];
  const body = req.body || {};

  if (Object.prototype.hasOwnProperty.call(body, 'title')) {
    const title = normalizeTitle(body.title);
    if (!title) {
      return res.status(400).json({ error: `title must be ${TITLE_MIN}-${TITLE_MAX} characters (trimmed)` });
    }
    params.push(title);
    sets.push(`title = $${params.length}`);
  }

  if (Object.prototype.hasOwnProperty.call(body, 'description')) {
    const description = normalizeDescription(body.description);
    if (description.error) return res.status(400).json({ error: description.error });
    params.push(description.value);
    sets.push(`description = $${params.length}`);
  }

  if (!sets.length) {
    return res.status(400).json({ error: 'Nothing to update — provide title and/or description' });
  }

  params.push(id, req.user.id);
  const updated = await one(
    `UPDATE playlists SET ${sets.join(', ')}, updatedat = CURRENT_TIMESTAMP
     WHERE id = $${params.length - 1} AND userid = $${params.length}
     RETURNING *`,
    params,
  );
  await auditLog({
    userid: req.user.id,
    action: 'playlist.update',
    ip: clientIpOf(req),
    meta: { playlistId: id, fields: sets.map((s) => s.split(' =')[0]) },
  });
  return res.json({ ok: true, playlist: playlistRow(updated) });
}));

/** DELETE /:id — remove the playlist (items cascade via FK). */
router.delete('/:id', wrap(async (req, res) => {
  const id = parseId(req.params.id);
  if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid playlist id' });

  const deleted = await one(
    `DELETE FROM playlists WHERE id = $1 AND userid = $2 RETURNING id`,
    [id, req.user.id],
  );
  if (!deleted) return res.status(404).json({ error: 'Playlist not found' });

  await auditLog({
    userid: req.user.id,
    action: 'playlist.delete',
    ip: clientIpOf(req),
    meta: { playlistId: id },
  });
  return res.json({ ok: true, deleted: num(deleted.id) });
}));

/** POST /:id/items — append a content row at the end of the playlist.
 *  Idempotent: an already-present contentId returns 200 { added: false }. */
router.post('/:id/items', wrap(async (req, res) => {
  const id = parseId(req.params.id);
  if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid playlist id' });

  const contentId = Number(req.body?.contentId);
  if (!Number.isInteger(contentId) || contentId <= 0) {
    return res.status(400).json({ error: 'Invalid content id' });
  }

  const playlist = await ownedPlaylist(id, req.user.id);
  if (!playlist) return res.status(404).json({ error: 'Playlist not found' });

  const content = await one(`SELECT id, title FROM content WHERE id = $1`, [contentId]);
  if (!content) return res.status(404).json({ error: 'Content not found' });

  // position = MAX(position)+1 (1-based); ON CONFLICT keeps concurrent adds race-safe.
  const inserted = await one(
    `INSERT INTO playlistitems (playlistid, contentid, position)
     SELECT $1, $2, COALESCE(MAX(position), 0) + 1 FROM playlistitems WHERE playlistid = $1
     ON CONFLICT (playlistid, contentid) DO NOTHING
     RETURNING id, position`,
    [id, contentId],
  );
  if (!inserted) {
    return res.json({ ok: true, added: false });
  }
  await rows(`UPDATE playlists SET updatedat = CURRENT_TIMESTAMP WHERE id = $1`, [id]);
  await auditLog({
    userid: req.user.id,
    action: 'playlist.item.add',
    ip: clientIpOf(req),
    meta: { playlistId: id, contentId, title: content.title },
  });
  return res.status(201).json({
    ok: true,
    added: true,
    item: { contentId, position: num(inserted.position), title: content.title },
  });
}));

/** DELETE /:id/items/:contentId — remove an item and renumber the positions
 *  that followed it (positions stay a dense 1..N sequence). */
router.delete('/:id/items/:contentId', wrap(async (req, res) => {
  const id = parseId(req.params.id);
  if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid playlist id' });
  const contentId = parseId(req.params.contentId);
  if (Number.isNaN(contentId)) return res.status(400).json({ error: 'Invalid content id' });

  const playlist = await ownedPlaylist(id, req.user.id);
  if (!playlist) return res.status(404).json({ error: 'Playlist not found' });

  const removed = await one(
    `DELETE FROM playlistitems WHERE playlistid = $1 AND contentid = $2 RETURNING position`,
    [id, contentId],
  );
  if (!removed) return res.json({ ok: true, removed: false });

  // Renumber: everything after the removed slot slides down by one.
  await rows(
    `UPDATE playlistitems SET position = position - 1 WHERE playlistid = $1 AND position > $2`,
    [id, num(removed.position)],
  );
  await rows(`UPDATE playlists SET updatedat = CURRENT_TIMESTAMP WHERE id = $1`, [id]);
  await auditLog({
    userid: req.user.id,
    action: 'playlist.item.remove',
    ip: clientIpOf(req),
    meta: { playlistId: id, contentId },
  });
  return res.json({ ok: true, removed: true });
}));

/** GET /:id/play — sequential playback order: the full item list plus the
 *  position to start from (?pos=, default 0, clamped to the list). */
router.get('/:id/play', wrap(async (req, res) => {
  const id = parseId(req.params.id);
  if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid playlist id' });

  const playlist = await ownedPlaylist(id, req.user.id);
  if (!playlist) return res.status(404).json({ error: 'Playlist not found' });

  const items = await rows(
    `SELECT pi.contentid, pi.position, pi.addedat, c.title, c.thumbnail, c.type, c.metadata
     FROM playlistitems pi
     JOIN content c ON c.id = pi.contentid
     WHERE pi.playlistid = $1
     ORDER BY pi.position ASC, pi.addedat ASC, pi.id ASC`,
    [id],
  );
  const mapped = items.map(itemRow);
  let startPos = Number.parseInt(req.query.pos, 10);
  if (!Number.isInteger(startPos) || startPos < 0) startPos = 0;
  if (mapped.length > 0) startPos = Math.min(startPos, mapped.length - 1); // clamp into the list
  return res.json({ ok: true, playlist: playlistRow(playlist), items: mapped, startPos });
}));

export default router;
