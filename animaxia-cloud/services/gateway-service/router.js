/**
 * services/gateway-service/router.js — Management endpoints (mounted at
 * /api/gateway by server.js). These run on the gateway itself, never proxied.
 *
 *   GET    /api/gateway/routes  → live route table (longest-prefix order) with
 *                                 per-upstream base URLs (credentials masked)
 *                                 + per-upstream breaker snapshots.
 *   GET    /api/gateway/cache   → edge cache stats (size, hits, misses, TTL…).
 *   DELETE /api/gateway/cache   → purge the whole edge cache → { ok: true }.
 *                                 Allowed with `x-purge-token` matching
 *                                 GATEWAYPURGETOKEN when that env is set;
 *                                 otherwise requires an edge-verified admin
 *                                 (auth.js requireEdgeAdmin).
 *   POST   /api/gateway/purge   → same as DELETE /api/gateway/cache.
 *   GET    /api/gateway/stats   → limiter stats + breaker snapshots +
 *                                 tracing stats (common/telemetry.js) +
 *                                 uptime + edge-auth/edge-cache stats.
 */

import express from 'express';
import { GATEWAY_ROUTES, SERVICE_NAMES, serviceUrl } from '@animaxia/common/services.js';
import { tracingStats } from '@animaxia/common/telemetry.js';
import { breakers, matchRoute, UPSTREAM_TIMEOUT_MS } from './proxy.js';
import { edgeStats, purgeAll } from './edgeCache.js';
import { authEdgeStats, requireEdgeAdmin } from './auth.js';
import { gatewayLimiter, gatewayRateLimit } from './rateLimit.js';

/** Mask any userinfo credentials in a URL (none are used today — keeps the shape). */
function maskUrl(url) {
  return String(url).replace(/:\/\/[^@/?#]+@/, '://***@');
}

/** Purge guard: x-purge-token (when GATEWAYPURGETOKEN is set) or edge admin. */
const purgeGuard = process.env.GATEWAYPURGETOKEN
  ? (req, res, next) => {
      if (req.get('x-purge-token') !== process.env.GATEWAYPURGETOKEN) {
        return res.status(403).json({ error: 'Invalid purge token' });
      }
      return next();
    }
  : requireEdgeAdmin;

/** Management router — mounted at /api/gateway (see server.js). */
export const managementRouter = (() => {
  const router = express.Router();

  /* Live routing table + breaker states + upstream base URLs. */
  router.get('/routes', (req, res) => {
    const routes = [...GATEWAY_ROUTES]
      .sort((a, b) => b.prefix.length - a.prefix.length)
      .map((route) => ({ prefix: route.prefix, service: route.service, upstream: maskUrl(serviceUrl(route.service)) }));
    const upstreams = {};
    for (const name of SERVICE_NAMES) {
      if (name === 'gateway') continue;
      upstreams[name] = maskUrl(serviceUrl(name));
    }
    res.json({
      routes,
      upstreams,
      matchStrategy: 'longest-prefix-wins',
      upstreamTimeoutMs: UPSTREAM_TIMEOUT_MS,
      breakers: breakers.snapshot(),
      sample: matchRoute('/api/analytics/trending'),
    });
  });

  /* Edge cache stats. */
  router.get('/cache', (req, res) => {
    res.json(edgeStats());
  });

  /* Purge the whole edge cache (token-guarded or admin-guarded). */
  const purgeHandler = (req, res) => {
    const { purged } = purgeAll();
    res.json({ ok: true, purged });
  };
  router.delete('/cache', purgeGuard, purgeHandler);
  router.post('/purge', purgeGuard, purgeHandler);

  /* Gateway-wide stats: limiter + breakers + tracing + uptime (+ extras). */
  router.get('/stats', (req, res) => {
    res.json({
      service: 'gateway-service',
      uptimeSec: Math.floor(process.uptime()),
      rateLimit: gatewayLimiter.stats(),
      breakers: breakers.snapshot(),
      tracing: tracingStats(),
      auth: authEdgeStats(),
      edgeCache: edgeStats(),
      config: {
        rateLimit: gatewayRateLimit,
        upstreamTimeoutMs: UPSTREAM_TIMEOUT_MS,
      },
    });
  });

  return router;
})();

export default managementRouter;
