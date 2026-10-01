/**
 * common/telemetry.js — Distributed tracing for Animaxia Cloud without any
 * OpenTelemetry SDK dependency:
 *
 *   • W3C Trace Context: parse/generate `traceparent` headers
 *     (https://www.w3.org/TR/trace-context/) — traceId 32 hex, spanId 16 hex.
 *   • `traceMiddleware` — starts a SERVER span per request, stores the active
 *     context in AsyncLocalStorage, sets the `x-trace-id` response header.
 *   • `serviceFetch` — fetch with `traceparent` injection (CLIENT span),
 *     timeout. This is how gateway → service and service → service calls
 *     achieve end-to-end distributed tracing.
 *   • OTLP exporter — batches spans as OTLP/HTTP JSON to OTELENDPOINT
 *     (default http://localhost:4318/v1/traces — the OpenTelemetry Collector
 *     from deploy/docker/docker-compose.observability.yml). Sampling via
 *     OTELSAMPLERATE; never blocks or fails requests (fire-and-forget).
 */

import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { logger } from './logger.js';

const TRACE_ENABLED = () => (process.env.TRACINGENABLED ?? 'true').toLowerCase() !== 'false';
const ENDPOINT = () => process.env.OTELSENDPOINT || 'http://localhost:4318/v1/traces';
const SAMPLE_RATE = () => {
  const rate = parseFloat(process.env.OTELSAMPLERATE ?? '1');
  return Number.isFinite(rate) ? Math.min(1, Math.max(0, rate)) : 1;
};

const als = new AsyncLocalStorage();

/* ------------------------------ W3C traceparent ----------------------------- */

export function makeTraceId() {
  return crypto.randomBytes(16).toString('hex');
}

export function makeSpanId() {
  return crypto.randomBytes(8).toString('hex');
}

export function parseTraceparent(header) {
  if (!header || typeof header !== 'string') return null;
  const match = header.trim().match(/^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i);
  if (!match) return null;
  const [, version, traceId, spanId, flags] = match;
  if (version === 'ff') return null;
  return { traceId: traceId.toLowerCase(), spanId: spanId.toLowerCase(), flags: flags.toLowerCase() };
}

export function makeTraceparent(traceId, spanId, sampled = true) {
  return `00-${traceId}-${spanId}-${sampled ? '01' : '00'}`;
}

/* -------------------------------- span engine ------------------------------- */

const MAX_BUFFER = 2048;
let spanBuffer = [];
let flushTimer = null;
let exporterFailures = 0;
let droppedSpans = 0;

function shouldSample() {
  const rate = SAMPLE_RATE();
  if (rate >= 1) return true;
  if (rate <= 0) return false;
  return Math.random() < rate;
}

/** Build a span object bound to an explicit trace context. */
function createSpan({ name, kind = 'INTERNAL', traceId, spanId, parentSpanId, sampled, attributes = {} }) {
  const startedAt = Date.now();
  const startHr = process.hrtime.bigint();
  return {
    name,
    kind,
    traceId,
    spanId,
    parentSpanId: parentSpanId || null,
    sampled,
    end({ status = 'ok', attributes: endAttrs = {} } = {}) {
      if (!sampled || !traceId) return;
      const durationNano = Number(process.hrtime.bigint() - startHr);
      if (spanBuffer.length >= MAX_BUFFER) {
        droppedSpans += 1;
        return;
      }
      spanBuffer.push({
        traceId,
        spanId,
        parentSpanId: this.parentSpanId,
        name,
        kind,
        startTimeUnixNano: String(startedAt * 1e6),
        durationUnixNano: String(durationNano),
        attributes: Object.entries({ ...attributes, ...endAttrs }).map(([key, value]) => ({
          key,
          value: { stringValue: String(value) },
        })),
        status: status === 'ok' ? { code: 1 } : { code: 2, message: String(status).slice(0, 300) },
      });
    },
  };
}

const NOOP_SPAN = { end() {}, traceId: null, spanId: null, sampled: false };

/**
 * Start a span inside the active request context (child of the current span).
 * Outside a request context it starts a new trace.
 */
export function startSpan(name, attributes = {}, { kind = 'INTERNAL' } = {}) {
  if (!TRACE_ENABLED()) return NOOP_SPAN;
  const parent = als.getStore();
  if (parent) {
    return createSpan({
      name,
      kind,
      traceId: parent.traceId,
      spanId: makeSpanId(),
      parentSpanId: parent.spanId,
      sampled: parent.sampled,
      attributes,
    });
  }
  return createSpan({ name, kind, traceId: makeTraceId(), spanId: makeSpanId(), parentSpanId: null, sampled: shouldSample(), attributes });
}

/* ------------------------------- OTLP exporter ------------------------------- */

async function flushSpans() {
  if (!spanBuffer.length || !TRACE_ENABLED()) return;
  const batch = spanBuffer.splice(0, 100);
  if (!batch.length) return;

  const resourceAttrs = [
    { key: 'service.name', value: { stringValue: process.env.SERVICENAME || 'animaxia-service' } },
    { key: 'service.version', value: { stringValue: '3.0.0' } },
    { key: 'deployment.environment', value: { stringValue: process.env.NODE_ENV || 'development' } },
  ];

  const body = JSON.stringify({
    resourceSpans: [
      {
        resource: { attributes: resourceAttrs },
        scopeSpans: [{ scope: { name: 'animaxia-cloud', version: '3.0.0' }, spans: batch }],
      },
    ],
  });

  try {
    const res = await fetch(ENDPOINT(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) throw new Error(`collector responded ${res.status}`);
    exporterFailures = 0;
  } catch (err) {
    exporterFailures += 1;
    if (exporterFailures <= 3) {
      logger.debug(`[telemetry] OTLP export failed (${err.message}) — tracing degraded, not blocking`);
    }
  }
}

function ensureFlushTimer() {
  if (flushTimer || !TRACE_ENABLED()) return;
  flushTimer = setInterval(() => {
    flushSpans().catch(() => {});
  }, 5000);
  if (typeof flushTimer.unref === 'function') flushTimer.unref();
}

export function tracingStats() {
  return {
    enabled: TRACE_ENABLED(),
    endpoint: ENDPOINT(),
    sampleRate: SAMPLE_RATE(),
    buffered: spanBuffer.length,
    dropped: droppedSpans,
    exporterFailures,
  };
}

/* ------------------------------ express middleware --------------------------- */

/**
 * traceMiddleware — continues the incoming `traceparent` trace (or starts a
 * fresh one), records a SERVER span for the request and exposes the context
 * to handlers via req.traceId / currentTrace().
 */
export function traceMiddleware() {
  ensureFlushTimer();
  return (req, res, next) => {
    if (!TRACE_ENABLED()) {
      req.traceId = null;
      return next();
    }
    const incoming = parseTraceparent(req.headers.traceparent);
    const context = {
      traceId: incoming ? incoming.traceId : makeTraceId(),
      parentSpanId: incoming ? incoming.spanId : null,
      spanId: makeSpanId(),
      sampled: incoming ? incoming.flags !== '00' : shouldSample(),
    };

    als.run(context, () => {
      const span = createSpan({
        name: `${req.method} ${String(req.originalUrl || req.url || '/').split('?')[0].slice(0, 100)}`,
        kind: 'SERVER',
        traceId: context.traceId,
        spanId: context.spanId,
        parentSpanId: context.parentSpanId,
        sampled: context.sampled,
        attributes: {
          'http.request.method': req.method,
          'url.path': String(req.originalUrl || req.url || '/').split('?')[0],
          'http.request.header.user_agent': req.headers['user-agent'] || '',
        },
      });
      req.traceId = context.traceId;
      req.spanId = context.spanId;
      res.set('x-trace-id', context.traceId);
      res.on('finish', () => {
        span.end({
          status: res.statusCode < 500 ? 'ok' : 'error',
          attributes: { 'http.response.status_code': res.statusCode },
        });
      });
      next();
    });
  };
}

/** Active request context ({ traceId, spanId, sampled, traceparent }) or null. */
export function currentTrace() {
  const ctx = als.getStore();
  if (!ctx) return null;
  return { ...ctx, traceparent: makeTraceparent(ctx.traceId, ctx.spanId, ctx.sampled) };
}

/** Inject the current trace context into outbound headers. */
export function injectTrace(headers = {}) {
  const ctx = currentTrace();
  const merged = { ...headers };
  if (ctx) merged.traceparent = makeTraceparent(ctx.traceId, makeSpanId(), ctx.sampled);
  return merged;
}

/**
 * serviceFetch — fetch with trace propagation + timeout + CLIENT span.
 * All cross-service HTTP in Animaxia Cloud uses this.
 */
export async function serviceFetch(url, init = {}, { timeoutMs = 15000, spanName = null } = {}) {
  const finalHeaders = injectTrace(init.headers || {});
  const method = (init.method || 'GET').toUpperCase();
  const span = startSpan(spanName || `${method} ${safePathOf(url)}`, { 'http.request.method': method, 'url.full': url }, { kind: 'CLIENT' });
  try {
    const res = await fetch(url, { ...init, headers: finalHeaders, signal: AbortSignal.timeout(timeoutMs) });
    span.end({ status: res.status < 500 ? 'ok' : 'error', attributes: { 'http.response.status_code': res.status } });
    return res;
  } catch (err) {
    span.end({ status: `error: ${err.message}` });
    throw err;
  }
}

function safePathOf(url) {
  try {
    return new URL(url).pathname.slice(0, 100);
  } catch {
    return 'unknown-path';
  }
}

export default { traceMiddleware, currentTrace, injectTrace, serviceFetch, startSpan, tracingStats, parseTraceparent, makeTraceparent, makeTraceId, makeSpanId };
