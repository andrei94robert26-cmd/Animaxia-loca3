/**
 * services/auth-service/rateLimit.js — Global limiter config consumed by
 * server.js (createService mounts it ahead of every router).
 *
 * { windowMs: 60000, max: 120 } per client IP — a generous blanket for the
 * identity plane. The sensitive auth routes carry their own TIGHTER limiter
 * inside the domain module: POST /api/auth/register|login run the per-IP
 * `auth` bucket (30/min, domain/users/auth.js authLimiter) on top of the
 * brute-force lockout (5 fails / 15 min → 15 min lock). /internal/verify-admin
 * rides the blanket too — the gateway caches its results 60s per sub, so the
 * internal volume is trivial.
 */

export const serviceRateLimit = { windowMs: 60000, max: 120 };

export default serviceRateLimit;
