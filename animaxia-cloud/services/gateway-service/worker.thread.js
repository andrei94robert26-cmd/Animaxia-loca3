/**
 * services/gateway-service/worker.thread.js — Upstream health prober thread.
 *
 * Runs inside a bun/node worker thread (spawned by common/worker.js via
 * createService in server.js). Every `intervalMs` it probes
 * `GET <upstream>/health` for each of the 9 Animaxia upstream services and
 * posts the results to the parent:
 *
 *   workerData : { serviceName, boot, workerBootId, intervalMs, timeoutMs,
 *                  upstreams: { auth: 'http://localhost:4001', ... } }
 *   → parent   : { type: 'heartbeat', at }
 *                { type: 'task', ok: true, at, runMs,
 *                  detail: { up: { auth: true, ... },
 *                            downSince: { auth: ISO|null, ... },
 *                            failures: { auth: n, ... } } }
 *   ← parent   : { type: 'run' }  → probe immediately
 *
 * The main process (server.js) polls the last task detail every 15s and feeds
 * the `animaxia_gateway_upstream_up{service}` Prometheus gauge. Circuit
 * breakers self-heal via their own half-open probes on real traffic; this
 * thread is the independent early-warning signal.
 *
 * DELIBERATELY dependency-free (only node: builtins) so it works identically
 * in bun worker threads — it imports NOTHING from @animaxia/common.
 */

import { parentPort, workerData } from 'node:worker_threads';

const intervalMs = Math.max(5000, parseInt(workerData?.intervalMs || '30000', 10));
const timeoutMs = Math.max(500, parseInt(workerData?.timeoutMs || '3000', 10));
const upstreams =
  workerData?.upstreams && typeof workerData.upstreams === 'object' ? workerData.upstreams : {};

/** Consecutive failed probes per service (reset to 0 on success). */
const failures = new Map();
/** ISO timestamp of the first failure of the current downtime streak. */
const downSince = new Map();

function post(message) {
  try {
    parentPort?.postMessage(message);
  } catch {
    /* the parent may be shutting down — never crash the thread over a post */
  }
}

/** One probe: 2xx from /health = up. Never throws. */
async function probeOne(base) {
  try {
    const res = await fetch(`${base}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json' },
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** One full task run: probe every upstream, track streaks, post the summary. */
async function runTask() {
  const startedAt = Date.now();
  try {
    const names = Object.keys(upstreams);
    const results = await Promise.all(
      names.map(async (name) => [name, await probeOne(upstreams[name])]),
    );
    const up = {};
    for (const [name, ok] of results) {
      up[name] = ok;
      if (ok) {
        failures.set(name, 0);
        downSince.delete(name);
      } else {
        failures.set(name, (failures.get(name) || 0) + 1);
        if (!downSince.has(name)) downSince.set(name, new Date().toISOString());
      }
    }
    post({
      type: 'task',
      ok: true,
      at: new Date().toISOString(),
      runMs: Date.now() - startedAt,
      detail: {
        up,
        downSince: Object.fromEntries(downSince),
        failures: Object.fromEntries(failures),
      },
    });
  } catch (err) {
    post({
      type: 'task',
      ok: false,
      at: new Date().toISOString(),
      runMs: Date.now() - startedAt,
      error: String(err?.message || err),
    });
  }
}

/* Parent messages: { type: 'run' } → immediate probe (used by tests/admin). */
if (parentPort) {
  parentPort.on('message', (msg) => {
    if (msg && msg.type === 'run') runTask();
  });
}

/* Boot heartbeat + immediate first probe, then the periodic loop. */
post({ type: 'heartbeat', at: new Date().toISOString() });
runTask();

const timer = setInterval(() => {
  post({ type: 'heartbeat', at: new Date().toISOString() });
  runTask();
}, intervalMs);
if (typeof timer.unref === 'function') timer.unref();
