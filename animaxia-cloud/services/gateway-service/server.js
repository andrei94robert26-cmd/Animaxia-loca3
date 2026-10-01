/**
 * services/gateway-service/server.js — Animaxia Cloud API Gateway (:8080).
 *
 * The single entry point in front of every Animaxia microservice: global edge
 * auth (verify-only JWT + route ACL), edge caching with stale-while-error,
 * per-upstream circuit breakers, distributed tracing (traceparent propagation
 * via serviceFetch), an aggregated /api/health fan-out, management endpoints
 * under /api/gateway/* and a worker thread probing upstream health into the
 * `animaxia_gateway_upstream_up{service}` Prometheus gauge.
 *
 * Boot wiring (createService from @animaxia/common/service.js). Router mount
 * order matters — gateway-owned routes win, the proxy catches the rest:
 *
 *   1. '/'            globalRouter          — gateway rate limiter + edge auth
 *                                             (runs for every /api/* request;
 *                                             createService's own /health,
 *                                             /metrics and / are mounted even
 *                                             earlier and stay un-throttled)
 *   2. '/api/gateway' managementRouter      — routes / cache / stats
 *   3. '/api/health'  aggregatedHealthRouter — fan-out health + /live
 *   4. '/'            proxyRouter           — catch-all proxy, LAST
 *
 * No DB, no attachUser (services attach users themselves from the forwarded
 * Authorization header).
 */

import 'dotenv/config';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { createService } from '@animaxia/common/service.js';
import { SERVICE_NAMES, serviceUrl } from '@animaxia/common/services.js';
import { Gauge, registerMetric } from '@animaxia/common/metrics.js';
import { logger } from '@animaxia/common/logger.js';
import { gatewayLimiter } from './rateLimit.js';
import { authEdge } from './auth.js';
import { managementRouter } from './router.js';
import { aggregatedHealthRouter } from './health.js';
import { proxyRouter } from './proxy.js';

/* ------------------------- global chain (all /api/*) ------------------------ */

const globalRouter = express.Router();
globalRouter.use(gatewayLimiter.middleware()); // cheapest check first
globalRouter.use(authEdge); // verify-only JWT + edge route ACL

/* --------------------------- upstream health gauge -------------------------- */

const UPSTREAM_NAMES = SERVICE_NAMES.filter((name) => name !== 'gateway');

/** 1 = upstream answered /health on the last worker probe, 0 = down. */
const upstreamUpGauge = registerMetric(
  new Gauge({
    name: 'animaxia_gateway_upstream_up',
    help: 'Whether a gateway upstream service answered /health on the last probe (1 up, 0 down)',
    labelNames: ['service'],
  }),
);
for (const name of UPSTREAM_NAMES) upstreamUpGauge.set({ service: name }, 0);

/* ----------------------------------- boot ----------------------------------- */

// NOTE: common/worker.js resolves a RELATIVE `file` against common/ itself, so
// services must pass an ABSOLUTE worker path (computed from this module). This
// works identically in dev (repo root) and in the Docker image (/app).
const workerFile = fileURLToPath(new URL('./worker.thread.js', import.meta.url));

// Upstream base URLs resolved once at boot, honoring the URL env overrides
// (AUTHSERVICEURL, CONTENTSERVICEURL, …) — passed into the worker thread.
const upstreamUrls = Object.fromEntries(UPSTREAM_NAMES.map((name) => [name, serviceUrl(name)]));

const svc = createService({
  name: 'gateway-service',
  version: '3.0.0',
  port: 8080,
  portEnv: 'GATEWAYPORT',
  initDb: false,
  attachUser: false,
  // The global limiter is owned by ./rateLimit.js (gatewayLimiter, mounted in
  // globalRouter above) so GET /api/gateway/stats can report live numbers —
  // createService's internal limiter instance is not exposed for reporting.
  rateLimit: null,
  routers: [
    { path: '/', router: globalRouter },
    { path: '/api/gateway', router: managementRouter },
    { path: '/api/health', router: aggregatedHealthRouter },
    { path: '/', router: proxyRouter }, // catch-all proxy — mounted LAST
  ],
  worker: {
    file: workerFile,
    intervalMs: 30000,
    workerData: { intervalMs: 30000, timeoutMs: 3000, upstreams: upstreamUrls },
  },
  health: { readiness: async () => ({ gateway: true }) },
});

/* Feed worker-thread probe results into animaxia_gateway_upstream_up{service}. */
const upstreamGaugeTimer = setInterval(() => {
  try {
    const detail = svc.worker?.status()?.lastTask?.detail;
    if (detail && detail.up && typeof detail.up === 'object') {
      for (const [name, up] of Object.entries(detail.up)) {
        upstreamUpGauge.set({ service: name }, up ? 1 : 0);
      }
    }
  } catch {
    /* metrics must never break the gateway */
  }
}, 15000);
if (typeof upstreamGaugeTimer.unref === 'function') upstreamGaugeTimer.unref();

logger.info(`[gateway] upstream registry: ${JSON.stringify(upstreamUrls)}`);

// Entry point — no default export (Bun 1.3 auto-serves objects with a port property).
