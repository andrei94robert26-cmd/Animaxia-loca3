/**
 * common/health.js — Standard health-check router for every Animaxia Cloud
 * microservice. GET /health returns liveness (process up) + readiness
 * (dependency checks) in one payload:
 *
 *   { status: 'ok'|'degraded', service, version, env, uptimeSec, timestamp,
 *     checks: { db: true, ... }, ...extras }
 *
 * status is 'ok' only when every readiness check passes; HTTP 200 is still
 * returned for degraded states (liveness) so orchestrators keep the pod
 * alive while traffic can be shed via readiness gating.
 */

import express from 'express';

export function createHealthRouter({ name = 'animaxia-service', version = '3.0.0', readiness = null, extras = () => ({}) } = {}) {
  const router = express.Router();

  router.get('/', async (req, res) => {
    let checks = {};
    let failed = false;
    if (typeof readiness === 'function') {
      try {
        checks = (await readiness()) || {};
      } catch (err) {
        checks = { error: err.message };
        failed = true;
      }
      for (const value of Object.values(checks)) {
        if (value === false || value === null || value === undefined) failed = true;
      }
    }
    let extra = {};
    try {
      extra = (await extras()) || {};
    } catch {
      extra = {};
    }
    res.status(200).json({
      status: failed ? 'degraded' : 'ok',
      service: process.env.SERVICENAME || name,
      version,
      env: process.env.NODE_ENV || 'development',
      uptimeSec: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
      checks,
      ...extra,
    });
  });

  return router;
}

export default createHealthRouter;
