/**
 * modules/analytics/playerhub.js — FAZA 21: admin playerhub gauges + personal
 * stats for every user. Two routers, both exported:
 *
 *   playerhubRouter — mount: app.use('/api/admin/playerhub', requireAuth,
 *                     requireAdmin, playerhubRouter)
 *     GET /status   → live playback/subtitle/source gauges (see below)
 *     GET /history  → the ADMIN's own watch history (personal, 50 latest)
 *
 *   mystatsRouter   — mount: app.use('/api/users/me/stats', requireAuth,
 *                     mystatsRouter)  ← BEFORE the profile mount on /api/users
 *     GET /         → personal watch/engagement/watchlist/genre/AI stats
 *
 * Honest notes baked into the payloads:
 *   • viewevents stores the playback kind in its `event` column
 *     (view|play|complete — see modules/platform/migrations.js); the status
 *     payload surfaces it as playback.byKind.
 *   • sources.byMode is an honest approximation from content metadata
 *     (metadata.player.sources / metadata.sources) — the exact mode is only
 *     known at resolvePlayer() time per request.
 *   • engagement.streakDays counts consecutive active UTC days ending today
 *     (or yesterday — a streak survives one idle day).
 */

import express from 'express';
import { rows, one, isoOrNull, num, assertPostgres } from '../platform/sql.js';
import { playerAllowedTypes } from '../player/player.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Count consecutive active days ending today (UTC); a streak survives one
 *  idle day (if today has no activity yet, yesterday may still extend it). */
function streakFromDates(dateKeys) {
  const active = new Set(dateKeys);
  const dayMs = 86400000;
  const today = new Date();
  let cursor = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  if (!active.has(cursor.toISOString().slice(0, 10))) {
    cursor = new Date(cursor.getTime() - dayMs); // yesterday
    if (!active.has(cursor.toISOString().slice(0, 10))) return 0;
  }
  let streak = 0;
  while (active.has(cursor.toISOString().slice(0, 10))) {
    streak += 1;
    cursor = new Date(cursor.getTime() - dayMs);
  }
  return streak;
}

/* ------------------------------ playerhub (admin) ---------------------------- */

export const playerhubRouter = express.Router();

/** GET /status — live gauges for the admin playerhub dashboard. */
playerhubRouter.get('/status', wrap(async (_req, res) => {
  assertPostgres();

  // Playback gauges (viewevents: kind lives in the `event` column).
  const [playbackTotals, byKindRows, topWatchedRows, usersWatchingRow, avgProgressRow] = await Promise.all([
    one(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE createdat > datetime('now','-1 day'))::int AS last24h
       FROM viewevents`,
    ),
    rows(`SELECT event AS kind, COUNT(*)::int AS count FROM viewevents GROUP BY event ORDER BY count DESC`),
    rows(
      `SELECT v.contentid, c.title, c.type, c.thumbnail, COUNT(*)::int AS plays
       FROM viewevents v
       JOIN content c ON c.id = v.contentid
       WHERE v.event IN ('view', 'play')
       GROUP BY v.contentid, c.title, c.type, c.thumbnail
       ORDER BY plays DESC, v.contentid ASC
       LIMIT 10`,
    ),
    one(
      `SELECT COUNT(DISTINCT userid)::int AS count FROM viewevents
       WHERE userid IS NOT NULL AND createdat > datetime('now','-1 day')`,
    ),
    one(`SELECT AVG(progress) AS avg FROM watchhistory`),
  ]);

  const byKind = {};
  for (const r of byKindRows) byKind[r.kind] = num(r.count);

  // Subtitle gauges — the FAZA-21 table; degrade honestly if the schema is absent.
  let subtitles;
  try {
    const [subTotalRow, subPerContentRows] = await Promise.all([
      one(`SELECT COUNT(*)::int AS total FROM subtitles`),
      rows(
        `SELECT s.contentid, c.title, COUNT(*)::int AS tracks
         FROM subtitles s
         JOIN content c ON c.id = s.contentid
         GROUP BY s.contentid, c.title
         ORDER BY tracks DESC, s.contentid ASC
         LIMIT 10`,
      ),
    ]);
    subtitles = {
      total: num(subTotalRow?.total),
      perContent: subPerContentRows.map((r) => ({
        contentId: num(r.contentid),
        title: r.title,
        tracks: num(r.tracks),
      })),
    };
  } catch (err) {
    subtitles = { total: 0, perContent: [], note: `subtitles table unavailable: ${err.message}` };
  }

  // Source gauges — honest approximation straight from content metadata.
  const [withSourcesRow, modeRows] = await Promise.all([
    one(
      `SELECT COUNT(*)::int AS count FROM content c
       WHERE (jsonb_typeof(c.metadata->'player'->'sources') = 'array' AND jsonb_array_length(c.metadata->'player'->'sources') > 0)
          OR (jsonb_typeof(c.metadata->'sources') = 'array' AND jsonb_array_length(c.metadata->'sources') > 0)`,
    ),
    rows(
      `SELECT s->>'type' AS mode, COUNT(*)::int AS count
       FROM content c
       CROSS JOIN LATERAL jsonb_array_elements(
         CASE
           WHEN jsonb_typeof(c.metadata->'player'->'sources') = 'array' THEN c.metadata->'player'->'sources'
           WHEN jsonb_typeof(c.metadata->'sources') = 'array' THEN c.metadata->'sources'
           ELSE '[]'
         END
       ) AS s
       GROUP BY 1
       ORDER BY count DESC`,
    ),
  ]);
  const contentWithSources = num(withSourcesRow?.count);
  const byMode = { direct: contentWithSources, none: 0 };
  for (const r of modeRows) {
    const mode = r.mode || 'untyped';
    byMode[mode] = num(r.count) + num(byMode[mode]); // entry counts per source type
  }
  const totalContentRow = await one(`SELECT COUNT(*)::int AS count FROM content`);
  byMode.none = Math.max(0, num(totalContentRow?.count) - contentWithSources);

  return res.json({
    ok: true,
    playback: {
      total: num(playbackTotals?.total),
      last24h: num(playbackTotals?.last24h),
      byKind, // viewevents.event: 'view' | 'play' | 'complete'
    },
    topWatched: topWatchedRows.map((r) => ({
      contentId: num(r.contentid),
      title: r.title,
      type: r.type,
      thumbnail: r.thumbnail || null,
      plays: num(r.plays),
    })),
    subtitles,
    sources: {
      allowedTypes: playerAllowedTypes(), // live player policy (PLAYERALLOW* env)
      contentWithSources,
      byMode, // direct = content with ≥1 source entry; per-type = source entries; none = content without sources
      note: 'mode approximation from metadata.sources/metadata.player.sources (m3u8 = HLS); exact mode is resolved per request by the player',
    },
    usersWatching: num(usersWatchingRow?.count), // distinct users with view events in the last 24h
    avgProgress: avgProgressRow?.avg == null ? null : Math.round(num(avgProgressRow.avg) * 10) / 10,
    uptimeSec: Math.floor(process.uptime()),
    generatedAt: new Date().toISOString(),
  });
}));

/** GET /history — the admin's own watch history (50 latest, personal view). */
playerhubRouter.get('/history', wrap(async (req, res) => {
  assertPostgres();
  const data = await rows(
    `SELECT h.contentid, c.title, c.thumbnail, h.progress, h.watchedat
     FROM watchhistory h
     JOIN content c ON c.id = h.contentid
     WHERE h.userid = $1
     ORDER BY h.watchedat DESC, h.id DESC
     LIMIT 50`,
    [req.user.id],
  );
  return res.json({
    ok: true,
    data: data.map((r) => ({
      contentid: num(r.contentid),
      title: r.title,
      thumbnail: r.thumbnail ?? null,
      progress: num(r.progress),
      watchedat: isoOrNull(r.watchedat),
    })),
  });
}));

/* ---------------------------- mystats (personal) ---------------------------- */

export const mystatsRouter = express.Router();

/** GET / — personal stats for the authenticated user. */
mystatsRouter.get('/', wrap(async (req, res) => {
  assertPostgres();
  const userid = req.user.id;

  const [watchRow, byTypeRows, activeDayRows, watchlistRow, viewsRow, topGenreRows] = await Promise.all([
    one(
      `SELECT COUNT(*)::int AS historycount,
              COALESCE(ROUND(SUM(progress) / 60.0), 0)::int AS totalminutes,
              AVG(progress) AS avgprogress
       FROM watchhistory WHERE userid = $1`,
      [userid],
    ),
    rows(
      `SELECT c.type AS type, COUNT(*)::int AS count
       FROM watchhistory h JOIN content c ON c.id = h.contentid
       WHERE h.userid = $1
       GROUP BY c.type ORDER BY count DESC, c.type ASC`,
      [userid],
    ),
    rows(
      `SELECT DISTINCT strftime('%Y-%m-%d', watchedat) AS date
       FROM watchhistory WHERE userid = $1
       ORDER BY date DESC`,
      [userid],
    ),
    one(`SELECT COUNT(*)::int AS count FROM watchlist WHERE userid = $1`, [userid]),
    one(`SELECT COUNT(*)::int AS count FROM viewevents WHERE userid = $1`, [userid]),
    rows(
      `SELECT g.value AS genre, COUNT(*)::int AS count
       FROM watchhistory h
       JOIN content c ON c.id = h.contentid
       CROSS JOIN json_each(
         CASE WHEN json_type(c.metadata->'genres') = 'array' THEN c.metadata->'genres' ELSE '[]' END
       ) AS g
       WHERE h.userid = $1
       GROUP BY g.value ORDER BY count DESC, g.value ASC
       LIMIT 5`,
      [userid],
    ),
  ]);

  const dateKeys = activeDayRows.map((r) => r.date).filter(Boolean);
  const lastActiveRow = await one(
    `SELECT MAX(watchedat) AS last FROM watchhistory WHERE userid = $1`,
    [userid],
  );

  // AI usage — aiusagelogs (AI Cloud, Phase 4) has a userid column; degrade to
  // an honest null when the table/permission is unavailable.
  let aiUsage = null;
  try {
    const aiRow = await one(
      `SELECT COUNT(*)::int AS calls, MAX(createdat) AS last FROM aiusagelogs WHERE userid = $1`,
      [userid],
    );
    aiUsage = { calls: num(aiRow?.calls), lastUsedAt: isoOrNull(aiRow?.last) };
  } catch {
    aiUsage = null;
  }

  return res.json({
    ok: true,
    watch: {
      historyCount: num(watchRow?.historycount),
      totalMinutes: num(watchRow?.totalminutes), // SUM(progress seconds) / 60, rounded
      byType: byTypeRows.map((r) => ({ type: r.type, count: num(r.count) })),
      avgProgress: watchRow?.avgprogress == null ? null : Math.round(num(watchRow.avgprogress) * 10) / 10,
    },
    engagement: {
      activeDays: dateKeys.length,
      lastActive: isoOrNull(lastActiveRow?.last),
      streakDays: streakFromDates(dateKeys),
    },
    watchlistCount: num(watchlistRow?.count),
    viewsCount: num(viewsRow?.count), // viewevents attributed to this user
    topGenres: topGenreRows.map((r) => ({ genre: r.genre, count: num(r.count) })),
    aiUsage,
  });
}));

export default playerhubRouter;
