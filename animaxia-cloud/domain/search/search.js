/**
 * domain/search/search.js — OpenSearch-style local search engine over the
 * `content` table: inverted index + BM25 ranking (k1=1.2, b=0.75), Levenshtein
 * fuzzy term expansion (distance ≤ 2, max 3 candidate terms per query term),
 * prefix/word-boundary autocomplete, and field filters (type / genre / year /
 * minRating). Engine label: 'animaxia-local-opensearch'.
 *
 * Router (mount: app.use('/api/search', searchRouter)):
 *   GET  /advanced?q=&type=&genre=&year=&minRating=&sort=score|year|rating|title&fuzzy=true&limit=20
 *        → { took, total, max_score, data: [content rows + _score] }          (public)
 *   GET  /autocomplete?q= → { suggestions: [{ id, title, type, thumbnail }] } (public)
 *   POST /index            → { ok, indexed }                                  (requireAdmin)
 *   GET  /status           → { docs, terms, lastSync, dirty, engine }         (public)
 *
 * Auto-resync: subscribes to the `content:changed` platform event at module
 * level → sets the dirty flag → the next query transparently rebuilds the
 * index under an async lock (concurrent requests await the same rebuild).
 */

import express from 'express';
import { rows } from '@animaxia/common/sql.js';
import { requireAuth, requireAdmin } from '../users/auth.js';
import { events } from '@animaxia/common/events.js';
import { logger } from '@animaxia/common/logger.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const ENGINE = 'animaxia-local-opensearch';
const BM25_K1 = 1.2;
const BM25_B = 0.75;

/* ------------------------------- text utilities ------------------------------ */

/** Lowercase, split on non-alphanumerics, drop tokens shorter than 2 chars. */
function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
}

/** Plain dynamic-programming Levenshtein distance (small corpora → fine). */
function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j += 1) prev[j] = j;
  for (let i = 1; i <= m; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/** JSONB-safe parse (pg may hand back a parsed object or a string). */
function parseMeta(value) {
  if (value === null || value === undefined) return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

/** Normalise a content row to the db.js normalizeRow shape (metadata parsed). */
function normalizeRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    externalid: row.externalid ?? null,
    type: row.type ?? null,
    title: row.title ?? null,
    metadata: parseMeta(row.metadata),
    thumbnail: row.thumbnail === undefined ? null : row.thumbnail,
    createdat:
      row.createdat instanceof Date
        ? row.createdat.toISOString()
        : String(row.createdat ?? new Date().toISOString()),
  };
}

/* --------------------------------- the index -------------------------------- */

/** Inverted-index + BM25 search engine over the content table. */
class SearchIndex {
  constructor() {
    /** @type {Map<number, { row: object, terms: Map<string, number>, length: number, genres: string[], year, rating: number, titleLower: string }>} */
    this.docs = new Map();
    /** @type {Map<string, Map<number, number>>} term → (docId → term frequency) */
    this.postings = new Map();
    this.totalDocs = 0;
    this.avgdl = 0;
    this.builtAt = null; // ISO timestamp of the last successful rebuild
    this.dirty = true;
    this.rebuildPromise = null; // async lock — concurrent ensureBuilt() coalesce
  }

  /** Full rebuild from the content table (SELECT via the platform SQL layer). */
  async rebuild() {
    const raw = await rows(
      'SELECT id, externalid, type, title, metadata, thumbnail, createdat FROM content',
    );
    const docs = new Map();
    const postings = new Map();
    let totalLength = 0;

    for (const rawRow of raw) {
      const row = normalizeRow(rawRow);
      if (!row || row.id == null) continue;
      const meta = row.metadata || {};
      const genres = Array.isArray(meta.genres) ? meta.genres.map((g) => String(g)) : [];
      const ratingValue = Number(meta.rating ?? meta.score);
      const yearValue = meta.year ?? null;

      const text = [
        row.title,
        meta.overview || '',
        meta.synopsis || '',
        meta.description || '',
        genres.join(' '),
        row.type || '',
      ].join(' ');

      const tokens = tokenize(text);
      const terms = new Map();
      for (const token of tokens) {
        terms.set(token, (terms.get(token) || 0) + 1);
      }
      for (const [term, tf] of terms) {
        let posting = postings.get(term);
        if (!posting) {
          posting = new Map();
          postings.set(term, posting);
        }
        posting.set(row.id, tf);
      }

      docs.set(row.id, {
        row,
        terms,
        length: tokens.length,
        genres,
        year: yearValue,
        rating: Number.isFinite(ratingValue) ? ratingValue : 0,
        titleLower: String(row.title || '').toLowerCase(),
      });
      totalLength += tokens.length;
    }

    this.docs = docs;
    this.postings = postings;
    this.totalDocs = docs.size;
    this.avgdl = docs.size > 0 ? totalLength / docs.size : 0;
    this.builtAt = new Date().toISOString();
    this.dirty = false;
    return this.totalDocs;
  }

  /** Rebuild once under an async lock; concurrent callers await the same run. */
  async ensureBuilt() {
    if (!this.dirty && this.builtAt) return;
    if (!this.rebuildPromise) {
      this.rebuildPromise = this.rebuild().finally(() => {
        this.rebuildPromise = null;
      });
    }
    await this.rebuildPromise;
  }

  /** BM25 contribution of one term for one document. */
  bm25(term, doc) {
    const posting = this.postings.get(term);
    if (!posting) return 0;
    const df = posting.size;
    const tf = doc.terms.get(term) || 0;
    if (tf === 0) return 0;
    const N = this.totalDocs || 1;
    const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
    const avgdl = this.avgdl > 0 ? this.avgdl : 1; // guard zero-length corpus
    const norm = tf + BM25_K1 * (1 - BM25_B + BM25_B * (doc.length / avgdl));
    return idf * ((tf * (BM25_K1 + 1)) / norm);
  }

  /**
   * Expand a query term: exact postings when present, otherwise the union of
   * postings for dictionary terms within Levenshtein distance ≤ 2 (max 3).
   */
  expandTerm(term) {
    const exact = this.postings.get(term);
    if (exact) return [{ term, posting: exact }];
    const candidates = [];
    for (const candidate of this.postings.keys()) {
      const distance = levenshtein(term, candidate);
      if (distance <= 2) {
        candidates.push({ term: candidate, distance });
        if (candidates.length >= 12) break; // bound the scan before ranking
      }
    }
    candidates.sort((a, b) => a.distance - b.distance);
    return candidates
      .slice(0, 3)
      .map((c) => ({ term: c.term, posting: this.postings.get(c.term) }))
      .filter((c) => c.posting);
  }

  /** Operational snapshot for GET /status. */
  status() {
    return {
      docs: this.totalDocs,
      terms: this.postings.size,
      lastSync: this.builtAt,
      dirty: this.dirty,
      engine: ENGINE,
    };
  }
}

const index = new SearchIndex();

// content:changed → mark dirty; the next query rebuilds under the async lock.
events.on('content:changed', () => {
  index.dirty = true;
});

/* ------------------------------ query evaluation ----------------------------- */

/**
 * Run an advanced query against the index.
 * @returns {{ took: number, total: number, max_score: number, data: object[] }}
 */
function runAdvancedQuery({ q, type, genre, year, minRating, sort, fuzzy, limit }) {
  const startedAt = Date.now();
  const fuzzyEnabled = fuzzy !== 'false'; // default on
  const queryTerms = tokenize(q);

  // Candidate scoring: for each query term use the exact postings when the term
  // exists, otherwise the union of its ≤2-distance fuzzy variants (max 3). Each
  // expansion contributes its own BM25 score, so typo matches still rank.
  const docScores = new Map();
  for (const term of queryTerms) {
    const expansions = fuzzyEnabled
      ? index.expandTerm(term)
      : index.postings.has(term)
        ? [{ term, posting: index.postings.get(term) }]
        : [];
    for (const { term: expandedTerm, posting } of expansions) {
      for (const docId of posting.keys()) {
        const doc = index.docs.get(docId);
        if (!doc) continue;
        docScores.set(docId, (docScores.get(docId) || 0) + index.bm25(expandedTerm, doc));
      }
    }
  }

  // Field filters.
  const genreNeedle = genre ? String(genre).toLowerCase() : null;
  const yearNeedle = year != null ? String(year) : null;
  const minRatingValue = Number.isFinite(Number(minRating)) ? Number(minRating) : null;
  const filtered = [];
  for (const [docId, score] of docScores) {
    const doc = index.docs.get(docId);
    if (!doc || score <= 0) continue;
    if (type && doc.row.type !== type) continue;
    if (genreNeedle && !doc.genres.some((g) => g.toLowerCase() === genreNeedle)) continue;
    if (yearNeedle && String(doc.year ?? '') !== yearNeedle) continue;
    if (minRatingValue !== null && doc.rating < minRatingValue) continue;
    filtered.push({ doc, score });
  }

  // Sorting.
  const sorters = {
    score: (a, b) => b.score - a.score || a.doc.row.id - b.doc.row.id,
    year: (a, b) => {
      const ay = a.doc.year ? Number(a.doc.year) || 0 : null;
      const by = b.doc.year ? Number(b.doc.year) || 0 : null;
      if (ay == null && by == null) return a.doc.row.id - b.doc.row.id;
      if (ay == null) return 1; // missing years last
      if (by == null) return -1;
      return by - ay || a.doc.row.id - b.doc.row.id;
    },
    rating: (a, b) => b.doc.rating - a.doc.rating || b.score - a.score,
    title: (a, b) => a.doc.titleLower.localeCompare(b.doc.titleLower) || a.doc.row.id - b.doc.row.id,
  };
  filtered.sort(sorters[sort] || sorters.score);

  const total = filtered.length;
  const maxScore = total > 0 ? Number(filtered[0].score.toFixed(6)) : 0;
  const data = filtered.slice(0, limit).map(({ doc, score }) => ({
    ...doc.row,
    _score: Number(score.toFixed(6)),
  }));

  return { took: Date.now() - startedAt, total, max_score: maxScore, data };
}

/* ---------------------------------- router ----------------------------------- */

const router = express.Router();

/** GET /api/search/advanced — BM25 + fuzzy + filters. Public. */
router.get('/advanced', wrap(async (req, res) => {
  const q = req.query.q != null ? String(req.query.q).trim() : '';
  if (!q) {
    return res.status(400).json({ error: 'Missing required query parameter: q' });
  }
  await index.ensureBuilt();

  const result = runAdvancedQuery({
    q,
    type: req.query.type ? String(req.query.type) : null,
    genre: req.query.genre ? String(req.query.genre) : null,
    year: req.query.year != null && req.query.year !== '' ? String(req.query.year) : null,
    minRating: req.query.minRating,
    sort: req.query.sort ? String(req.query.sort) : 'score',
    fuzzy: req.query.fuzzy != null ? String(req.query.fuzzy) : 'true',
    limit: Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20)),
  });
  return res.json(result);
}));

/** GET /api/search/autocomplete?q= — prefix/word-boundary title suggestions. Public. */
router.get('/autocomplete', wrap(async (req, res) => {
  const q = req.query.q != null ? String(req.query.q).trim().toLowerCase() : '';
  if (q.length < 1) {
    return res.status(400).json({ error: 'Missing required query parameter: q' });
  }
  await index.ensureBuilt();

  const matches = [];
  for (const doc of index.docs.values()) {
    const title = doc.titleLower;
    const startsWith = title.startsWith(q);
    const wordBoundary = title.includes(` ${q}`);
    if (!startsWith && !wordBoundary) continue;
    matches.push({
      id: doc.row.id,
      title: doc.row.title,
      type: doc.row.type,
      thumbnail: doc.row.thumbnail,
      rating: doc.rating || null,
      startsWith,
    });
  }
  matches.sort((a, b) => {
    if (a.startsWith !== b.startsWith) return a.startsWith ? -1 : 1; // prefix hits first
    return (b.rating || 0) - (a.rating || 0); // then by rating desc
  });

  return res.json({
    suggestions: matches.slice(0, 8).map(({ id, title, type, thumbnail }) => ({ id, title, type, thumbnail })),
  });
}));

/** POST /api/search/index — force a rebuild (admin). */
router.post('/index', requireAuth, requireAdmin, wrap(async (req, res) => {
  const indexed = await index.rebuild();
  logger.info(`[search] Manual reindex by user ${req.user?.id ?? '?'} — ${indexed} docs`);
  return res.json({ ok: true, indexed });
}));

/** GET /api/search/status — index health snapshot. Public. */
router.get('/status', (req, res) => {
  res.json(index.status());
});

export default router;
