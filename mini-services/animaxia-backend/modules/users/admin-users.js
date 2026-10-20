/**
 * modules/users/admin-users.js — TS2b: admin user management + moderation queue.
 *
 *   • GET  /api/admin/users              — list users (id, username, email,
 *     isadmin, emailverified, twofaenabled, banned, createdat, lastloginat)
 *   • PATCH /api/admin/users/:id         — { banned?, isadmin? } with guards:
 *     cannot demote yourself, cannot demote the last admin, cannot ban yourself
 *     or another admin (privilege-escalation safety), cannot unban/promote
 *     nonexistent accounts.
 *   • GET  /api/admin/moderation         — latest 30 comments + 30 reviews +
 *     30 watch parties (JOIN users + content) for the moderation queue.
 *
 * Mount (server.js), both behind requireAuth + requireAdmin:
 *   app.use('/api/admin/users', adminUsersRouter);
 *   app.use('/api/admin/moderation', adminModerationRouter);
 *
 * The `banned` users column is ensured idempotently here (ADD COLUMN IF NOT
 * EXISTS) — modules/users/auth.js login rejects banned accounts with 403
 * 'Cont suspendat'.
 */

import express from 'express';
import { one, rows, num, isoOrNull } from '../platform/sql.js';
import { auditLog, clientIpOf } from '../security/security.js';
import { logger } from '../../utils/logger.js';

/* ----------------------------- schema ensure ----------------------------- */

/** Idempotent: the users.banned flag (default false). Runs on module import. */
export async function ensureAdminUsersSchema() {
  const columns = await rows('PRAGMA table_info(users)');
  if (!columns.some((column) => String(column.name).toLowerCase() === 'banned')) {
    await rows('ALTER TABLE users ADD COLUMN banned INTEGER NOT NULL DEFAULT 0');
  }
  await rows('CREATE INDEX IF NOT EXISTS idx_users_banned ON users(banned)');
  logger.info('[admin-users] schema verified — users.banned ensured (idempotent)');
}

/* -------------------------------- helpers -------------------------------- */

function publicAdminUser(row) {
  return {
    id: num(row.id),
    username: row.username,
    email: row.email,
    isadmin: row.role === 'admin',
    role: row.role || 'user',
    emailverified: row.emailverified === true || row.emailverified === 1,
    twofaenabled: row.twofaenabled === true || row.twofaenabled === 1,
    banned: row.banned === true || row.banned === 1,
    createdat: isoOrNull(row.createdat),
    lastloginat: isoOrNull(row.lastloginat),
  };
}

/* --------------------------------- router --------------------------------- */

export const adminUsersRouter = express.Router();

/** GET / — list all users (newest first). */
adminUsersRouter.get('/', async (req, res, next) => {
  try {
    const list = await rows(
      `SELECT id, username, email, role, emailverified, twofaenabled, banned, createdat, lastloginat
       FROM users ORDER BY createdat DESC, id DESC`,
    );
    return res.json({ ok: true, data: list.map(publicAdminUser) });
  } catch (err) {
    return next(err);
  }
});

/** PATCH /:id — body { banned?: boolean, isadmin?: boolean }. */
adminUsersRouter.patch('/:id', async (req, res, next) => {
  try {
    const targetId = num(req.params.id);
    if (!Number.isInteger(targetId) || targetId <= 0) {
      return res.status(400).json({ error: 'ID utilizator invalid' });
    }
    const { banned, isadmin } = req.body || {};
    const wantsBan = typeof banned === 'boolean';
    const wantsRole = typeof isadmin === 'boolean';
    if (!wantsBan && !wantsRole) {
      return res.status(400).json({ error: 'Nimic de actualizat — trimite { banned } sau { isadmin }' });
    }

    const target = await one(
      `SELECT id, username, email, role FROM users WHERE id = $1`,
      [targetId],
    );
    if (!target) {
      return res.status(404).json({ error: 'Utilizatorul nu există' });
    }

    /* Guard 1: you cannot demote yourself (the classic lockout mistake). */
    if (wantsRole && !isadmin && num(target.id) === num(req.user.id)) {
      return res.status(400).json({ error: 'Nu îți poți retrage singur statutul de administrator' });
    }
    /* Guard 2: you cannot ban yourself. */
    if (wantsBan && banned && num(target.id) === num(req.user.id)) {
      return res.status(400).json({ error: 'Nu îți poți suspenda propriul cont' });
    }
    /* Guard 3: last-admin protection — demoting the only admin is refused. */
    if (wantsRole && !isadmin && target.role === 'admin') {
      const count = await one(`SELECT COUNT(*) AS count FROM users WHERE role = 'admin'`);
      if (num(count?.count) <= 1) {
        return res.status(400).json({ error: 'Este singurul administrator — promovează altcineva înainte de retrogradare' });
      }
    }
    /* Guard 4: banning another admin would be a silent privilege escalation
       vector (unban later by a different admin) — require demotion first. */
    if (wantsBan && banned && target.role === 'admin') {
      return res.status(400).json({ error: 'Retrogradează mai întâi administratorul înainte de suspendare' });
    }

    if (wantsBan) {
      await rows(`UPDATE users SET banned = $1 WHERE id = $2`, [banned, targetId]);
    }
    if (wantsRole) {
      await rows(`UPDATE users SET role = $1 WHERE id = $2`, [isadmin ? 'admin' : 'user', targetId]);
      /* Role changes revoke every live refresh token — the session must be
         re-authenticated under the new privileges. */
      await rows(`UPDATE refreshtokens SET revoked = TRUE WHERE userid = $1`, [targetId]);
    }

    const fresh = await one(
      `SELECT id, username, email, role, emailverified, twofaenabled, banned, createdat, lastloginat
       FROM users WHERE id = $1`,
      [targetId],
    );
    await auditLog({
      userid: num(req.user.id),
      action: 'admin.users.patch',
      ip: clientIpOf(req),
      meta: { target: targetId, banned: wantsBan ? banned : undefined, isadmin: wantsRole ? isadmin : undefined },
    });
    logger.info(
      `[admin-users] patched user ${targetId} by ${req.user.id}` +
        (wantsBan ? ` — banned=${banned}` : '') +
        (wantsRole ? ` — isadmin=${isadmin}` : ''),
    );
    return res.json({ ok: true, user: publicAdminUser(fresh) });
  } catch (err) {
    return next(err);
  }
});

/* ----------------------------- moderation queue ---------------------------- */

export const adminModerationRouter = express.Router();

/**
 * GET / — the latest 30 comments, 30 reviews and 30 watch parties with author
 * + content title joined in. Read-only: deletions reuse the existing
 * owner/admin routes (/api/social/comments/:id, /api/social/reviews/:id).
 */
adminModerationRouter.get('/', async (req, res, next) => {
  try {
    const comments = await rows(
      `SELECT c.id, c.body, c.createdat, c.parentid,
              u.username AS author, u.id AS authorid,
              ct.id AS contentid, ct.title AS contenttitle, ct.type AS contenttype
       FROM comments c
       JOIN users u ON u.id = c.userid
       LEFT JOIN content ct ON ct.id = c.contentid
       ORDER BY c.createdat DESC
       LIMIT 30`,
    );
    const reviews = await rows(
      `SELECT r.id, r.rating, r.title, r.body, r.createdat,
              u.username AS author, u.id AS authorid,
              ct.id AS contentid, ct.title AS contenttitle, ct.type AS contenttype
       FROM reviews r
       JOIN users u ON u.id = r.userid
       LEFT JOIN content ct ON ct.id = r.contentid
       ORDER BY r.createdat DESC
       LIMIT 30`,
    );
    const parties = await rows(
      `SELECT p.id, p.code, p.title, p.status, p.createdat, p.updatedat,
              u.username AS author, u.id AS authorid,
              ct.id AS contentid, ct.title AS contenttitle, ct.type AS contenttype
       FROM watchparties p
       JOIN users u ON u.id = p.hostid
       LEFT JOIN content ct ON ct.id = p.contentid
       ORDER BY p.updatedat DESC
       LIMIT 30`,
    );
    return res.json({
      ok: true,
      comments: comments.map((c) => ({
        id: num(c.id),
        body: c.body,
        createdat: isoOrNull(c.createdat),
        author: c.author,
        authorid: num(c.authorid),
        contentid: c.contentid == null ? null : num(c.contentid),
        contenttitle: c.contenttitle,
        contenttype: c.contenttype,
      })),
      reviews: reviews.map((r) => ({
        id: num(r.id),
        rating: num(r.rating),
        title: r.title,
        body: r.body,
        createdat: isoOrNull(r.createdat),
        author: r.author,
        authorid: num(r.authorid),
        contentid: r.contentid == null ? null : num(r.contentid),
        contenttitle: r.contenttitle,
        contenttype: r.contenttype,
      })),
      parties: parties.map((p) => ({
        id: num(p.id),
        code: p.code,
        title: p.title,
        status: p.status,
        createdat: isoOrNull(p.createdat),
        updatedat: isoOrNull(p.updatedat),
        author: p.author,
        authorid: num(p.authorid),
        contentid: p.contentid == null ? null : num(p.contentid),
        contenttitle: p.contenttitle,
        contenttype: p.contenttype,
      })),
    });
  } catch (err) {
    return next(err);
  }
});

export default adminUsersRouter;
