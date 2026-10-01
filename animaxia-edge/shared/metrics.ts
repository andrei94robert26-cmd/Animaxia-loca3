/**
 * shared/metrics.ts — FAZA 9 (Ops & Observability) unified metrics for the
 * Animaxia edge layer.
 *
 * One registry per worker isolate + a `withMetrics` wrapper that observes
 * requests without altering them (pure passthrough — the same Response object
 * is returned). Counters are in-memory per isolate; in production each worker
 * reports its own series, in the local harness (single process) all modules
 * share the registry and stay distinguishable via the `module` label.
 *
 * Exposed endpoints:
 *   module workers  GET /metrics               (public, per-worker isolate)
 *   gateway         GET /edge/metrics          (requireInternalAuth, like the
 *                                               other /edge/* management routes)
 *   both accept ?format=json for a structured snapshot.
 *
 * Metric contract (canonical doc: animaxia-ops/metrics/METRICS.md):
 *   animaxia_edge_requests_total{module,route,status}             counter
 *   animaxia_edge_request_latency_ms_{bucket|sum|count}{module,route} histogram
 *   animaxia_edge_errors_total{module}                            counter (5xx + throws)
 *   animaxia_edge_cache_events_total{module,state}                counter (x-edge-cache tag)
 *   animaxia_edge_waf_blocks_total{rule}                          counter (gateway)
 *   animaxia_edge_cron_runs_total{cron} / animaxia_edge_cron_jobs_total{job,ok} (cron worker)
 *
 * Route labels are normalized (numeric segments → :id, max 3 segments) to keep
 * label cardinality bounded. Zero dependencies. Strict TypeScript.
 */

import type { EdgeEnv, EdgeCtx } from './types';
import { jsonOk } from './http';

const BUCKETS_MS = [10, 25, 50, 100, 250, 500, 1000, 2500];
const MAX_ROUTE_SEGMENTS = 3;

export interface MetricsLabels {
  readonly [key: string]: string;
}

export interface CounterSeries {
  name: string;
  labels: MetricsLabels;
  value: number;
}

export interface HistSeries {
  name: string;
  labels: MetricsLabels;
  count: number;
  sum: number;
  buckets: { le: string; cumulative: number }[];
}

export interface MetricsSnapshot {
  counters: CounterSeries[];
  histograms: HistSeries[];
}

/* ------------------------------------------------------------ primitives --- */

/** Prometheus label-value escaping. */
function esc(v: string): string {
  return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** Sorted label block: {k1="v1",k2="v2"} or '' when empty. */
function labelStr(labels: MetricsLabels): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return '';
  return `{${keys.map((k) => `${k}="${esc(labels[k])}"`).join(',')}}`;
}

/** Label block with one extra appended label (histogram le buckets). */
function labelStrWith(labels: MetricsLabels, extraKey: string, extraValue: string): string {
  const keys = Object.keys(labels).sort();
  const parts = keys.map((k) => `${k}="${esc(labels[k])}"`);
  parts.push(`${extraKey}="${esc(extraValue)}"`);
  return `{${parts.join(',')}}`;
}

/** Numeric path segments → :id, cap segment count (cardinality guard). */
export function normalizeEdgeRoute(pathname: string): string {
  const segs = pathname.split('?')[0].split('/').filter(Boolean).slice(0, MAX_ROUTE_SEGMENTS);
  const norm = segs.map((s) => (/^\d+$/.test(s) ? ':id' : s));
  return norm.length === 0 ? '/' : `/${norm.join('/')}`;
}

/* -------------------------------------------------------------- registry --- */

export class MetricsRegistry {
  private counters = new Map<string, Map<string, { labels: MetricsLabels; value: number }>>();
  private hists = new Map<string, Map<string, { labels: MetricsLabels; count: number; sum: number; buckets: number[] }>>();

  inc(name: string, labels: MetricsLabels = {}, value = 1): void {
    if (!this.counters.has(name)) this.counters.set(name, new Map());
    const key = labelStr(labels);
    const map = this.counters.get(name)!;
    const slot = map.get(key) || { labels, value: 0 };
    slot.value += value;
    map.set(key, slot);
  }

  /** Observe a latency in milliseconds into a bounded histogram. */
  observe(name: string, labels: MetricsLabels = {}, ms = 0): void {
    if (!this.hists.has(name)) this.hists.set(name, new Map());
    const key = labelStr(labels);
    const map = this.hists.get(name)!;
    const h = map.get(key) || { labels, count: 0, sum: 0, buckets: new Array(BUCKETS_MS.length + 1).fill(0) };
    h.count += 1;
    h.sum += ms;
    let placed = false;
    for (let i = 0; i < BUCKETS_MS.length; i += 1) {
      if (ms <= BUCKETS_MS[i]) {
        h.buckets[i] += 1;
        placed = true;
        break;
      }
    }
    if (!placed) h.buckets[BUCKETS_MS.length] += 1;
    map.set(key, h);
  }

  snapshot(): MetricsSnapshot {
    const counters: CounterSeries[] = [];
    for (const [name, slots] of this.counters) {
      for (const { labels, value } of slots.values()) counters.push({ name, labels, value });
    }
    const histograms: HistSeries[] = [];
    for (const [name, slots] of this.hists) {
      for (const h of slots.values()) {
        let cum = 0;
        const buckets = BUCKETS_MS.map((le, i) => {
          cum += h.buckets[i];
          return { le: String(le), cumulative: cum };
        });
        buckets.push({ le: '+Inf', cumulative: h.count });
        histograms.push({ name, labels: h.labels, count: h.count, sum: Math.round(h.sum * 100) / 100, buckets });
      }
    }
    return { counters, histograms };
  }

  renderPrometheus(): string {
    const lines: string[] = [];
    const snap = this.snapshot();
    const seenTypes = new Set<string>();
    for (const c of snap.counters) {
      if (!seenTypes.has(c.name)) {
        lines.push(`# TYPE ${c.name} counter`);
        seenTypes.add(c.name);
      }
      lines.push(`${c.name}${labelStr(c.labels)} ${c.value}`);
    }
    const seenHist = new Set<string>();
    for (const h of snap.histograms) {
      if (!seenHist.has(h.name)) {
        lines.push(`# TYPE ${h.name} histogram`);
        seenHist.add(h.name);
      }
      for (const b of h.buckets) {
        lines.push(`${h.name}_bucket${labelStrWith(h.labels, 'le', b.le)} ${b.cumulative}`);
      }
      lines.push(`${h.name}_sum${labelStr(h.labels)} ${h.sum}`);
      lines.push(`${h.name}_count${labelStr(h.labels)} ${h.count}`);
    }
    return `${lines.join('\n')}\n`;
  }

  reset(): void {
    this.counters.clear();
    this.hists.clear();
  }
}

/** Shared per-isolate registry (single process → shared across modules in tests). */
export const edgeMetrics = new MetricsRegistry();

/** Test/ops helper re-exported for the local harness reset. */
export function resetEdgeMetrics(): void {
  edgeMetrics.reset();
}

/* --------------------------------------------------------------- serving --- */

/** Build the /metrics response: Prometheus text (default) or ?format=json. */
export function metricsResponse(url: URL, module: string): Response {
  if (url.searchParams.get('format') === 'json') {
    return jsonOk({ ok: true, module, generatedAt: new Date().toISOString(), ...edgeMetrics.snapshot() });
  }
  return new Response(edgeMetrics.renderPrometheus(), {
    headers: {
      'content-type': 'text/plain; version=0.0.4; charset=utf-8',
      'x-edge-metrics-module': module,
    },
  });
}

/* -------------------------------------------------------------- wrapping --- */

export type EdgeFetchHandler = (request: Request, env: EdgeEnv, ctx: EdgeCtx) => Promise<Response>;

export interface WithMetricsOptions {
  /**
   * Path the wrapper intercepts with the metrics response (GET only).
   * Default '/metrics'; pass null to disable interception (the gateway serves
   * /edge/metrics from its authenticated management routes instead).
   */
  metricsPath?: string | null;
}

/**
 * Wrap a worker fetch handler with request/latency/error/cache observation.
 * Pure passthrough: the handler's Response is returned untouched (the
 * x-edge-cache tag is only read, never consumed). Handler throws propagate
 * unchanged after being counted.
 */
export function withMetrics(
  module: string,
  handler: EdgeFetchHandler,
  opts: WithMetricsOptions = {},
): EdgeFetchHandler {
  const metricsPath = opts.metricsPath === undefined ? '/metrics' : opts.metricsPath;
  return async (request: Request, env: EdgeEnv, ctx: EdgeCtx): Promise<Response> => {
    const url = new URL(request.url);
    if (metricsPath !== null && request.method === 'GET' && url.pathname === metricsPath) {
      return metricsResponse(url, module);
    }

    const started = Date.now();
    try {
      const res = await handler(request, env, ctx);
      const route = normalizeEdgeRoute(url.pathname);
      edgeMetrics.inc('animaxia_edge_requests_total', { module, route, status: String(res.status) });
      edgeMetrics.observe('animaxia_edge_request_latency_ms', { module, route }, Date.now() - started);
      if (res.status >= 500) {
        edgeMetrics.inc('animaxia_edge_errors_total', { module });
      }
      const cacheTag = res.headers.get('x-edge-cache');
      if (cacheTag) {
        edgeMetrics.inc('animaxia_edge_cache_events_total', { module, state: cacheTag.toLowerCase() });
      }
      return res;
    } catch (err) {
      edgeMetrics.inc('animaxia_edge_requests_total', { module, route: normalizeEdgeRoute(url.pathname), status: '500' });
      edgeMetrics.inc('animaxia_edge_errors_total', { module });
      throw err;
    }
  };
}
