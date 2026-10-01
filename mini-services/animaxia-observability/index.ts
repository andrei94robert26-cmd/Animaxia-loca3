/**
 * FAZA 23 — animaxia-observability (port FIX 4050)
 * Stack de observabilitate enterprise RUNNABLE LOCAL — echivalentul local al:
 *   Prometheus (scrape 10s + /metrics) · Grafana (4 dashboards + live data)
 *   Alertmanager (10 reguli, evaluare 15s) · OTel Collector (OTLP/HTTP-JSON)
 *   Synthetics (46 checks globale, 60s)
 * ZERO dependențe externe (node:http / node:net / node:crypto + bun built-ins).
 */
import http from 'node:http';
import crypto from 'node:crypto';
import {
  CORS_ALLOWLIST,
  PORT,
  RETENTION_DAYS,
  RETENTION_SWEEP_MS,
  SERVICE_NAME,
  VERSION,
} from './config.ts';
import { MetricsStore } from './modules/metrics-store.ts';
import { TraceCollector } from './modules/collector.ts';
import { Scraper } from './modules/scrape.ts';
import { AlertManager } from './modules/alerts.ts';
import { Synthetics } from './modules/synthetics.ts';
import { Dashboards } from './modules/dashboards.ts';
import { buildSummary } from './modules/summary.ts';

const store = new MetricsStore();
const collector = new TraceCollector();
const scraper = new Scraper(store);
const alerts = new AlertManager(store, scraper);
const synthetics = new Synthetics(store);
const dashboards = new Dashboards(store, scraper);

const startedAt = Date.now();

/* NEON FREE PLAN (scale-to-zero): sincronizarea collector→gauge (fost timer la
 * 5s) se face acum LAZY — în tick-ul scraperului (la 30 min) și înainte de
 * fiecare citire a metricilor — zero activitate de fundal. */
function syncCollectorGauge(): void {
  scraper.collectorTracesActive = collector.stats().tracesActive;
}

// retention sweep (orar) — comportament real, testabil
setInterval(() => {
  const res = store.retentionSweep();
  if (res.droppedPoints > 0) {
    log(`retention sweep: ${res.droppedPoints} puncte > ${RETENTION_DAYS} zile drop-ate`);
  }
}, RETENTION_SWEEP_MS);

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ── CORS ──────────────────────────────────────────────────────────────────
/** Allowlist ['http://localhost:81','http://localhost:3000'] + mirror dev:
 *  Origin http://localhost:<alt port> → reflectat; fără Origin → OK. */
function corsHeaders(req: http.IncomingMessage): Record<string, string> {
  const origin = req.headers.origin;
  if (!origin || typeof origin !== 'string') {
    return {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    };
  }
  const allow = CORS_ALLOWLIST.includes(origin as (typeof CORS_ALLOWLIST)[number])
    ? origin
    : /^http:\/\/localhost(:\d+)?$/.test(origin)
      ? origin // mirror dev — orice localhost
      : '';
  return {
    'Access-Control-Allow-Origin': allow,
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

// ── helpers ───────────────────────────────────────────────────────────────
interface ParsedUrl {
  path: string;
  query: URLSearchParams;
}

function parseUrl(raw: string | undefined): ParsedUrl {
  const u = new URL(raw ?? '/', `http://localhost:${PORT}`);
  return { path: u.pathname.replace(/\/+$/, '') || '/', query: u.searchParams };
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    ...extraHeaders,
  });
  res.end(payload);
}

function readBody(req: http.IncomingMessage, limitBytes = 2 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function tryParseJson(buf: Buffer): unknown {
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    return null;
  }
}

// ── server ────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const { path, query } = parseUrl(req.url);
  const cors = corsHeaders(req);
  const method = (req.method ?? 'GET').toUpperCase();

  if (method === 'OPTIONS') {
    res.writeHead(204, cors);
    res.end();
    return;
  }

  try {
    // ─────────── info / health ─────────────────────────────────────────────
    if (path === '/' && method === 'GET') {
      syncCollectorGauge();
      sendJson(res, 200, {
        ok: true,
        service: SERVICE_NAME,
        version: VERSION,
        port: PORT,
        description:
          'FAZA 23 — observability stack local rulabil: OTel Collector (OTLP/HTTP-JSON), Prometheus (scrape+expose), Alertmanager (10 reguli), Grafana-compatible (4 dashboards), Synthetics (46 checks)',
        components: {
          collector: '/v1/traces, /v1/metrics, /api/traces*',
          prometheus: '/metrics, /api/metrics.json (scrape 30 min — NEON FREE PLAN, retention 30d)',
          alerts: '/api/alerts, /alertmanager/api/v2/alerts (10 reguli, eval 5 min)',
          dashboards: '/api/dashboards (faza23-pipeline, faza23-huburi, faza23-player, faza23-global)',
          synthetics: '/api/synthetics (46 checks, ON-DEMAND via POST /api/synthetics/_run — NEON FREE PLAN)',
          summary: '/api/summary (contract fix pentru #/admin/observability)',
        },
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      }, cors);
      return;
    }

    if ((path === '/health' || path === '/api/observability/health') && method === 'GET') {
      sendJson(res, 200, {
        ok: true,
        service: SERVICE_NAME,
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
        components: {
          collector: true,
          metrics: true,
          alerts: true,
          dashboards: true,
          synthetics: true,
        },
        retentionDays: RETENTION_DAYS,
      }, cors);
      return;
    }

    // ─────────── OTel collector: ingest ───────────────────────────────────
    if (path === '/v1/traces' && method === 'POST') {
      const body = tryParseJson(await readBody(req));
      if (body === null) {
        sendJson(res, 400, { error: 'invalid JSON body' }, cors);
        return;
      }
      const result = collector.ingest(body);
      // Atribuire per serviciu (FAZA 23 final: înainte toate span-urile erau
      // creditate primului serviciu din stats — bug; acum ingest() returnează
      // defalcarea exactă per service.name).
      for (const [svc, n] of Object.entries(result.perService)) {
        store.countIngest('spans', svc, n);
      }
      sendJson(res, 200, { acceptedSpans: result.acceptedSpans }, cors);
      return;
    }

    if (path === '/v1/metrics' && method === 'POST') {
      const body = tryParseJson(await readBody(req));
      if (body === null || !Array.isArray((body as { metrics?: unknown }).metrics)) {
        sendJson(res, 400, { error: 'invalid body: {metrics:[...]} expected' }, cors);
        return;
      }
      const metrics = (body as { metrics: unknown[] }).metrics;
      let accepted = 0;
      for (const m of metrics) {
        if (store.ingestOtelMetric(m as { name: string })) {
          accepted++;
          const labels = (m as { labels?: Record<string, unknown> }).labels ?? {};
          const svc = typeof labels['service'] === 'string' ? labels['service'] : 'unknown';
          store.countIngest('metrics', svc, 1);
        }
      }
      sendJson(res, 200, { accepted }, cors);
      return;
    }

    // ─────────── traces query API ─────────────────────────────────────────
    if (path === '/api/traces' && method === 'GET') {
      const service = query.get('service') ?? undefined;
      const limit = query.get('limit') ? Number(query.get('limit')) : undefined;
      const error = query.get('error');
      sendJson(
        res,
        200,
        collector.listTraces({
          service,
          limit: Number.isFinite(limit) ? limit : undefined,
          error: error === null || error === '' ? undefined : error === 'true' || error === '1',
        }),
        cors,
      );
      return;
    }

    if (path === '/api/traces/stats' && method === 'GET') {
      sendJson(res, 200, collector.stats(), cors);
      return;
    }

    const traceMatch = /^\/api\/traces\/([0-9a-fA-F]{8,64})$/.exec(path);
    if (traceMatch && method === 'GET') {
      const trace = collector.getTrace(traceMatch[1]);
      if (!trace) {
        sendJson(res, 404, { error: 'trace not found' }, cors);
        return;
      }
      const spans = [...trace.spans].sort((a, b) => a.startMs - b.startMs);
      sendJson(res, 200, { traceId: trace.traceId, spans }, cors);
      return;
    }

    // ─────────── Prometheus expose ────────────────────────────────────────
    if (path === '/metrics' && method === 'GET') {
      syncCollectorGauge(); // NEON FREE PLAN: gauge lazy, la citire
      const text = store.render();
      res.writeHead(200, {
        'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
        ...cors,
      });
      res.end(text);
      return;
    }

    if (path === '/api/metrics.json' && method === 'GET') {
      syncCollectorGauge(); // NEON FREE PLAN: gauge lazy, la citire
      sendJson(res, 200, store.toJson(), cors);
      return;
    }

    // ─────────── alerts ───────────────────────────────────────────────────
    if (path === '/api/alerts' && method === 'GET') {
      sendJson(
        res,
        200,
        {
          rules: alerts.rulesView(),
          firing: alerts.firing(),
          pending: alerts.pending(),
          log: alerts.logView(),
        },
        cors,
      );
      return;
    }

    if (path === '/alertmanager/api/v2/alerts' && method === 'GET') {
      sendJson(res, 200, alerts.alertmanagerV2(), cors);
      return;
    }

    const simulateMatch = /^\/api\/alerts\/_simulate\/([\w-]+)$/.exec(path);
    if (simulateMatch && method === 'POST') {
      const body = tryParseJson(await readBody(req));
      sendJson(res, 200, alerts.simulate(simulateMatch[1], body), cors);
      return;
    }

    // ─────────── dashboards ───────────────────────────────────────────────
    if (path === '/api/dashboards' && method === 'GET') {
      sendJson(res, 200, dashboards.list(), cors);
      return;
    }

    const dashMatch = /^\/api\/dashboards\/([\w-]+)$/.exec(path);
    if (dashMatch && method === 'GET') {
      const json = dashboards.grafanaJson(dashMatch[1]);
      if (!json) {
        sendJson(res, 404, { error: `dashboard ${dashMatch[1]} not found` }, cors);
        return;
      }
      sendJson(res, 200, json, cors);
      return;
    }

    const dashDataMatch = /^\/api\/dashboards\/([\w-]+)\/data$/.exec(path);
    if (dashDataMatch && method === 'GET') {
      const data = dashboards.liveData(dashDataMatch[1]);
      if (!data) {
        sendJson(res, 404, { error: `dashboard ${dashDataMatch[1]} not found` }, cors);
        return;
      }
      sendJson(res, 200, data, cors);
      return;
    }

    // ─────────── synthetics ───────────────────────────────────────────────
    if (path === '/api/synthetics' && method === 'GET') {
      sendJson(res, 200, synthetics.view(), cors);
      return;
    }

    if (path === '/api/synthetics/_run' && method === 'POST') {
      const result = await synthetics.runNow();
      sendJson(res, 200, result, cors);
      return;
    }

    const synMatch = /^\/api\/synthetics\/([\w-]+)\/history$/.exec(path);
    if (synMatch && method === 'GET') {
      const hist = synthetics.historyFor(synMatch[1]);
      if (!hist) {
        sendJson(res, 404, { error: `check ${synMatch[1]} not found` }, cors);
        return;
      }
      sendJson(res, 200, hist, cors);
      return;
    }

    // ─────────── summary (contract fix) ───────────────────────────────────
    if (path === '/api/summary' && method === 'GET') {
      sendJson(res, 200, buildSummary(store, scraper, collector, alerts, synthetics), cors);
      return;
    }

    // ─────────── 404 ──────────────────────────────────────────────────────
    sendJson(
      res,
      404,
      { error: `Route not found: ${method} ${path}`, traceId: crypto.randomUUID() },
      cors,
    );
  } catch (err) {
    log(`ERROR ${method} ${path}: ${err instanceof Error ? err.message : String(err)}`);
    sendJson(res, 500, { error: 'internal error' }, cors);
  }
});

server.listen(PORT, () => {
  log(`${SERVICE_NAME} v${VERSION} ascultă pe :${PORT} (retention ${RETENTION_DAYS}d)`);
});

// pornim componentele de fundal
scraper.start();
alerts.start();
synthetics.start();

process.on('SIGTERM', () => {
  scraper.stop();
  alerts.stop();
  synthetics.stop();
  server.close();
  process.exit(0);
});
process.on('SIGINT', () => {
  scraper.stop();
  alerts.stop();
  synthetics.stop();
  server.close();
  process.exit(0);
});
