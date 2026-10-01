/* global caches */
/**
 * animaxia-edge — the Animaxia Cloud edge worker (Cloudflare Workers runtime).
 *
 * Sits in front of the API gateway (services/gateway-service, :8080) and provides:
 *   1. KV-backed runtime config ("config" key, 60s in-memory cache, safe defaults)
 *   2. Maintenance mode — 503 JSON + Retry-After ("/api/health" always bypasses)
 *   3. R2 media for "/media/*" (SVG posters/thumbnails), 24h Cache-Control,
 *      origin pass-through on miss ("X-Edge: r2" tells you which side answered)
 *   4. Edge caching for public catalog GETs via the Cache API
 *      ("X-Edge-Cache: HIT | MISS"); the origin subrequest uses cache: 'no-store'
 *      so Cloudflare's default CDN cache doesn't double-cache behind our back
 *   5. Origin failover: on network error or origin 502/503/504, retry once
 *      against config.fallbackOrigin ("X-Edge-Fallback: true")
 *   6. Security headers on every response (nosniff, referrer policy, and we
 *      strip server / x-powered-by)
 *   7. Per-isolate in-memory per-IP rate limit as a last-resort backstop
 *
 * Bindings (see ../wrangler.toml):
 *   - ANIMAXIA_CONFIG (KV)  — namespace holding the "config" key
 *                            (seed: kv/config.example.json)
 *   - ANIMAXIA_MEDIA  (R2)  — bucket "animaxia-media", key = path minus "/media/"
 *   - ORIGIN_URL      (var) — the gateway to proxy to
 *
 * NOTE on rate limiting: the Map below is per-isolate only (each edge machine
 * counts separately). Real enforcement is layered:
 *   - terraform/rate-limit.tf — Cloudflare Rate Limiting rules (per-IP, global)
 *   - services/gateway-service — the gateway's own limiter
 * This in-worker check is just a cheap safety net for pathological clients.
 *
 * Zero dependencies. Vanilla JS. `bun build --no-bundle cdn/cloudflare/src/worker.js`
 * passes (syntax-only check used in CI; the file targets the Workers runtime).
 */

/* ------------------------------------------------------------------ config */

const CONFIG_KEY = 'config';            // KV key holding the edge config JSON
const CONFIG_CACHE_MS = 60_000;         // in-memory KV config cache window

// Fallbacks used when KV is empty/unavailable. Keep in sync with
// kv/config.example.json and terraform/kv.tf.
const DEFAULT_CONFIG = {
  maintenance: false,                   // true → 503 for everything but /api/health
  edgeRateLimitPerMin: 600,             // per-IP, per-isolate backstop limit
  cacheablePaths: [                     // GET prefixes cached via Cache API
    '/api/all', '/api/content', '/api/anime', '/api/movies',
    '/api/tv', '/api/sports', '/api/news', '/api/search',
  ],
  originHeaders: {},                    // extra headers set on origin subrequests
  fallbackOrigin: '',                   // e.g. "https://backup-gateway.example.com"
};

const DEFAULT_ORIGIN = 'https://gateway.animaxia.internal'; // override via [vars] ORIGIN_URL

// Tiny cache for the KV config (per isolate, refreshed every CONFIG_CACHE_MS).
let cachedConfig = null;
let cachedConfigAt = 0;

async function loadConfig(env) {
  const now = Date.now();
  if (cachedConfig && now - cachedConfigAt < CONFIG_CACHE_MS) return cachedConfig;
  let stored = null;
  try {
    if (env.ANIMAXIA_CONFIG) stored = await env.ANIMAXIA_CONFIG.get(CONFIG_KEY, 'json');
  } catch (_) { /* KV hiccup → fall back to defaults below */ }
  cachedConfig = { ...DEFAULT_CONFIG, ...(stored && typeof stored === 'object' ? stored : {}) };
  if (!Array.isArray(cachedConfig.cacheablePaths)) cachedConfig.cacheablePaths = DEFAULT_CONFIG.cacheablePaths;
  cachedConfigAt = now;
  return cachedConfig;
}

/* -------------------------------------------------------- small rate limit */

// ip -> { count, resetAt }. Per-isolate ONLY (see file header note).
const rateBuckets = new Map();

function inMemoryRateLimit(ip, limitPerMin) {
  const now = Date.now();
  // Opportunistic cleanup so the Map can't grow without bound.
  if (rateBuckets.size > 10_000) {
    for (const [key, bucket] of rateBuckets) if (bucket.resetAt <= now) rateBuckets.delete(key);
  }
  let bucket = rateBuckets.get(ip);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + 60_000 };
    rateBuckets.set(ip, bucket);
  }
  bucket.count += 1;
  return bucket.count <= limitPerMin;
}

/* ------------------------------------------------------------- helpers */

function jsonResponse(body, status, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...extraHeaders },
  });
}

// Copy a response with hardened headers; strips fingerprinting headers.
function withSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', 'strict-origin-when-cross-origin');
  headers.delete('server');
  headers.delete('x-powered-by');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// "/api/anime" prefix-matches "/api/anime" and "/api/anime/..." but not "/api/animeflix".
function matchesPrefix(pathname, prefixes) {
  return prefixes.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

const MIME_BY_EXT = {
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', json: 'application/json',
  webm: 'video/webm', mp4: 'video/mp4', txt: 'text/plain; charset=utf-8',
};

function contentTypeFor(key) {
  const ext = key.includes('.') ? key.split('.').pop().toLowerCase() : '';
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

// Headers forwarded to the origin: copy the inbound request, drop hop-by-hop /
// Cloudflare-injected ones, then set forwarding info + config.originHeaders.
function buildOriginHeaders(request, config, url) {
  const headers = new Headers();
  for (const [name, value] of request.headers) {
    if (['host', 'cf-connecting-ip', 'cf-ipcountry', 'cf-ray', 'cf-visitor',
      'cdn-loop', 'x-forwarded-for', 'x-forwarded-proto'].includes(name)) continue;
    headers.set(name, value);
  }
  const ip = request.headers.get('cf-connecting-ip');
  if (ip) headers.set('x-forwarded-for', ip);
  headers.set('x-forwarded-proto', url.protocol.replace(':', ''));
  for (const [name, value] of Object.entries(config.originHeaders || {})) {
    headers.set(name, String(value));
  }
  return headers;
}

/* ------------------------------------------------------ origin + failover */

// Single attempt against one origin base. `cache: 'no-store'` keeps the
// subrequest out of Cloudflare's default CDN cache — the Cache API below is
// the single source of truth for edge caching.
async function fetchFromOrigin(base, request, env, config, url, bodyBuffer) {
  const originBase = (base || DEFAULT_ORIGIN).replace(/\/+$/, '');
  const init = {
    method: request.method,
    headers: buildOriginHeaders(request, config, url),
    redirect: 'manual',
    cache: 'no-store',
  };
  if (bodyBuffer && bodyBuffer.byteLength > 0) init.body = bodyBuffer;
  return fetch(originBase + url.pathname + url.search, init);
}

const UPSTREAM_FAILURE_STATUSES = [502, 503, 504];

// Primary origin → (on network error or 502/503/504) one retry against
// config.fallbackOrigin. Returns a response with security headers applied
// (plus x-edge-fallback when the backup answered), or a 502 JSON error.
async function fetchWithFailover(request, env, config, url, bodyBuffer) {
  let primary = null;
  let primaryError = null;

  try {
    primary = await fetchFromOrigin(env.ORIGIN_URL, request, env, config, url, bodyBuffer);
  } catch (err) {
    primaryError = err;
  }

  const primaryFailed = !!primaryError || UPSTREAM_FAILURE_STATUSES.includes(primary?.status);
  const fallbackBase = (config.fallbackOrigin || '').trim();

  if (primaryFailed && fallbackBase) {
    let fallback = null;
    try {
      fallback = await fetchFromOrigin(fallbackBase, request, env, config, url, bodyBuffer);
    } catch (_) { /* handled below */ }
    if (fallback && !UPSTREAM_FAILURE_STATUSES.includes(fallback.status)) {
      const res = withSecurityHeaders(fallback);
      res.headers.set('x-edge-fallback', 'true');
      return res;
    }
    return upstreamUnavailable(request, primary, primaryError);
  }

  if (primaryError) return upstreamUnavailable(request, null, primaryError);
  return withSecurityHeaders(primary);
}

// Last-ditch 502: keep the trace id (if any) and the Cloudflare ray id visible.
function upstreamUnavailable(request, failedResponse, err) {
  const traceId =
    failedResponse?.headers?.get('x-trace-id') || request.headers.get('x-trace-id') || null;
  const cfRay = request.headers.get('cf-ray') || null;
  const headers = { 'retry-after': '30' };
  if (traceId) headers['x-trace-id'] = traceId;
  return withSecurityHeaders(jsonResponse({
    error: 'edge cannot reach origin',
    fallbackAttempted: true,
    cfRay,
    traceId,
    detail: err ? String(err.message || err) : undefined,
  }, 502, headers));
}

/* -------------------------------------------------------------- media (R2) */

// GET /media/<key> → R2 object from bucket "animaxia-media" (binding
// ANIMAXIA_MEDIA). Hit → served straight from R2 with a 24h browser cache.
// Miss → pass through to the origin (which may still serve it or 404).
async function serveMedia(request, env, config, url, bodyBuffer) {
  const key = url.pathname.slice('/media/'.length);
  if (key && env.ANIMAXIA_MEDIA) {
    let object = null;
    try {
      object = await env.ANIMAXIA_MEDIA.get(key);
    } catch (_) { /* R2 hiccup → pass through to origin below */ }
    if (object) {
      const headers = new Headers();
      try { object.writeHttpMetadata(headers); } catch (_) { /* optional metadata */ }
      if (!headers.has('content-type')) headers.set('content-type', contentTypeFor(key));
      headers.set('cache-control', 'public, max-age=86400');
      headers.set('x-edge', 'r2');
      headers.set('x-content-type-options', 'nosniff');
      headers.set('referrer-policy', 'strict-origin-when-cross-origin');
      headers.set('etag', object.httpEtag);
      return new Response(object.body, { status: 200, headers });
    }
  }
  return fetchWithFailover(request, env, config, url, bodyBuffer);
}

/* ------------------------------------------------------------ cache (API) */

// Public catalog GETs are cached with the Cache API:
//   HIT  → served from the edge cache (x-edge-cache: HIT)
//   MISS → fetched from origin, stored via ctx.waitUntil(cache.put(...))
//          only when the response is 200 and not Cache-Control private/no-store.
async function serveCacheableApi(request, env, config, ctx, url) {
  const cache = caches.default;

  const hit = await cache.match(request);
  if (hit) {
    const res = withSecurityHeaders(hit);
    res.headers.set('x-edge-cache', 'HIT');
    return res;
  }

  const upstream = await fetchWithFailover(request, env, config, url, null);
  const cacheControl = (upstream.headers.get('cache-control') || '').toLowerCase();

  if (upstream.status === 200 && !/(private|no-store)/.test(cacheControl)) {
    // Clone BEFORE the client copy is consumed; put() rejects responses with
    // Set-Cookie, so guard against unhandled rejections.
    const storable = upstream.clone();
    ctx.waitUntil(cache.put(request, storable).catch(() => {}));
  }

  upstream.headers.set('x-edge-cache', 'MISS');
  return upstream;
}

/* ----------------------------------------------------------- fetch handler */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const config = await loadConfig(env);

    // 1) Last-resort per-IP rate limit (per-isolate — see header note).
    //    /api/health stays exempt so uptime probes are never throttled.
    const clientIp = request.headers.get('cf-connecting-ip') || 'unknown';
    const ipLimit = Number(config.edgeRateLimitPerMin) > 0
      ? Number(config.edgeRateLimitPerMin)
      : DEFAULT_CONFIG.edgeRateLimitPerMin;
    if (url.pathname !== '/api/health' && !inMemoryRateLimit(clientIp, ipLimit)) {
      return withSecurityHeaders(jsonResponse({
        error: 'rate limited at the edge (per-isolate backstop; see Cloudflare Rate Limiting rules)',
        retryAfterSec: 60,
      }, 429, { 'retry-after': '60' }));
    }

    // 2) Maintenance mode — everything except /api/health gets a polite 503.
    if (config.maintenance === true && url.pathname !== '/api/health') {
      return withSecurityHeaders(jsonResponse({
        error: 'Animaxia is in maintenance mode',
        maintenance: true,
        retryAfterSec: 60,
      }, 503, { 'retry-after': '60' }));
    }

    // Request bodies are buffered once so the failover retry can reuse them
    // (a stream can only be consumed one time). API JSON payloads are small;
    // the gateway enforces the real body limit anyway.
    let bodyBuffer = null;
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      bodyBuffer = await request.arrayBuffer();
    }

    // 3) Media: R2 first, origin as fallback (reads only — writes go to origin).
    if (url.pathname.startsWith('/media/') && (request.method === 'GET' || request.method === 'HEAD')) {
      return serveMedia(request, env, config, url, bodyBuffer);
    }

    // 4) Cacheable public API GETs (prefix list comes from KV config).
    //    Requests carrying credentials are never edge-cached: the Cache API key
    //    ignores the Authorization header, so a shared entry could leak between
    //    users. Authenticated callers simply go straight to the origin.
    if (request.method === 'GET'
        && !request.headers.has('authorization')
        && matchesPrefix(url.pathname, config.cacheablePaths)) {
      return serveCacheableApi(request, env, config, ctx, url);
    }

    // 5) Everything else: proxy to origin with failover, pass through
    //    status + headers + body untouched (plus our security headers).
    return fetchWithFailover(request, env, config, url, bodyBuffer);
  },
};
