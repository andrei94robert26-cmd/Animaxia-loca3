/**
 * services/ai-service/rateLimit.js — Per-service rate-limit policy.
 *
 * AI is the most expensive request path in the fleet (upstream LLM calls or
 * a 100-row candidate ranking pass), so the default is deliberately tighter
 * than the fleet-wide 120/min: 60 requests per minute per client IP. On top
 * of this, the domain router enforces its own much stricter quotas — per-plan
 * daily limits (free 10 / plus 100 / pro 500), a 5/day anonymous IP bucket
 * and 10/min (describe) / 30/min (chat) endpoint-specific limiters — so this
 * limiter is the outer blunt guard, not the quota system.
 *
 * Operators can still raise/lower the ceiling globally with the existing
 * house knobs RATELIMITWINDOW_MS / RATELIMITMAX (they override the defaults
 * here); when unset the tighter AI defaults apply.
 */

export const aiRateLimit = {
  windowMs: parseInt(process.env.RATELIMITWINDOW_MS || '60000', 10),
  max: parseInt(process.env.RATELIMITMAX || '60', 10),
};

export default aiRateLimit;
