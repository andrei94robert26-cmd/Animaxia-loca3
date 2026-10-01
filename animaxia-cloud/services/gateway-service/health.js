/**
 * services/gateway-service/health.js — Aggregated upstream health (fan-out).
 *
 * Mounted at /api/health by server.js (the gateway's OWN /health from
 * createService stays the cheap self-check):
 *
 *   GET /api/health      → fan-out `GET <upstream>/health` (serviceFetch,
 *                          3s timeout) to all 9 non-gateway services in
 *                          parallel, merged with gateway self info. Always
 *                          HTTP 200 (liveness semantics): `status` is "ok"
 *                          only when every upstream is reachable and not
 *                          degraded, otherwise "degraded". Unreachable
 *                          upstreams are reported per-service as
 *                          { status: 'unreachable', error }.
 *   GET /api/health/live → trivial liveness { status: 'ok' }.
 */

import express from 'express';
import { SERVICE_NAMES, serviceUrl } from '@animaxia/common/services.js';
import { serviceFetch } from '@animaxia/common/telemetry.js';
import { wrap } from '@animaxia/common/middleware.js';
import { breakers } from './proxy.js';
import { edgeStats } from './edgeCache.js';

const UPSTREAM_NAMES = SERVICE_NAMES.filter((name) => name !== 'gateway');
const VERSION = '3.0.0';
const HEALTH_TIMEOUT_MS = 3000;

/** Probe one upstream — never throws; returns a status object. */
async function probeUpstream(name) {
  const base = serviceUrl(name);
  try {
    const res = await serviceFetch(
      `${base}/health`,
      { headers: { accept: 'application/json' } },
      { timeoutMs: HEALTH_TIMEOUT_MS, spanName: `health-check ${name}` },
    );
    if (!res.ok) {
      return { status: 'unreachable', service: `${name}-service`, url: base, httpStatus: res.status };
    }
    const body = await res.json().catch(() => ({}));
    return {
      status: body.status === 'degraded' ? 'degraded' : 'ok',
      service: body.service || `${name}-service`,
      url: base,
      ...(body.version ? { version: body.version } : {}),
      ...(body.env ? { env: body.env } : {}),
      ...(Number.isFinite(body.uptimeSec) ? { uptimeSec: body.uptimeSec } : {}),
      ...(body.checks ? { checks: body.checks } : {}),
    };
  } catch (err) {
    return {
      status: 'unreachable',
      service: `${name}-service`,
      url: base,
      error: String(err?.message || err).slice(0, 200),
    };
  }
}

/** Aggregated health router — mounted at /api/health (see server.js). */
export const aggregatedHealthRouter = (() => {
  const router = express.Router();

  /* Trivial liveness (no fan-out). */
  router.get('/live', (req, res) => {
    res.json({ status: 'ok', service: 'gateway', timestamp: new Date().toISOString() });
  });

  /* Aggregated fan-out health — always 200, status field carries the verdict. */
  router.get(
    '/',
    wrap(async (req, res) => {
      const results = await Promise.all(UPSTREAM_NAMES.map((name) => probeUpstream(name)));
      const upstreams = {};
      let degraded = false;
      UPSTREAM_NAMES.forEach((name, index) => {
        const report = results[index];
        upstreams[name] = report;
        if (report.status !== 'ok') degraded = true;
      });
      res.status(200).json({
        status: degraded ? 'degraded' : 'ok',
        service: 'gateway',
        version: VERSION,
        timestamp: new Date().toISOString(),
        uptimeSec: Math.floor(process.uptime()),
        upstreams,
        breakers: breakers.snapshot(),
        edgeCache: edgeStats(),
      });
    }),
  );

  return router;
})();

export default aggregatedHealthRouter;
