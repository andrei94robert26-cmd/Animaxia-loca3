/**
 * services/analytics-service/rateLimit.js — Per-service rate-limit policy.
 *
 * Analytics is the hottest write path in the platform: every playback page
 * fires POST /api/analytics/views (telemetry from the player), and the domain
 * router already throttles that endpoint to 120/min per IP on its own. The
 * outer service limiter therefore defaults to a GENEROUS 240 requests per
 * minute per client IP (2× the fleet default of 120) so legitimate bursts —
 * a page with several embeds, dashboards polling /trending — never trip the
 * blunt outer guard before the router's own precise limits apply.
 *
 * Operators can still tune the ceiling globally with the existing house knobs
 * RATELIMITWINDOW_MS / RATELIMITMAX (they override the defaults here); when
 * unset the analytics defaults apply.
 */

export const analyticsRateLimit = {
  windowMs: parseInt(process.env.RATELIMITWINDOW_MS || '60000', 10),
  max: parseInt(process.env.RATELIMITMAX || '240', 10),
};

export default analyticsRateLimit;
