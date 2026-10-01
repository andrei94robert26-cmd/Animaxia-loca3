/**
 * modules/social/follows.js — FAZA 10: social graph (follows) + people
 * discovery + public profiles.
 *
 * Routes (mounted under /api/social, additive — no collisions with Phase 2):
 *   GET  /people?q=&limit=        → { data: [userCard] }             (requireAuth)
 *   POST /follow   {userId}       → { ok, following: true }          (requireAuth, 30/min)
 *   POST /unfollow {userId}       → { ok, following: false }         (requireAuth, 30/min)
 *   GET  /following               → { data: [userCard] }             (requireAuth)
 *   GET  /followers               → { data: [userCard] }             (requireAuth)
 *   GET  /user/:id/profile        → { user, stats, recentReviews, recentActivity, relation } (public, auth-aware)
 *
 * userCard shape (no email — public field whitelist):
 *   { id, username, avatar, plan, followers, following, reviews, isfollowing }
 *
 * Follow/unfollow are idempotent; self-follow is 400. A successful follow
 * writes an activityevents row ('follow') via insertActivityEvent.
 */

import express from 'express';
import { rows, one, parseJsonb, isoOrNull, num } from '../platform/sql.js';
import { assertPostgres } from '../platform/sql.js';
import { requireAuth, attachUser, getUserById } from '../users/auth.js';
import { userRateLimit } from '../security/security.js';
import { insertActivityEvent } from './activity-events.js';

/* --------------------------------- helpers --------------------------------- */

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const followLimiter = userRateLimit({ scope: 'user', max: 30, windowMs: 60000, key: 'social-follow' });

function parseId(value) {
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) && n > 0 ? n : NaN;
}

const USER_CARD_SQL = `
  u.id, u.username, u.avatar, u.plan,
  (SELECT COUNT(*) FROM follows fa WHERE fa.followeeid = u.id) AS followers,
  (SELECT COUNT(*) FROM follows fb WHERE fb.followerid = u.id) AS following,
  (SELECT COUNT(*) FROM reviews r WHERE r.userid = u.id) AS reviews`;

function shapeCard(row) {
  return {
    id: num(row.id),
    username: row.username,
    avatar: row.avatar || null,
    plan: row.plan || 'free',
    followers: num(row.followers),
    following: num(row.following),
    reviews: num(row.reviews),
    isfollowing: row.isfollowing === true || row.isfollowing === 't' || row.isfollowing === true,
  };
}

/* --------------------------------- router ---------------------------------- */

export const socialFollowsRouter = express.Router();

/** GET /people — discovery: users I don't follow yet, ranked by social signal. */
socialFollowsRouter.get(
  '/people',
  requireAuth,
  wrap(async (req, res) => {
    assertPostgres();
    const me = num(req.user.id);
    const limit = Math.min(Math.max(num(req.query.limit, 12), 1), 30);
    const q = String(req.query.q || '').trim().slice(0, 60);

    const params = [me];
    let filter = `u.id <> $1 AND NOT EXISTS (SELECT 1 FROM follows f WHERE f.followerid = $1 AND f.followeeid = u.id)`;
    if (q) {
      params.push(`%${q}%`);
      filter += ` AND lower(u.username) LIKE lower($2)`;
    }
    params.push(limit);

    const data = await rows(
      `SELECT ${USER_CARD_SQL},
              EXISTS (SELECT 1 FROM follows f2 WHERE f2.followerid = $1 AND f2.followeeid = u.id) AS isfollowing
       FROM users u
       WHERE ${filter}
       ORDER BY followers DESC, reviews DESC, u.id ASC
       LIMIT $${params.length}`,
      params,
    );
    res.json({ data: data.map(shapeCard) });
  }),
);

/** POST /follow {userId} — idempotent follow. */
socialFollowsRouter.post(
  '/follow',
  requireAuth,
  followLimiter,
  wrap(async (req, res) => {
    assertPostgres();
    const me = num(req.user.id);
    const target = parseId(req.body?.userId);
    if (!Number.isInteger(target)) return res.status(400).json({ error: 'userId (positive integer) is required' });
    if (target === me) return res.status(400).json({ error: 'You cannot follow yourself' });

    const targetUser = await getUserById(target);
    if (!targetUser) return res.status(404).json({ error: 'User not found' });

    const existing = await one(
      `SELECT id FROM follows WHERE followerid = $1 AND followeeid = $2`,
      [me, target],
    );
    if (!existing) {
      await rows(
        `INSERT INTO follows (followerid, followeeid) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [me, target],
      );
      await insertActivityEvent({
        actorid: me,
        type: 'follow',
        targetuserid: target,
        metadata: { username: targetUser.username },
      });
    }
    res.json({ ok: true, following: true });
  }),
);

/** POST /unfollow {userId} — idempotent unfollow. */
socialFollowsRouter.post(
  '/unfollow',
  requireAuth,
  followLimiter,
  wrap(async (req, res) => {
    assertPostgres();
    const me = num(req.user.id);
    const target = parseId(req.body?.userId);
    if (!Number.isInteger(target)) return res.status(400).json({ error: 'userId (positive integer) is required' });
    await rows(`DELETE FROM follows WHERE followerid = $1 AND followeeid = $2`, [me, target]);
    res.json({ ok: true, following: false });
  }),
);

/** GET /following — users I follow. */
socialFollowsRouter.get(
  '/following',
  requireAuth,
  wrap(async (req, res) => {
    assertPostgres();
    const me = num(req.user.id);
    const data = await rows(
      `SELECT ${USER_CARD_SQL},
              TRUE AS isfollowing
       FROM users u
       WHERE EXISTS (SELECT 1 FROM follows f WHERE f.followerid = $1 AND f.followeeid = u.id)
       ORDER BY u.username ASC
       LIMIT 100`,
      [me],
    );
    res.json({ data: data.map(shapeCard) });
  }),
);

/** GET /followers — my followers. */
socialFollowsRouter.get(
  '/followers',
  requireAuth,
  wrap(async (req, res) => {
    assertPostgres();
    const me = num(req.user.id);
    const data = await rows(
      `SELECT ${USER_CARD_SQL},
              EXISTS (SELECT 1 FROM follows f3 WHERE f3.followerid = $1 AND f3.followeeid = u.id) AS isfollowing
       FROM users u
       WHERE EXISTS (SELECT 1 FROM follows f WHERE f.followeeid = $1 AND f.followerid = u.id)
       ORDER BY u.username ASC
       LIMIT 100`,
      [me],
    );
    res.json({ data: data.map(shapeCard) });
  }),
);

/**
 * GET /user/:id/profile — public profile (no email): counts, recent reviews,
 * recent activity, relation (isfollowing / followsme) when authenticated,
 * plus taste overlap (shared genres from watch history) when authenticated.
 */
socialFollowsRouter.get(
  '/user/:id/profile',
  attachUser,
  wrap(async (req, res) => {
    assertPostgres();
    const id = parseId(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid user id' });

    const user = await getUserById(id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const me = req.user ? num(req.user.id) : null;
    const [statsRow, recentReviews, recentActivity, relationRow] = await Promise.all([
      one(
        `SELECT
           (SELECT COUNT(*) FROM follows fa WHERE fa.followeeid = $1) AS followers,
           (SELECT COUNT(*) FROM follows fb WHERE fb.followerid = $1) AS following,
           (SELECT COUNT(*) FROM reviews r WHERE r.userid = $1) AS reviews,
           (SELECT COUNT(*) FROM comments cm WHERE cm.userid = $1) AS comments,
           (SELECT COUNT(*) FROM watchparties wp WHERE wp.hostid = $1) AS partieshosted`,
        [id],
      ),
      rows(
        `SELECT r.id, r.rating, r.title, r.body, r.createdat, c.id AS contentid, c.title AS contenttitle, c.type AS contenttype, c.thumbnail AS contentthumbnail
         FROM reviews r JOIN content c ON c.id = r.contentid
         WHERE r.userid = $1
         ORDER BY r.createdat DESC
         LIMIT 5`,
        [id],
      ),
      rows(
        `SELECT ae.id, ae.type, ae.createdat, ae.contentid, ae.metadata,
               c.title AS contenttitle, c.type AS contenttype
         FROM activityevents ae
         LEFT JOIN content c ON c.id = ae.contentid
         WHERE ae.actorid = $1
         ORDER BY ae.createdat DESC, ae.id DESC
         LIMIT 10`,
        [id],
      ),
      me
        ? one(
            `SELECT
               EXISTS (SELECT 1 FROM follows f WHERE f.followerid = $1 AND f.followeeid = $2) AS isfollowing,
               EXISTS (SELECT 1 FROM follows f WHERE f.followerid = $2 AND f.followeeid = $1) AS followsme`,
            [me, id],
          )
        : Promise.resolve(null),
    ]);

    /* Taste overlap: top genres from each side's watch history metadata. */
    let taste = null;
    if (me && me !== id) {
      const [mine, theirs] = await Promise.all([
        rows(
          `SELECT c.metadata FROM watchhistory wh JOIN content c ON c.id = wh.contentid WHERE wh.userid = $1 LIMIT 200`,
          [me],
        ),
        rows(
          `SELECT c.metadata FROM watchhistory wh JOIN content c ON c.id = wh.contentid WHERE wh.userid = $1 LIMIT 200`,
          [id],
        ),
      ]);
      const genreCount = (list) => {
        const counts = new Map();
        for (const row of list) {
          const meta = parseJsonb(row.metadata, {});
          const genres = Array.isArray(meta.genres) ? meta.genres : [];
          for (const g of genres) {
            const key = String(g).toLowerCase();
            counts.set(key, (counts.get(key) || 0) + 1);
          }
        }
        return counts;
      };
      const myGenres = genreCount(mine);
      const theirGenres = genreCount(theirs);
      const overlap = [...theirGenres.keys()].filter((g) => myGenres.has(g));
      const top = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([g]) => g);
      const union = new Set([...myGenres.keys(), ...theirGenres.keys()]);
      taste = {
        sharedGenres: overlap,
        myTopGenres: top(myGenres),
        theirTopGenres: top(theirGenres),
        score: union.size ? Math.round((overlap.length / union.size) * 100) : 0,
      };
    }

    res.json({
      user: {
        id: num(user.id),
        username: user.username,
        avatar: user.avatar || null,
        plan: user.plan || 'free',
        createdat: isoOrNull(user.createdat),
      },
      stats: {
        followers: num(statsRow?.followers),
        following: num(statsRow?.following),
        reviews: num(statsRow?.reviews),
        comments: num(statsRow?.comments),
        partiesHosted: num(statsRow?.partieshosted),
      },
      recentReviews: recentReviews.map((r) => ({
        id: num(r.id),
        rating: num(r.rating),
        title: r.title || null,
        body: String(r.body || '').slice(0, 280),
        createdat: isoOrNull(r.createdat),
        content: { id: num(r.contentid), title: r.contenttitle, type: r.contenttype, thumbnail: r.contentthumbnail },
      })),
      recentActivity: recentActivity.map((a) => ({
        id: num(a.id),
        type: a.type,
        createdat: isoOrNull(a.createdat),
        content: a.contentid
          ? { id: num(a.contentid), title: a.contenttitle, type: a.contenttype }
          : null,
        metadata: parseJsonb(a.metadata, {}),
      })),
      relation: relationRow
        ? { isfollowing: relationRow.isfollowing === true, followsme: relationRow.followsme === true }
        : null,
      taste,
    });
  }),
);
