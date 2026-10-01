/**
 * services/search-service/rateLimit.js — Per-service rate-limit policy.
 *
 * Search is public and cache-hot, and autocomplete fires a request per
 * keystroke (the frontend debounces at ~300 ms — a fast typist still reaches
 * well over 100 requests/min). The outer service limiter therefore defaults
 * to a GENEROUS 240 requests per minute per client IP (2× the fleet default
 * of 120). Queries are cheap once the in-memory BM25 index is warm (no LLM,
 * no upstream providers), so the cost profile tolerates it.
 *
 * Operators can still tune the ceiling globally with the existing house
 * knobs RATELIMITWINDOW_MS / RATELIMITMAX (they override the defaults here);
 * when unset the search defaults apply.
 */

export const searchRateLimit = {
  windowMs: parseInt(process.env.RATELIMITWINDOW_MS || '60000', 10),
  max: parseInt(process.env.RATELIMITMAX || '240', 10),
};

export default searchRateLimit;
