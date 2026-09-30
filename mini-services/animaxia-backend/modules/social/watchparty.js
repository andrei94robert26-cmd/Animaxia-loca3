/**
 * modules/social/watchparty.js — FAZA 10: watch parties (REST persistence).
 *
 * The animaxia-realtime service (:4010, socket.io) relays live control/chat
 * events; THIS module owns persistence and is the source of truth for party
 * metadata, membership, the host's playback state snapshot (for resume and
 * late joiners when realtime restarts) and chat history.
 *
 * Routes (mounted under /api/social, additive — no collisions with Phase 2):
 *   POST   /party {contentId, title?, isPrivate?} → { ok, party }        (requireAuth, 10/min)
 *   GET    /parties?limit=&includeEnded=          → { data: [partyCard] }(public, auth-aware amIMember)
 *   GET    /party/:id                             → { party, members, state, messages } (public)
 *   POST   /party/:id/join                        → { ok, party }        (requireAuth, 30/min)
 *   POST   /party/:id/leave                       → { ok, status }       (requireAuth)
 *   POST   /party/:id/sync {state}                → { ok, state }        (requireAuth; host only)
 *   GET    /party/:id/messages?beforeId=          → { data: [message], nextBeforeId } (member or public read)
 *   POST   /party/:id/messages {body}             → { ok, message }      (requireAuth member, 60/min)
 *   POST   /party/join-code {code}                → { ok, party }        (public)
 *
 * partyCard: { id, code, title, isprivate, status, content: {…}, host: {…},
 *              members, createdat, updatedat, amimember? }
 * state (host snapshot): { positionSec, isPaused, playbackRate, sourceIndex, updatedAt }
 *   — merged as JSONB, validated loosely (numbers/booleans only).
 *
 * Host leaving ends the party (status='ended' + activity 'party:ended').
 * Parties not updated for 24h are lazily marked ended on GET /parties.
 * Activity events: 'party:create' (host), 'party:join' (members).
 */

import express from 'express';
import { rows, one, jsonb, parseJsonb, isoOrNull, num } from '../platform/sql.js';
import { assertPostgres } from '../platform/sql.js';
import { requireAuth, attachUser } from '../users/auth.js';
import { userRateLimit } from '../security/security.js';
import { insertActivityEvent } from './activity-events.js';
import { logger } from '../../utils/logger.js';

/* --------------------------------- helpers --------------------------------- */

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const createLimiter = userRateLimit({ scope: 'user', max: 10, windowMs: 60000, key: 'social-party-create' });
const joinLimiter = userRateLimit({ scope: 'user', max: 30, windowMs: 60000, key: 'social-party-join' });
const messageLimiter = userRateLimit({ scope: 'user', max: 60, windowMs: 60000, key: 'social-party-message' });

const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; // no 0/O/1/I/L
const MESSAGE_MAX = 500;

function parseId(value) {
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) && n > 0 ? n : NaN;
}

function randomCode(len = 6) {
  let out = '';
  for (let i = 0; i < len; i += 1) {
    out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return out;
}

/** Sanitize the host state snapshot: numbers/booleans only, bounded. */
function sanitizeState(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const positionSec = num(src.positionSec, 0);
  const playbackRate = num(src.playbackRate, 1);
  const sourceIndex = num(src.sourceIndex, 0);
  return {
    positionSec: Number.isFinite(positionSec) && positionSec >= 0 ? Math.min(positionSec, 86_400) : 0,
    isPaused: typeof src.isPaused === 'boolean' ? src.isPaused : true,
    playbackRate: playbackRate > 0 && playbackRate <= 4 ? playbackRate : 1,
    sourceIndex: Number.isFinite(sourceIndex) && sourceIndex >= 0 ? Math.min(Math.floor(sourceIndex), 20) : 0,
    updatedAt: new Date().toISOString(),
  };
}

async function getPartyById(id) {
  return one(
    `SELECT wp.*, u.username AS hostname, u.avatar AS hostavatar,
            c.title AS contenttitle, c.type AS contenttype, c.thumbnail AS contentthumbnail
     FROM watchparties wp
     JOIN users u ON u.id = wp.hostid
     JOIN content c ON c.id = wp.contentid
     WHERE wp.id = $1`,
    [id],
  );
}

function shapePartyCard(row, { withCode = true } = {}) {
  const out = {
    id: num(row.id),
    code: withCode ? row.code : undefined,
    title: row.title,
    isprivate: row.isprivate === true,
    status: row.status,
    content: {
      id: num(row.contentid),
      title: row.contenttitle,
      type: row.contenttype,
      thumbnail: row.contentthumbnail,
    },
    host: { id: num(row.hostid), username: row.hostname, avatar: row.hostavatar || null },
    members: num(row.membercount ?? 0),
    createdat: isoOrNull(row.createdat),
    updatedat: isoOrNull(row.updatedat),
  };
  if (row.amimember !== undefined) out.amimember = row.amimember === true;
  return out;
}

async function membersOf(partyId) {
  const data = await rows(
    `SELECT m.role, m.joinedat, u.id, u.username, u.avatar
     FROM watchpartymembers m
     JOIN users u ON u.id = m.userid
     WHERE m.partyid = $1
     ORDER BY m.joinedat ASC
     LIMIT 50`,
    [partyId],
  );
  return data.map((m) => ({
    userid: num(m.id),
    username: m.username,
    avatar: m.avatar || null,
    role: m.role,
    joinedat: isoOrNull(m.joinedat),
  }));
}

async function isMember(partyId, userId) {
  const row = await one(
    `SELECT role FROM watchpartymembers WHERE partyid = $1 AND userid = $2`,
    [partyId, userId],
  );
  return row ? row.role : null;
}

/** Lazy housekeeping: parties untouched for 24h are marked ended. */
async function expireStaleParties() {
  try {
    await rows(
      `UPDATE watchparties SET status = 'ended', updatedat = NOW()
       WHERE status = 'active' AND updatedat < NOW() - INTERVAL '24 hours'`,
    );
  } catch (err) {
    logger.warn(`[social] stale party expiry failed: ${err.message}`);
  }
}

/* --------------------------------- router ---------------------------------- */

export const socialPartyRouter = express.Router();

/** POST /party — create a party (I become host). */
socialPartyRouter.post(
  '/party',
  requireAuth,
  createLimiter,
  wrap(async (req, res) => {
    assertPostgres();
    const me = num(req.user.id);
    const contentId = parseId(req.body?.contentId);
    if (!Number.isInteger(contentId)) return res.status(400).json({ error: 'contentId (positive integer) is required' });

    const content = await one(`SELECT id, title FROM content WHERE id = $1`, [contentId]);
    if (!content) return res.status(404).json({ error: 'Content not found' });

    const title = req.body?.title
      ? String(req.body.title).trim().slice(0, 120)
      : `${req.user.username}'s ${content.title} watch party`;
    const isprivate = req.body?.isPrivate === true;

    /* End my previous active hosted parties (one active host party at a time). */
    await rows(
      `UPDATE watchparties SET status = 'ended', updatedat = NOW()
       WHERE hostid = $1 AND status = 'active'`,
      [me],
    );

    let party = null;
    for (let attempt = 0; attempt < 5 && !party; attempt += 1) {
      party = await one(
        `INSERT INTO watchparties (code, hostid, contentid, title, isprivate, state)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)
         ON CONFLICT (code) DO NOTHING
         RETURNING *`,
        [randomCode(), me, contentId, title, isprivate, jsonb(sanitizeState(null))],
      );
    }
    if (!party) return res.status(503).json({ error: 'Could not allocate a party code — try again' });

    await rows(
      `INSERT INTO watchpartymembers (partyid, userid, role) VALUES ($1, $2, 'host')
       ON CONFLICT DO NOTHING`,
      [num(party.id), me],
    );

    await insertActivityEvent({
      actorid: me,
      type: 'party:create',
      contentid: contentId,
      metadata: { partyid: num(party.id), title, isprivate },
    });

    const full = await getPartyById(num(party.id));
    res.status(201).json({
      ok: true,
      party: shapePartyCard({ ...full, membercount: 1 }),
    });
  }),
);

/** GET /parties — public active parties (private ones excluded). */
socialPartyRouter.get(
  '/parties',
  attachUser,
  wrap(async (req, res) => {
    assertPostgres();
    await expireStaleParties();

    const me = req.user ? num(req.user.id) : null;
    const limit = Math.min(Math.max(num(req.query.limit, 20), 1), 50);
    const includeEnded = req.query.includeEnded === 'true' || req.query.includeEnded === '1';

    const params = [];
    let where = includeEnded ? `wp.status IN ('active','ended')` : `wp.status = 'active'`;
    if (!includeEnded) where += ` AND wp.isprivate = FALSE`;

    const memberExpr = me
      ? `EXISTS (SELECT 1 FROM watchpartymembers m WHERE m.partyid = wp.id AND m.userid = ${me}) AS amimember`
      : `FALSE AS amimember`;

    const data = await rows(
      `SELECT wp.*, u.username AS hostname, u.avatar AS hostavatar,
              c.title AS contenttitle, c.type AS contenttype, c.thumbnail AS contentthumbnail,
              (SELECT COUNT(*) FROM watchpartymembers m2 WHERE m2.partyid = wp.id) AS membercount,
              ${memberExpr}
       FROM watchparties wp
       JOIN users u ON u.id = wp.hostid
       JOIN content c ON c.id = wp.contentid
       WHERE ${where}
       ORDER BY wp.updatedat DESC
       LIMIT ${limit}`,
      params,
    );
    res.json({ data: data.map((row) => shapePartyCard(row)) });
  }),
);

/** GET /party/:id — party detail (metadata, members, state, recent messages). */
socialPartyRouter.get(
  '/party/:id',
  attachUser,
  wrap(async (req, res) => {
    assertPostgres();
    const id = parseId(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid party id' });

    const party = await getPartyById(id);
    if (!party) return res.status(404).json({ error: 'Watch party not found' });

    const memberCount = await one(
      `SELECT COUNT(*) AS c FROM watchpartymembers WHERE partyid = $1`,
      [id],
    );
    const messages = await rows(
      `SELECT pm.id, pm.body, pm.createdat, u.id AS userid, u.username, u.avatar
       FROM partymessages pm
       JOIN users u ON u.id = pm.userid
       WHERE pm.partyid = $1
       ORDER BY pm.id DESC
       LIMIT 50`,
      [id],
    );

    res.json({
      party: shapePartyCard({ ...party, membercount: num(memberCount?.c) }),
      members: await membersOf(id),
      state: sanitizeState(parseJsonb(party.state, {})),
      messages: messages.reverse().map((m) => ({
        id: num(m.id),
        body: m.body,
        createdat: isoOrNull(m.createdat),
        user: { id: num(m.userid), username: m.username, avatar: m.avatar || null },
      })),
    });
  }),
);

/** POST /party/:id/join — become a member. */
socialPartyRouter.post(
  '/party/:id/join',
  requireAuth,
  joinLimiter,
  wrap(async (req, res) => {
    assertPostgres();
    const me = num(req.user.id);
    const id = parseId(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid party id' });

    const party = await one(`SELECT * FROM watchparties WHERE id = $1`, [id]);
    if (!party) return res.status(404).json({ error: 'Watch party not found' });
    if (party.status !== 'active') return res.status(410).json({ error: 'This watch party has ended' });

    const alreadyMember = await isMember(id, me);
    if (!alreadyMember) {
      await rows(
        `INSERT INTO watchpartymembers (partyid, userid, role) VALUES ($1, $2, 'member')
         ON CONFLICT DO NOTHING`,
        [id, me],
      );
      await rows(`UPDATE watchparties SET updatedat = NOW() WHERE id = $1`, [id]);
      if (num(party.hostid) !== me) {
        await insertActivityEvent({
          actorid: me,
          type: 'party:join',
          contentid: num(party.contentid),
          metadata: { partyid: id, title: party.title },
        });
      }
    }

    const full = await getPartyById(id);
    const count = await one(`SELECT COUNT(*) AS c FROM watchpartymembers WHERE partyid = $1`, [id]);
    res.json({ ok: true, party: shapePartyCard({ ...full, membercount: num(count?.c), amimember: true }) });
  }),
);

/** POST /party/:id/leave — leave; host leaving ends the party. */
socialPartyRouter.post(
  '/party/:id/leave',
  requireAuth,
  wrap(async (req, res) => {
    assertPostgres();
    const me = num(req.user.id);
    const id = parseId(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid party id' });

    const party = await one(`SELECT * FROM watchparties WHERE id = $1`, [id]);
    if (!party) return res.status(404).json({ error: 'Watch party not found' });

    const role = await isMember(id, me);
    if (!role) return res.json({ ok: true, status: party.status });

    await rows(`DELETE FROM watchpartymembers WHERE partyid = $1 AND userid = $2`, [id, me]);

    if (role === 'host' || num(party.hostid) === me) {
      await rows(`UPDATE watchparties SET status = 'ended', updatedat = NOW() WHERE id = $1`, [id]);
      await insertActivityEvent({
        actorid: me,
        type: 'party:ended',
        contentid: num(party.contentid),
        metadata: { partyid: id, title: party.title },
      });
      return res.json({ ok: true, status: 'ended' });
    }

    await rows(`UPDATE watchparties SET updatedat = NOW() WHERE id = $1`, [id]);
    res.json({ ok: true, status: 'active' });
  }),
);

/** POST /party/:id/sync — host-only playback state snapshot. */
socialPartyRouter.post(
  '/party/:id/sync',
  requireAuth,
  wrap(async (req, res) => {
    assertPostgres();
    const me = num(req.user.id);
    const id = parseId(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid party id' });

    const party = await one(`SELECT * FROM watchparties WHERE id = $1`, [id]);
    if (!party) return res.status(404).json({ error: 'Watch party not found' });
    if (num(party.hostid) !== me) return res.status(403).json({ error: 'Only the host can update the sync state' });

    const state = sanitizeState(req.body?.state || req.body);
    await rows(
      `UPDATE watchparties SET state = $2::jsonb, updatedat = NOW() WHERE id = $1`,
      [id, jsonb(state)],
    );
    res.json({ ok: true, state });
  }),
);

/** GET /party/:id/messages?beforeId= — chat history (keyset, newest page first). */
socialPartyRouter.get(
  '/party/:id/messages',
  attachUser,
  wrap(async (req, res) => {
    assertPostgres();
    const id = parseId(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid party id' });
    const beforeId = parseId(req.query.beforeId || '');

    const params = [id];
    let where = `pm.partyid = $1`;
    if (Number.isInteger(beforeId)) {
      params.push(beforeId);
      where += ` AND pm.id < $2`;
    }
    params.push(50);

    const data = await rows(
      `SELECT pm.id, pm.body, pm.createdat, u.id AS userid, u.username, u.avatar
       FROM partymessages pm
       JOIN users u ON u.id = pm.userid
       WHERE ${where}
       ORDER BY pm.id DESC
       LIMIT $${params.length}`,
      params,
    );
    const page = data.reverse();
    res.json({
      data: page.map((m) => ({
        id: num(m.id),
        body: m.body,
        createdat: isoOrNull(m.createdat),
        user: { id: num(m.userid), username: m.username, avatar: m.avatar || null },
      })),
      nextBeforeId: page.length && data.length === 50 ? num(page[0].id) : null,
    });
  }),
);

/** POST /party/:id/messages — post a chat message (members only). */
socialPartyRouter.post(
  '/party/:id/messages',
  requireAuth,
  messageLimiter,
  wrap(async (req, res) => {
    assertPostgres();
    const me = num(req.user.id);
    const id = parseId(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid party id' });

    const party = await one(`SELECT * FROM watchparties WHERE id = $1`, [id]);
    if (!party) return res.status(404).json({ error: 'Watch party not found' });
    if (party.status !== 'active') return res.status(410).json({ error: 'This watch party has ended' });

    const role = await isMember(id, me);
    if (!role) return res.status(403).json({ error: 'Join the watch party before chatting' });

    const body = String(req.body?.body || '').trim();
    if (!body || body.length > MESSAGE_MAX) {
      return res.status(400).json({ error: `body must be 1-${MESSAGE_MAX} characters` });
    }

    const saved = await one(
      `INSERT INTO partymessages (partyid, userid, body) VALUES ($1, $2, $3) RETURNING id, createdat`,
      [id, me, body],
    );
    await rows(`UPDATE watchparties SET updatedat = NOW() WHERE id = $1`, [id]);
    res.status(201).json({
      ok: true,
      message: {
        id: num(saved.id),
        body,
        createdat: isoOrNull(saved.createdat),
        user: { id: me, username: req.user.username, avatar: req.user.avatar || null },
      },
    });
  }),
);

/** POST /party/join-code — look up an active party by its 6-char code. */
socialPartyRouter.post(
  '/party/join-code',
  wrap(async (req, res) => {
    assertPostgres();
    const code = String(req.body?.code || '').trim().toUpperCase();
    if (!/^[2-9A-HJKMNP-Z]{6}$/.test(code)) {
      return res.status(400).json({ error: 'Code must be 6 characters (no 0/O/1/I/L)' });
    }
    const party = await one(
      `SELECT * FROM watchparties WHERE code = $1 AND status = 'active'`,
      [code],
    );
    if (!party) return res.status(404).json({ error: 'No active watch party with that code' });

    const full = await getPartyById(num(party.id));
    const count = await one(`SELECT COUNT(*) AS c FROM watchpartymembers WHERE partyid = $1`, [num(party.id)]);
    res.json({ ok: true, party: shapePartyCard({ ...full, membercount: num(count?.c) }) });
  }),
);
