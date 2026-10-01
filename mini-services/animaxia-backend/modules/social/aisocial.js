/**
 * modules/social/aisocial.js — FAZA 10: AI × Social endpoints.
 *
 * Mounted at /api/ai/social (additive — aicloudRouter keeps owning
 * /api/ai/rag|assistant|personal|admin|cloud|tools|vector).
 *
 * Routes:
 *   GET  /home                    → { friendsAlsoWatched, tasteMatches, socialPicks }
 *                                  (requireAuth; deterministic SQL — no LLM, no quota)
 *   POST /review-digest/:contentId → { ok, summary, sentiment, themes, reviewCount, provider, degraded }
 *                                  (requireAuth; AI quota gated; llm-core chain
 *                                   z-ai → openai → mock with deterministic fallback)
 *
 * friendsAlsoWatched — cross-user recommendations: titles watched or
 * watchlisted by people I follow (plus their review ratings), minus my own
 * history/watchlist, ranked by distinct friends then rating.
 *
 * tasteMatches — followed users ranked by shared watch-history titles and
 * genre overlap (Jaccard over watch-history genres).
 *
 * socialPicks — community loved: highest-rated recent reviews platform-wide
 * (rating >= 8) on titles I haven't seen.
 */

import express from 'express';
import { rows, one, parseJsonb, num } from '../platform/sql.js';
import { requireAuth } from '../users/auth.js';
import { clientIpOf } from '../security/security.js';
import { consumeAiQuota, llmComplete } from '../aicloud/llm-core.js';

/* --------------------------------- helpers --------------------------------- */

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function parseId(value) {
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) && n > 0 ? n : NaN;
}

const STOPWORDS = new Set([
  'the', 'and', 'this', 'that', 'with', 'from', 'have', 'has', 'was', 'were', 'are', 'for',
  'but', 'not', 'you', 'your', 'its', 'it\'s', 'their', 'there', 'would', 'could', 'really',
  'just', 'like', 'about', 'into', 'than', 'then', 'them', 'some', 'more', 'most', 'much',
  'very', 'when', 'what', 'which', 'while', 'after', 'before', 'because', 'story', 'movie',
  'series', 'anime', 'film', 'show', 'episode', 'season', 'character', 'characters', 'watch',
  'watching', 'watched', 'great', 'good', 'best',
]);

function topThemes(bodies, max = 5) {
  const counts = new Map();
  for (const body of bodies) {
    for (const word of String(body).toLowerCase().split(/[^a-z']+/)) {
      if (word.length < 4 || STOPWORDS.has(word)) continue;
      counts.set(word, (counts.get(word) || 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, max).map(([word]) => word);
}

/* --------------------------------- router ---------------------------------- */

export const socialAiRouter = express.Router();

/** GET /home — social-aware recommendation home (deterministic, no LLM). */
socialAiRouter.get(
  '/home',
  requireAuth,
  wrap(async (req, res) => {
    const me = num(req.user.id);

    const friendsAlsoWatched = await rows(
      `SELECT c.id, c.title, c.type, c.thumbnail,
              COUNT(DISTINCT fs.userid) AS friends,
              AVG(fs.rating) AS avgrating,
              ARRAY_AGG(DISTINCT fs.username) AS friendnames
       FROM (
         SELECT wh.userid, wh.contentid, NULL AS rating, u.username
         FROM follows f
         JOIN watchhistory wh ON wh.userid = f.followeeid
         JOIN users u ON u.id = wh.userid
         WHERE f.followerid = $1
         UNION
         SELECT wl.userid, wl.contentid, NULL, u.username
         FROM follows f
         JOIN watchlist wl ON wl.userid = f.followeeid
         JOIN users u ON u.id = wl.userid
         WHERE f.followerid = $1
         UNION
         SELECT r.userid, r.contentid, r.rating, u.username
         FROM follows f
         JOIN reviews r ON r.userid = f.followeeid
         JOIN users u ON u.id = r.userid
         WHERE f.followerid = $1
       ) fs
       JOIN content c ON c.id = fs.contentid
       WHERE c.id NOT IN (SELECT contentid FROM watchhistory WHERE userid = $1)
         AND c.id NOT IN (SELECT contentid FROM watchlist WHERE userid = $1)
       GROUP BY c.id
       ORDER BY friends DESC, avgrating DESC NULLS LAST, c.id ASC
       LIMIT 8`,
      [me],
    );

    const tasteMatchesRaw = await rows(
      `SELECT u.id, u.username, u.avatar,
              (SELECT COUNT(*) FROM watchhistory mine
                JOIN watchhistory theirs ON theirs.contentid = mine.contentid
                WHERE mine.userid = $1 AND theirs.userid = u.id) AS sharedtitles,
              (SELECT COUNT(*) FROM watchhistory th WHERE th.userid = u.id) AS theirtitles
       FROM follows f
       JOIN users u ON u.id = f.followeeid
       WHERE f.followerid = $1
       ORDER BY sharedtitles DESC, u.id ASC
       LIMIT 6`,
      [me],
    );

    /* Genre Jaccard over watch histories for each taste match. */
    const [myGenresRow, theirGenres] = await Promise.all([
      rows(
        `SELECT c.metadata FROM watchhistory wh JOIN content c ON c.id = wh.contentid WHERE wh.userid = $1 LIMIT 300`,
        [me],
      ),
      Promise.all(
        tasteMatchesRaw.map((t) =>
          rows(
            `SELECT c.metadata FROM watchhistory wh JOIN content c ON c.id = wh.contentid WHERE wh.userid = $1 LIMIT 300`,
            [num(t.id)],
          ),
        ),
      ),
    ]);
    const genreSet = (list) => {
      const set = new Set();
      for (const row of list) {
        for (const g of parseJsonb(row.metadata, {}).genres || []) set.add(String(g).toLowerCase());
      }
      return set;
    };
    const mine = genreSet(myGenresRow);
    const tasteMatches = tasteMatchesRaw.map((t, i) => {
      const theirs = genreSet(theirGenres[i] || []);
      const union = new Set([...mine, ...theirs]);
      const shared = [...theirs].filter((g) => mine.has(g));
      return {
        user: { id: num(t.id), username: t.username, avatar: t.avatar || null },
        sharedTitles: num(t.sharedtitles),
        theirTitles: num(t.theirtitles),
        genreOverlap: shared,
        score: union.size ? Math.round((shared.length / union.size) * 100) : 0,
      };
    });
    tasteMatches.sort((a, b) => b.sharedTitles * 2 + b.score - (a.sharedTitles * 2 + a.score));

    const socialPicks = await rows(
      `SELECT c.id, c.title, c.type, c.thumbnail,
              ROUND(AVG(r.rating), 1) AS avgrating,
              COUNT(*) AS reviewcount,
              ARRAY_AGG(DISTINCT u.username) AS reviewers
       FROM reviews r
       JOIN content c ON c.id = r.contentid
       JOIN users u ON u.id = r.userid
       WHERE r.rating >= 8
         AND c.id NOT IN (SELECT contentid FROM watchhistory WHERE userid = $1)
         AND c.id NOT IN (SELECT contentid FROM watchlist WHERE userid = $1)
       GROUP BY c.id
       HAVING COUNT(*) >= 1
       ORDER BY avgrating DESC, reviewcount DESC, MAX(r.createdat) DESC
       LIMIT 8`,
      [me],
    );

    res.json({
      friendsAlsoWatched: friendsAlsoWatched.map((row) => ({
        content: {
          id: num(row.id),
          title: row.title,
          type: row.type,
          thumbnail: row.thumbnail,
        },
        friends: num(row.friends),
        avgRating: row.avgrating != null ? Math.round(num(row.avgrating) * 10) / 10 : null,
        friendNames: row.friendnames || [],
      })),
      tasteMatches,
      socialPicks: socialPicks.map((row) => ({
        content: {
          id: num(row.id),
          title: row.title,
          type: row.type,
          thumbnail: row.thumbnail,
        },
        avgRating: num(row.avgrating),
        reviewCount: num(row.reviewcount),
        reviewers: (row.reviewers || []).slice(0, 3),
      })),
    });
  }),
);

/** POST /review-digest/:contentId — AI summary of the community reviews. */
socialAiRouter.post(
  '/review-digest/:contentId',
  requireAuth,
  wrap(async (req, res) => {
    const contentId = parseId(req.params.contentId);
    if (!Number.isInteger(contentId)) return res.status(400).json({ error: 'Invalid content id' });

    const quota = consumeAiQuota({ user: req.user, ip: clientIpOf(req) });
    if (!quota.allowed) return res.status(quota.status).json(quota);

    const content = await one(`SELECT id, title FROM content WHERE id = $1`, [contentId]);
    if (!content) return res.status(404).json({ error: 'Content not found' });

    const reviewRows = await rows(
      `SELECT r.rating, r.body FROM reviews r WHERE r.contentid = $1 ORDER BY r.createdat DESC LIMIT 30`,
      [contentId],
    );
    if (reviewRows.length === 0) {
      return res.json({
        ok: true,
        summary: 'No community reviews yet — be the first to share your take.',
        sentiment: 'neutral',
        themes: [],
        reviewCount: 0,
        provider: 'deterministic',
        degraded: false,
      });
    }

    const bodies = reviewRows.map((r) => String(r.body || ''));
    const avg = reviewRows.reduce((acc, r) => acc + num(r.rating), 0) / reviewRows.length;
    const sentiment = avg >= 7.5 ? 'positive' : avg >= 5.5 ? 'mixed' : 'critical';
    const themes = topThemes(bodies);
    const fallback = `${reviewRows.length} community review${reviewRows.length === 1 ? '' : 's'}, averaging ${Math.round(avg * 10) / 10}/10 — overall ${sentiment}. Recurring themes: ${themes.length ? themes.join(', ') : 'general impressions'}.`;

    if (reviewRows.length < 2) {
      return res.json({
        ok: true,
        summary: fallback,
        sentiment,
        themes,
        reviewCount: reviewRows.length,
        provider: 'deterministic',
        degraded: false,
      });
    }

    const messages = [
      {
        role: 'system',
        content:
          'You are Animaxia\'s community digest writer. Summarize user reviews of a title in 2-3 neutral, warm sentences: overall verdict, what reviewers praise or criticize, and recurring themes. No markdown, no lists.',
      },
      {
        role: 'user',
        content: `Title: ${content.title}\nAverage rating: ${Math.round(avg * 10) / 10}/10 from ${reviewRows.length} reviews.\n\nReviews:\n${bodies
          .map((b, i) => `${i + 1}. ${b.slice(0, 400)}`)
          .join('\n')}`,
      },
    ];

    const result = await llmComplete({
      messages,
      feature: 'social',
      mode: 'summarize',
      user: req.user,
      query: `review-digest:${contentId}`,
      fallback,
    });

    if (!result.ok || !result.text) {
      return res.json({
        ok: true,
        summary: fallback,
        sentiment,
        themes,
        reviewCount: reviewRows.length,
        provider: 'deterministic',
        degraded: true,
      });
    }

    res.json({
      ok: true,
      summary: result.text.trim(),
      sentiment,
      themes,
      reviewCount: reviewRows.length,
      provider: result.provider,
      degraded: result.degraded,
    });
  }),
);
