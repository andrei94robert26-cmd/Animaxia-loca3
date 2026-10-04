import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const PORT = 4060;
const REFRESH_MS = 30_000;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RECOVERIES = 200;

const LOOPBACK = ['http:', '', '127.0.0.1'].join('/');

const URLS = {
  observabilitySummary: `${LOOPBACK}:4050/api/summary`,
  observabilityAlerts: `${LOOPBACK}:4050/api/alerts`,
  observabilityEvents: `${LOOPBACK}:4050/api/events?limit=100`,
  observabilityProbe: `${LOOPBACK}:4050/api/probe`,
  watchdogStatus: `${LOOPBACK}:4020/api/watchdog/status`,
  watchdogCheck: `${LOOPBACK}:4020/api/watchdog/check`,
};

const startedAt = Date.now();
const dataDir = path.resolve('data');
const stateFile = path.join(dataDir, 'state.json');

fs.mkdirSync(dataDir, { recursive: true });

let cycleRunning = false;
let completedCycles = 0;
let lastRefreshAt = null;
let lastError = null;

let observabilitySummary = null;
let watchdogStatus = null;
let incidents = [];
let events = [];
let recoveries = [];

function loadState() {
  try {
    if (!fs.existsSync(stateFile)) return;

    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));

    completedCycles = Number.isFinite(state.completedCycles)
      ? state.completedCycles
      : 0;

    recoveries = Array.isArray(state.recoveries)
      ? state.recoveries.slice(-MAX_RECOVERIES)
      : [];
  } catch (error) {
    console.error('[stability] state load failed:', error.message);
  }
}

function persistState() {
  const temporaryFile = `${stateFile}.tmp`;

  try {
    fs.writeFileSync(
      temporaryFile,
      JSON.stringify(
        {
          completedCycles,
          recoveries: recoveries.slice(-MAX_RECOVERIES),
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );

    fs.renameSync(temporaryFile, stateFile);
  } catch (error) {
    console.error('[stability] state persist failed:', error.message);
  }
}

async function requestJson(url, options = {}) {
  const controller = new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT_MS,
  );

  try {
    const response = await fetch(url, {
      method: options.method ?? 'GET',
      cache: 'no-store',
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        'user-agent': 'animaxia-stability/1.0',
      },
    });

    const text = await response.text();

    let body = null;

    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return body;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeIncident(alert) {
  const intentionalDemo =
    alert?.data?.intentionalDemo === true ||
    alert?.key === 'gateway:us:redundancy';

  return {
    id: alert.id,
    key: alert.key,
    service: alert.service,
    severity: alert.severity,
    message: alert.message,
    active: alert.active === true,
    intentionalDemo,
    createdAt: alert.createdAt,
    lastSeenAt: alert.lastSeenAt,
    resolvedAt: alert.resolvedAt ?? null,
    data: alert.data ?? null,
  };
}

function calculateScore(activeIncidents) {
  let score = 100;

  for (const incident of activeIncidents) {
    if (incident.intentionalDemo) continue;

    if (incident.severity === 'critical') {
      score -= 30;
    } else if (incident.severity === 'warning') {
      score -= 10;
    } else {
      score -= 1;
    }
  }

  return Math.max(0, score);
}

function currentFailovers() {
  const regions =
    observabilitySummary?.gateway?.regions ?? [];

  return regions.map((region) => {
    const healthy = region.upstreams.filter(
      (upstream) =>
        upstream.healthy && !upstream.forcedDown,
    ).length;

    const total = region.upstreams.length;

    return {
      region: region.name,
      label: region.label,
      healthy,
      total,
      available: healthy > 0,
      failoverActive: healthy > 0 && healthy < total,
      intentionalDemo:
        region.name === 'us' &&
        healthy > 0 &&
        healthy < total,
    };
  });
}

function currentStatus() {
  const activeIncidents = incidents.filter(
    (incident) => incident.active,
  );

  const critical = activeIncidents.filter(
    (incident) => incident.severity === 'critical',
  ).length;

  const warning = activeIncidents.filter(
    (incident) => incident.severity === 'warning',
  ).length;

  const info = activeIncidents.filter(
    (incident) => incident.severity === 'info',
  ).length;

  const failovers = currentFailovers();

  const criticalServicesHealthy =
    observabilitySummary?.ok === true &&
    watchdogStatus?.ok === true &&
    failovers.every((region) => region.available);

  return {
    ok: criticalServicesHealthy && critical === 0,
    service: 'animaxia-stability',
    port: PORT,
    uptimeSec: Math.floor(
      (Date.now() - startedAt) / 1000,
    ),
    completedCycles,
    lastRefreshAt,
    lastError,
    score: calculateScore(activeIncidents),
    state:
      critical > 0
        ? 'critical'
        : warning > 0
          ? 'degraded'
          : 'stable',
    dependencies: {
      observability: {
        healthy: observabilitySummary?.ok === true,
        cycles:
          observabilitySummary?.completedCycles ?? 0,
      },
      watchdog: {
        healthy: watchdogStatus?.ok === true,
        cycles: watchdogStatus?.completedCycles ?? 0,
      },
    },
    incidents: {
      active: activeIncidents.length,
      critical,
      warning,
      info,
    },
    failovers: {
      active: failovers.filter(
        (region) => region.failoverActive,
      ).length,
      regions: failovers,
    },
    recoveries: {
      total: recoveries.length,
      latest: recoveries.slice(-10).reverse(),
    },
    timestamp: new Date().toISOString(),
  };
}

async function refreshState() {
  if (cycleRunning) return currentStatus();

  cycleRunning = true;

  try {
    const [
      summary,
      alertsResponse,
      eventsResponse,
      watchdog,
    ] = await Promise.all([
      requestJson(URLS.observabilitySummary),
      requestJson(URLS.observabilityAlerts),
      requestJson(URLS.observabilityEvents),
      requestJson(URLS.watchdogStatus),
    ]);

    observabilitySummary = summary;
    watchdogStatus = watchdog;

    incidents = Array.isArray(alertsResponse?.alerts)
      ? alertsResponse.alerts.map(normalizeIncident)
      : [];

    events = Array.isArray(eventsResponse?.events)
      ? eventsResponse.events
      : [];

    completedCycles += 1;
    lastRefreshAt = new Date().toISOString();
    lastError = null;

    persistState();
  } catch (error) {
    lastError =
      error instanceof Error
        ? error.message
        : String(error);

    console.error(
      '[stability] refresh failed:',
      lastError,
    );
  } finally {
    cycleRunning = false;
  }

  return currentStatus();
}

async function runRecovery() {
  const recovery = {
    id: crypto.randomUUID(),
    startedAt: new Date().toISOString(),
    finishedAt: null,
    success: false,
    actions: [],
    error: null,
  };

  try {
    const [watchdogResult, observabilityResult] =
      await Promise.allSettled([
        requestJson(URLS.watchdogCheck, {
          method: 'POST',
        }),
        requestJson(URLS.observabilityProbe, {
          method: 'POST',
        }),
      ]);

    recovery.actions.push({
      action: 'watchdog-check',
      success: watchdogResult.status === 'fulfilled',
      error:
        watchdogResult.status === 'rejected'
          ? String(watchdogResult.reason)
          : null,
    });

    recovery.actions.push({
      action: 'observability-probe',
      success:
        observabilityResult.status === 'fulfilled',
      error:
        observabilityResult.status === 'rejected'
          ? String(observabilityResult.reason)
          : null,
    });

    await refreshState();

    recovery.success = recovery.actions.every(
      (action) => action.success,
    );
  } catch (error) {
    recovery.error =
      error instanceof Error
        ? error.message
        : String(error);
  }

  recovery.finishedAt = new Date().toISOString();

  recoveries.push(recovery);

  if (recoveries.length > MAX_RECOVERIES) {
    recoveries = recoveries.slice(-MAX_RECOVERIES);
  }

  persistState();

  return recovery;
}

function sendJson(response, status, body) {
  response.statusCode = status;

  response.setHeader(
    'content-type',
    'application/json; charset=utf-8',
  );

  response.setHeader(
    'cache-control',
    'no-store',
  );

  response.end(JSON.stringify(body));
}

const server = http.createServer(
  (request, response) => {
    const url = new URL(
      request.url ?? '/',
      `${LOOPBACK}:${PORT}`,
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
        service: 'animaxia-stability',
        port: PORT,
        uptimeSec: Math.floor(
          (Date.now() - startedAt) / 1000,
        ),
        completedCycles,
        timestamp: new Date().toISOString(),
      });

      return;
    }

    if (
      request.method === 'GET' &&
      url.pathname === '/api/stability/status'
    ) {
      sendJson(response, 200, currentStatus());
      return;
    }

    if (
      request.method === 'GET' &&
      url.pathname === '/api/incidents'
    ) {
      const activeOnly =
        url.searchParams.get('active') !== 'false';

      const selected = activeOnly
        ? incidents.filter(
            (incident) => incident.active,
          )
        : incidents;

      sendJson(response, 200, {
        count: selected.length,
        incidents: selected,
      });

      return;
    }

    if (
      request.method === 'GET' &&
      url.pathname === '/api/failovers'
    ) {
      const failovers = currentFailovers();

      sendJson(response, 200, {
        count: failovers.filter(
          (region) => region.failoverActive,
        ).length,
        regions: failovers,
      });

      return;
    }

    if (
      request.method === 'GET' &&
      url.pathname === '/api/recoveries'
    ) {
      sendJson(response, 200, {
        count: recoveries.length,
        recoveries: recoveries
          .slice()
          .reverse(),
      });

      return;
    }

    if (
      request.method === 'GET' &&
      url.pathname === '/api/events'
    ) {
      sendJson(response, 200, {
        count: events.length,
        events,
      });

      return;
    }

    if (
      request.method === 'POST' &&
      url.pathname === '/api/recovery/run'
    ) {
      void runRecovery().then((recovery) => {
        if (!response.writableEnded) {
          sendJson(response, 200, {
            recovery,
            status: currentStatus(),
          });
        }
      });

      return;
    }

    if (
      request.method === 'POST' &&
      url.pathname === '/api/stability/refresh'
    ) {
      void refreshState().then((status) => {
        if (!response.writableEnded) {
          sendJson(response, 200, status);
        }
      });

      return;
    }

    sendJson(response, 404, {
      error: 'Not found',
      service: 'animaxia-stability',
    });
  },
);

server.requestTimeout = 20_000;
server.headersTimeout = 20_000;
server.keepAliveTimeout = 5_000;

loadState();

server.listen(PORT, '127.0.0.1', () => {
  console.log(
    `[stability] listening on 127.0.0.1:${PORT}`,
  );

  void refreshState();
});

const interval = setInterval(() => {
  void refreshState();
}, REFRESH_MS);

function shutdown(signal) {
  console.log(
    `[stability] ${signal}, shutting down`,
  );

  clearInterval(interval);
  persistState();

  server.close(() => {
    process.exit(0);
  });

  setTimeout(
    () => process.exit(1),
    5_000,
  ).unref();
}

process.on(
  'SIGTERM',
  () => shutdown('SIGTERM'),
);

process.on(
  'SIGINT',
  () => shutdown('SIGINT'),
);
