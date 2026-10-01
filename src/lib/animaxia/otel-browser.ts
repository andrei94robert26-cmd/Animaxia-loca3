/**
 * otel-browser.ts — FAZA 23 (observability): browser-side OTel-style tracing.
 *
 * Monkey-patches window.fetch (original kept) so every same-origin API call
 * (`/api/*` or `/v1/*`, WITHOUT XTransformPort=4050 — own exports excluded to
 * avoid a feedback loop) becomes a span exported in batches to the
 * animaxia-observability collector:
 *
 *   POST /v1/traces?XTransformPort=4050  →  { "acceptedSpans": N }
 *
 * The outgoing request carries a W3C `traceparent` header
 * (`00-<traceId 32hex>-<spanId 16hex>-01`); the TS3 backend middleware adopts
 * that trace id and echoes it back as `X-Trace-Id`, so
 * `http.trace_correlated` records REAL end-to-end correlation (browser span
 * and backend span share the same traceId).
 *
 * HARD RULES (observability must never affect UX):
 *  • idempotent install (window-level guard survives HMR / double calls);
 *  • browser-only (no-op during SSR — `typeof window` check);
 *  • zero throw — every path is wrapped in try/catch, failures are silent;
 *  • batch: queue capped at 200 spans, flush at 20 spans OR every 5 s;
 *  • export POST failures drop the batch silently (no retry storm);
 *  • `navigator.sendBeacon` fallback on page hide (the reliable "unload");
 *  • the original fetch is never restored (patch lives for the session — ok).
 */

/** Simple-format span accepted by the collector (modules/collector.ts, path b). */
interface BrowserSpan {
  traceId: string;
  spanId: string;
  parentSpanId: string;
  name: string;
  service: string;
  kind: number;
  startMs: number;
  endMs: number;
  status: number;
  attributes: {
    'http.method': string;
    'http.url': string;
    'http.status_code': number;
    'http.trace_correlated': boolean;
  };
}

/* ------------------------------ constants ------------------------------ */

const SERVICE_NAME = 'animaxia-web';
const EXPORT_URL = '/v1/traces?XTransformPort=4050';
const MAX_QUEUE = 200;
const FLUSH_SPANS = 20;
const FLUSH_MS = 5_000;
const WINDOW_FLAG = '__animaxiaOtelInstalled';

declare global {
  interface Window {
    [WINDOW_FLAG]?: boolean;
  }
}

/* ------------------------------ id helpers ------------------------------ */

/** `chars` random hex chars (crypto-backed; Math.random fallback). */
function randomHex(chars: number): string {
  try {
    const bytes = new Uint8Array(Math.ceil(chars / 2));
    crypto.getRandomValues(bytes);
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    return hex.slice(0, chars);
  } catch {
    let out = '';
    while (out.length < chars) out += Math.random().toString(16).slice(2);
    return out.slice(0, chars);
  }
}

/* ------------------------------ install -------------------------------- */

/**
 * Installs the fetch patch exactly once per window. Safe to call from any
 * client effect; no-op on the server, after the first call, or when the
 * environment lacks the pieces it needs.
 */
export function installBrowserTracing(): void {
  try {
    if (typeof window === 'undefined') return; // SSR guard — browser only
    if (window[WINDOW_FLAG]) return; // idempotent (also survives HMR)
    if (typeof window.fetch !== 'function') return;

    const originalFetch = window.fetch.bind(window);
    window[WINDOW_FLAG] = true;

    const queue: BrowserSpan[] = [];
    let flushTimer: number | null = null;

    /** Drop-only-on-overflow batch export. Silent on any failure. */
    const flush = (): void => {
      try {
        if (flushTimer !== null) {
          window.clearTimeout(flushTimer);
          flushTimer = null;
        }
        if (queue.length === 0) return;
        const spans = queue.splice(0, queue.length);
        // originalFetch: never re-enters the patch (and the URL carries
        // XTransformPort=4050, which the patch excludes anyway).
        void originalFetch(EXPORT_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ spans }),
          keepalive: true,
        }).catch(() => {
          /* drop silently — observability must never surface to the user */
        });
      } catch {
        /* silent */
      }
    };

    const ensureTimer = (): void => {
      if (flushTimer === null) {
        flushTimer = window.setTimeout(flush, FLUSH_MS);
      }
    };

    /** sendBeacon fallback for the very last batch of the page. */
    const flushBeacon = (): void => {
      try {
        if (queue.length === 0) return;
        if (flushTimer !== null) {
          window.clearTimeout(flushTimer);
          flushTimer = null;
        }
        const spans = queue.splice(0, queue.length);
        const blob = new Blob([JSON.stringify({ spans })], { type: 'application/json' });
        navigator.sendBeacon(EXPORT_URL, blob);
      } catch {
        /* silent */
      }
    };
    window.addEventListener('pagehide', flushBeacon);

    const patchedFetch: typeof fetch = (input, init) => {
      let traceId = '';
      let spanId = '';
      let method = 'GET';
      let pathLabel = '';
      let startMs = 0;
      let perfStart = 0;
      let traced = false;

      try {
        /* Resolve URL + method for every call shape (string | URL | Request). */
        let url = '';
        if (typeof input === 'string') url = input;
        else if (input instanceof URL) url = input.href;
        else if (input && typeof (input as Request).url === 'string') url = (input as Request).url;
        if (!url) return originalFetch(input, init);

        method =
          (typeof init?.method === 'string' && init.method) ||
          (input && !(input instanceof URL) && typeof (input as Request).method === 'string'
            ? (input as Request).method
            : 'GET') ||
          'GET';

        const parsed = new URL(url, window.location.href);
        const sameOrigin = parsed.origin === window.location.origin;
        const isApiPath = parsed.pathname.startsWith('/api/') || parsed.pathname.startsWith('/v1/');
        const isOwnExport = parsed.searchParams.get('XTransformPort') === '4050';
        if (!sameOrigin || !isApiPath || isOwnExport) return originalFetch(input, init);

        traced = true;
        traceId = randomHex(32);
        spanId = randomHex(16);
        method = method.toUpperCase();
        pathLabel = parsed.pathname;
        startMs = Date.now();
        perfStart = performance.now();

        /* Merge the caller's headers (object | Headers | tuple array, plus the
           Request's own headers when init doesn't override) and set traceparent. */
        let headers: Headers;
        if (init?.headers !== undefined) headers = new Headers(init.headers);
        else if (input && !(input instanceof URL) && (input as Request).headers)
          headers = new Headers((input as Request).headers);
        else headers = new Headers();
        headers.set('traceparent', `00-${traceId}-${spanId}-01`);
        init = { ...(init ?? {}), headers };
      } catch {
        /* Could not build tracing context → plain pass-through. */
        return originalFetch(input, init);
      }

      if (!traced) return originalFetch(input, init);

      const record = (httpStatus: number, responseTraceId: string | null): void => {
        try {
          const perfNow = performance.now();
          const endMs = startMs + Math.max(0, perfNow - perfStart);
          const correlated =
            typeof responseTraceId === 'string' && responseTraceId.toLowerCase() === traceId;
          const span: BrowserSpan = {
            traceId,
            spanId,
            parentSpanId: '',
            name: `${method} ${pathLabel}`,
            service: SERVICE_NAME,
            kind: 1,
            startMs,
            endMs,
            status: httpStatus,
            attributes: {
              'http.method': method,
              'http.url': pathLabel,
              'http.status_code': httpStatus,
              'http.trace_correlated': correlated,
            },
          };
          if (queue.length >= MAX_QUEUE) queue.shift(); // cap 200: drop oldest
          queue.push(span);
          if (queue.length >= FLUSH_SPANS) flush();
          else ensureTimer();
        } catch {
          /* silent */
        }
      };

      return originalFetch(input, init).then(
        (res) => {
          let responseTraceId: string | null = null;
          try {
            responseTraceId = res.headers.get('x-trace-id');
          } catch {
            responseTraceId = null;
          }
          record(res.status, responseTraceId);
          return res;
        },
        (err: unknown) => {
          record(0, null); // network/abort failure — status 0
          throw err; // preserve the caller's rejection semantics
        },
      );
    };

    window.fetch = patchedFetch;
  } catch {
    /* silent — never throw from instrumentation */
  }
}
