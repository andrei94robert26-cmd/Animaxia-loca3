/**
 * services/gateway-service/proxy.js — The routing/proxy core of the gateway.
 *
 * For every /api/* request that no earlier router claimed (management routes
 * under /api/gateway and the aggregated /api/health are mounted first and are
 * never proxied):
 *
 *   1. Longest-prefix route match against GATEWAY_ROUTES (common/services.js)
 *      — /api/analytics wins over /api/all. Unknown /api/* → 404
 *      { error: 'No upstream route', path }.
 *   2. Unsafe methods (POST/PUT/PATCH/DELETE) trigger best-effort smart edge
 *      cache invalidation BEFORE forwarding (see edgeCache.js).
 *   3. Cacheable GETs are served from the edge cache on HIT (X-Cache: HIT).
 *   4. Per-upstream circuit breaker (BreakerRegistry, threshold 3 / open 30s).
 *      A rejected call falls back to stale (X-Cache: STALE) or 503
 *      { error, service, retryAfterSec, degraded: true }.
 *   5. The upstream call goes through serviceFetch (common/telemetry.js) so a
 *      `traceparent` header is injected automatically — end-to-end distributed
 *      tracing from the client through the gateway into every microservice.
 *      Forwarded: method, query string, body (JSON, re-serialised) and a safe
 *      header subset (authorization, content-type, accept, user-agent,
 *      x-request-id). host/connection are NEVER forwarded.
 *   6. Responses pass through verbatim (status + content-type + body) with
 *      `X-Upstream-Service` and `X-Upstream-Latency-Ms` added. Fresh cacheable
 *      200s are stored in the edge cache (X-Cache: MISS / BYPASS otherwise).
 *   7. Failures: network error → 502, timeout → 504 (both
 *      { error, service, degraded: true, detail }); upstream 5xx → breaker
 *      failure + stale fallback, else passed through verbatim with
 *      X-Gateway-Degraded. Upstream 4xx are NEVER masked.
 */

import express from 'express';
import { GATEWAY_ROUTES, serviceUrl } from '@animaxia/common/services.js';
import { BreakerRegistry } from '@animaxia/common/circuit.js';
import { serviceFetch } from '@animaxia/common/telemetry.js';
import { wrap } from '@animaxia/common/middleware.js';
import { logger } from '@animaxia/common/logger.js';
import { isCacheable, lookupEdge, storeEdge, peekStaleEdge, invalidateOnUnsafe } from './edgeCache.js';

/** Per-upstream circuit breakers (3 failures → open 30s → half-open probes). */
export const breakers = new BreakerRegistry({ threshold: 3, openMs: 30000 });

/** Upstream call timeout (GATEWAYUPSTREAMTIMEOUTMS, default 15s). */
export const UPSTREAM_TIMEOUT_MS = Math.max(1000, parseInt(process.env.GATEWAYUPSTREAMTIMEOUTMS || '15000', 10));

/** Route table sorted longest-prefix-first so /api/analytics beats /api/all. */
export const SORTED_ROUTES = [...GATEWAY_ROUTES].sort((a, b) => b.prefix.length - a.prefix.length);

/** Gateway-owned prefixes — never proxied (safety net; mounted earlier anyway). */
const SKIP_PREFIXES = ['/api/gateway', '/api/health'];

/** Request headers forwarded upstream (host/connection are never forwarded). */
const FORWARD_HEADERS = ['authorization', 'content-type', 'accept', 'user-agent', 'x-request-id'];

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Longest-prefix route match for a request path — { prefix, service } | null. */
export function matchRoute(path) {
  for (const route of SORTED_ROUTES) {
    if (path === route.prefix || path.startsWith(`${route.prefix}/`)) return route;
  }
  return null;
}

/** Safe header subset + the gateway-generated x-request-id for correlation. */
function buildForwardHeaders(req) {
  const headers = {};
  for (const name of FORWARD_HEADERS) {
    if (req.headers[name] !== undefined) headers[name] = req.headers[name];
  }
  if (headers['x-request-id'] === undefined && req.requestId) {
    headers['x-request-id'] = String(req.requestId);
  }
  return headers;
}

/**
 * JSON body re-serialisation (the platform API is JSON-only — multipart and
 * raw-text bodies are not proxied; the monolith surface is 100% JSON).
 */
function buildForwardBody(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  const body = req.body;
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 0) return undefined;
  return JSON.stringify(body);
}

/** Serve a stale-while-error copy (200 + X-Cache: STALE). */
function serveStale(res, service, entry, latencyMs) {
  res.set('X-Cache', 'STALE');
  res.set('X-Upstream-Service', service);
  if (Number.isFinite(latencyMs)) res.set('X-Upstream-Latency-Ms', String(Math.round(latencyMs)));
  if (entry.contentType) res.set('Content-Type', entry.contentType);
  return res.status(entry.status || 200).send(Buffer.from(entry.body));
}

/** Pass an upstream response through verbatim + gateway metadata headers. */
function sendUpstreamResponse(res, service, upstream, buf, latencyMs, cacheState) {
  res.set('X-Upstream-Service', service);
  res.set('X-Upstream-Latency-Ms', String(latencyMs));
  if (cacheState) res.set('X-Cache', cacheState);
  const contentType = upstream.headers.get('content-type');
  if (contentType) res.set('Content-Type', contentType);
  const cacheControl = upstream.headers.get('cache-control');
  if (cacheControl) res.set('Cache-Control', cacheControl);
  const etag = upstream.headers.get('etag');
  if (etag) res.set('ETag', etag);
  return res.status(upstream.status).send(buf);
}

/** The proxy handler — mounted LAST so gateway-owned routes always win. */
async function proxyHandler(req, res, next) {
  const path = req.path;

  /* Never proxy gateway-owned prefixes (safety net — they are mounted earlier). */
  if (SKIP_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) {
    return next();
  }

  const route = matchRoute(path);
  if (!route) {
    return res.status(404).json({ error: 'No upstream route', path });
  }

  const service = route.service;
  const method = req.method;
  const originalUrl = req.originalUrl || req.url;
  const breaker = breakers.get(service);
  const cacheable = isCacheable(method, path);
  const cacheKey = `${service}:${originalUrl}`;

  /* Best-effort smart invalidation on unsafe methods (before forwarding). */
  if (UNSAFE_METHODS.has(method)) {
    try {
      invalidateOnUnsafe(method, path);
    } catch {
      /* invalidation must never break the proxy */
    }
  }

  /* Edge cache lookup (GET + cacheable prefix only). */
  if (cacheable) {
    const hit = lookupEdge(cacheKey);
    if (hit) {
      const ageSec = Math.max(0, Math.floor((Date.now() - (hit.storedAt || Date.now())) / 1000));
      res.set('X-Cache', 'HIT');
      res.set('Age', String(ageSec));
      res.set('X-Upstream-Service', service);
      res.set('X-Upstream-Latency-Ms', '0');
      if (hit.contentType) res.set('Content-Type', hit.contentType);
      return res.status(hit.status || 200).send(Buffer.from(hit.body));
    }
  }

  /* Circuit breaker gate — rejection falls back to stale, else 503. */
  try {
    breaker.allow();
  } catch (err) {
    const stale = peekStaleEdge(cacheKey);
    if (stale) return serveStale(res, service, stale);
    const retryAfterSec = Math.max(1, Math.ceil((breaker.openedAt + breaker.openMs - Date.now()) / 1000));
    res.set('Retry-After', String(retryAfterSec));
    return res.status(503).json({
      error: err.message,
      service,
      retryAfterSec,
      degraded: true,
      breaker: breaker.snapshot().state,
    });
  }

  /* Upstream call via serviceFetch — injects traceparent (CLIENT span). */
  const url = `${serviceUrl(service)}${originalUrl}`;
  const init = { method, headers: buildForwardHeaders(req) };
  const body = buildForwardBody(req);
  if (body !== undefined) init.body = body;

  const startedAt = Date.now();
  let upstream;
  try {
    upstream = await serviceFetch(url, init, {
      timeoutMs: UPSTREAM_TIMEOUT_MS,
      spanName: `proxy ${method} ${service} ${path}`,
    });
  } catch (err) {
    breaker.failure(err?.message || 'upstream error');
    const message = String(err?.message || err);
    const isTimeout =
      err?.name === 'TimeoutError' || err?.name === 'AbortError' || /timeout|aborted|abort/i.test(message);
    const stale = peekStaleEdge(cacheKey);
    if (stale) return serveStale(res, service, stale, Date.now() - startedAt);
    logger.warn(`[proxy] ${method} ${originalUrl} → ${service} failed: ${message}`);
    return res.status(isTimeout ? 504 : 502).json({
      error: isTimeout ? `Upstream timeout after ${UPSTREAM_TIMEOUT_MS}ms` : 'Bad gateway',
      service,
      degraded: true,
      detail: message.slice(0, 200),
    });
  }

  const latencyMs = Date.now() - startedAt;

  /* Upstream 5xx → breaker failure + stale fallback, else verbatim pass-through. */
  if (upstream.status >= 500) {
    breaker.failure(`upstream ${upstream.status}`);
    const stale = peekStaleEdge(cacheKey);
    if (stale) return serveStale(res, service, stale, latencyMs);
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.set('X-Gateway-Degraded', 'true');
    return sendUpstreamResponse(res, service, upstream, buf, latencyMs, 'BYPASS');
  }

  breaker.success();

  const buf = Buffer.from(await upstream.arrayBuffer());
  if (cacheable && upstream.status === 200) {
    storeEdge(cacheKey, upstream.status, upstream.headers.get('content-type') || 'application/json', buf);
  }
  return sendUpstreamResponse(res, service, upstream, buf, latencyMs, cacheable ? 'MISS' : 'BYPASS');
}

/** Catch-all proxy router — mounted as the FINAL routers entry in server.js. */
export const proxyRouter = (() => {
  const router = express.Router();
  router.all('/api', wrap(proxyHandler)); // bare /api → still routed/404 by the handler
  router.all('/api/*', wrap(proxyHandler));
  return router;
})();

export default proxyRouter;
