/**
 * common/metrics.js — Zero-dependency Prometheus metrics library for Animaxia
 * Cloud. Implements the Prometheus text exposition format (version 0.0.4):
 * Counter, Gauge and Histogram with label sets, a global registry, standard
 * HTTP/process metrics and a /metrics-ready Express handler.
 *
 * The default metric family names are shared by every microservice and
 * documented in BLUEPRINT §11 (animaxia_http_requests_total, ...).
 */

const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

/* ------------------------------- primitives -------------------------------- */

class Metric {
  constructor({ name, help, type, labelNames = [] }) {
    this.name = name;
    this.help = help;
    this.type = type; // 'counter' | 'gauge' | 'histogram'
    this.labelNames = labelNames;
    this.samples = new Map(); // key (serialized labels) -> value
    if (this.type === 'histogram') {
      this.buckets = DEFAULT_BUCKETS;
      this.bucketCounts = new Map(); // key -> { bucketIndex: count, sum, count }
    }
  }

  _key(labels = {}) {
    const parts = [];
    for (const labelName of this.labelNames) {
      if (labels[labelName] !== undefined) parts.push(`${labelName}="${String(labels[labelName]).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
    }
    return parts.join(',');
  }

  _ensure(labels) {
    const key = this._key(labels);
    if (!this.samples.has(key)) {
      this.samples.set(key, this.type === 'counter' || this.type === 'gauge' ? 0 : { count: 0, sum: 0 });
      if (this.type === 'histogram') {
        this.bucketCounts.set(key, this.buckets.map(() => 0));
      }
    }
    return key;
  }
}

export class Counter extends Metric {
  constructor(options) {
    super({ ...options, type: 'counter' });
  }
  inc(labels = {}, value = 1) {
    if (typeof labels === 'number') {
      value = labels;
      labels = {};
    }
    const key = this._ensure(labels);
    this.samples.set(key, (this.samples.get(key) || 0) + value);
  }
}

export class Gauge extends Metric {
  constructor(options) {
    super({ ...options, type: 'gauge' });
  }
  set(labels = {}, value = 0) {
    if (typeof labels === 'number') {
      value = labels;
      labels = {};
    }
    const key = this._ensure(labels);
    this.samples.set(key, value);
  }
  inc(labels = {}, value = 1) {
    if (typeof labels === 'number') {
      value = labels;
      labels = {};
    }
    const key = this._ensure(labels);
    this.samples.set(key, (this.samples.get(key) || 0) + value);
  }
  dec(labels = {}, value = 1) {
    this.inc(labels, -value);
  }
}

export class Histogram extends Metric {
  constructor(options) {
    super({ ...options, type: 'histogram' });
  }
  observe(labels = {}, value = 0) {
    if (typeof labels === 'number') {
      value = labels;
      labels = {};
    }
    const key = this._ensure(labels);
    const entry = this.samples.get(key);
    entry.count += 1;
    entry.sum += value;
    const counts = this.bucketCounts.get(key);
    for (let i = 0; i < this.buckets.length; i += 1) {
      if (value <= this.buckets[i]) counts[i] += 1;
    }
  }
}

/* -------------------------------- registry --------------------------------- */

const registry = new Map();

export function registerMetric(metric) {
  registry.set(metric.name, metric);
  return metric;
}

function formatBucketLabel(bound) {
  return String(bound);
}

/** Render the full registry in Prometheus text format. */
export function renderMetrics() {
  const lines = [];
  const metricNames = [...registry.keys()].sort();
  for (const name of metricNames) {
    const metric = registry.get(name);
    lines.push(`# HELP ${name} ${metric.help}`);
    lines.push(`# TYPE ${name} ${metric.type}`);
    for (const [labelsKey, value] of metric.samples) {
      if (metric.type === 'histogram') {
        const counts = metric.bucketCounts.get(labelsKey);
        let cumulative = 0;
        for (let i = 0; i < metric.buckets.length; i += 1) {
          cumulative += counts[i];
          const labelSuffix = labelsKey ? `${labelsKey},le="${formatBucketLabel(metric.buckets[i])}"` : `le="${formatBucketLabel(metric.buckets[i])}"`;
          lines.push(`${name}_bucket{${labelSuffix}} ${cumulative}`);
        }
        const infLabels = labelsKey ? `${labelsKey},le="+Inf"` : 'le="+Inf"';
        lines.push(`${name}_bucket{${infLabels}} ${value.count}`);
        const sumLabels = labelsKey ? `${labelsKey}` : '';
        lines.push(`${name}_sum{${sumLabels}} ${Number(value.sum.toFixed(6))}`);
        lines.push(`${name}_count{${sumLabels}} ${value.count}`);
      } else {
        const labelSuffix = labelsKey ? `{${labelsKey}}` : '';
        lines.push(`${name}${labelSuffix} ${value}`);
      }
    }
  }
  lines.push('');
  lines.push(`# HELP animaxia_metrics_exporter_build_info Animaxia Cloud metrics exporter`);
  lines.push(`# TYPE animaxia_metrics_exporter_build_info gauge`);
  lines.push(`animaxia_metrics_exporter_build_info{version="3.0.0"} 1`);
  return `${lines.join('\n')}\n`;
}

/** Express handler: GET /metrics */
export function metricsHandler() {
  return (req, res) => {
    res.type('text/plain; version=0.0.4; charset=utf-8');
    res.send(renderMetrics());
  };
}

/* ------------------------- standard service metrics ------------------------- */

const SERVICE = () => process.env.SERVICENAME || 'unknown';

export const httpRequestsTotal = registerMetric(
  new Counter({
    name: 'animaxia_http_requests_total',
    help: 'Total HTTP requests handled',
    labelNames: ['service', 'method', 'route', 'status'],
  }),
);

export const httpRequestDuration = registerMetric(
  new Histogram({
    name: 'animaxia_http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['service', 'method', 'route'],
  }),
);

export const uptimeGauge = registerMetric(
  new Gauge({
    name: 'animaxia_uptime_seconds',
    help: 'Service uptime in seconds',
    labelNames: ['service'],
  }),
);

export const memoryRssGauge = registerMetric(
  new Gauge({
    name: 'animaxia_memory_rss_bytes',
    help: 'Resident set size in bytes',
    labelNames: ['service'],
  }),
);

export const memoryHeapGauge = registerMetric(
  new Gauge({
    name: 'animaxia_memory_heap_used_bytes',
    help: 'Used heap size in bytes',
    labelNames: ['service'],
  }),
);

export const eventLoopLagGauge = registerMetric(
  new Gauge({
    name: 'animaxia_event_loop_lag_seconds',
    help: 'Event loop lag in seconds (sampled)',
    labelNames: ['service'],
  }),
);

export const cacheHits = registerMetric(
  new Counter({ name: 'animaxia_cache_hits_total', help: 'Cache hits', labelNames: ['service'] }),
);

export const cacheMisses = registerMetric(
  new Counter({ name: 'animaxia_cache_misses_total', help: 'Cache misses', labelNames: ['service'] }),
);

export const rateLimitedTotal = registerMetric(
  new Counter({ name: 'animaxia_rate_limited_total', help: 'Requests rejected by the rate limiter', labelNames: ['service'] }),
);

// Shared gauge instances the cache/rate-limit modules bump via globalThis.
globalThis.__animaxiaMetrics = { cacheHits, cacheMisses, rateLimited: rateLimitedTotal };

/** Normalise a path into a low-cardinality route label. */
function routeLabel(path) {
  const clean = String(path || '/').split('?')[0];
  return clean
    .replace(/\/\d+(?=\/|$)/g, '/:id')
    .replace(/\/[a-f0-9-]{16,}(?=\/|$)/gi, '/:hash')
    .slice(0, 120) || '/';
}

/** Express middleware: records request count + latency per service/route/status. */
export function httpMetricsMiddleware() {
  return (req, res, next) => {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      try {
        const seconds = Number(process.hrtime.bigint() - start) / 1e9;
        const labels = {
          service: SERVICE(),
          method: req.method,
          route: routeLabel(req.baseUrl ? `${req.baseUrl}${req.path || ''}` : req.path || req.originalUrl || '/'),
          status: String(res.statusCode),
        };
        httpRequestsTotal.inc(labels);
        httpRequestDuration.observe({ service: labels.service, method: labels.method, route: labels.route }, seconds);
      } catch {
        /* metrics must never break requests */
      }
    });
    next();
  };
}

/** Refresh process-level gauges (called on an interval by createService). */
export function refreshProcessMetrics() {
  const service = SERVICE();
  uptimeGauge.set({ service }, Math.floor(process.uptime()));
  const mem = process.memoryUsage();
  memoryRssGauge.set({ service }, mem.rss);
  memoryHeapGauge.set({ service }, mem.heapUsed);
  const start = process.hrtime.bigint();
  setImmediate(() => {
    try {
      eventLoopLagGauge.set({ service }, Number(process.hrtime.bigint() - start) / 1e9);
    } catch {
      /* ignore */
    }
  });
}

export default {
  Counter,
  Gauge,
  Histogram,
  registerMetric,
  renderMetrics,
  metricsHandler,
  httpMetricsMiddleware,
  refreshProcessMetrics,
};
