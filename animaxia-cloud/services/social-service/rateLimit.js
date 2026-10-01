/**
 * services/social-service/rateLimit.js — Global limiter config consumed by
 * server.js (createService mounts it ahead of every router).
 *
 * { windowMs: 60000, max: 120 } per client IP — the blanket over all social
 * reads/writes. Comment CREATION carries its own tighter per-user limiter
 * inside the domain module (20/min, domain/social/comments.js commentLimiter);
 * the gateway applies its global edge limiter and a token check for
 * POST/PUT/DELETE on /api/social/* on top.
 */

export const serviceRateLimit = { windowMs: 60000, max: 120 };

export default serviceRateLimit;
