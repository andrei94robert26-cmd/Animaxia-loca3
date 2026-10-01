/**
 * services/gateway-service/rateLimit.js — Global gateway rate-limit config.
 *
 * ONE fixed-window limiter for ALL /api/* traffic through the gateway
 * (GATEWAYRATELIMITWINDOW_MS default 60000 / GATEWAYRATELIMITMAX default 300,
 * keyed by client IP). The instance is owned HERE rather than inside
 * createService() so GET /api/gateway/stats can report live limiter numbers;
 * server.js mounts gatewayLimiter.middleware() in the global router chain,
 * ahead of every management/proxy route. (createService's own /health,
 * /metrics and / info routes are intentionally NOT rate-limited — probes and
 * scrapes must never receive a 429.)
 */

import { createRateLimit } from '@animaxia/common/rateLimit.js';

export const gatewayRateLimit = {
  windowMs: parseInt(process.env.GATEWAYRATELIMITWINDOW_MS || '60000', 10),
  max: parseInt(process.env.GATEWAYRATELIMITMAX || '300', 10),
};

/** Shared limiter instance used by server.js (and reported by router.js). */
export const gatewayLimiter = createRateLimit({ ...gatewayRateLimit, name: 'gateway-service' });

export default gatewayLimiter;
