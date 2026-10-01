/**
 * common/service.js — createService(): the standard boot factory every Animaxia
 * Cloud microservice uses (BLUEPRINT §6). Composes the full middleware stack
 * (CORS → JSON → requestId → requestLogger → tracing → metrics → rate limit →
 * attachUser → routers → health → metrics → 404 → error), runs boot hooks
 * (initDb → ensureSchema → seedIfEmpty), owns a worker thread, and handles
 * graceful SIGTERM/SIGINT shutdown (Kubernetes-friendly).
 */

import express from 'express';
import cors from 'cors';
import { initDb, closeDb, ping, driverInfo } from './db.js';
import { requestLogger } from './logger.js';
import { logger } from './logger.js';
import { traceMiddleware } from './telemetry.js';
import { httpMetricsMiddleware, metricsHandler, refreshProcessMetrics } from './metrics.js';
import { rateLimitMiddleware, createRateLimit } from './rateLimit.js';
import { requestId, attachUserFromToken, errorHandler, notFoundHandler } from './middleware.js';
import { createHealthRouter } from './health.js';
import { startWorkerThread } from './worker.js';

export function createService(options = {}) {
  const {
    name = 'animaxia-service',
    version = '3.0.0',
    port = 8080,
    portEnv = null, // e.g. 'AUTHPORT'
    cors: corsEnabled = true,
    bodyLimit = '2mb',
    initDb: withDb = true,
    ensureSchema = null,
    seedIfEmpty = null,
    attachUser: withAttachUser = false,
    rateLimit = { windowMs: parseInt(process.env.RATELIMITWINDOW_MS || '60000', 10), max: parseInt(process.env.RATELIMITMAX || '120', 10) },
    routers = [],
    health = {},
    worker = null,
    beforeListen = null,
  } = options;

  const serviceName = process.env.SERVICENAME || name;
  process.env.SERVICENAME = serviceName;

  // Port precedence: the service's OWN port env (AUTHPORT, GATEWAYPORT, …) wins
  // over the generic PORT — the shared .env carries the monolith's PORT=4000,
  // which must never leak into cloud services. Docker/K8s set PORT per
  // container and it applies when the specific override is absent.
  const resolvedPort = (() => {
    const fromServiceEnv = portEnv ? parseInt(process.env[portEnv] || '', 10) : NaN;
    if (Number.isFinite(fromServiceEnv) && fromServiceEnv > 0) return fromServiceEnv;
    const fromPort = parseInt(process.env.PORT || '', 10);
    if (Number.isFinite(fromPort) && fromPort > 0 && String(fromPort) !== '4000') return fromPort;
    return port;
  })();

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  /* ------------------------------ middleware ------------------------------- */

  if (corsEnabled) {
    app.use(
      cors({
        origin: (origin, cb) => cb(null, !origin || origin === process.env.CORS_ORIGIN || true),
      }),
    );
  }
  app.use(express.json({ limit: bodyLimit }));
  app.use(requestId());
  app.use(requestLogger);
  app.use(traceMiddleware());
  app.use(httpMetricsMiddleware());

  let limiter = null;
  if (rateLimit) {
    if (rateLimit === true) {
      app.use(rateLimitMiddleware);
    } else {
      limiter = createRateLimit({ ...rateLimit, name: serviceName });
      app.use(limiter.middleware());
    }
  }

  if (withAttachUser) app.use(attachUserFromToken);

  /* ------------------------------ health/info ------------------------------- */

  const workerHandle = worker
    ? startWorkerThread({ file: worker.file, workerData: worker.workerData || { intervalMs: worker.intervalMs || 60000 }, serviceName })
    : null;

  app.get('/', (req, res) => {
    res.json({
      service: serviceName,
      version,
      status: 'ok',
      docs: 'Try /health, /metrics',
      ...(withDb ? { db: driverInfo() } : {}),
    });
  });

  app.use(
    '/health',
    createHealthRouter({
      name: serviceName,
      version,
      readiness: health.readiness || (withDb ? async () => ({ db: await ping() }) : null),
      extras: async () => ({
        ...(workerHandle ? { worker: workerHandle.status() } : {}),
        ...(limiter ? { rateLimit: limiter.stats() } : {}),
      }),
    }),
  );

  if ((process.env.METRICSENABLED ?? 'true').toLowerCase() !== 'false') {
    app.get('/metrics', metricsHandler());
  }

  /* -------------------------------- routers -------------------------------- */

  for (const mount of routers) {
    if (!mount || !mount.path || !mount.router) continue;
    app.use(mount.path, mount.router);
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  /* ---------------------------------- boot ---------------------------------- */

  const processMetricsTimer = setInterval(() => refreshProcessMetrics(), 15000);
  if (typeof processMetricsTimer.unref === 'function') processMetricsTimer.unref();

  let server = null;
  let shuttingDown = false;

  async function main() {
    if (withDb) {
      await initDb();
    }
    if (typeof ensureSchema === 'function') {
      try {
        await ensureSchema();
      } catch (err) {
        logger.error(`[boot] Schema hook failed (${serviceName}): ${err.message}`);
      }
    }
    if (typeof seedIfEmpty === 'function' && withDb) {
      try {
        await seedIfEmpty();
      } catch (err) {
        logger.error(`[boot] Seed hook failed (non-fatal): ${err.message}`);
      }
    }
    if (typeof beforeListen === 'function') {
      await beforeListen();
    }

    server = app.listen(resolvedPort, () => {
      logger.info('============================================================');
      logger.info(`  ${serviceName.toUpperCase()} v${version} — listening on http://localhost:${resolvedPort}`);
      if (withDb) logger.info(`  DB driver: ${driverInfo().driver} (connected: ${driverInfo().connected})`);
      if (workerHandle) logger.info(`  Worker thread: ${worker.file}`);
      logger.info(`  Env: ${process.env.NODE_ENV || 'development'} · Rate limit: ${rateLimit ? `${rateLimit.max ?? 'global'}/${rateLimit.windowMs ?? ''}ms` : 'off'}`);
      logger.info('============================================================');
    });

    const shutdown = async (signal) => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info(`[shutdown] ${signal} received — draining ${serviceName}`);
      try {
        workerHandle?.stop();
      } catch {
        /* ignore */
      }
      server?.close(async () => {
        if (withDb) await closeDb();
        process.exit(0);
      });
      setTimeout(() => process.exit(0), 8000).unref?.();
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('unhandledRejection', (reason) => {
      logger.error(`[process] Unhandled rejection: ${reason instanceof Error ? reason.stack || reason.message : reason}`);
    });
    process.on('uncaughtException', (err) => {
      logger.error(`[process] Uncaught exception: ${err instanceof Error ? err.stack || err.message : err}`);
    });
  }

  const bootPromise = main().catch((err) => {
    logger.error(`[boot] Fatal startup error in ${serviceName}: ${err.stack || err.message}`);
    process.exit(1);
  });

  // NOTE: deliberately NO `port` property on the returned object — Bun 1.3
  // auto-serves entry files whose default export looks like Bun.serve options
  // (an object with a `port` key), which would crash every service. The listen
  // port is exposed as `listenPort`.
  return { app, server: () => server, worker: workerHandle, bootPromise, listenPort: resolvedPort, serviceName };
}

export default createService;
