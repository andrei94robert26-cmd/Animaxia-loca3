/**
 * modules/social/reviews.js — FAZA 10: content reviews (rating 1-10) with
 * likes, aggregates and platform-wide recents.
 *
 * Distinct from Phase-2 comments (short threads): reviews are one-per-user
 * per content (upsert), carry a 1-10 rating and build the community rating
 * aggregate shown on content pages.
 *
 * Routes (mounted under /api/social, additive — no collisions with Phase 2):
 *   GET  /reviews/content/:id   → { data: [review], aggregate }     (public, auth-aware myLike)
 *   POST /reviews {contentId, rating, title?, body}
 *                               → { ok, review, created }           (requireAuth, 10/min)
 *   DELETE /reviews/:id         → { ok }                            (requireAuth; owner or admin)
 *   POST /reviews/:id/like      → { ok, likes, liked }              (requireAuth; toggle, 60/min)
 *   GET  /reviews/recent?limit= → { data: [review] }                (public)
 *
 * review shape: { id, rating, title, body, createdat, updatedat,
 *                 user: {id, username, avatar}, likes, liked,
 *                 content?: {id, title, type, thumbnail} }   (content only in /recent)
 * aggregate: { count, avg, distribution: { [1..10]: number } }
 *
 * Upsert writes an activityevents row ('review', metadata.edited on update).
 */

import express from 'express';
import { rows, one, isoOrNull, num } from '../platform/sql.js';
import { requireAuth, attachUser } from '../users/auth.js';
import { userRateLimit } from '../security/security.js';
import { insertActivityEvent } from './activity-events.js';

/* --------------------------------- helpers --------------------------------- */

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const reviewLimiter = userRateLimit({ scope: 'user', max: 10, windowMs: 60000, key: 'social-review' });
const likeLimiter = userRateLimit({ scope: 'user', max: 60, windowMs: 60000, key: 'social-review-like' });

const BODY_MIN = 10;
const BODY_MAX = 4000;
const TITLE_MAX = 120;

function parseId(value) {
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) && n > 0 ? n : NaN;
}

const REVIEW_SELECT = `
  r.id, r.rating, r.title, r.body, r.createdat, r.updatedat, r.contentid,
  u.id AS userid, u.username, u.avatar,
  (SELECT COUNT(*) FROM reviewlikes rl WHERE rl.reviewid = r.id) AS likes`;

function shapeReview(row, { withContent = false } = {}) {
  const out = {
    id: num(row.id),
    rating: num(row.rating),
    title: row.title || null,
    body: row.body,
    createdat: isoOrNull(row.createdat),
    updatedat: isoOrNull(row.updatedat),
    user: { id: num(row.userid), username: row.username, avatar: row.avatar || null },
    likes: num(row.likes),
    liked: row.liked === true,
  };
  if (withContent) {
    out.content = row.contentid
      ? { id: num(row.contentid), title: row.contenttitle, type: row.contenttype, thumbnail: row.contentthumbnail }
      : null;
  }
  return out;
}

async function reviewAggregate(contentId) {
  const agg = await one(
    `SELECT COUNT(*) AS count, COALESCE(AVG(rating), 0) AS avg FROM reviews WHERE contentid = $1`,
    [contentId],
  );
  const distRows = await rows(
    `SELECT rating, COUNT(*) AS count FROM reviews WHERE contentid = $1 GROUP BY rating`,
    [contentId],
  );
  const distribution = {};
  for (let i = 1; i <= 10; i += 1) distribution[i] = 0;
  for (const row of distRows) distribution[num(row.rating)] = num(row.count);
  return {
    count: num(agg?.count),
    avg: Math.round(num(agg?.avg) * 10) / 10,
    distribution,
  };
}

/* --------------------------------- router ---------------------------------- */

export const socialReviewsRouter = express.Router();

/** GET /reviews/content/:id — reviews for one content + aggregate (public). */
socialReviewsRouter.get(
  '/reviews/content/:id',
  attachUser,
  wrap(async (req, res) => {
    const contentId = parseId(req.params.id);
    if (!Number.isInteger(contentId)) return res.status(400).json({ error: 'Invalid content id' });

    const me = req.user ? num(req.user.id) : null;
    const params = [contentId];
    let likeExpr = 'FALSE AS liked';
    if (me) {
      params.push(me);
      likeExpr = `EXISTS (SELECT 1 FROM reviewlikes rl2 WHERE rl2.reviewid = r.id AND rl2.userid = $2) AS liked`;
    }

    const data = await rows(
      `SELECT ${REVIEW_SELECT}, ${likeExpr}
       FROM reviews r
       JOIN users u ON u.id = r.userid
       WHERE r.contentid = $1
       ORDER BY likes DESC, r.createdat DESC
       LIMIT 50`,
      params,
    );
    res.json({ data: data.map((row) => shapeReview(row)), aggregate: await reviewAggregate(contentId) });
  }),
);

/** POST /reviews — upsert my review for a content (one per user per content). */
socialReviewsRouter.post(
  '/reviews',
  requireAuth,
  reviewLimiter,
  wrap(async (req, res) => {
    const me = num(req.user.id);
    const contentId = parseId(req.body?.contentId);
    const rating = num(req.body?.rating, NaN);
    const title = req.body?.title ? String(req.body.title).trim().slice(0, TITLE_MAX) : null;
    const body = String(req.body?.body || '').trim();

    if (!Number.isInteger(contentId)) return res.status(400).json({ error: 'contentId (positive integer) is required' });
    if (!Number.isInteger(rating) || rating < 1 || rating > 10) {
      return res.status(400).json({ error: 'rating must be an integer between 1 and 10' });
    }
    if (body.length < BODY_MIN || body.length > BODY_MAX) {
      return res.status(400).json({ error: `body must be between ${BODY_MIN} and ${BODY_MAX} characters` });
    }

    const content = await one(`SELECT id, title FROM content WHERE id = $1`, [contentId]);
    if (!content) return res.status(404).json({ error: 'Content not found' });

    const existing = await one(
      `SELECT id FROM reviews WHERE userid = $1 AND contentid = $2`,
      [me, contentId],
    );

    const saved = existing
      ? await one(
          `UPDATE reviews SET rating = $3, title = $4, body = $5, updatedat = CURRENT_TIMESTAMP
           WHERE id = $1 AND userid = $2
           RETURNING id, rating, title, body, createdat, updatedat, contentid`,
          [num(existing.id), me, rating, title, body],
        )
      : await one(
          `INSERT INTO reviews (userid, contentid, rating, title, body)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, rating, title, body, createdat, updatedat, contentid`,
          [me, contentId, rating, title, body],
        );

    await insertActivityEvent({
      actorid: me,
      type: 'review',
      contentid: contentId,
      metadata: {
        reviewid: num(saved.id),
        rating,
        edited: Boolean(existing),
        preview: body.slice(0, 140),
      },
    });

    res.status(existing ? 200 : 201).json({
      ok: true,
      created: !existing,
      review: {
        id: num(saved.id),
        rating: num(saved.rating),
        title: saved.title || null,
        body: saved.body,
        createdat: isoOrNull(saved.createdat),
        updatedat: isoOrNull(saved.updatedat),
        user: { id: me, username: req.user.username, avatar: req.user.avatar || null },
        likes: 0,
        liked: false,
      },
    });
  }),
);

/** DELETE /reviews/:id — owner or admin. */
socialReviewsRouter.delete(
  '/reviews/:id',
  requireAuth,
  wrap(async (req, res) => {
    const id = parseId(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid review id' });
    const review = await one(`SELECT id, userid FROM reviews WHERE id = $1`, [id]);
    if (!review) return res.status(404).json({ error: 'Review not found' });
    if (num(review.userid) !== num(req.user.id) && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'You can only delete your own reviews' });
    }
    await rows(`DELETE FROM reviews WHERE id = $1`, [id]);
    res.json({ ok: true });
  }),
);

/** POST /reviews/:id/like — toggle my like on a review. */
socialReviewsRouter.post(
  '/reviews/:id/like',
  requireAuth,
  likeLimiter,
  wrap(async (req, res) => {
    const me = num(req.user.id);
    const id = parseId(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid review id' });

    const review = await one(`SELECT id FROM reviews WHERE id = $1`, [id]);
    if (!review) return res.status(404).json({ error: 'Review not found' });

    const existing = await one(
      `SELECT 1 AS x FROM reviewlikes WHERE userid = $1 AND reviewid = $2`,
      [me, id],
    );
    if (existing) {
      await rows(`DELETE FROM reviewlikes WHERE userid = $1 AND reviewid = $2`, [me, id]);
    } else {
      await rows(
        `INSERT INTO reviewlikes (userid, reviewid) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [me, id],
      );
    }
    const counted = await one(
      `SELECT COUNT(*) AS likes FROM reviewlikes WHERE reviewid = $1`,
      [id],
    );
    res.json({ ok: true, likes: num(counted?.likes), liked: !existing });
  }),
);

/** GET /reviews/recent — platform-wide recent reviews (Reviews tab). */
socialReviewsRouter.get(
  '/reviews/recent',
  attachUser,
  wrap(async (req, res) => {
    const limit = Math.min(Math.max(num(req.query.limit, 20), 1), 50);
    const me = req.user ? num(req.user.id) : null;

    const params = [limit];
    let likeExpr = 'FALSE AS liked';
    if (me) {
      params.unshift(me);
      likeExpr = `EXISTS (SELECT 1 FROM reviewlikes rl2 WHERE rl2.reviewid = r.id AND rl2.userid = $1) AS liked`;
    }

    const data = await rows(
      `SELECT ${REVIEW_SELECT}, ${likeExpr},
              c.title AS contenttitle, c.type AS contenttype, c.thumbnail AS contentthumbnail
       FROM reviews r
       JOIN users u ON u.id = r.userid
       JOIN content c ON c.id = r.contentid
       ORDER BY r.createdat DESC
       LIMIT $${params.length}`,
      params,
    );
    res.json({ data: data.map((row) => shapeReview(row, { withContent: true })) });
  }),
);
