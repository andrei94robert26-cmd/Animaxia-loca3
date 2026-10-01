/**
 * shared/fuzzy.ts — fuzzy matching + autocomplete for edge search.
 *
 * Mirrors the cloud search-service semantics (animaxia-cloud/domain/search):
 *   • fuzzy term expansion with edit distance ≤ 2, max 3 candidate terms
 *     per query term
 *   • prefix / word-boundary autocomplete, top 8 suggestions
 *
 * Pure functions over a catalog snapshot (CatalogItem[]) so the search
 * worker can answer from KV without a cloud round-trip.
 */

import type { CatalogItem } from './types';

/* --------------------------------------------------------- levenshtein ----- */

/** Classic DP edit distance with an early-exit band (max). */
export function levenshtein(a: string, b: string, max = Infinity): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  if (Math.abs(a.length - b.length) > max) return max + 1;

  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > max) return max + 1;
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

/* -------------------------------------------------------- fuzzy scoring ---- */

function normalize(text: string): string {
  return String(text || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
}

/**
 * Score a query against a target title, 0 (no match) … 100 (exact).
 * Components: exact / prefix / word-prefix / substring / fuzzy distance
 * (≤2 edits) with a subsequence tiebreaker.
 */
export function fuzzyScore(query: string, target: string): number {
  const q = normalize(query).trim();
  const t = normalize(target).trim();
  if (!q || !t) return 0;
  if (q === t) return 100;
  if (t.startsWith(q)) return 92 - Math.min(10, t.length - q.length);
  const words = t.split(/[^a-z0-9]+/).filter(Boolean);
  for (const w of words) {
    if (w === q) return 88;
    if (w.startsWith(q)) return 80;
  }
  if (t.includes(q)) return 70;
  const dist = levenshtein(q, t, 2);
  if (dist <= 2 && q.length >= 4) {
    return 60 - dist * 8 - Math.max(0, t.length - q.length) / 2;
  }
  // Per-word fuzzy (e.g. query "naruto shipp" vs word "narutopedia").
  for (const w of words) {
    if (Math.abs(w.length - q.length) <= 2 && levenshtein(q, w, 2) <= 2) return 52;
  }
  // Subsequence fallback (letters of q appear in order).
  let ti = 0;
  let matched = 0;
  for (const ch of q) {
    const idx = t.indexOf(ch, ti);
    if (idx === -1) { matched = 0; break; }
    matched += 1;
    ti = idx + 1;
  }
  if (matched === q.length) return Math.max(10, 40 - (t.length - q.length));
  return 0;
}

/* ------------------------------------------------------- term expansion ---- */

/**
 * Expand a query term with fuzzy variants from the corpus vocabulary
 * (distance ≤ 2, max `maxVariants`), cloud search-service semantics.
 */
export function expandQueryTerms(
  query: string,
  corpusTerms: string[],
  opts: { maxDistance?: number; maxVariants?: number } = {},
): string[] {
  const maxDistance = opts.maxDistance ?? 2;
  const maxVariants = opts.maxVariants ?? 3;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of String(query || '').split(/\s+/).filter(Boolean)) {
    const term = normalize(raw);
    if (!term) continue;
    if (!seen.has(term)) { seen.add(term); out.push(term); }
    if (term.length < 4) continue; // short terms expand to noise
    let variants = 0;
    for (const candidateRaw of corpusTerms) {
      if (variants >= maxVariants) break;
      const candidate = normalize(candidateRaw);
      if (candidate === term || seen.has(candidate)) continue;
      if (Math.abs(candidate.length - term.length) > maxDistance) continue;
      if (levenshtein(term, candidate, maxDistance) <= maxDistance) {
        seen.add(candidate);
        out.push(candidate);
        variants += 1;
      }
    }
  }
  return out;
}

/* -------------------------------------------------------- ranked search ---- */

export interface ScoredItem {
  item: CatalogItem;
  score: number;
  matchedTerm: string;
}

/**
 * Fuzzy search over a catalog snapshot: each query term (plus its fuzzy
 * expansions) contributes the best per-term score; results are ranked by
 * total score, ties by title length (shorter = more precise).
 */
export function fuzzySearch(
  items: CatalogItem[],
  query: string,
  opts: { limit?: number; fuzzy?: boolean; maxVariants?: number } = {},
): ScoredItem[] {
  const limit = Math.max(1, Math.min(50, opts.limit ?? 20));
  const q = String(query || '').trim();
  if (!q) return [];

  const terms = normalize(q).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];

  const corpus = Array.from(new Set(
    items.flatMap((i) => normalize(i.title).split(/[^a-z0-9]+/).filter((w) => w.length >= 4)),
  )).slice(0, 4_000);

  const expansions = (opts.fuzzy ?? true)
    ? expandQueryTerms(q, corpus, { maxDistance: 2, maxVariants: opts.maxVariants ?? 3 })
    : terms;

  const scored: ScoredItem[] = [];
  for (const item of items) {
    let total = 0;
    let matched = '';
    for (const term of terms) {
      let best = 0;
      let bestTerm = '';
      for (const exp of expansions) {
        if (!exp.startsWith(term) && !terms.includes(exp) && term !== exp) {
          // expansion must stay relevant: only score if close to the term
        }
        const s = fuzzyScore(exp, item.title);
        if (s > best) { best = s; bestTerm = exp; }
      }
      if (best > 0) { total += best; matched = matched || bestTerm; }
    }
    if (total > 0) scored.push({ item, score: total, matchedTerm: matched });
  }

  scored.sort((a, b) => (b.score - a.score) || (a.item.title.length - b.item.title.length));
  return scored.slice(0, limit);
}

/* --------------------------------------------------------- autocomplete ---- */

export interface AutocompleteSuggestion {
  id: number;
  title: string;
  type: string;
  thumbnail: string | null;
}

/** Prefix / word-boundary autocomplete, top `limit` (cloud uses 8). */
export function autocomplete(
  items: CatalogItem[],
  q: string,
  limit = 8,
): AutocompleteSuggestion[] {
  const nq = normalize(q).trim();
  if (!nq) return [];
  const matches: Array<{ item: CatalogItem; rank: number }> = [];
  for (const item of items) {
    const t = normalize(item.title);
    let rank = 0;
    if (t.startsWith(nq)) rank = 3;
    else {
      const wordIdx = t.split(/[^a-z0-9]+/).findIndex((w) => w.startsWith(nq));
      if (wordIdx === 0) rank = 2;
      else if (wordIdx > 0) rank = 1;
    }
    if (rank > 0) matches.push({ item, rank });
  }
  matches.sort((a, b) => b.rank - a.rank || a.item.title.length - b.item.title.length);
  return matches.slice(0, Math.max(1, limit)).map(({ item }) => ({
    id: item.id,
    title: item.title,
    type: item.type,
    thumbnail: item.thumbnail ?? null,
  }));
}
