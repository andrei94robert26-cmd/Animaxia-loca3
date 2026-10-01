/**
 * services/content-service/rateLimit.js — Per-service rate-limit config.
 *
 * Same limits as the monolith backend (RATELIMITWINDOW_MS / RATELIMITMAX —
 * defaults 60000ms / 120 requests per client IP). server.js passes this
 * object to createService, which instantiates the limiter (mounted after
 * tracing/metrics, before the routers) and surfaces its live stats in the
 * /health extras. createService's own /health, /metrics and / info routes
 * are not rate-limited — probes and scrapes must never receive a 429.
 */

export const serviceRateLimit = {
  windowMs: parseInt(process.env.RATELIMITWINDOW_MS || '60000', 10),
  max: parseInt(process.env.RATELIMITMAX || '120', 10),
};

export default serviceRateLimit;
