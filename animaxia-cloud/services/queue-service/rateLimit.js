/**
 * services/queue-service/rateLimit.js — Per-service rate-limit policy.
 *
 * Fleet-standard 120 requests per minute per client IP: the queue surface is
 * mostly lightweight SQL (list/stats/cron tick), and the heavy work is done
 * by background handlers, not request paths. The POST /api/workers/mine and
 * /refresh endpoints additionally require auth/admin, and enqueue() itself
 * is a single INSERT — cheap. Operators can still tune the ceiling globally
 * with the house knobs RATELIMITWINDOW_MS / RATELIMITMAX (they override the
 * defaults here).
 */

export const serviceRateLimit = {
  windowMs: parseInt(process.env.RATELIMITWINDOW_MS || '60000', 10),
  max: parseInt(process.env.RATELIMITMAX || '120', 10),
};

export default serviceRateLimit;
