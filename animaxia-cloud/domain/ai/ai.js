/**
 * domain/ai/ai.js — AI layer for Animaxia, backed by z-ai-web-dev-sdk with
 * deterministic heuristic fallbacks (provider: 'z-ai' | 'heuristic').
 *
 *   GET  /recommendations?limit=10  → { data: [{ content, reason }], provider } (optionalAuth)
 *   POST /summarize  { contentId }  → { summary, provider }                    (optionalAuth)
 *   POST /describe   { title, type, genres? } → { description, provider }      (public, 10/min per IP)
 *   POST /chat       { contentId, message }   → { reply, provider }            (requireAuth, 30/min per user)
 *   GET  /status                     → { provider, available, model, requestsToday, quota }
 *
 * Quota model (applies to every endpoint EXCEPT GET /status):
 *   • Authenticated callers: planLimits(user.plan).aiPerDay per calendar day
 *     (free 10 / plus 100 / pro 500) → 402 { error, upgrade: true, plan } on exceed.
 *   • Unauthenticated callers on /recommendations, /summarize and /describe:
 *     an ANONYMOUS bucket keyed by client IP with a fixed limit of 5 requests
 *     per day (shared across those three endpoints). This keeps the public
 *     endpoints useful for a taste test while preventing free LLM farming.
 *   • requestsToday (GET /status) counts every quota-guarded request, anonymous
 *     and authenticated alike, reset at UTC midnight.
 *
 * Chat history persists to the `aichats` table (contentid, userid, role, message).
 * The z-ai SDK is lazily created once per process; every completion runs with
 * thinking disabled, a 20s timeout and 1 retry, returning null on failure so
 * callers can degrade to the heuristic path.
 */

import express from 'express';
import ZAI from 'z-ai-web-dev-sdk';
import { listContent, getContentById } from '@animaxia/common/db.js';
import { rows } from '@animaxia/common/sql.js';
import { requireAuth } from '../users/auth.js';
import { userRateLimit, clientIpOf } from '../security/security.js';
import { planLimits } from '../premium/plans.js';
import { advancedCache } from '../cache/advancedCache.js';
import { logger } from '@animaxia/common/logger.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* ------------------------------ z-ai singleton ------------------------------ */

let zaiInstance = null;
let zaiAvailable = false; // flips true after the first successful completion
let zaiLastError = null;

/** Lazily create the ZAI client singleton (never throws — callers handle null). */
async function getZai() {
  if (!zaiInstance) zaiInstance = await ZAI.create();
  return zaiInstance;
}

/**
 * Run one chat completion: assistant-role system message + user message,
 * thinking disabled, 20s timeout (Promise.race) and a single retry.
 * @param {Array<{ role: string, content: string }>} messages
 * @returns {Promise<string|null>} trimmed completion text, or null on failure.
 */
async function complete(messages, { timeoutMs = 20000 } = {}) {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const zai = await getZai();
      const completion = await Promise.race([
        zai.chat.completions.create({ messages, thinking: { type: 'disabled' } }),
        new Promise((_, reject) => {
          const timer = setTimeout(
            () => reject(new Error(`z-ai completion timed out after ${timeoutMs}ms`)),
            timeoutMs,
          );
          if (typeof timer.unref === 'function') timer.unref();
        }),
      ]);
      const text = completion?.choices?.[0]?.message?.content;
      if (typeof text === 'string' && text.trim().length > 0) {
        zaiAvailable = true;
        zaiLastError = null;
        return text.trim();
      }
      throw new Error('z-ai returned an empty completion');
    } catch (err) {
      zaiLastError = err?.message || String(err);
      if (attempt >= 2) {
        logger.warn(`[ai] z-ai completion failed, using heuristic fallback: ${zaiLastError}`);
        return null;
      }
    }
  }
  return null;
}

/** Parse LLM JSON output; strips ```json fences and grabs the outer {...}. */
function parseJsonLoose(text) {
  if (!text) return null;
  let t = String(text).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(t.slice(start, end + 1));
  } catch {
    return null;
  }
}

/* ------------------------------- daily quotas ------------------------------- */

const ANON_DAILY_LIMIT = 5; // unauthenticated /recommendations + /summarize + /describe
const userQuotas = new Map(); // userId → { date: 'YYYY-MM-DD', count }
const anonQuotas = new Map(); // ip → { date: 'YYYY-MM-DD', count }
const globalDaily = { date: today(), count: 0 };

function today() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

function bucketFor(map, key) {
  const date = today();
  let entry = map.get(key);
  if (!entry || entry.date !== date) {
    entry = { date, count: 0 };
    map.set(key, entry);
  }
  return entry;
}

/** Periodic sweep so idle identities do not accumulate (enterprise hygiene). */
const quotaSweep = setInterval(() => {
  const date = today();
  for (const map of [userQuotas, anonQuotas]) {
    for (const [key, entry] of map) {
      if (entry.date !== date) map.delete(key);
    }
  }
  if (globalDaily.date !== date) globalDaily.count = 0;
}, 3600000);
if (typeof quotaSweep.unref === 'function') quotaSweep.unref();

/**
 * Quota guard middleware for every endpoint except GET /status.
 * Authenticated → per-user plan quota; anonymous → 5/day per-IP bucket.
 */
function quotaGuard(req, res, next) {
  if (globalDaily.date !== today()) globalDaily.count = 0;
  globalDaily.count += 1;

  if (req.user) {
    const plan = req.user.plan || 'free';
    const limit = planLimits(plan).aiPerDay;
    const entry = bucketFor(userQuotas, req.user.id);
    if (entry.count >= limit) {
      return res.status(402).json({
        error: 'Daily AI quota reached for your plan',
        upgrade: true,
        plan,
        limit,
      });
    }
    entry.count += 1;
    return next();
  }

  const entry = bucketFor(anonQuotas, clientIpOf(req));
  if (entry.count >= ANON_DAILY_LIMIT) {
    return res.status(402).json({
      error: 'Daily AI quota reached for your plan',
      upgrade: true,
      plan: 'anonymous',
      limit: ANON_DAILY_LIMIT,
    });
  }
  entry.count += 1;
  return next();
}

/* ------------------------------- taste helpers ------------------------------ */

/** Genres from a content row's metadata. */
function rowGenres(row) {
  const genres = row?.metadata?.genres;
  return Array.isArray(genres) ? genres.map((g) => String(g)) : [];
}

function rowRating(row) {
  const meta = row?.metadata || {};
  const rating = Number(meta.rating ?? meta.score);
  return Number.isFinite(rating) ? rating : 0;
}

/** Deterministic relevance score: preference types/genres + watch-history genres + rating. */
function heuristicScore(row, profileTypes, profileGenres, historyGenres) {
  let score = rowRating(row) / 10; // 0..1 gentle baseline
  if (profileTypes.includes(row.type)) score += 3;
  const genres = rowGenres(row).map((g) => g.toLowerCase());
  let prefHits = 0;
  for (const g of profileGenres) {
    if (genres.includes(String(g).toLowerCase())) prefHits += 1;
  }
  score += Math.min(6, prefHits * 2);
  let histHits = 0;
  for (const g of historyGenres) {
    if (genres.includes(String(g).toLowerCase())) histHits += 1;
  }
  score += Math.min(3, histHits);
  return score;
}

/** Human-readable fallback reason for a pick. */
function heuristicReason(row, isAuthed) {
  const genres = rowGenres(row).slice(0, 2);
  const rating = rowRating(row);
  if (isAuthed && genres.length > 0) {
    return `${row.title} lines up with the genres you have been enjoying — ${genres.join(' and ')} done right.`;
  }
  if (rating > 0) {
    return `${row.title} is one of the highest-rated ${row.type || 'titles'} on Animaxia right now.`;
  }
  return `${row.title} is a fresh ${row.type || 'title'} worth a spot on your watchlist.`;
}

/** Load the user's taste profile: preference JSONB + genres from watch history. */
async function loadTasteProfile(user) {
  if (!user) return null;
  const prefs = user.preferences && typeof user.preferences === 'object' ? user.preferences : {};
  const profile = {
    types: Array.isArray(prefs.types) ? prefs.types.map(String) : [],
    genres: Array.isArray(prefs.genres) ? prefs.genres.map(String) : [],
    franchises: Array.isArray(prefs.franchises) ? prefs.franchises.map(String) : [],
  };
  let historyGenres = [];
  try {
    const history = await rows(
      `SELECT c.metadata FROM watchhistory wh
       JOIN content c ON c.id = wh.contentid
       WHERE wh.userid = $1
       ORDER BY wh.watchedat DESC LIMIT 20`,
      [user.id],
    );
    const seen = new Set();
    for (const r of history) {
      const meta = typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata ?? {};
      for (const g of Array.isArray(meta.genres) ? meta.genres : []) {
        if (!seen.has(String(g))) seen.add(String(g));
      }
    }
    historyGenres = [...seen];
  } catch {
    historyGenres = []; // watch history unavailable — preferences still apply
  }
  return { profile, historyGenres };
}

/* ---------------------------------- router ----------------------------------- */

const router = express.Router();

/**
 * GET /api/ai/recommendations?limit=10 — personalised picks.
 * LLM ranks a compact candidate list; unmatched slots are filled from the
 * heuristic ordering. Cached per user (or 'anon') for 5 minutes.
 */
router.get('/recommendations', quotaGuard, wrap(async (req, res) => {
  const limit = Math.min(20, Math.max(1, parseInt(req.query.limit, 10) || 10));
  const user = req.user || null;
  const cacheKey = advancedCache.userKey(user ? user.id : 'anon', `ai:recs:${limit}`);

  const cached = advancedCache.get(cacheKey);
  if (cached) {
    return res.json({ ...cached, cached: true });
  }

  const list = await listContent({ limit: 100, page: 1 });
  const rowsAll = list.data || [];
  if (rowsAll.length === 0) {
    return res.json({ data: [], provider: 'heuristic' });
  }

  const taste = await loadTasteProfile(user);
  const profileTypes = taste?.profile.types || [];
  const profileGenres = taste?.profile.genres || [];
  const historyGenres = taste?.historyGenres || [];

  const ranked = rowsAll
    .map((row) => ({
      row,
      score: heuristicScore(row, profileTypes, profileGenres, historyGenres),
    }))
    .sort((a, b) => b.score - a.score || a.row.id - b.row.id);

  // Compact candidate list (max 40) for the LLM prompt.
  const candidates = ranked.slice(0, 40).map(({ row }) => ({
    title: row.title,
    type: row.type,
    genres: rowGenres(row).slice(0, 3),
    rating: rowRating(row) || null,
  }));

  const systemPrompt =
    'You are Animaxia\'s recommendation engine. Respond ONLY with valid JSON: ' +
    '{"picks":[{"title":"<exact title from list>","reason":"<one sentence, energetic, <120 chars>"}]}';
  const userMessage =
    `Candidate titles (JSON lines):\n${candidates.map((c) => JSON.stringify(c)).join('\n')}\n\n` +
    (user
      ? `User taste profile: ${JSON.stringify(taste.profile)}. Recently watched genres: ${JSON.stringify(historyGenres)}.\n`
      : 'No user taste data available — recommend broadly appealing titles.\n') +
    `Pick exactly ${Math.min(limit, candidates.length)} titles. Return ONLY the JSON object.`;

  let picks = [];
  let provider = 'heuristic';
  const raw = await complete([
    { role: 'assistant', content: systemPrompt },
    { role: 'user', content: userMessage },
  ]);
  const parsed = parseJsonLoose(raw);
  if (parsed?.picks && Array.isArray(parsed.picks)) {
    const byTitle = new Map(rowsAll.map((r) => [String(r.title || '').toLowerCase(), r]));
    const used = new Set();
    for (const pick of parsed.picks) {
      const title = String(pick?.title || '').toLowerCase();
      const row = byTitle.get(title);
      if (row && !used.has(row.id)) {
        used.add(row.id);
        const reason =
          typeof pick.reason === 'string' && pick.reason.trim()
            ? pick.reason.trim().slice(0, 160)
            : heuristicReason(row, Boolean(user));
        picks.push({ content: row, reason });
      }
      if (picks.length >= limit) break;
    }
    if (picks.length > 0) provider = 'z-ai';
  }

  // Fill any remaining slots from the heuristic ordering.
  if (picks.length < limit) {
    const used = new Set(picks.map((p) => p.content.id));
    for (const { row } of ranked) {
      if (picks.length >= limit) break;
      if (used.has(row.id)) continue;
      picks.push({ content: row, reason: heuristicReason(row, Boolean(user)) });
    }
  }

  const payload = { data: picks, provider };
  advancedCache.set(cacheKey, payload, { ttlMs: 300000, tags: ['users', 'content'] });
  return res.json(payload);
}));

/**
 * POST /api/ai/summarize { contentId } — 3-4 sentence summary + 3 key points.
 * Cached globally per content for 10 minutes (tag 'content').
 */
router.post('/summarize', quotaGuard, wrap(async (req, res) => {
  const contentId = Number(req.body?.contentId);
  if (!Number.isInteger(contentId) || contentId <= 0) {
    return res.status(400).json({ error: 'Missing or invalid contentId' });
  }

  const cacheKey = `ai:summarize:${contentId}`;
  const cached = advancedCache.get(cacheKey);
  if (cached) {
    return res.json({ ...cached, cached: true });
  }

  const content = await getContentById(contentId);
  if (!content) return res.status(404).json({ error: 'Content not found' });

  const meta = content.metadata || {};
  const source = meta.overview || meta.synopsis || meta.description || '';
  if (!source || !String(source).trim()) {
    const payload = { summary: `No synopsis available yet for ${content.title}.`, provider: 'heuristic' };
    advancedCache.set(cacheKey, payload, { ttlMs: 600000, tags: ['content'] });
    return res.json(payload);
  }

  const raw = await complete([
    {
      role: 'assistant',
      content:
        "You are Animaxia's synopsis writer. Produce a tight 3-4 sentence summary of the given title, " +
        'followed by exactly 3 key-point bullets, each on its own line starting with "- ". No preamble.',
    },
    {
      role: 'user',
      content: `Title: ${content.title}\nType: ${content.type || 'unknown'}\nSynopsis: ${String(source).slice(0, 4000)}`,
    },
  ]);

  let payload;
  if (raw) {
    payload = { summary: raw, provider: 'z-ai' };
  } else {
    // Heuristic: first two sentences of the source + a clear note.
    const sentences = String(source).match(/[^.!?]+[.!?]+/g) || [String(source)];
    const lead = sentences.slice(0, 2).join(' ').trim();
    payload = {
      summary: `${lead}\n\n- Summary auto-generated from the available synopsis.\n- AI summarisation is temporarily unavailable.\n- Check back shortly for the full AI-written overview.`,
      provider: 'heuristic',
    };
  }

  advancedCache.set(cacheKey, payload, { ttlMs: 600000, tags: ['content'] });
  return res.json(payload);
}));

/**
 * POST /api/ai/describe { title, type, genres? } — marketing blurb.
 * Public, 10/min per IP, anonymous daily quota applies.
 */
router.post(
  '/describe',
  userRateLimit({ scope: 'ip', max: 10, windowMs: 60000, key: 'ai-describe' }),
  quotaGuard,
  wrap(async (req, res) => {
    const { title, type, genres } = req.body || {};
    if (!title || !type || typeof title !== 'string' || typeof type !== 'string') {
      return res.status(400).json({ error: 'Missing required fields: title, type' });
    }
    const genreList = Array.isArray(genres) ? genres.map(String).filter(Boolean) : [];

    const raw = await complete([
      {
        role: 'assistant',
        content:
          "You are Animaxia's streaming-platform copywriter. Write a compelling, energetic 2-3 sentence " +
          'description for the given title. No preamble, no quotes, just the description text.',
      },
      {
        role: 'user',
        content: `Title: ${title}\nType: ${type}${genreList.length ? `\nGenres: ${genreList.join(', ')}` : ''}`,
      },
    ]);

    if (raw) {
      return res.json({ description: raw, provider: 'z-ai' });
    }
    return res.json({
      description: `${title} is a ${type} title${genreList.length ? ` blending ${genreList.slice(0, 3).join(', ')}` : ''} — stream it now on Animaxia.`,
      provider: 'heuristic',
    });
  }),
);

/**
 * POST /api/ai/chat { contentId, message } — content-scoped assistant chat.
 * requireAuth + 30/min per user. History: the user's last 10 messages for this
 * content (user-scoped for privacy), replayed to the LLM in chronological order.
 */
router.post(
  '/chat',
  requireAuth,
  userRateLimit({ scope: 'user', max: 30, windowMs: 60000, key: 'ai-chat' }),
  quotaGuard,
  wrap(async (req, res) => {
    const { contentId, message } = req.body || {};
    const text = typeof message === 'string' ? message.trim() : '';
    if (!Number.isInteger(Number(contentId)) || Number(contentId) <= 0) {
      return res.status(400).json({ error: 'Missing or invalid contentId' });
    }
    if (text.length < 1 || text.length > 1000) {
      return res.status(400).json({ error: 'message must be between 1 and 1000 characters' });
    }

    const content = await getContentById(Number(contentId));
    if (!content) return res.status(404).json({ error: 'Content not found' });

    let history = [];
    try {
      const recent = await rows(
        `SELECT role, message FROM aichats
         WHERE contentid = $1 AND userid = $2
         ORDER BY createdat DESC, id DESC LIMIT 10`,
        [Number(contentId), req.user.id],
      );
      history = recent
        .map((r) => ({ role: r.role === 'assistant' ? 'assistant' : 'user', content: String(r.message) }))
        .reverse(); // chronological order for the LLM
    } catch {
      history = [];
    }

    const meta = content.metadata || {};
    const overview = String(meta.overview || meta.synopsis || meta.description || '').slice(0, 500);
    const systemPrompt =
      `You are Animaxia's assistant for "${content.title}", a ${content.type || 'title'}${rowGenres(content).length ? ` (${rowGenres(content).slice(0, 4).join(', ')})` : ''}. ` +
      `Stay on topic, be enthusiastic but concise (max ~120 words). Context: ${overview || 'no synopsis available'}`;

    const raw = await complete([
      { role: 'assistant', content: systemPrompt },
      ...history,
      { role: 'user', content: text },
    ]);

    let reply;
    let provider = 'heuristic';
    if (raw) {
      reply = raw;
      provider = 'z-ai';
    } else {
      reply =
        `${content.title} is a ${content.type || 'title'}${rowGenres(content).length ? ` blending ${rowGenres(content).slice(0, 3).join(', ')}` : ''} in the Animaxia library. ` +
        (overview ? `Here is what we know: ${overview}` : 'We do not have a synopsis for this title yet.') +
        ' The AI assistant is briefly offline — try the AI summary on the title page (POST /api/ai/summarize) for a quick overview.';
    }

    // Persist both turns (user message + reply) for future context.
    try {
      await rows(
        `INSERT INTO aichats (contentid, userid, role, message) VALUES ($1, $2, 'user', $3), ($1, $2, 'assistant', $4)`,
        [Number(contentId), req.user.id, text, reply],
      );
    } catch (err) {
      logger.warn(`[ai] Failed to persist chat turns: ${err.message}`);
    }

    return res.json({ reply, provider });
  }),
);

/**
 * GET /api/ai/status — provider health + daily usage counters (no quota cost).
 */
router.get('/status', (req, res) => {
  if (globalDaily.date !== today()) globalDaily.count = 0;
  res.json({
    provider: 'z-ai',
    available: zaiAvailable,
    ...(zaiLastError ? { lastError: zaiLastError } : {}),
    model: 'z-ai-chat',
    requestsToday: globalDaily.count,
    quota: {
      free: planLimits('free').aiPerDay,
      plus: planLimits('plus').aiPerDay,
      pro: planLimits('pro').aiPerDay,
      anonymous: ANON_DAILY_LIMIT,
    },
  });
});

export default router;
