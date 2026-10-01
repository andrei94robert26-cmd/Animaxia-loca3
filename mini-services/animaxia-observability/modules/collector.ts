/**
 * OTel Collector — ingest OTLP/HTTP-JSON compatibil, DOUĂ formate:
 *  (a) OTLP canonic: {resourceSpans:[{resource:{attributes},scopeSpans:[{spans:[…]}]}]}
 *      cu traceId/spanId hex, startTimeUnixNano, status.code (0 unset / 1 ok / 2 error),
 *      attributes [{key, value:{stringValue|intValue|doubleValue|boolValue}}]
 *  (b) simplu (browser): {spans:[{traceId,spanId,parentSpanId,name,service,startMs,endMs,status,attributes}]}
 *
 * Normalizează intern la structura unică NormSpan. Stocare: ring buffer
 * LRU 5000 traces + agregate per serviciu + bucket-e spans/min.
 */
import { TRACES_RING_MAX } from '../config.ts';

export interface NormSpan {
  traceId: string;
  spanId: string;
  parentSpanId: string;
  name: string;
  service: string;
  kind: number;
  startMs: number;
  endMs: number;
  durationMs: number;
  status: 'ok' | 'error' | 'unset';
  attributes: Record<string, string | number>;
  receivedMs: number;
}

export interface StoredTrace {
  traceId: string;
  service: string;
  rootName: string;
  startedAt: number; // ms
  durationMs: number; // max(end) - min(start)
  spanCount: number;
  error: boolean;
  spans: NormSpan[];
}

export interface ServiceAggregate {
  name: string;
  spans: number;
  errors: number;
  totalDurationMs: number;
}

interface MinuteBucket {
  minuteSec: number;
  spans: number;
}

const UNKNOWN_SERVICE = 'unknown';

/** extrage valoarea dintr-un OTLP attribute value */
function otlpValue(v: unknown): string | number | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.stringValue === 'string') return o.stringValue;
  if (typeof o.intValue !== 'undefined') return Number(o.intValue);
  if (typeof o.doubleValue !== 'undefined') return Number(o.doubleValue);
  if (typeof o.boolValue !== 'undefined') return o.boolValue ? 1 : 0;
  return undefined;
}

function otlpAttributes(attrs: unknown): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  if (!Array.isArray(attrs)) return out;
  for (const a of attrs) {
    if (!a || typeof a !== 'object') continue;
    const { key, value } = a as { key?: string; value?: unknown };
    if (typeof key !== 'string') continue;
    const v = otlpValue(value);
    if (v !== undefined) out[key] = v;
  }
  return out;
}

function hexId(v: unknown, len: number): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  return new RegExp(`^[0-9a-f]{${len}}$`).test(s) ? s : null;
}

function normStatus(status: unknown): 'ok' | 'error' | 'unset' {
  if (typeof status === 'string') {
    const s = status.toLowerCase();
    if (s === 'error' || s === 'err' || s === 'failed') return 'error';
    if (s === 'ok' || s === 'success') return 'ok';
    return 'unset';
  }
  if (status && typeof status === 'object') {
    const code = (status as { code?: unknown }).code;
    const n = Number(code);
    if (n === 2) return 'error';
    if (n === 1) return 'ok';
    return 'unset';
  }
  if (typeof status === 'number') {
    if (status === 2) return 'error';
    if (status === 1) return 'ok';
    return 'unset';
  }
  return 'unset';
}

export class TraceCollector {
  private traces = new Map<string, StoredTrace>(); // LRU: insert = touch
  private services = new Map<string, ServiceAggregate>();
  private minuteBuckets: MinuteBucket[] = [];
  private totalSpans = 0;

  /** POST /v1/traces — body OTLP canonic SAU simplu. Intoarce numărul acceptat
   *  și defalcarea per serviciu (pentru contorii de ingest per serviciu). */
  ingest(body: unknown): {
    acceptedSpans: number;
    rejectedSpans: number;
    perService: Record<string, number>;
  } {
    let accepted = 0;
    let rejected = 0;
    const perService: Record<string, number> = {};

    const pushSpan = (span: NormSpan | null) => {
      if (!span) {
        rejected++;
        return;
      }
      accepted++;
      perService[span.service] = (perService[span.service] ?? 0) + 1;
      this.storeSpan(span);
    };

    if (body && typeof body === 'object' && Array.isArray((body as { resourceSpans?: unknown }).resourceSpans)) {
      // (a) OTLP canonic
      const { resourceSpans } = body as { resourceSpans: unknown[] };
      for (const rs of resourceSpans) {
        if (!rs || typeof rs !== 'object') continue;
        const rsObj = rs as {
          resource?: { attributes?: unknown };
          scopeSpans?: { spans?: unknown[] }[];
        };
        const resourceAttrs = otlpAttributes(rsObj.resource?.attributes);
        const serviceName =
          typeof resourceAttrs['service.name'] === 'string'
            ? (resourceAttrs['service.name'] as string)
            : UNKNOWN_SERVICE;
        for (const ss of rsObj.scopeSpans ?? []) {
          for (const raw of ss?.spans ?? []) {
            pushSpan(this.parseOtlpSpan(raw, serviceName));
          }
        }
      }
    } else if (body && typeof body === 'object' && Array.isArray((body as { spans?: unknown }).spans)) {
      // (b) format simplu (browser)
      const { spans } = body as { spans: unknown[] };
      for (const raw of spans) {
        pushSpan(this.parseSimpleSpan(raw));
      }
    } else {
      return { acceptedSpans: 0, rejectedSpans: 0, perService };
    }

    this.totalSpans += accepted;
    this.touchMinuteBuckets(accepted);
    this.evictOldBuckets();
    return { acceptedSpans: accepted, rejectedSpans: rejected, perService };
  }

  private parseOtlpSpan(raw: unknown, serviceName: string): NormSpan | null {
    if (!raw || typeof raw !== 'object') return null;
    const s = raw as Record<string, unknown>;
    const traceId = hexId(s.traceId, 32);
    const spanId = hexId(s.spanId, 16);
    if (!traceId || !spanId) return null;
    let parentSpanId = '';
    if (typeof s.parentSpanId === 'string' && s.parentSpanId.length > 0) {
      parentSpanId = hexId(s.parentSpanId, 16) ?? '';
    }
    let startMs = NaN;
    let endMs = NaN;
    try {
      startMs = Number(BigInt(String(s.startTimeUnixNano ?? '0')) / 1_000_000n);
      endMs = Number(BigInt(String(s.endTimeUnixNano ?? '0')) / 1_000_000n);
    } catch {
      startMs = NaN;
      endMs = NaN;
    }
    const now = Date.now();
    const start = Number.isFinite(startMs) && startMs > 0 ? startMs : now;
    const end = Number.isFinite(endMs) && endMs >= start ? endMs : now;
    const spanAttrs = otlpAttributes(s.attributes);
    const service =
      typeof spanAttrs['service.name'] === 'string'
        ? (spanAttrs['service.name'] as string)
        : serviceName;
    return {
      traceId,
      spanId,
      parentSpanId,
      name: typeof s.name === 'string' && s.name ? s.name : 'span',
      service,
      kind: Number(s.kind) || 1,
      startMs: start,
      endMs: end,
      durationMs: Math.max(0, end - start),
      status: normStatus(s.status),
      attributes: spanAttrs,
      receivedMs: now,
    };
  }

  private parseSimpleSpan(raw: unknown): NormSpan | null {
    if (!raw || typeof raw !== 'object') return null;
    const s = raw as Record<string, unknown>;
    const traceId =
      hexId(s.traceId, 32) ??
      (typeof s.traceId === 'string' && /^[0-9a-zA-Z]{8,64}$/.test(s.traceId)
        ? s.traceId.toLowerCase()
        : null);
    const spanId =
      hexId(s.spanId, 16) ??
      (typeof s.spanId === 'string' && /^[0-9a-zA-Z]{4,32}$/.test(s.spanId)
        ? s.spanId.toLowerCase()
        : null);
    if (!traceId || !spanId) return null;
    const now = Date.now();
    const startMs = Number.isFinite(Number(s.startMs)) ? Number(s.startMs) : now;
    const endMsRaw = Number.isFinite(Number(s.endMs)) ? Number(s.endMs) : Math.max(now, startMs);
    const endMs = Math.max(startMs, endMsRaw);
    const attrs: Record<string, string | number> = {};
    if (s.attributes && typeof s.attributes === 'object') {
      for (const [k, v] of Object.entries(s.attributes as Record<string, unknown>)) {
        if (typeof v === 'string' || typeof v === 'number') {
          attrs[k] = v;
        } else if (typeof v === 'boolean') {
          attrs[k] = v ? 1 : 0;
        }
      }
    }
    return {
      traceId,
      spanId,
      parentSpanId: typeof s.parentSpanId === 'string' ? s.parentSpanId.toLowerCase() : '',
      name: typeof s.name === 'string' && s.name ? s.name : 'span',
      service: typeof s.service === 'string' && s.service ? s.service : UNKNOWN_SERVICE,
      kind: Number(s.kind) || 1,
      startMs,
      endMs,
      durationMs: Math.max(0, endMs - startMs),
      status: normStatus(s.status),
      attributes: attrs,
      receivedMs: now,
    };
  }

  private storeSpan(span: NormSpan): void {
    let trace = this.traces.get(span.traceId);
    if (!trace) {
      trace = {
        traceId: span.traceId,
        service: span.service,
        rootName: span.name,
        startedAt: span.startMs,
        durationMs: span.durationMs,
        spanCount: 0,
        error: false,
        spans: [],
      };
    }
    // LRU touch: re-insert la coada Map-ului
    this.traces.delete(span.traceId);
    this.traces.set(span.traceId, trace);

    trace.spans.push(span);
    trace.spanCount = trace.spans.length;
    let minStart = Infinity;
    let maxEnd = 0;
    for (const x of trace.spans) {
      if (x.startMs < minStart) minStart = x.startMs;
      if (x.endMs > maxEnd) maxEnd = x.endMs;
    }
    trace.startedAt = minStart;
    trace.durationMs = Math.max(0, maxEnd - minStart);
    if (span.status === 'error') trace.error = true;
    // rootName = span-ul cu parent gol sau cel mai timpuriu
    const root = trace.spans.find((x) => !x.parentSpanId) ?? trace.spans[0];
    trace.rootName = root.name;
    trace.service = root.service ?? trace.service;

    // agregate per serviciu (cumulate de la pornirea serviciului — onest)
    let agg = this.services.get(span.service);
    if (!agg) {
      agg = { name: span.service, spans: 0, errors: 0, totalDurationMs: 0 };
      this.services.set(span.service, agg);
    }
    agg.spans++;
    if (span.status === 'error') agg.errors++;
    agg.totalDurationMs += span.durationMs;

    this.evictIfNeeded();
  }

  private evictIfNeeded(): void {
    while (this.traces.size > TRACES_RING_MAX) {
      const oldestKey = this.traces.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      this.traces.delete(oldestKey);
    }
  }

  private touchMinuteBuckets(spans: number): void {
    const minuteSec = Math.floor(Date.now() / 60000);
    const last = this.minuteBuckets[this.minuteBuckets.length - 1];
    if (last && last.minuteSec === minuteSec) last.spans += spans;
    else this.minuteBuckets.push({ minuteSec, spans });
  }

  private evictOldBuckets(): void {
    const cutoff = Math.floor(Date.now() / 60000) - 60; // păstrăm ultima oră
    this.minuteBuckets = this.minuteBuckets.filter((b) => b.minuteSec >= cutoff);
  }

  // ── query API ───────────────────────────────────────────────────────────

  listTraces(opts: { service?: string; limit?: number; error?: boolean }): {
    traces: Omit<StoredTrace, 'spans'>[];
    total: number;
  } {
    const limit = Math.max(1, Math.min(200, opts.limit ?? 50));
    const all = [...this.traces.values()];
    const filtered = all
      .filter((t) => (opts.service ? t.service === opts.service : true))
      .filter((t) => (opts.error === undefined ? true : t.error === opts.error))
      .sort((a, b) => b.startedAt - a.startedAt);
    const total = filtered.length;
    return {
      traces: filtered.slice(0, limit).map(({ spans: _spans, ...rest }) => rest),
      total,
    };
  }

  getTrace(traceId: string): StoredTrace | null {
    return this.traces.get(traceId.toLowerCase()) ?? null;
  }

  stats(): {
    services: { name: string; spans: number; errors: number; errorRate: number; avgMs: number }[];
    spansPerMin: number;
    tracesActive: number;
    spansTotal: number;
  } {
    const services = [...this.services.values()].map((a) => ({
      name: a.name,
      spans: a.spans,
      errors: a.errors,
      errorRate: a.spans > 0 ? a.errors / a.spans : 0,
      avgMs: a.spans > 0 ? Math.round(a.totalDurationMs / a.spans) : 0,
    }));
    const lastMinute = this.minuteBuckets[this.minuteBuckets.length - 1];
    const spansPerMin = lastMinute ? lastMinute.spans : 0;
    return {
      services,
      spansPerMin,
      tracesActive: this.traces.size,
      spansTotal: this.totalSpans,
    };
  }

  recentTraces(n: number): StoredTrace[] {
    const all = [...this.traces.values()].sort((a, b) => b.startedAt - a.startedAt);
    return all.slice(0, n);
  }
}
