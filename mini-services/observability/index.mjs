import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const PORT = 4050;
const PROBE_INTERVAL_MS = 30_000;
const PROBE_TIMEOUT_MS = 7_000;
const MAX_EVENTS = 500;
const MAX_ALERTS = 200;

const startedAt = Date.now();
const dataDir = path.resolve('data');
const stateFile = path.join(dataDir, 'state.json');

fs.mkdirSync(dataDir, { recursive: true });

const targets = {
  frontend: {
    url: 'http://127.0.0.1:3000/',
  },
  backend: {
    url: 'http://127.0.0.1:4000/api/health',
  },
  watchdog: {
    url: 'http://127.0.0.1:4020/api/watchdog/status',
  },
  gateway: {
    url: 'http://127.0.0.1:4040/api/infra/status',
  },
};

const probes = Object.fromEntries(
  Object.entries(targets).map(([name, target]) => [
    name,
    {
      ...target,
      healthy: false,
      status: null,
      latencyMs: null,
      lastCheck: null,
      lastSuccess: null,
      lastError: null,
      consecutiveFailures: 0,
      totalChecks: 0,
      totalFailures: 0,
    },
  ]),
);

let completedCycles = 0;
let cycleRunning = false;
let backendSnapshot = null;
let watchdogSnapshot = null;
let gatewaySnapshot = null;
let events = [];
let alerts = [];

function loadPersistedState() {
  try {
    if (!fs.existsSync(stateFile)) return;

    const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));

    if (Number.isFinite(saved.completedCycles)) {
      completedCycles = saved.completedCycles;
    }

    if (Array.isArray(saved.events)) {
      events = saved.events.slice(-MAX_EVENTS);
    }

    if (Array.isArray(saved.alerts)) {
      alerts = saved.alerts.slice(-MAX_ALERTS);
    }
  } catch (error) {
    console.error('[observability] state load failed:', error.message);
  }
}

function persistState() {
  const temporary = `${stateFile}.tmp`;

  const payload = JSON.stringify(
    {
      completedCycles,
      events: events.slice(-MAX_EVENTS),
      alerts: alerts.slice(-MAX_ALERTS),
      updatedAt: new Date().toISOString(),
    },
    null,
    2,
  );

  try {
    fs.writeFileSync(temporary, payload);
    fs.renameSync(temporary, stateFile);
  } catch (error) {
    console.error('[observability] state persist failed:', error.message);
  }
}

function addEvent(service, type, message, data = null) {
  events.push({
    id: crypto.randomUUID(),
    service,
    type,
    message,
    data,
    createdAt: new Date().toISOString(),
  });

  if (events.length > MAX_EVENTS) {
    events = events.slice(-MAX_EVENTS);
  }
}

function upsertAlert({
  key,
  severity,
  service,
  message,
  active,
  data = null,
}) {
  const existing = alerts.find((alert) => alert.key === key && alert.active);

  if (active) {
    if (existing) {
      existing.lastSeenAt = new Date().toISOString();
      existing.message = message;
      existing.data = data;
      return;
    }

    alerts.push({
      id: crypto.randomUUID(),
      key,
      severity,
      service,
      message,
      data,
      active: true,
      createdAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      resolvedAt: null,
    });

    addEvent(service, 'alert-opened', message, data);
  } else if (existing) {
    existing.active = false;
    existing.resolvedAt = new Date().toISOString();

    addEvent(service, 'alert-resolved', message, data);
  }

  if (alerts.length > MAX_ALERTS) {
    alerts = alerts.slice(-MAX_ALERTS);
  }
}

async function requestJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  const started = Date.now();

  try {
    const response = await fetch(url, {
      method: 'GET',
      cache: 'no-store',
      signal: controller.signal,
      headers: {
        'user-agent': 'animaxia-observability/1.0',
        accept: 'application/json',
      },
    });

    const text = await response.text();
    let body = null;

    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }

    return {
      ok: response.ok,
      status: response.status,
      latencyMs: Date.now() - started,
      body,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function probe(name) {
  const target = probes[name];
  const previousHealthy = target.healthy;

  target.totalChecks += 1;
  target.lastCheck = Date.now();

  try {
    const result = await requestJson(target.url);

    target.status = result.status;
    target.latencyMs = result.latencyMs;

    if (!result.ok) {
      throw new Error(`HTTP ${result.status}`);
    }

    target.healthy = true;
    target.lastSuccess = Date.now();
    target.lastError = null;
    target.consecutiveFailures = 0;

    if (!previousHealthy && target.totalChecks > 1) {
      addEvent(
        name,
        'service-recovered',
        `${name} a revenit în stare operațională`,
        {
          status: result.status,
          latencyMs: result.latencyMs,
        },
      );
    }

    if (name === 'backend') {
      backendSnapshot = result.body;
    }

    if (name === 'watchdog') {
      watchdogSnapshot = result.body;
    }

    if (name === 'gateway') {
      gatewaySnapshot = result.body;
    }
  } catch (error) {
    target.healthy = false;
    target.status = null;
    target.lastError =
      error instanceof Error ? error.message : String(error);
    target.consecutiveFailures += 1;
    target.totalFailures += 1;

    if (previousHealthy || target.totalChecks === 1) {
      addEvent(
        name,
        'service-degraded',
        `${name} nu răspunde`,
        {
          error: target.lastError,
        },
      );
    }
  }

  upsertAlert({
    key: `service:${name}:unavailable`,
    severity: 'critical',
    service: name,
    message: `${name} nu răspunde`,
    active: !target.healthy,
    data: {
      status: target.status,
      error: target.lastError,
      consecutiveFailures: target.consecutiveFailures,
    },
  });
}

function evaluateProviderAlerts() {
  const providers = backendSnapshot?.providers ?? [];

  for (const provider of providers) {
    const isJikan = provider.name === 'jikan';
    const degraded = provider.state !== 'closed';

    upsertAlert({
      key: `provider:${provider.name}:degraded`,
      severity: isJikan ? 'warning' : 'warning',
      service: provider.name,
      message: isJikan
        ? `Jikan degradat: ${provider.lastError ?? provider.state}`
        : `${provider.name} degradat: ${provider.state}`,
      active: degraded,
      data: provider,
    });
  }
}

function evaluateGatewayAlerts() {
  const regions = gatewaySnapshot?.regions ?? [];

  for (const region of regions) {
    const healthy = region.upstreams.filter(
      (upstream) => upstream.healthy && !upstream.forcedDown,
    ).length;

    const total = region.upstreams.length;
    const unavailable = healthy === 0;
    const redundancyDegraded = healthy > 0 && healthy < total;

    upsertAlert({
      key: `gateway:${region.name}:unavailable`,
      severity: 'critical',
      service: 'gateway',
      message: `Regiunea ${region.label} nu are upstream sănătos`,
      active: unavailable,
      data: { region: region.name, healthy, total },
    });

    upsertAlert({
      key: `gateway:${region.name}:redundancy`,
      severity: 'info',
      service: 'gateway',
      message:
        region.name === 'us'
          ? `Failover demo US activ: ${healthy}/${total} upstream-uri`
          : `Redundanță redusă în ${region.label}: ${healthy}/${total}`,
      active: redundancyDegraded,
      data: {
        region: region.name,
        healthy,
        total,
        intentionalDemo: region.name === 'us',
      },
    });
  }
}

async function runCycle() {
  if (cycleRunning) return;

  cycleRunning = true;

  try {
    await Promise.all(Object.keys(probes).map(probe));

    evaluateProviderAlerts();
    evaluateGatewayAlerts();

    completedCycles += 1;
    persistState();
  } finally {
    cycleRunning = false;
  }
}

function currentSummary() {
  const activeAlerts = alerts.filter((alert) => alert.active);
  const allHealthy = Object.values(probes).every(
    (probeState) => probeState.healthy,
  );

  return {
    ok: allHealthy,
    service: 'animaxia-observability',
    port: PORT,
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    completedCycles,
    intervalMs: PROBE_INTERVAL_MS,
    probes,
    providers: backendSnapshot?.providers ?? [],
    database: backendSnapshot?.db ?? null,
    backendCache: backendSnapshot?.cache ?? null,
    watchdog: watchdogSnapshot
      ? {
          ok: watchdogSnapshot.ok,
          completedCycles: watchdogSnapshot.completedCycles,
          services: watchdogSnapshot.services,
        }
      : null,
    gateway: gatewaySnapshot
      ? {
          ok: gatewaySnapshot.ok,
          redisMode: gatewaySnapshot.redisMode,
          regions: gatewaySnapshot.regions,
          cache: gatewaySnapshot.cache,
          counters: gatewaySnapshot.counters,
        }
      : null,
    alerts: {
      active: activeAlerts.length,
      critical: activeAlerts.filter(
        (alert) => alert.severity === 'critical',
      ).length,
      warning: activeAlerts.filter(
        (alert) => alert.severity === 'warning',
      ).length,
      info: activeAlerts.filter(
        (alert) => alert.severity === 'info',
      ).length,
    },
    events: {
      total: events.length,
      latest: events.slice(-10).reverse(),
    },
    timestamp: new Date().toISOString(),
  };
}

function prometheusMetrics() {
  const lines = [
    '# HELP animaxia_observability_up Observability service status',
    '# TYPE animaxia_observability_up gauge',
    'animaxia_observability_up 1',
    '# HELP animaxia_observability_cycles_total Completed probe cycles',
    '# TYPE animaxia_observability_cycles_total counter',
    `animaxia_observability_cycles_total ${completedCycles}`,
  ];

  for (const [name, probeState] of Object.entries(probes)) {
    lines.push(
      `animaxia_service_up{service="${name}"} ${
        probeState.healthy ? 1 : 0
      }`,
    );

    lines.push(
      `animaxia_service_latency_ms{service="${name}"} ${
        probeState.latencyMs ?? -1
      }`,
    );

    lines.push(
      `animaxia_service_failures_total{service="${name}"} ${
        probeState.totalFailures
      }`,
    );
  }

  const activeAlerts = alerts.filter((alert) => alert.active);

  lines.push(
    `animaxia_alerts_active ${activeAlerts.length}`,
  );

  return `${lines.join('\n')}\n`;
}

function sendJson(response, status, body) {
  response.statusCode = status;
  response.setHeader(
    'content-type',
    'application/json; charset=utf-8',
  );
  response.setHeader('cache-control', 'no-store');
  response.end(JSON.stringify(body));
}

const server = http.createServer((request, response) => {
  const url = new URL(
    request.url ?? '/',
    `http://${request.headers.host ?? `127.0.0.1:${PORT}`}`,
  );

  if (
    request.method === 'GET' &&
    (
      url.pathname === '/health' ||
      url.pathname === '/api/health'
    )
  ) {
    sendJson(response, 200, {
      ok: true,
      service: 'animaxia-observability',
      port: PORT,
      uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
      completedCycles,
      timestamp: new Date().toISOString(),
    });
    return;
  }

  if (
    request.method === 'GET' &&
    url.pathname === '/api/summary'
  ) {
    sendJson(response, 200, currentSummary());
    return;
  }

  if (
    request.method === 'GET' &&
    url.pathname === '/api/metrics'
  ) {
    sendJson(response, 200, {
      service: 'animaxia-observability',
      completedCycles,
      probes,
      timestamp: new Date().toISOString(),
    });
    return;
  }

  if (
    request.method === 'GET' &&
    url.pathname === '/metrics'
  ) {
    response.statusCode = 200;
    response.setHeader(
      'content-type',
      'text/plain; version=0.0.4; charset=utf-8',
    );
    response.setHeader('cache-control', 'no-store');
    response.end(prometheusMetrics());
    return;
  }

  if (
    request.method === 'GET' &&
    url.pathname === '/api/alerts'
  ) {
    const activeOnly =
      url.searchParams.get('active') !== 'false';

    sendJson(response, 200, {
      count: activeOnly
        ? alerts.filter((alert) => alert.active).length
        : alerts.length,
      alerts: activeOnly
        ? alerts.filter((alert) => alert.active)
        : alerts.slice().reverse(),
    });
    return;
  }

  if (
    request.method === 'GET' &&
    url.pathname === '/api/events'
  ) {
    const requestedLimit = Number.parseInt(
      url.searchParams.get('limit') ?? '50',
      10,
    );

    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(requestedLimit, 1), 200)
      : 50;

    sendJson(response, 200, {
      count: events.length,
      events: events.slice(-limit).reverse(),
    });
    return;
  }

  if (
    request.method === 'POST' &&
    url.pathname === '/api/probe'
  ) {
    void runCycle().then(() => {
      if (!response.writableEnded) {
        sendJson(response, 200, currentSummary());
      }
    });
    return;
  }

  sendJson(response, 404, {
    error: 'Not found',
    service: 'animaxia-observability',
  });
});

server.requestTimeout = 15_000;
server.headersTimeout = 15_000;
server.keepAliveTimeout = 5_000;

loadPersistedState();

server.listen(PORT, '127.0.0.1', () => {
  console.log(
    `[observability] listening on 127.0.0.1:${PORT}, ` +
    `interval=${PROBE_INTERVAL_MS}ms`,
  );

  void runCycle();
});

const interval = setInterval(() => {
  void runCycle();
}, PROBE_INTERVAL_MS);

function shutdown(signal) {
  console.log(`[observability] ${signal}, shutting down`);

  clearInterval(interval);
  persistState();

  server.close(() => {
    process.exit(0);
  });

  setTimeout(() => process.exit(1), 5_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
