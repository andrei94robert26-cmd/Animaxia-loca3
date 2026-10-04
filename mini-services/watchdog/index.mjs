import http from 'node:http';
import { spawn } from 'node:child_process';

const PORT = 4020;
const CHECK_INTERVAL_MS = 15_000;
const REQUEST_TIMEOUT_MS = 5_000;
const FAILURE_THRESHOLD = 3;
const RESTART_COOLDOWN_MS = 60_000;

const startedAt = Date.now();

const targets = {
  frontend: {
    service: 'animaxia-frontend',
    url: 'http://127.0.0.1:3000/',
  },
  backend: {
    service: 'animaxia-backend',
    url: 'http://127.0.0.1:4000/api/health',
  },
  gateway: {
    service: 'animaxia-global-gateway',
    url: 'http://127.0.0.1:4040/api/infra/health',
  },
};

const state = Object.fromEntries(
  Object.entries(targets).map(([name, target]) => [
    name,
    {
      ...target,
      healthy: false,
      status: null,
      latencyMs: null,
      consecutiveFailures: 0,
      lastCheck: null,
      lastSuccess: null,
      lastFailure: null,
      lastError: null,
      lastRestart: null,
      restartCount: 0,
      restarting: false,
    },
  ]),
);

let cycleRunning = false;
let completedCycles = 0;

function restartService(name) {
  const target = state[name];
  const now = Date.now();

  if (target.restarting) return;

  if (
    target.lastRestart &&
    now - target.lastRestart < RESTART_COOLDOWN_MS
  ) {
    return;
  }

  target.restarting = true;
  target.lastRestart = now;
  target.restartCount += 1;

  console.log(
    `[watchdog] restart ${target.service}, failures=${target.consecutiveFailures}`,
  );

  const child = spawn(
    '/data/data/com.termux/files/usr/bin/sv',
    ['restart', target.service],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    },
  );

  child.stdout.on('data', (chunk) => {
    process.stdout.write(`[watchdog:${target.service}] ${chunk}`);
  });

  child.stderr.on('data', (chunk) => {
    process.stderr.write(`[watchdog:${target.service}] ${chunk}`);
  });

  child.on('error', (error) => {
    target.lastError = `restart failed: ${error.message}`;
    target.restarting = false;
  });

  child.on('close', (code) => {
    if (code !== 0) {
      target.lastError = `sv restart exited with code ${code}`;
    }

    target.restarting = false;
  });
}

async function probe(name) {
  const target = state[name];
  const started = Date.now();
  const controller = new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT_MS,
  );

  try {
    const response = await fetch(target.url, {
      method: 'GET',
      cache: 'no-store',
      signal: controller.signal,
      headers: {
        'user-agent': 'animaxia-watchdog/1.0',
      },
    });

    target.status = response.status;
    target.latencyMs = Date.now() - started;
    target.lastCheck = Date.now();

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    target.healthy = true;
    target.consecutiveFailures = 0;
    target.lastSuccess = Date.now();
    target.lastError = null;
  } catch (error) {
    target.healthy = false;
    target.status = null;
    target.latencyMs = Date.now() - started;
    target.lastCheck = Date.now();
    target.lastFailure = Date.now();
    target.consecutiveFailures += 1;
    target.lastError =
      error instanceof Error ? error.message : String(error);

    console.error(
      `[watchdog] ${name} failed ` +
      `(${target.consecutiveFailures}/${FAILURE_THRESHOLD}): ` +
      target.lastError,
    );

    if (target.consecutiveFailures >= FAILURE_THRESHOLD) {
      restartService(name);
    }
  } finally {
    clearTimeout(timer);
  }
}

async function runCycle() {
  if (cycleRunning) return;

  cycleRunning = true;

  try {
    await Promise.all(Object.keys(state).map(probe));
    completedCycles += 1;
  } finally {
    cycleRunning = false;
  }
}

function publicState() {
  const services = Object.fromEntries(
    Object.entries(state).map(([name, target]) => [
      name,
      {
        service: target.service,
        url: target.url,
        healthy: target.healthy,
        status: target.status,
        latencyMs: target.latencyMs,
        consecutiveFailures: target.consecutiveFailures,
        lastCheck: target.lastCheck,
        lastSuccess: target.lastSuccess,
        lastFailure: target.lastFailure,
        lastError: target.lastError,
        lastRestart: target.lastRestart,
        restartCount: target.restartCount,
        restarting: target.restarting,
      },
    ]),
  );

  return {
    ok: Object.values(state).every((target) => target.healthy),
    service: 'animaxia-watchdog',
    port: PORT,
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    completedCycles,
    policy: {
      intervalMs: CHECK_INTERVAL_MS,
      timeoutMs: REQUEST_TIMEOUT_MS,
      failureThreshold: FAILURE_THRESHOLD,
      restartCooldownMs: RESTART_COOLDOWN_MS,
    },
    services,
    timestamp: new Date().toISOString(),
  };
}

const server = http.createServer((request, response) => {
  const url = new URL(
    request.url ?? '/',
    `http://${request.headers.host ?? `127.0.0.1:${PORT}`}`,
  );

  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');

  if (
    request.method === 'GET' &&
    (
      url.pathname === '/api/health' ||
      url.pathname === '/health'
    )
  ) {
    const body = publicState();

    response.statusCode = body.ok ? 200 : 503;
    response.end(
      JSON.stringify({
        ok: body.ok,
        service: body.service,
        uptimeSec: body.uptimeSec,
        completedCycles: body.completedCycles,
        timestamp: body.timestamp,
      }),
    );
    return;
  }

  if (
    request.method === 'GET' &&
    url.pathname === '/api/watchdog/status'
  ) {
    const body = publicState();

    response.statusCode = 200;
    response.end(JSON.stringify(body));
    return;
  }

  if (
    request.method === 'POST' &&
    url.pathname === '/api/watchdog/check'
  ) {
    void runCycle().then(() => {
      if (!response.writableEnded) {
        response.statusCode = 200;
        response.end(JSON.stringify(publicState()));
      }
    });
    return;
  }

  response.statusCode = 404;
  response.end(
    JSON.stringify({
      error: 'Not found',
      service: 'animaxia-watchdog',
    }),
  );
});

server.requestTimeout = 10_000;
server.headersTimeout = 10_000;
server.keepAliveTimeout = 5_000;

server.listen(PORT, '127.0.0.1', () => {
  console.log(
    `[watchdog] listening on 127.0.0.1:${PORT}, ` +
    `threshold=${FAILURE_THRESHOLD}, interval=${CHECK_INTERVAL_MS}ms`,
  );

  void runCycle();
});

const interval = setInterval(() => {
  void runCycle();
}, CHECK_INTERVAL_MS);

function shutdown(signal) {
  console.log(`[watchdog] ${signal}, shutting down`);
  clearInterval(interval);

  server.close(() => {
    process.exit(0);
  });

  setTimeout(() => process.exit(1), 5_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
