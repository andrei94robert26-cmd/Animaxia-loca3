/**
 * domain/aicloud/personal.js — Personal AI (Phase 4, requirement 5).
 *
 * CLOUD PORT NOTE: imported verbatim from the monolith
 * modules/aicloud/personal.js — only the imports were rewritten to the
 * @animaxia/common / @animaxia/domain packages (BLUEPRINT §4 import map).
 *
 * Every signed-in user gets:
 *   • an AI profile      — aiprofiles row (taste tags + summary) refreshed on
 *                          demand, plus a personal taste EMBEDDING in the
 *                          vector store (kind 'user', written by index-user)
 *   • daily picks        — personalized RAG recommendations cached per user
 *                          for 15 minutes (rotating naturally each day)
 *   • weekly recap       — watch-stats recap composed once per ISO week
 *   • feed intelligence  — activity feed re-ranked by taste with an aiWhy
 *                          line per item
 *   • player companion   — before-you-watch note, more-like-this, predicted
 *                          rating and next-up
 *
 * Endpoints (router): /api/ai/personal/home | /feed | /player | /recap
 */

import crypto from 'node:crypto';
import { rows, one, jsonb, parseJsonb, isoOrNull } from '@animaxia/common/sql.js';
import { listContent, getContentById } from '@animaxia/common/db.js';
import { llmComplete, buildPrompt, buildContext, aiQuotaStatus } from './llm-core.js';
import { recommendForUser, moreLikeThis, userMatchScore, loadProfileText } from './rag-engine.js';
import { indexUser, vectorStatus } from './vector-service.js';

/* --------------------------------- caches ---------------------------------- */

const homeCache = new Map(); // userId → { at, payload } (TTL 10 min)
const recapCache = new Map(); // userId → { week, payload } (TTL per ISO week)
const HOME_TTL_MS = 10 * 60 * 1000;

function isoWeekKey(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/* ------------------------------ AI profile row ------------------------------ */

/** Upsert the caller's aiprofiles row (taste tags + summary). Best-effort. */
async function upsertAiProfile(user, profileText) {
  try {
    const prefs = user.preferences && typeof user.preferences === 'object' ? user.preferences : {};
    const tasteTags = [
      ...(Array.isArray(prefs.types) ? prefs.types : []),
      ...(Array.isArray(prefs.genres) ? prefs.genres.slice(0, 6) : []),
    ].slice(0, 10);
    await rows(
      `INSERT INTO aiprofiles (userid, summary, tastetags, updatedat)
       VALUES ($1,$2,$3::jsonb, NOW())
       ON CONFLICT (userid) DO UPDATE SET summary = EXCLUDED.summary,
         tastetags = EXCLUDED.tastetags, updatedat = NOW()`,
      [user.id, String(profileText || '').slice(0, 1000), jsonb({ tags: tasteTags })],
    );
  } catch {
    /* local fallback driver — profile stays implicit (vector embedding) */
  }
}

async function readAiProfile(userId) {
  try {
    const row = await one(`SELECT summary, tastetags, updatedat FROM aiprofiles WHERE userid = $1`, [userId]);
    if (!row) return null;
    return {
      summary: row.summary,
      tags: parseJsonb(row.tastetags, {}).tags ?? [],
      updatedat: isoOrNull(row.updatedat),
    };
  } catch {
    return null;
  }
}

/* --------------------------------- history ---------------------------------- */

/** Latest watch-history rows (with genres) for a user. */
async function userHistory(userId, limit = 12) {
  try {
    const history = await rows(
      `SELECT c.id, c.title, c.type, c.thumbnail, c.metadata, wh.progress, wh.watchedat
       FROM watchhistory wh JOIN content c ON c.id = wh.contentid
       WHERE wh.userid = $1 ORDER BY wh.watchedat DESC LIMIT $2`,
      [userId, limit],
    );
    return history.map((r) => {
      const meta = parseJsonb(r.metadata, {});
      return {
        id: Number(r.id),
        title: r.title,
        type: r.type ?? null,
        thumbnail: r.thumbnail ?? null,
        genres: Array.isArray(meta.genres) ? meta.genres.map(String) : [],
        progress: Number(r.progress ?? 0),
        watchedat: isoOrNull(r.watchedat),
      };
    });
  } catch {
    return [];
  }
}

/* ------------------------------- greeting line ------------------------------ */

function greetingFallback(username, picks) {
  const hour = new Date().getUTCHours();
  const daypart = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
  const top = picks[0]?.title;
  return top
    ? `Good ${daypart}, ${username} — today’s top pick for you is ${top}.`
    : `Good ${daypart}, ${username} — fresh picks are ready below.`;
}

async function greetingLine(user, picks, stats, traceId) {
  const context = buildContext({
    docs: picks.slice(0, 4).map((p) => ({ title: p.title, type: p.type, genres: p.genres, text: p.reason })),
    profile: { username: user.username, plan: user.plan, types: user.preferences?.types, genres: user.preferences?.genres },
    extra: `[WEEK STATS] watched ${stats.watched} titles · top genres: ${stats.topGenres.join(', ') || 'n/a'}`,
    budgetTokens: 500,
  });
  const prompt = buildPrompt('personal', { query: 'Write the greeting line for the personal home.', context });
  const result = await llmComplete({
    messages: [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user },
    ],
    feature: 'personal',
    mode: 'greeting',
    user,
    query: 'personal-greeting',
    traceId,
    fallback: () => greetingFallback(user.username, picks),
  });
  return { line: result.text, provider: result.provider, degraded: result.degraded };
}

/* ------------------------------- weekly recap ------------------------------- */

async function weeklyStats(userId) {
  const history = await userHistory(userId, 50);
  const recent = history.filter(
    (h) => h.watchedat && Date.now() - Date.parse(h.watchedat) < 7 * 24 * 3600 * 1000,
  );
  const genreCount = new Map();
  for (const h of recent) {
    for (const g of h.genres) genreCount.set(g, (genreCount.get(g) || 0) + 1);
  }
  const topGenres = [...genreCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([g]) => g);
  return {
    watched: recent.length,
    topGenres,
    topTitles: recent.slice(0, 5).map((h) => h.title),
    historyTotal: history.length,
  };
}

function recapFallback(username, stats) {
  if (stats.watched === 0) {
    return `${username}, no watches logged this week — Animaxia AI kept your picks warm. Open the personal home and pick one tonight; your taste profile updates with every title.`;
  }
  return [
    `${username}, your week on Animaxia in numbers: ${stats.watched} title${stats.watched === 1 ? '' : 's'} watched${
      stats.topGenres.length ? `, led by ${stats.topGenres.slice(0, 2).join(' and ').toLowerCase()}` : ''
    }.`,
    stats.topTitles.length ? `Highlights: ${stats.topTitles.slice(0, 3).join(', ')}.` : '',
    'Next week’s picks are already sharpening — keep the streak alive.',
  ]
    .filter(Boolean)
    .join(' ');
}

/** Weekly recap (cached per ISO week per user). */
export async function getWeeklyRecap(user, { traceId = null, refresh = false } = {}) {
  const id = traceId || crypto.randomUUID();
  const week = isoWeekKey();
  const cached = recapCache.get(user.id);
  if (!refresh && cached && cached.week === week) return cached.payload;

  const stats = await weeklyStats(user.id);
  const context = buildContext({
    docs: stats.topTitles.map((t) => ({ title: t, text: `watched this week` })),
    profile: { username: user.username, plan: user.plan },
    extra: `[WEEKLY STATS] watched=${stats.watched} topGenres=${stats.topGenres.join(', ')} historyTotal=${stats.historyTotal}`,
    budgetTokens: 500,
  });
  const prompt = buildPrompt('personal', { query: 'Write the weekly recap.', context });
  const result = await llmComplete({
    messages: [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user },
    ],
    feature: 'personal',
    mode: 'weekly-recap',
    user,
    query: 'weekly-recap',
    traceId: id,
    fallback: () => recapFallback(user.username, stats),
  });

  const payload = {
    ok: true,
    week,
    recap: result.text,
    stats,
    provider: result.provider,
    degraded: result.degraded,
    traceId: id,
  };
  recapCache.set(user.id, { week, payload });
  return payload;
}

/* --------------------------------- home ------------------------------------- */

/**
 * Personal home (GET /api/ai/personal/home): greeting, daily picks,
 * because-you-watched row, AI profile, quota meter, recap preview.
 */
export async function getPersonalHome(user, { traceId = null } = {}) {
  const id = traceId || crypto.randomUUID();

  // Refresh the personal embedding + profile in the background.
  const profileText = await loadProfileText(user);
  void upsertAiProfile(user, profileText).catch(() => {});
  void indexUser(user).catch(() => {}); // keep the taste embedding fresh

  const cached = homeCache.get(user.id);
  if (cached && Date.now() - cached.at < HOME_TTL_MS) {
    return { ...cached.payload, cached: true, quota: aiQuotaStatus({ user }) };
  }

  const picks = await recommendForUser(user, { limit: 6, traceId: id });

  const history = await userHistory(user.id, 6);
  const seed = history[0];
  let becauseYouWatched = [];
  if (seed) {
    try {
      const similar = await moreLikeThis(seed.id, 6);
      becauseYouWatched = similar.map((s) => ({ ...s, because: `because you watched ${seed.title}` }));
    } catch {
      becauseYouWatched = [];
    }
  }

  const stats = await weeklyStats(user.id);
  const greeting = await greetingLine(user, picks.data ?? [], stats, id).catch(() => ({
    line: greetingFallback(user.username, picks.data ?? []),
    provider: 'mock',
    degraded: true,
  }));

  const profile = await readAiProfile(user.id);
  const vector = await vectorStatus().catch(() => ({ backend: 'mock' }));

  const payload = {
    ok: true,
    greeting: greeting.line,
    mood: stats.watched > 3 ? 'on a streak' : stats.watched > 0 ? 'steady' : 'fresh start',
    dailyPicks: (picks.data ?? []).map((p) => ({
      id: p.id,
      title: p.title,
      type: p.type,
      thumbnail: p.thumbnail,
      rating: p.rating,
      year: p.year,
      genres: p.genres,
      reason: p.reason,
      score: p.score,
    })),
    becauseYouWatched,
    aiProfile: {
      tags: profile?.tags ?? [
        ...(user.preferences?.types ?? []),
        ...(user.preferences?.genres ?? []).slice(0, 4),
      ].slice(0, 8),
      summary: profile?.summary ?? profileText,
      embedding: { backend: vector.backend, kind: 'user' },
    },
    quota: aiQuotaStatus({ user }),
    recapPreview: recapFallback(user.username, stats),
    provider: greeting.provider,
    degraded: greeting.degraded,
    generatedat: new Date().toISOString(),
    traceId: id,
  };
  homeCache.set(user.id, { at: Date.now(), payload });
  return payload;
}

/* ---------------------------------- feed ------------------------------------ */

/** Deterministic per-item "why is this in your feed" line. */
function feedWhy(item, profileText) {
  const lower = (profileText || '').toLowerCase();
  if (item.type === 'comment') {
    return lower.includes(String(item.content || '').toLowerCase().split(' ')[0] ?? '\u0000')
      ? `${item.user} is talking about ${item.content} — right in your taste space.`
      : `${item.user} commented on ${item.content}.`;
  }
  if (item.genres && item.genres.some((g) => lower.includes(String(g).toLowerCase()))) {
    return `matches the ${item.genres.find((g) => lower.includes(String(g).toLowerCase()))} lane you have been enjoying.`;
  }
  if (item.type === 'content') return 'fresh on Animaxia — picked for your feed by AI ranking.';
  return 'from the Animaxia activity stream.';
}

/**
 * Personal feed (GET /api/ai/personal/feed): taste-ranked activity with an
 * aiWhy line per item + the weekly recap block.
 */
export async function getPersonalFeed(user, { limit = 10, traceId = null } = {}) {
  const id = traceId || crypto.randomUUID();
  const safeLimit = Math.max(1, Math.min(20, limit));
  const profileText = await loadProfileText(user);

  const activities = [];
  try {
    const comments = await rows(
      `SELECT cm.body, cm.createdat, c.id AS contentid, c.title AS contenttitle, c.type AS contenttype,
              c.thumbnail, c.metadata, u.username
       FROM comments cm
       LEFT JOIN content c ON c.id = cm.contentid
       LEFT JOIN users u ON u.id = cm.userid
       ORDER BY cm.createdat DESC LIMIT 30`,
    );
    for (const r of comments) {
      const meta = parseJsonb(r.metadata, {});
      activities.push({
        type: 'comment',
        user: r.username ?? 'someone',
        contentid: r.contentid,
        content: r.contenttitle,
        contenttype: r.contenttype,
        thumbnail: r.thumbnail ?? null,
        genres: Array.isArray(meta.genres) ? meta.genres.map(String) : [],
        preview: String(r.body || '').slice(0, 140),
        createdat: isoOrNull(r.createdat),
      });
    }
  } catch {
    /* comments unavailable */
  }
  try {
    const latest = await listContent({ page: 1, limit: 20 });
    for (const row of latest.data) {
      const meta = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
      activities.push({
        type: 'content',
        contentid: row.id,
        content: row.title,
        contenttype: row.type,
        thumbnail: row.thumbnail ?? null,
        genres: Array.isArray(meta.genres) ? meta.genres.map(String) : [],
        preview: 'new on Animaxia',
        createdat: row.createdat,
      });
    }
  } catch {
    /* ignore */
  }

  // Taste ranking: genre hits against the profile + own-activity bonus.
  const lower = (profileText || '').toLowerCase();
  const ranked = activities
    .map((a) => {
      let score = 0;
      if (a.genres) {
        for (const g of a.genres) if (lower.includes(String(g).toLowerCase())) score += 2;
      }
      if (a.type === 'content') score += 1;
      if (a.user === user.username) score += 1;
      return { ...a, score, aiWhy: feedWhy(a, profileText) };
    })
    .sort((a, b) => b.score - a.score || String(b.createdat || '').localeCompare(String(a.createdat || '')))
    .slice(0, safeLimit);

  const recap = await getWeeklyRecap(user, { traceId: id }).catch(() => null);

  return {
    ok: true,
    data: ranked,
    recap: recap ? { week: recap.week, recap: recap.recap, stats: recap.stats } : null,
    basedOn: { personalized: Boolean(profileText) },
    traceId: id,
  };
}

/* --------------------------------- player ----------------------------------- */

/**
 * Player companion (GET /api/ai/personal/player?contentId=): before-you-watch
 * note, more-like-this, predicted rating, next-up.
 */
export async function getPersonalPlayer(user, contentId, { traceId = null } = {}) {
  const id = traceId || crypto.randomUUID();
  const content = await getContentById(contentId);
  if (!content) throw Object.assign(new Error('Content not found'), { status: 404 });

  const match = await userMatchScore(user, content.id).catch(() => null);
  const predictedRating = match == null ? null : Number((5.5 + match * 4).toFixed(1));

  // Before-you-watch: short deterministic + LLM hybrid (mode 'summaries' path).
  const meta = content.metadata && typeof content.metadata === 'object' ? content.metadata : {};
  const overview = [meta.overview, meta.synopsis, meta.description].filter(Boolean).join(' ');
  const context = buildContext({
    docs: [{ title: content.title, type: content.type, genres: meta.genres, text: overview }],
    profile: { username: user.username, plan: user.plan, types: user.preferences?.types, genres: user.preferences?.genres },
    extra: `[PREDICTED MATCH] ${match ?? 'n/a'}`,
    budgetTokens: 700,
  });
  const prompt = buildPrompt('summaries', { query: `One tight "before you watch" note for ${content.title}.`, context });
  const result = await llmComplete({
    messages: [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user },
    ],
    feature: 'personal',
    mode: 'player-companion',
    user,
    query: `player:${content.title}`,
    traceId: id,
    fallback: () =>
      [
        `${content.title} — a ${content.type || 'title'}${Array.isArray(meta.genres) && meta.genres.length ? ` in ${meta.genres.slice(0, 3).join(' / ')}` : ''}.`,
        overview ? String(overview).split(/(?<=[.!?])\s+/).slice(0, 2).join(' ') : 'Press play and let the first act speak.',
        match != null && match >= 0.55 ? 'High match for your taste — clear your evening.' : 'A solid pick — see how the first act lands.',
      ]
        .filter(Boolean)
        .join(' '),
  });

  const similar = await moreLikeThis(content.id, 6).catch(() => []);
  const history = await userHistory(user.id, 5);
  const watchedIds = new Set(history.map((h) => h.id));
  const nextUp = (await recommendForUser(user, { limit: 6, traceId: id }).catch(() => ({ data: [] }))).data
    ?.filter?.((p) => p.id !== content.id && !watchedIds.has(p.id))?.[0] ?? null;

  return {
    ok: true,
    contentId: content.id,
    title: content.title,
    beforeYouWatch: result.text,
    predictedRating,
    matchScore: match,
    moreLikeThis: similar,
    nextUp,
    provider: result.provider,
    degraded: result.degraded,
    traceId: id,
  };
}
