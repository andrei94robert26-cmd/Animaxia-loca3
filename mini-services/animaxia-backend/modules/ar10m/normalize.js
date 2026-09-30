/**
 * modules/ar10m/normalize.js — AR10M single source of truth for title
 * normalization, hashing and logical shard assignment (Task AR10M-2-BE).
 *
 * This module is PURE: it imports NOTHING and touches no env side effects
 * beyond reads, so it can be statically imported anywhere (backend modules,
 * tests/bench-ar10m.mjs, scripts/ar10m-rebalance.mjs) without cycles.
 *
 * Invariants pinned by the AR10M spec (do NOT change — ids/shards must stay
 * stable forever):
 *   • normalizeTitle — lowercase, NFKD, strip diacritics (combining marks,
 *     covers Romanian ă â î ș ț and any other Latin diacritics), remove
 *     punctuation (keep letters+digits+spaces), collapse whitespace, trim.
 *   • fnv1a32 — FNV-1a 32-bit (house style, identical to modules/sharding/
 *     model.js fnv1a): h = 0x811c9dc5; per char: h ^= code; h = Math.imul(h,
 *     0x01000193) >>> 0.
 *   • computeShardId — fnv1a32(normalizeTitle(title) + ':' + (year ?? ''))
 *     % AR10M_SHARD_COUNT. Deterministic and stable forever: the logical
 *     shard of a title never changes, regardless of physical placement.
 *   • AR10M_SHARD_COUNT — env AR10M_SHARD_COUNT, default 15, clamped 1..15.
 */

/** Diacritic stripping: NFKD then remove combining marks (U+0300..U+036F). */
const COMBINING_MARKS = /[\u0300-\u036f]/g;

/** Punctuation removal: keep letters, digits and spaces. */
const NON_WORD = /[^\p{L}\p{N} ]+/gu;

/** Whitespace collapse. */
const MULTI_SPACE = /\s+/g;

/**
 * Normalize a title for indexing/search: lowercase → NFKD → strip combining
 * marks (diacritics: ă→a, â→a, î→i, ș→s, ț→t, é→e, ü→u …) → strip
 * punctuation → collapse whitespace → trim.
 * Example: 'Băltăgul — Șoimii Carpaților!' → 'baltagul soimii carpatilor'.
 */
export function normalizeTitle(t) {
  const raw = String(t ?? '');
  const lowered = raw.toLowerCase();
  // NFKD decomposition turns precomposed diacritics into base letter +
  // combining mark (U+0300..U+036F); stripping the marks unifies them.
  const decomposed = lowered.normalize('NFKD').replace(COMBINING_MARKS, '');
  const noPunct = decomposed.replace(NON_WORD, ' ');
  return noPunct.replace(MULTI_SPACE, ' ').trim();
}

/** FNV-1a 32-bit hash of a string, unsigned. Pinned algorithm — do not change. */
export function fnv1a32(str) {
  const s = String(str ?? '');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Logical shard count: env AR10M_SHARD_COUNT, default 15, clamped to 1..15.
 * Frozen at 15 maximum by the spec (15 slots ANIMAXIA_DB_01..ANIMAXIA_DB_15).
 */
export const AR10M_SHARD_COUNT = (() => {
  const n = parseInt(process.env.AR10M_SHARD_COUNT || '15', 10);
  if (!Number.isFinite(n)) return 15;
  return Math.min(15, Math.max(1, Math.floor(n)));
})();

/**
 * Logical shard id (0..AR10M_SHARD_COUNT-1) for a title+year pair.
 * Stable forever — the physical DB behind a logical shard may change
 * (rebalance), but the shard_id stored on rows never does.
 */
export function computeShardId(title, year) {
  const key = `${normalizeTitle(title)}:${year ?? ''}`;
  return fnv1a32(key) % AR10M_SHARD_COUNT;
}

/**
 * Normalize a production year to an integer in 1888..2100 (1888 = first
 * motion picture, "Roundhay Garden Scene") or null when unknown/invalid.
 */
export function normalizeYear(y) {
  if (y === null || y === undefined || y === '') return null;
  const n = typeof y === 'number' ? Math.trunc(y) : parseInt(String(y).trim(), 10);
  if (!Number.isFinite(n)) return null;
  if (n < 1888 || n > 2100) return null;
  return n;
}
