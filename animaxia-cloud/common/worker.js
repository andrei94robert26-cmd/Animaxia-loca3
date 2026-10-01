/**
 * common/worker.js — Worker-thread bootstrap for Animaxia Cloud microservices.
 * Every service owns a worker thread (BLUEPRINT §7) running its periodic
 * maintenance task; this module standardises spawning, message protocol,
 * respawn-on-crash, heartbeats and Prometheus gauges.
 *
 * Contract with the thread file (worker.thread.js):
 *   workerData: { serviceName, intervalMs, boot: ISO, workerBootId }
 *   thread → parent messages:
 *     { type: 'heartbeat', at }                       — periodic liveness ping
 *     { type: 'task', ok, detail?, error?, at, runMs } — one completed task run
 *   parent → thread messages:
 *     { type: 'run' }                                  — ask for one immediate run
 *
 * The parent exposes status via getWorkerStatus() (surfaced in /health extras
 * and service info endpoints).
 */

import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { Gauge, Counter, registerMetric } from './metrics.js';
import { logger } from './logger.js';

const workerHeartbeatAgeGauge = registerMetric(
  new Gauge({
    name: 'animaxia_worker_last_heartbeat_seconds',
    help: 'Seconds since the service worker thread last sent a heartbeat',
    labelNames: ['service'],
  }),
);

const workerTaskRuns = registerMetric(
  new Counter({
    name: 'animaxia_worker_task_runs_total',
    help: 'Worker thread task runs (ok or failed)',
    labelNames: ['service', 'ok'],
  }),
);

const workerTaskDuration = registerMetric(
  new Gauge({
    name: 'animaxia_worker_last_task_duration_seconds',
    help: 'Duration of the last worker task run in seconds',
    labelNames: ['service'],
  }),
);

export function startWorkerThread({ file, workerData = {}, serviceName = process.env.SERVICENAME || 'animaxia-service' } = {}) {
  const resolvedPath = path.isAbsolute(file) ? file : path.resolve(path.dirname(fileURLToPath(import.meta.url)), file);
  const state = {
    file: resolvedPath,
    startedAt: new Date().toISOString(),
    lastHeartbeat: null,
    lastTask: null,
    restarts: 0,
    workerBootId: crypto.randomUUID(),
  };

  let worker = null;
  let stopped = false;

  function spawn() {
    worker = new Worker(resolvedPath, {
      workerData: {
        serviceName,
        boot: new Date().toISOString(),
        workerBootId: state.workerBootId,
        ...workerData,
      },
    });

    worker.on('message', (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'heartbeat') {
        state.lastHeartbeat = msg.at || new Date().toISOString();
        const ageSec = state.lastHeartbeat ? (Date.now() - Date.parse(state.lastHeartbeat)) / 1000 : -1;
        workerHeartbeatAgeGauge.set({ service: serviceName }, Math.max(0, ageSec));
      } else if (msg.type === 'task') {
        state.lastTask = {
          ok: Boolean(msg.ok),
          at: msg.at || new Date().toISOString(),
          runMs: msg.runMs ?? null,
          detail: msg.detail || null,
          error: msg.error || null,
        };
        workerTaskRuns.inc({ service: serviceName, ok: msg.ok ? 'true' : 'false' });
        if (msg.runMs != null) workerTaskDuration.set({ service: serviceName }, msg.runMs / 1000);
        if (msg.ok) {
          logger.debug(`[worker] ${serviceName} task ok${msg.detail ? `: ${JSON.stringify(msg.detail).slice(0, 200)}` : ''}`);
        } else {
          logger.warn(`[worker] ${serviceName} task failed: ${msg.error}`);
        }
      }
    });

    worker.on('error', (err) => {
      logger.error(`[worker] ${serviceName} thread error: ${err.message}`);
    });

    worker.on('exit', (code) => {
      if (stopped) return;
      state.restarts += 1;
      logger.warn(`[worker] ${serviceName} thread exited (code ${code}) — respawning in 5s`);
      setTimeout(() => {
        if (!stopped) spawn();
      }, 5000).unref?.();
    });

    return worker;
  }

  spawn();

  return {
    worker: () => worker,
    status: () => ({
      file: path.relative(process.cwd(), resolvedPath),
      startedAt: state.startedAt,
      lastHeartbeatAt: state.lastHeartbeat,
      lastTask: state.lastTask,
      restarts: state.restarts,
      running: Boolean(worker) && !stopped,
    }),
    /** Ask the thread to run its task immediately (used by tests/admin). */
    runNow() {
      if (worker) worker.postMessage({ type: 'run' });
    },
    stop() {
      stopped = true;
      if (worker) worker.terminate().catch(() => {});
    },
  };
}

export default startWorkerThread;
