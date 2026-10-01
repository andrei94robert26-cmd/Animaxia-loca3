/**
 * modules/social/comments.js — Social core: 2-level threaded comments,
 * comment votes (likes/dislikes) and content likes.
 *
 * Routes (mounted FIRST under /api/social, before feedRouter):
 *   GET    /content/:id/comments   → { data: [threads] }               (public; Bearer token adds myVote)
 *   POST   /content/:id/comments   → { ok, comment }                   (requireAuth + 20/min per-user limit)
 *   DELETE /comments/:id           → { ok }                            (requireAuth; owner or admin)
 *   POST   /comments/:id/vote      → { ok, likes, dislikes, myVote }   (requireAuth; value 1|-1|0)
 *   POST   /content/:id/like       → { ok, likes, dislikes, myVote }   (requireAuth; value 1|-1|0)
 *   GET    /content/:id/likes      → { likes, dislikes, myVote }       (public)
 *
 * Thread shape (frozen contract):
 *   { id, body, createdat, user: { id, username, avatar },
 *     likes, dislikes, myVote, replies: [ <same shape without replies> ] }
 * - likes  = COUNT(commentvotes.value = 1)
 * - dislikes = COUNT(commentvotes.value = -1)
 * - myVote = 1|-1|0 when authenticated (0 = no vote), null when anonymous
 * - Threads are strictly 2-level: replying to a reply re-roots the new
 *   comment on the reply's top-level parent.
 *
 * Events: emitPlatform('comment:added', { contentid, userid }) after inserts.
 * No HTTP cacheMiddleware — responses are user-dependent (myVote).
 */

import express from 'express';
import { rows, one, isoOrNull, num } from '../platform/sql.js';
import { requireAuth } from '../users/auth.js';
import { userRateLimit, auditLog, clientIpOf } from '../security/security.js';
import { emitPlatform } from '../platform/events.js';
import { getContentById } from '../../db.js';

/* --------------------------------- helpers --------------------------------- */

/** Wrap an async handler so rejections reach the Express error middleware. */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Per-user comment creation limit: 20 per minute. */
const commentLimiter = userRateLimit({ scope: 'user', max: 20, windowMs: 60000, key: 'comments' });

const MAX_BODY_LEN = 2000;
const TOP_LEVEL_LIMIT = 50;

/** Parse a positive-integer route param → number, or NaN when invalid. */
function parseId(value) {
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) && n > 0 ? n : NaN;
}

/** Normalize a vote/like payload value: accepts 1|-1|0 (number or numeric string). */
function parseVoteValue(raw) {
  if (raw === null || raw === undefined || raw === '') return NaN;
  const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw), 10);
  return n === 1 || n === -1 || n === 0 ? n : NaN;
}

/**
 * Vote tallies for one comment + the caller's own vote.
 * @returns {Promise<{ likes: number, dislikes: number, myVote: number }>}
 */
async function commentVoteStats(commentId, userId) {
  const agg = await one(
    `SELECT COUNT(*) FILTER (WHERE value = 1)::int AS likes,
            COUNT(*) FILTER (WHERE value = -1)::int AS dislikes
     FROM commentvotes WHERE commentid = $1`,
    [commentId],
  );
  let myVote = 0;
  if (userId) {
    const mine = await one(
      `SELECT value FROM commentvotes WHERE commentid = $1 AND userid = $2`,
      [commentId, userId],
    );
    myVote = mine ? num(mine.value) : 0;
  }
  return { likes: num(agg?.likes), dislikes: num(agg?.dislikes), myVote };
}

/**
 * Like tallies for one content row + the caller's own like state.
 * @returns {Promise<{ likes: number, dislikes: number, myVote: number | null }>}
 */
async function contentLikeStats(contentId, userId) {
  const agg = await one(
    `SELECT COUNT(*) FILTER (WHERE value = 1)::int AS likes,
            COUNT(*) FILTER (WHERE value = -1)::int AS dislikes
     FROM contentlikes WHERE contentid = $1`,
    [contentId],
  );
  let myVote = null;
  if (userId) {
    const mine = await one(
      `SELECT value FROM contentlikes WHERE contentid = $1 AND userid = $2`,
      [contentId, userId],
    );
    myVote = mine ? num(mine.value) : 0;
  }
  return { likes: num(agg?.likes), dislikes: num(agg?.dislikes), myVote };
}

/** Shape a comment row into the frozen thread/comment contract. */
function shapeComment(row, votes, myVote, withReplies) {
  const out = {
    id: num(row.id),
    body: row.body,
    createdat: isoOrNull(row.createdat),
    user: { id: num(row.userid), username: row.username, avatar: row.avatar || null },
    likes: votes.likes,
    dislikes: votes.dislikes,
    myVote,
  };
  if (withReplies) out.replies = [];
  return out;
}

/* ---------------------------------- router --------------------------------- */

export const commentsRouter = express.Router();

/**
 * GET /content/:id/comments — public thread list for a content row.
 * Top-level comments (parentid IS NULL) newest-first (LIMIT 50), each with
 * ALL of its replies oldest-first. A valid Bearer token (attached globally
 * by attachUser) upgrades myVote from null to 1|-1|0.
 */
commentsRouter.get('/content/:id/comments', wrap(async (req, res) => {
  const contentId = parseId(req.params.id);
  if (Number.isNaN(contentId)) return res.status(400).json({ error: 'Invalid content id' });

  const content = await getContentById(contentId);
  if (!content) return res.status(404).json({ error: 'Content not found' });

  const [topRows, replyRows, voteRows, myVoteRows] = await Promise.all([
    rows(
      `SELECT c.id, c.body, c.createdat, c.parentid,
              u.id AS userid, u.username, u.avatar
       FROM comments c
       JOIN users u ON u.id = c.userid
       WHERE c.contentid = $1 AND c.parentid IS NULL
       ORDER BY c.createdat DESC
       LIMIT $2`,
      [contentId, TOP_LEVEL_LIMIT],
    ),
    rows(
      `SELECT c.id, c.body, c.createdat, c.parentid,
              u.id AS userid, u.username, u.avatar
       FROM comments c
       JOIN users u ON u.id = c.userid
       WHERE c.contentid = $1 AND c.parentid IS NOT NULL
       ORDER BY c.createdat ASC`,
      [contentId],
    ),
    rows(
      `SELECT v.commentid,
              COUNT(*) FILTER (WHERE v.value = 1)::int AS likes,
              COUNT(*) FILTER (WHERE v.value = -1)::int AS dislikes
       FROM commentvotes v
       JOIN comments c ON c.id = v.commentid
       WHERE c.contentid = $1
       GROUP BY v.commentid`,
      [contentId],
    ),
    req.user
      ? rows(
          `SELECT v.commentid, v.value
           FROM commentvotes v
           JOIN comments c ON c.id = v.commentid
           WHERE c.contentid = $1 AND v.userid = $2`,
          [contentId, req.user.id],
        )
      : Promise.resolve([]),
  ]);

  const votesByComment = new Map(voteRows.map((r) => [num(r.commentid), { likes: num(r.likes), dislikes: num(r.dislikes) }]));
  const myVoteByComment = new Map(myVoteRows.map((r) => [num(r.commentid), num(r.value)]));
  const zero = { likes: 0, dislikes: 0 };
  const voteOf = (id) => votesByComment.get(id) ?? zero;
  const myVoteOf = (id) => (req.user ? myVoteByComment.get(id) ?? 0 : null);

  // Index every comment of the thread for root resolution.
  const byId = new Map();
  for (const row of [...topRows, ...replyRows]) byId.set(num(row.id), row);

  // Shape top-level threads (replies attached below).
  const threads = topRows.map((row) => shapeComment(row, voteOf(num(row.id)), myVoteOf(num(row.id)), true));

  /** Resolve the top-level ancestor of a reply (defensive against >2 levels). */
  const rootIdOf = (row) => {
    const seen = new Set();
    let current = row;
    while (current && current.parentid != null && !seen.has(num(current.id))) {
      seen.add(num(current.id));
      const parent = byId.get(num(current.parentid));
      if (!parent) return null; // orphan (deleted root) — dropped from output
      if (parent.parentid == null) return num(parent.id);
      current = parent;
    }
    return null;
  };

  const threadById = new Map(threads.map((t) => [t.id, t]));
  for (const row of replyRows) {
    const rootId = rootIdOf(row);
    const thread = rootId != null ? threadById.get(rootId) : null;
    if (!thread) continue; // reply to a thread outside the newest-50 window
    thread.replies.push(shapeComment(row, voteOf(num(row.id)), myVoteOf(num(row.id)), false));
  }

  return res.json({ data: threads });
}));

/**
 * POST /content/:id/comments — create a comment or reply.
 * Body: { body: string (1–2000 chars after trim), parentid?: number }.
 * 2-level enforcement: when parentid points at a reply, the new comment is
 * re-rooted on that reply's top-level parent. Emits 'comment:added'.
 */
commentsRouter.post('/content/:id/comments', requireAuth, commentLimiter, wrap(async (req, res) => {
  const contentId = parseId(req.params.id);
  if (Number.isNaN(contentId)) return res.status(400).json({ error: 'Invalid content id' });

  const content = await getContentById(contentId);
  if (!content) return res.status(404).json({ error: 'Content not found' });

  const rawBody = req.body?.body;
  const body = typeof rawBody === 'string' ? rawBody.trim() : '';
  if (!body || body.length > MAX_BODY_LEN) {
    return res.status(400).json({ error: `Comment body must be 1–${MAX_BODY_LEN} characters (after trimming)` });
  }

  // Optional parent: must exist in this content's thread; replies to replies
  // are flattened onto the reply's root (2-level threads).
  let parentId = null;
  const rawParent = req.body?.parentid;
  if (rawParent !== null && rawParent !== undefined && rawParent !== '') {
    parentId = parseId(rawParent);
    if (Number.isNaN(parentId)) return res.status(400).json({ error: 'Invalid parentid' });
    const parent = await one(
      `SELECT id, contentid, parentid FROM comments WHERE id = $1`,
      [parentId],
    );
    if (!parent) return res.status(404).json({ error: 'Parent comment not found' });
    if (num(parent.contentid) !== contentId) {
      return res.status(400).json({ error: 'Parent comment belongs to different content' });
    }
    if (parent.parentid != null) parentId = num(parent.parentid); // flatten to root
  }

  const inserted = await one(
    `INSERT INTO comments (contentid, userid, parentid, body)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [contentId, req.user.id, parentId, body],
  );

  emitPlatform('comment:added', { contentid: contentId, userid: req.user.id });

  return res.status(201).json({
    ok: true,
    comment: {
      id: num(inserted.id),
      body: inserted.body,
      createdat: isoOrNull(inserted.createdat),
      user: { id: req.user.id, username: req.user.username, avatar: req.user.avatar || null },
      likes: 0,
      dislikes: 0,
      myVote: 0,
      replies: [],
    },
  });
}));

/**
 * DELETE /comments/:id — hard delete (replies and votes cascade via FKs).
 * Owner (userid === req.user.id) or admin only.
 */
commentsRouter.delete('/comments/:id', requireAuth, wrap(async (req, res) => {
  const commentId = parseId(req.params.id);
  if (Number.isNaN(commentId)) return res.status(400).json({ error: 'Invalid comment id' });

  const existing = await one(
    `SELECT id, contentid, userid, parentid FROM comments WHERE id = $1`,
    [commentId],
  );
  if (!existing) return res.status(404).json({ error: 'Comment not found' });

  const isOwner = num(existing.userid) === req.user.id;
  const isAdmin = req.user.role === 'admin';
  if (!isOwner && !isAdmin) {
    return res.status(403).json({ error: 'You can only delete your own comments', code: 'FORBIDDEN' });
  }

  await rows(`DELETE FROM comments WHERE id = $1`, [commentId]);
  await auditLog({
    userid: req.user.id,
    action: 'comment.delete',
    ip: clientIpOf(req),
    meta: { commentid: commentId, contentid: num(existing.contentid) },
  });

  return res.json({ ok: true });
}));

/**
 * POST /comments/:id/vote — vote on a comment.
 * Body: { value: 1 | -1 | 0 } — 0 removes the vote, ±1 upserts
 * (PK userid+commentid). Returns fresh tallies.
 */
commentsRouter.post('/comments/:id/vote', requireAuth, wrap(async (req, res) => {
  const commentId = parseId(req.params.id);
  if (Number.isNaN(commentId)) return res.status(400).json({ error: 'Invalid comment id' });

  const value = parseVoteValue(req.body?.value);
  if (Number.isNaN(value)) {
    return res.status(400).json({ error: 'value must be 1, -1 or 0' });
  }

  const comment = await one(`SELECT id FROM comments WHERE id = $1`, [commentId]);
  if (!comment) return res.status(404).json({ error: 'Comment not found' });

  if (value === 0) {
    await rows(`DELETE FROM commentvotes WHERE commentid = $1 AND userid = $2`, [commentId, req.user.id]);
  } else {
    await rows(
      `INSERT INTO commentvotes (userid, commentid, value)
       VALUES ($1, $2, $3)
       ON CONFLICT (userid, commentid) DO UPDATE SET value = EXCLUDED.value`,
      [req.user.id, commentId, value],
    );
  }

  const stats = await commentVoteStats(commentId, req.user.id);
  return res.json({ ok: true, ...stats });
}));

/**
 * POST /content/:id/like — like/dislike/unlike a content row.
 * Body: { value: 1 | -1 | 0 } — 0 removes the like, ±1 upserts
 * (PK contentid+userid). Returns fresh tallies.
 */
commentsRouter.post('/content/:id/like', requireAuth, wrap(async (req, res) => {
  const contentId = parseId(req.params.id);
  if (Number.isNaN(contentId)) return res.status(400).json({ error: 'Invalid content id' });

  const value = parseVoteValue(req.body?.value);
  if (Number.isNaN(value)) {
    return res.status(400).json({ error: 'value must be 1, -1 or 0' });
  }

  const content = await getContentById(contentId);
  if (!content) return res.status(404).json({ error: 'Content not found' });

  if (value === 0) {
    await rows(`DELETE FROM contentlikes WHERE contentid = $1 AND userid = $2`, [contentId, req.user.id]);
  } else {
    await rows(
      `INSERT INTO contentlikes (contentid, userid, value)
       VALUES ($1, $2, $3)
       ON CONFLICT (contentid, userid) DO UPDATE SET value = EXCLUDED.value`,
      [contentId, req.user.id, value],
    );
  }

  const stats = await contentLikeStats(contentId, req.user.id);
  return res.json({ ok: true, ...stats });
}));

/**
 * GET /content/:id/likes — public like tallies for a content row.
 * myVote is 1|-1|0 with a valid Bearer token, null otherwise.
 */
commentsRouter.get('/content/:id/likes', wrap(async (req, res) => {
  const contentId = parseId(req.params.id);
  if (Number.isNaN(contentId)) return res.status(400).json({ error: 'Invalid content id' });

  const content = await getContentById(contentId);
  if (!content) return res.status(404).json({ error: 'Content not found' });

  const stats = await contentLikeStats(contentId, req.user?.id ?? null);
  return res.json(stats);
}));

export default commentsRouter;
