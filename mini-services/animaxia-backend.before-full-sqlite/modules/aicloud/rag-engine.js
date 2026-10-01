/**
 * modules/aicloud/rag-engine.js — Retrieval-Augmented Generation (Phase 4, req 3).
 *
 * Pipeline: query → retrieve (vector + metadata) → rank → prompt → LLM
 *   1. RETRIEVE — vector similarity over content embeddings (vector-service);
 *      the primary title (chat/explain/summarize modes) is fetched directly
 *      and enriched with its most similar neighbors.
 *   2. RANK — hybrid score: 0.62·vector + 0.18·lexical overlap + 0.10·user
 *      affinity (types/genres) + 0.10·popularity (rating).
 *   3. PROMPT — mode-aware prompt + token-budgeted context (llm-core
 *      buildPrompt/buildContext), retrieved text wrapped in delimiters so
 *      embedded instructions cannot hijack the model (guardrail).
 *   4. LLM — llm-core provider chain; every mode has a deterministic composer
 *      used as the mock/degraded fallback, so RAG never fails offline.
 *
 * Modes (requirement 3):
 *   • recommendations    → ranked library picks with reasons
 *   • summaries          → watch-decision summary of one title
 *   • explanations       → why this title matches (or not) this viewer
 *   • chat-with-content  → spoiler-safe conversation about one title
 *
 * Exposed programmatic API (router + personal + tools):
 *   runRag({ mode, query, user, contentId, history, topK, limit, traceId }),
 *   moreLikeThis(contentId, k), userMatchScore(user, contentId),
 *   loadProfileText(user), rankDocs(query, docs, user)
 */

import crypto from 'node:crypto';
import { getContentById, listContent } from '../../db.js';
import { rows, parseJsonb } from '../platform/sql.js';
import { llmComplete, buildPrompt, buildContext } from './llm-core.js';
import { vectorSearch } from './vector-service.js';

/* --------------------------------- helpers --------------------------------- */

function rowMeta(row) {
  const meta = row?.metadata && typeof row.metadata === 'object' ? row.metadata : {};
  return {
    genres: Array.isArray(meta.genres) ? meta.genres.map(String) : [],
    rating: typeof meta.rating === 'number' ? meta.rating : typeof meta.score === 'number' ? meta.score : null,
    year: meta.year ?? null,
    overview: [meta.overview, meta.synopsis, meta.description].filter(Boolean).join(' ') || '',
  };
}

function rowToDoc(row, score = 0) {
  const meta = rowMeta(row);
  return {
    id: row.id,
    title: row.title,
    type: row.type || 'title',
    thumbnail: row.thumbnail ?? null,
    genres: meta.genres,
    rating: meta.rating,
    year: meta.year,
    text: [row.title, row.type, meta.genres.join(', '), meta.overview].filter(Boolean).join('. '),
    score,
  };
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
}

/** Lexical overlap: share of query tokens present in the doc text. */
function lexicalOverlap(query, docText) {
  const qTokens = [...new Set(tokenize(query))];
  if (!qTokens.length) return 0;
  const dTokens = new Set(tokenize(docText));
  let hits = 0;
  for (const t of qTokens) if (dTokens.has(t)) hits += 1;
  return hits / qTokens.length;
}

/**
 * Load the caller's taste profile (preferences + watch-history genres),
 * self-contained twin of the Phase-2 helper — works for anonymous (null).
 */
export async function loadProfileText(user) {
  if (!user) return null;
  const prefs = user.preferences && typeof user.preferences === 'object' ? user.preferences : {};
  const parts = [
    `viewer ${user.username} (${user.plan || 'free'} plan)`,
    Array.isArray(prefs.types) && prefs.types.length ? `enjoys types: ${prefs.types.join(', ')}` : '',
    Array.isArray(prefs.genres) && prefs.genres.length ? `loves genres: ${prefs.genres.join(', ')}` : '',
    Array.isArray(prefs.franchises) && prefs.franchises.length ? `follows franchises: ${prefs.franchises.join(', ')}` : '',
  ];
  try {
    const history = await rows(
      `SELECT c.title, c.metadata FROM watchhistory wh JOIN content c ON c.id = wh.contentid
       WHERE wh.userid = $1 ORDER BY wh.watchedat DESC LIMIT 12`,
      [user.id],
    );
    const genres = new Set();
    const titles = [];
    for (const r of history) {
      titles.push(r.title);
      const meta = parseJsonb(r.metadata, {});
      if (Array.isArray(meta.genres)) meta.genres.forEach((g) => genres.add(String(g)));
    }
    if (titles.length) parts.push(`recently watched: ${titles.join(', ')}`);
    if (genres.size) parts.push(`history genres: ${[...genres].slice(0, 10).join(', ')}`);
  } catch {
    /* history enrichment is optional */
  }
  return parts.filter(Boolean).join('. ');
}

/** User-affinity score 0..1 for a doc (type + genre overlap). */
function userAffinity(doc, profileText) {
  if (!profileText) return 0;
  const lower = profileText.toLowerCase();
  let score = 0;
  if (doc.type && lower.includes(String(doc.type).toLowerCase())) score += 0.4;
  let genreHits = 0;
  for (const genre of doc.genres || []) {
    if (lower.includes(String(genre).toLowerCase())) genreHits += 1;
  }
  score += Math.min(0.6, genreHits * 0.3);
  return Math.min(1, score);
}

/**
 * RANK step — hybrid re-scoring of retrieved docs (requirement 3).
 * @param {string} query  @param {Array} docs  @param {string|null} profileText
 */
export function rankDocs(query, docs, profileText = null) {
  return docs
    .map((doc) => {
      const vec = Math.max(0, doc.score ?? 0);
      const lex = lexicalOverlap(query, doc.text || doc.title || '');
      const aff = userAffinity(doc, profileText);
      const pop = Math.min(1, (doc.rating ?? 0) / 10);
      return { ...doc, rankScore: Number((0.62 * vec + 0.18 * lex + 0.1 * aff + 0.1 * pop).toFixed(4)) };
    })
    .sort((a, b) => b.rankScore - a.rankScore);
}

/** Retrieve + rank library docs for a query. */
async function retrieveRanked({ query, user, topK = 18, limit = 6 }) {
  const profileText = await loadProfileText(user);
  const search = await vectorSearch({ query, kind: 'content', topK });
  let docs = search.data.map((r) => ({
    id: r.refid,
    title: r.title,
    type: r.type,
    thumbnail: r.thumbnail,
    genres: Array.isArray(r.genres) ? r.genres : [],
    rating: r.metadata?.rating ?? null,
    year: r.metadata?.year ?? null,
    text: r.snippet || '',
    score: r.score,
  }));

  // Guarantee a usable candidate set even with an empty vector index.
  if (docs.length < 3) {
    const fresh = await listContent({ page: 1, limit: 24 });
    const seen = new Set(docs.map((d) => d.id));
    for (const row of fresh.data) {
      if (!seen.has(row.id)) docs.push(rowToDoc(row, 0));
    }
  }
  const ranked = rankDocs(query, docs, profileText);
  return { ranked: ranked.slice(0, Math.max(1, Math.min(10, limit))), profileText, backend: search.backend };
}

/** "More like this" — nearest neighbors of one content row. */
export async function moreLikeThis(contentId, k = 6) {
  const row = await getContentById(contentId);
  if (!row) throw Object.assign(new Error('Content not found'), { status: 404 });
  const doc = rowToDoc(row);
  const search = await vectorSearch({ query: doc.text, kind: 'content', topK: k + 3 });
  return search.data
    .filter((r) => r.refid !== Number(contentId))
    .slice(0, k)
    .map((r) => ({
      id: r.refid,
      title: r.title,
      type: r.type,
      thumbnail: r.thumbnail,
      genres: r.genres,
      score: r.score,
    }));
}

/** How well one title matches the user's taste embedding (0..1 or null). */
export async function userMatchScore(user, contentId) {
  if (!user) return null;
  const profileText = await loadProfileText(user);
  if (!profileText) return null;
  try {
    const search = await vectorSearch({ query: profileText, kind: 'content', topK: 60 });
    const hit = search.data.find((r) => r.refid === Number(contentId));
    return hit ? Number(hit.score.toFixed(3)) : 0.05;
  } catch {
    return null;
  }
}

/* ------------------------- deterministic composers -------------------------- */

function heuristicReason(doc, profileText, query) {
  const genres = (doc.genres || []).slice(0, 2).join(' and ');
  if (query && lexicalOverlap(query, doc.title) > 0) {
    return `directly matches your search — ${doc.title} hits the themes you asked for${genres ? ` (${genres})` : ''}.`;
  }
  if (genres && profileText && profileText.toLowerCase().includes(genres.split(' and ')[0].toLowerCase())) {
    return `${doc.title} plays in the ${genres} space you have been enjoying lately.`;
  }
  if (doc.rating && doc.rating >= 7.5) {
    return `${doc.title} is one of the highest-rated ${doc.type || 'titles'} on Animaxia right now.`;
  }
  return `${doc.title} is a fresh ${doc.type || 'title'} that fits the Animaxia library mix you are browsing.`;
}

function composeRecommend(ranked, query, profileText) {
  const intro = query
    ? `Here are the Animaxia picks for “${String(query).slice(0, 80)}”:`
    : 'Here are today’s Animaxia picks for you:';
  const bullets = ranked
    .slice(0, 6)
    .map((d) => `- ${d.title} (${d.type || 'title'}) — ${heuristicReason(d, profileText, query)}`)
    .join('\n');
  return `${intro}\n${bullets}`;
}

function firstSentences(text, n = 2) {
  return String(text || '')
    .split(/(?<=[.!?])\s+/)
    .filter(Boolean)
    .slice(0, n)
    .join(' ');
}

function composeSummary(content, doc) {
  const meta = rowMeta(content);
  const genreBit = meta.genres.length ? ` A ${meta.genres.slice(0, 3).join(' / ')} ${content.type || 'title'}` : ` A ${content.type || 'title'}`;
  const pitch = meta.overview
    ? firstSentences(meta.overview, 2)
    : 'The library metadata for this title is light, but it earns its spot in the catalog.';
  return [
    `${content.title}${meta.year ? ` (${meta.year})` : ''} is${genreBit} on Animaxia.${meta.rating ? ` It holds a strong ${meta.rating.toFixed ? meta.rating.toFixed(1) : meta.rating} rating.` : ''}`,
    pitch,
    `Worth your time if you like ${meta.genres.length ? meta.genres.slice(0, 3).join(', ').toLowerCase() : 'well-crafted ' + (content.type || 'titles')} — a solid pick for your next session.`,
  ].join('\n\n');
}

function composeExplain(content, user, matchScore) {
  const meta = rowMeta(content);
  const genres = meta.genres.slice(0, 3).join(', ') || 'its genre space';
  if (user && matchScore != null) {
    const strength = matchScore >= 0.55 ? 'a strong match' : matchScore >= 0.3 ? 'a good match' : 'an adventurous detour';
    return [
      `${content.title} is ${strength} for your taste profile (match score ${(matchScore * 100).toFixed(0)}%).`,
      `It lives in ${genres}${meta.year ? ` and arrived in ${meta.year}` : ''}. Viewers who enjoyed your recent watch history tend to rate its mix highly${meta.rating ? ` — it sits at ${meta.rating.toFixed ? meta.rating.toFixed(1) : meta.rating} on the platform` : ''}.`,
      matchScore < 0.3
        ? 'If you want something closer to your usual picks, the More-like-this row below has tighter matches.'
        : 'Expect the pacing and themes you have been enjoying lately.',
    ].join(' ');
  }
  return [
    `${content.title} is a ${content.type || 'title'} anchored in ${genres}.`,
    meta.overview ? firstSentences(meta.overview, 2) : '',
    meta.rating ? `The community rates it ${meta.rating.toFixed ? meta.rating.toFixed(1) : meta.rating}.` : '',
    'Sign in and Animaxia AI will score the match against your personal taste embedding.',
  ]
    .filter(Boolean)
    .join(' ');
}

function composeChat(message, content, similar) {
  const meta = rowMeta(content);
  const similarTitles = similar.slice(0, 3).map((s) => s.title).join(', ');
  return [
    `About ${content.title}${meta.year ? ` (${meta.year})` : ''} — ${meta.genres.length ? `a ${meta.genres.slice(0, 3).join(' / ')} ${content.type || 'title'}` : `a ${content.type || 'title'}`} from the Animaxia library:`,
    meta.overview ? firstSentences(meta.overview, 2) : 'The catalog metadata is light on plot details for this one.',
    `On “${String(message).slice(0, 120)}” — the safest answer stays spoiler-free: watch the first act and let the setup speak for itself.`,
    similarTitles ? `If it clicks, similar titles on Animaxia: ${similarTitles}.` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** Parse "- Title (type) — reason" bullets out of an LLM recommendation text. */
function extractReasons(text) {
  const map = new Map();
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^\s*[-•*]\s*(.+?)\s+[—–-]\s+(.+)$/);
    if (m) {
      const title = m[1].replace(/\s*\([^)]*\)\s*$/, '').trim().toLowerCase();
      if (title.length > 1) map.set(title, m[2].trim());
    }
  }
  return map;
}

/* ---------------------------------- runRag --------------------------------- */

/**
 * Run the full RAG pipeline for one mode. Never throws for LLM reasons —
 * degradation is flagged via `degraded: true`.
 *
 * @param {object} opts
 * @param {'recommendations'|'summaries'|'explanations'|'chat-with-content'} opts.mode
 * @returns mode-specific result object (see router).
 */
export async function runRag({
  mode,
  query = '',
  user = null,
  contentId = null,
  history = [],
  topK = 18,
  limit = 6,
  traceId = null,
} = {}) {
  const id = traceId || crypto.randomUUID();

  /* --------------------------- mode: recommendations -------------------------- */
  if (mode === 'recommendations') {
    let effectiveQuery = String(query || '').trim();
    if (!effectiveQuery) {
      const profileText = await loadProfileText(user);
      effectiveQuery = profileText
        ? profileText.slice(0, 400)
        : 'popular high-quality movies tv anime on Animaxia';
    }
    const { ranked, profileText } = await retrieveRanked({ query: effectiveQuery, user, topK, limit });
    const picks = ranked.slice(0, limit);
    const context = buildContext({
      docs: picks.map((d) => ({ title: d.title, type: d.type, genres: d.genres, text: d.text })),
      profile: user
        ? { username: user.username, plan: user.plan, types: user.preferences?.types, genres: user.preferences?.genres }
        : null,
      budgetTokens: 1500,
    });
    const prompt = buildPrompt('recommendations', { query: effectiveQuery, context });
    const result = await llmComplete({
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
      feature: 'rag',
      mode: 'recommendations',
      user,
      query: effectiveQuery,
      traceId: id,
      fallback: () => composeRecommend(picks, query, profileText),
    });

    const reasons = extractReasons(result.text);
    const data = picks.map((d) => {
      const llmReason = reasons.get(String(d.title).toLowerCase());
      return {
        id: d.id,
        title: d.title,
        type: d.type,
        thumbnail: d.thumbnail,
        rating: d.rating,
        year: d.year,
        genres: d.genres,
        score: d.rankScore,
        reason: llmReason || heuristicReason(d, profileText, query),
      };
    });
    return {
      ok: true,
      mode,
      provider: result.provider,
      degraded: result.degraded,
      traceId: id,
      query: query || null,
      personalized: Boolean(user),
      data,
      intro: data.length && !result.degraded ? firstSentences(result.text, 1) : null,
    };
  }

  /* -------------------- content-anchored modes (need a row) -------------------- */
  const content = contentId != null ? await getContentById(contentId) : null;
  if (!content) {
    throw Object.assign(new Error('Content not found'), { status: 404 });
  }
  const doc = rowToDoc(content, 1);
  const similar = await moreLikeThis(content.id, 5).catch(() => []);
  const profileText = await loadProfileText(user);

  /* ------------------------------ mode: summaries ----------------------------- */
  if (mode === 'summaries') {
    const context = buildContext({
      docs: [doc, ...similar.slice(0, 2).map((s) => ({ title: s.title, type: s.type, text: `similar: ${s.title}` }))],
      budgetTokens: 1200,
    });
    const prompt = buildPrompt('summaries', { query: `Summarize ${content.title} for a viewer deciding whether to watch it.`, context });
    const result = await llmComplete({
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
      feature: 'rag',
      mode: 'summaries',
      user,
      query: `summarize:${content.title}`,
      traceId: id,
      fallback: () => composeSummary(content, doc),
    });
    return {
      ok: true,
      mode,
      provider: result.provider,
      degraded: result.degraded,
      traceId: id,
      contentId: content.id,
      title: content.title,
      summary: result.text,
    };
  }

  /* ----------------------------- mode: explanations --------------------------- */
  if (mode === 'explanations') {
    const matchScore = await userMatchScore(user, content.id);
    const context = buildContext({
      docs: [doc],
      profile: user
        ? { username: user.username, plan: user.plan, types: user.preferences?.types, genres: user.preferences?.genres }
        : null,
      extra: profileText ? `[VIEWER TASTE] ${profileText.slice(0, 400)}\n[COMPUTED MATCH SCORE] ${matchScore ?? 'n/a'}` : '',
      budgetTokens: 1200,
    });
    const question =
      String(query || '').trim() ||
      `Explain why ${content.title} is (or is not) a good match for this viewer.`;
    const prompt = buildPrompt('explanations', { query: question, context });
    const result = await llmComplete({
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
      feature: 'rag',
      mode: 'explanations',
      user,
      query: `explain:${content.title}`,
      traceId: id,
      fallback: () => composeExplain(content, user, matchScore),
    });
    return {
      ok: true,
      mode,
      provider: result.provider,
      degraded: result.degraded,
      traceId: id,
      contentId: content.id,
      title: content.title,
      matchScore,
      explanation: result.text,
      similar: similar.slice(0, 3),
    };
  }

  /* --------------------------- mode: chat-with-content ------------------------ */
  if (mode === 'chat-with-content') {
    const message = String(query || '').trim();
    if (!message) throw Object.assign(new Error('Message is required'), { status: 400 });
    const context = buildContext({
      docs: [doc],
      extra: similar.length ? `[SIMILAR ON ANIMAXIA] ${similar.map((s) => s.title).join(', ')}` : '',
      budgetTokens: 1200,
    });
    const safeHistory = Array.isArray(history)
      ? history
          .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
          .slice(-8)
      : [];
    const prompt = buildPrompt('chat-with-content', { query: message, context, history: safeHistory });
    const result = await llmComplete({
      messages: [
        { role: 'system', content: prompt.system },
        ...safeHistory.map((m) => ({ role: m.role, content: m.content })),
        { role: 'user', content: prompt.user },
      ],
      feature: 'rag',
      mode: 'chat-with-content',
      user,
      query: message,
      traceId: id,
      fallback: () => composeChat(message, content, similar),
    });
    return {
      ok: true,
      mode,
      provider: result.provider,
      degraded: result.degraded,
      traceId: id,
      contentId: content.id,
      title: content.title,
      reply: result.text,
      sources: [
        { id: content.id, title: content.title, score: 1 },
        ...similar.slice(0, 3).map((s) => ({ id: s.id, title: s.title, score: Number(s.score.toFixed(3)) })),
      ],
    };
  }

  throw Object.assign(new Error(`Unknown RAG mode: ${mode}`), { status: 400 });
}

/** Convenience for personal AI: personalized daily picks via the RAG pipeline. */
export async function recommendForUser(user, { limit = 6, traceId = null } = {}) {
  const result = await runRag({ mode: 'recommendations', query: '', user, limit, traceId });
  return result;
}
