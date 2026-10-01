/**
 * services/premium-service/rateLimit.js — Global limiter config consumed by
 * server.js (createService mounts it ahead of every router).
 *
 * { windowMs: 60000, max: 120 } per client IP — the premium surface is small
 * (6 routes, mostly GETs); the gateway applies its own global edge limiter on
 * top and requires a token at the edge for POST /api/premium/checkout.
 */

export const serviceRateLimit = { windowMs: 60000, max: 120 };

export default serviceRateLimit;
