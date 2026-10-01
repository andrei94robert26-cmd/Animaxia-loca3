/**
 * player/src/index.ts — ANIMAXIA EDGE PLAYER worker.
 *
 * Streams HLS through the edge + serves R2 media. The gateway routes these
 * inbound paths here with the URL preserved:
 *
 *   GET /player/manifest/:id — resolve the cloud mobile player payload
 *       (GET /api/mobile/player/:id → { content, mode, allowedTypes, sources,
 *       primary, nextUp }; each source is { type, url, label } with type ∈
 *       mp4 | m3u8 | youtube | iframe — modules/player/player.js), pick the
 *       first HLS source, fetch its m3u8 (after the allowlist check) and
 *       return the REWRITTEN manifest (variant playlists → the variant
 *       endpoint, segments/keys → /hls). Responses are cached via
 *       shared/cache.ts cachedJsonFetch (key player:manifest:<id>, TTL
 *       cfg.player.manifestTtlSec, SWR 60s, stale-if-error 300s) as a JSON
 *       bundle so every HIT keeps the exact same response headers.
 *       No HLS source → the cloud payload is returned as-is with
 *       'x-edge-player: no-hls' (clients fall back to mp4/youtube).
 *   GET /player/manifest/variant?src=<enc> — same rewrite for nested
 *       playlists; allowlist enforced (403 otherwise).
 *   GET /hls?u=<enc> — segment proxy: allowlist enforced, client Range
 *       forwarded, L1 tier via the Workers Cache API ONLY (binary bodies
 *       never enter the KV tier), optional R2 write-through
 *       (hls/<sha256(url)>.<ext>, bodies ≤ 4MB, .ts/.m4s/.mp4) and R2
 *       stale-if-error when the origin throws or 5xxes.
 *   GET /player/sources/:id — the cloud mobile player payload as plain JSON
 *       (cached, key player:sources:<id>).
 *   GET|HEAD /player/media/* — MEDIA_BUCKET objects (thumbnails/,
 *       offline-test.mp4) with Range + HEAD support.
 *   GET /player/health — worker + binding stats.
 *
 * Requests carrying an Authorization header skip the shared cache entirely
 * (shared/cache.ts contract) — the underlying cloud payloads are public, but
 * cache keys are not user-scoped.
 */

import type { EdgeCtx, EdgeEnv, EdgeWorker, R2ObjectLike } from '../../shared/types';
import type { EdgeConfig } from '../../shared/config';
import { loadEdgeConfig } from '../../shared/config';
import { jsonError, jsonOk, withCors, withSecurityHeaders } from '../../shared/http';
import { buildForwardedHeaders, hostAllowed, upstreamFetch } from '../../shared/upstream';
import { cachedJsonFetch, edgeCacheApi } from '../../shared/cache';
import { sha256Hex } from '../../shared/jwt';
import { withMetrics } from '../../shared/metrics'; // FAZA 9 ops
import { TENANT_HEADER, resolveTenantOf, tenantKeyPrefix, tenantPlayerAllowlist } from '../../shared/tenant'; // FAZA 11 multi-tenant
import { SHARD_HEADER, resolveShardOf, shardKeySegment } from '../../shared/shard'; // FAZA 13 shard-aware edge
import { M3U8_CONTENT_TYPE, contentTypeForPath, rewriteManifest, writeThroughExt } from './hls';

/* ------------------------------------------------------------- constants --- */

const MEDIA_PREFIX = '/player/media/';
const SEGMENT_L1_ORIGIN = 'https://edge-cache.animaxia.internal'; // synthetic Cache API origin
const SEGMENT_MAX_R2_BYTES = 4 * 1024 * 1024; // write-through cap (spec: 4MB)
const UPSTREAM_TIMEOUT_MS = 15_000;
const MANIFEST_TIMEOUT_MS = 10_000;

/**
 * Internal cache bundle for /player/manifest/:id — what cachedJsonFetch
 * stores. flavor 'rewritten' carries the edge manifest; 'no-hls' carries the
 * untouched cloud JSON so clients can fall back to the other sources.
 */
interface ManifestBundle {
  v: 1;
  flavor: 'rewritten' | 'no-hls';
  sourceHost: string | null;
  body: string;
}

/** Cloud mobile player source item (modules/player/player.js normalizeSources). */
interface CloudSource {
  type: string;
  url: string;
  label: string;
}

/* ------------------------------------------------------------- helpers ----- */

function methodNotAllowed(method: string, allow: string): Response {
  return jsonError(405, 'method_not_allowed', `Method ${method} is not allowed here.`, { allow }, { allow });
}

/** Parse an absolute http(s) URL, or null. */
function parseHttpUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/** Extract + normalize the `sources` array from a cloud player payload. */
function extractSources(payload: unknown): CloudSource[] {
  const raw = payload && typeof payload === 'object' ? (payload as { sources?: unknown }).sources : null;
  if (!Array.isArray(raw)) return [];
  const out: CloudSource[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const url = typeof record.url === 'string'
      ? record.url
      : typeof record.src === 'string'
        ? record.src
        : null;
    if (!url) continue;
    out.push({
      type: typeof record.type === 'string' ? record.type : '',
      url,
      label: typeof record.label === 'string' ? record.label : '',
    });
  }
  return out;
}

/**
 * HLS detection from the REAL cloud shape: resolvePlayer types are
 * 'mp4' | 'm3u8' | 'youtube' | 'iframe' (inferred from the URL), so the
 * canonical marker is type === 'm3u8'; label/url checks catch miner-fed
 * entries that typed themselves loosely.
 */
function isHlsSource(source: CloudSource): boolean {
  const type = source.type.toLowerCase();
  const label = source.label.toLowerCase();
  const url = source.url.toLowerCase();
  return type === 'm3u8' || type === 'hls' || label.includes('hls') || url.includes('.m3u8');
}

/** Minimal headers for an external HLS fetch (origin UAs often reject empty). */
function hlsFetchHeaders(request: Request): Record<string, string> {
  const headers: Record<string, string> = { accept: '*/*' };
  const ua = request.headers.get('user-agent');
  if (ua) headers['user-agent'] = ua;
  return headers;
}

/** Fetch a playlist/manifest text; null on network error or non-2xx. */
async function fetchManifestText(request: Request, target: URL): Promise<string | null> {
  try {
    const res = await fetch(target.href, {
      headers: hlsFetchHeaders(request),
      redirect: 'follow',
      signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/* --------------------------------------------- GET /player/manifest/:id ---- */

/**
 * fetchUpstream for cachedJsonFetch: resolve the cloud player payload, pick
 * the first HLS source, fetch + rewrite its manifest, and return the whole
 * result as a JSON ManifestBundle (or pass cloud errors through untouched).
 */
async function buildManifestBundle(
  request: Request,
  env: EdgeEnv,
  id: number,
  cfg: EdgeConfig,
  tenant: string, // FAZA 11 — per-tenant HLS host allowlist
  shard: number, // FAZA 13 — shard header upstream
): Promise<Response> {
  const upstream = await upstreamFetch({
    env,
    kind: 'mobile',
    path: `/mobile/player/${id}`,
    method: 'GET',
    headers: buildForwardedHeaders(request, { [TENANT_HEADER]: tenant, [SHARD_HEADER]: String(shard) }),
  });
  if (!upstream.ok) return upstream; // 400 bad id / 404 unknown id / 5xx → passthrough

  const cloudText = await upstream.text();
  let payload: unknown;
  try {
    payload = JSON.parse(cloudText);
  } catch {
    return jsonError(502, 'bad_upstream', `Cloud mobile player payload for id ${id} is not valid JSON.`);
  }

  const hls = extractSources(payload).find(isHlsSource);
  const manifestUrl = hls ? parseHttpUrl(hls.url) : null;

  if (!manifestUrl) {
    // No HLS source (or unparseable URL) → cloud payload as-is; clients use
    // the mp4/youtube entries from `sources`.
    const bundle: ManifestBundle = { v: 1, flavor: 'no-hls', sourceHost: null, body: cloudText };
    return jsonOk(bundle);
  }
  // FAZA 11: the tenant's KV allowlist (t:<slug>:player:allowlist) overrides
  // the global config list; 'global' keeps the config list unchanged.
  if (!hostAllowed(manifestUrl, await tenantPlayerAllowlist(env, tenant, cfg.player.allowHosts))) {
    return jsonError(403, 'host_not_allowed', `HLS host "${manifestUrl.host}" is not on the player allowlist for tenant '${tenant}'.`, { host: manifestUrl.host, tenant });
  }

  const manifestText = await fetchManifestText(request, manifestUrl);
  if (manifestText === null) {
    // Origin down → still hand clients the full source list instead of a 5xx.
    const bundle: ManifestBundle = { v: 1, flavor: 'no-hls', sourceHost: manifestUrl.host, body: cloudText };
    return jsonOk(bundle);
  }

  const bundle: ManifestBundle = {
    v: 1,
    flavor: 'rewritten',
    sourceHost: manifestUrl.host,
    body: rewriteManifest(manifestText, manifestUrl.href),
  };
  return jsonOk(bundle);
}

/** Convert a cachedJsonFetch response (JSON bundle) into the final response. */
async function toManifestResponse(cached: Response, cfg: EdgeConfig): Promise<Response> {
  if (cached.status !== 200) return cached; // errors pass through untouched

  const text = await cached.text();
  let bundle: ManifestBundle | null = null;
  try {
    const parsed = JSON.parse(text) as Partial<ManifestBundle>;
    if (
      parsed && typeof parsed === 'object' && parsed.v === 1
      && (parsed.flavor === 'rewritten' || parsed.flavor === 'no-hls')
      && typeof parsed.body === 'string'
    ) {
      bundle = parsed as ManifestBundle;
    }
  } catch {
    bundle = null;
  }
  if (!bundle) {
    // Not one of our bundles (defensive) → rebuild the passthrough verbatim.
    return new Response(text, { status: cached.status, statusText: cached.statusText, headers: cached.headers });
  }

  if (bundle.flavor === 'rewritten') {
    const headers: Record<string, string> = {
      'content-type': M3U8_CONTENT_TYPE,
      'cache-control': `public, max-age=${cfg.player.manifestTtlSec}`,
      'x-edge-player': 'rewritten',
    };
    if (bundle.sourceHost) headers['x-edge-source'] = bundle.sourceHost;
    return new Response(bundle.body, { headers });
  }
  return new Response(bundle.body, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': `public, max-age=${cfg.player.manifestTtlSec}`,
      'x-edge-player': 'no-hls',
    },
  });
}

async function handleManifest(
  request: Request,
  env: EdgeEnv,
  ctx: EdgeCtx,
  id: number,
  cfg: EdgeConfig,
  tenant: string, // FAZA 11
  shard: number, // FAZA 13
): Promise<Response> {
  const cacheable = !request.headers.has('authorization');
  const cached = await cachedJsonFetch({
    env,
    ctx,
    // FAZA 11: tenant-scoped; FAZA 13: + shard segment after the tenant prefix.
    key: `${tenantKeyPrefix(tenant)}${shardKeySegment(shard)}player:manifest:${id}`,
    fetchUpstream: () => buildManifestBundle(request, env, id, cfg, tenant, shard),
    opts: {
      ttlSec: cacheable ? cfg.player.manifestTtlSec : 0,
      swrSec: 60,
      staleIfErrorSec: 300,
    },
    cacheApi: edgeCacheApi(),
  });
  return toManifestResponse(cached, cfg);
}

/* ------------------------------------- GET /player/manifest/variant?src= --- */

async function handleVariant(request: Request, env: EdgeEnv, url: URL, cfg: EdgeConfig, tenant: string): Promise<Response> {
  const src = url.searchParams.get('src');
  if (!src) {
    return jsonError(400, 'bad_src', 'Missing required query parameter: src (the encoded upstream playlist URL).');
  }
  const target = parseHttpUrl(src);
  if (!target) {
    return jsonError(400, 'bad_src', 'Parameter src must be an absolute http(s) playlist URL.');
  }
  // FAZA 11: per-tenant allowlist (KV override, global fallback).
  if (!hostAllowed(target, await tenantPlayerAllowlist(env, tenant, cfg.player.allowHosts))) {
    return jsonError(403, 'host_not_allowed', `Playlist host "${target.host}" is not on the player allowlist for tenant '${tenant}'.`, { host: target.host, tenant });
  }

  const text = await fetchManifestText(request, target);
  if (text === null) {
    return jsonError(502, 'upstream_unavailable', `Cannot fetch the HLS playlist from ${target.host}.`);
  }
  return new Response(rewriteManifest(text, target.href), {
    headers: {
      'content-type': M3U8_CONTENT_TYPE,
      'cache-control': `public, max-age=${cfg.player.manifestTtlSec}`,
      'x-edge-player': 'rewritten',
      'x-edge-source': target.host,
    },
  });
}

/* ------------------------------------------------------- GET /hls?u= ------ */

function segmentL1Request(cacheKey: string): Request {
  return new Request(`${SEGMENT_L1_ORIGIN}/hls/${encodeURIComponent(cacheKey)}`);
}

/** R2 stale-if-error copy for a segment (only mirrored extensions are held). */
async function segmentFromR2(env: EdgeEnv, target: URL, cfg: EdgeConfig): Promise<Response | null> {
  if (!env.HLS_CACHE) return null;
  const ext = writeThroughExt(target.pathname);
  if (!ext) return null;
  const key = `hls/${await sha256Hex(target.href)}.${ext}`;
  let obj: R2ObjectLike | null = null;
  try {
    obj = await env.HLS_CACHE.get(key);
  } catch {
    return null;
  }
  if (!obj || !obj.body) return null;

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  if (!headers.has('content-type')) headers.set('content-type', contentTypeForPath(target.pathname));
  headers.set('etag', obj.httpEtag);
  headers.set('accept-ranges', 'bytes');
  headers.set('cache-control', `public, max-age=${cfg.player.segmentTtlSec}`);
  headers.set('x-edge-player', 'stale-if-error');
  return new Response(obj.body, { status: 200, headers });
}

async function handleSegment(
  request: Request,
  env: EdgeEnv,
  ctx: EdgeCtx,
  url: URL,
  cfg: EdgeConfig,
  tenant: string, // FAZA 11
): Promise<Response> {
  const raw = url.searchParams.get('u');
  if (!raw) {
    return jsonError(400, 'bad_url', 'Missing required query parameter: u (the encoded segment URL).');
  }
  const target = parseHttpUrl(raw);
  if (!target) {
    return jsonError(400, 'bad_url', 'Parameter u must be an absolute http(s) segment URL.');
  }
  // FAZA 11: per-tenant allowlist (KV override, global fallback).
  if (!hostAllowed(target, await tenantPlayerAllowlist(env, tenant, cfg.player.allowHosts))) {
    return jsonError(403, 'host_not_allowed', `Segment host "${target.host}" is not on the player allowlist for tenant '${tenant}'.`, { host: target.host, tenant });
  }

  const rangeHeader = request.headers.get('range');
  const cacheApi = edgeCacheApi();
  const cacheKey = `hls:${await sha256Hex(target.href)}`;

  // L1 — Cache API only (binary bodies never enter the KV tier). Full-body
  // hits; Range requests skip the tier and go upstream instead.
  if (!rangeHeader && cacheApi) {
    const hit = await cacheApi.match(segmentL1Request(cacheKey)).catch(() => null);
    if (hit && hit.status === 200) {
      const headers = new Headers(hit.headers);
      headers.set('cache-control', `public, max-age=${cfg.player.segmentTtlSec}`);
      headers.set('x-edge-cache', 'HIT');
      return new Response(hit.body, { status: 200, headers });
    }
  }

  const headersUpstream = hlsFetchHeaders(request);
  if (rangeHeader) headersUpstream.range = rangeHeader; // client Range forwarded

  let upstream: Response | null = null;
  try {
    upstream = await fetch(target.href, {
      headers: headersUpstream,
      redirect: 'follow',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch {
    upstream = null;
  }

  if (!upstream || upstream.status >= 500) {
    const stale = await segmentFromR2(env, target, cfg);
    if (stale) return stale;
    if (upstream) return upstream; // 5xx passthrough
    return jsonError(502, 'upstream_unavailable', `Cannot fetch the media segment from ${target.host}.`);
  }

  // Full 200 body → buffer once, then L1 put + optional R2 write-through.
  if (upstream.status === 200 && !rangeHeader) {
    const body = await upstream.arrayBuffer();
    const contentType = upstream.headers.get('content-type') || contentTypeForPath(target.pathname);
    const etag = upstream.headers.get('etag');

    const headers = new Headers();
    headers.set('content-type', contentType);
    headers.set('cache-control', `public, max-age=${cfg.player.segmentTtlSec}`);
    headers.set('accept-ranges', 'bytes');
    if (etag) headers.set('etag', etag);
    headers.set('x-edge-cache', 'MISS');

    if (cacheApi) {
      const l1Headers = new Headers();
      l1Headers.set('content-type', contentType);
      l1Headers.set('cache-control', `public, max-age=${cfg.player.segmentTtlSec}`);
      if (etag) l1Headers.set('etag', etag);
      ctx.waitUntil(
        cacheApi.put(segmentL1Request(cacheKey), new Response(body, { status: 200, headers: l1Headers }))
          .catch(() => undefined),
      );
    }

    const ext = writeThroughExt(target.pathname);
    if (cfg.player.r2WriteThrough && env.HLS_CACHE && ext && body.byteLength > 0 && body.byteLength <= SEGMENT_MAX_R2_BYTES) {
      const r2Key = `hls/${await sha256Hex(target.href)}.${ext}`;
      ctx.waitUntil(
        env.HLS_CACHE.put(r2Key, body, { httpMetadata: { contentType } }).catch(() => null),
      );
    }

    return new Response(body, { status: 200, headers });
  }

  // Range (206) / non-200 upstream responses → stream through untouched.
  const passthrough = new Headers(upstream.headers);
  passthrough.set('cache-control', `public, max-age=${cfg.player.segmentTtlSec}`);
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: passthrough,
  });
}

/* -------------------------------------------- GET /player/sources/:id ----- */

async function handleSources(
  request: Request,
  env: EdgeEnv,
  ctx: EdgeCtx,
  id: number,
  cfg: EdgeConfig,
  tenant: string, // FAZA 11
  shard: number, // FAZA 13
): Promise<Response> {
  const cacheable = !request.headers.has('authorization');
  return cachedJsonFetch({
    env,
    ctx,
    // FAZA 11: tenant-scoped; FAZA 13: + shard segment after the tenant prefix.
    key: `${tenantKeyPrefix(tenant)}${shardKeySegment(shard)}player:sources:${id}`,
    fetchUpstream: () => upstreamFetch({
      env,
      kind: 'mobile',
      path: `/mobile/player/${id}`,
      method: 'GET',
      headers: buildForwardedHeaders(request, { [TENANT_HEADER]: tenant, [SHARD_HEADER]: String(shard) }),
    }),
    opts: {
      ttlSec: cacheable ? cfg.player.manifestTtlSec : 0,
      swrSec: 60,
      staleIfErrorSec: 300,
    },
    cacheApi: edgeCacheApi(),
  });
}

/* --------------------------------------------- GET /player/media/* -------- */

/** Common response headers for an R2 media object. */
function mediaHeaders(obj: R2ObjectLike, key: string): Headers {
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  if (!headers.has('content-type')) headers.set('content-type', contentTypeForPath(key));
  headers.set('etag', obj.httpEtag);
  headers.set('accept-ranges', 'bytes');
  headers.set('cache-control', 'public, max-age=86400');
  return headers;
}

type RangeSpec = { offset: number; length: number } | 'unsatisfiable' | null;

/**
 * Parse a Range header against a known object size.
 *   null             → malformed → ignore, serve the full 200 (RFC 9110)
 *   'unsatisfiable'  → outside the object → 416
 */
function parseRangeHeader(header: string, size: number): RangeSpec {
  const match = /^bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/.exec(header.trim());
  if (!match) return null;
  const [, startRaw, endRaw] = match;
  if (startRaw === '' && endRaw === '') return null;
  if (startRaw === '') {
    // suffix range: last N bytes
    const n = Number(endRaw);
    if (!Number.isFinite(n) || n <= 0) return 'unsatisfiable';
    const length = Math.min(n, size);
    return { offset: size - length, length };
  }
  const start = Number(startRaw);
  if (!Number.isFinite(start) || start < 0) return null;
  if (start >= size) return 'unsatisfiable';
  if (endRaw === '') return { offset: start, length: size - start };
  const end = Number(endRaw);
  if (!Number.isFinite(end) || end < start) return null;
  return { offset: start, length: Math.min(end, size - 1) - start + 1 };
}

async function handleMedia(request: Request, env: EdgeEnv, url: URL): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    return methodNotAllowed(method, 'GET, HEAD');
  }

  let key = url.pathname.slice(MEDIA_PREFIX.length);
  try {
    key = decodeURIComponent(key);
  } catch {
    /* keep the raw form — R2 keys are opaque strings */
  }
  key = key.replace(/^\/+/, ''); // tolerate a doubled slash after the prefix
  if (!key || key.includes('..')) {
    return jsonError(400, 'bad_key', 'Media key must be a non-empty R2 object path without ".." segments.');
  }
  if (!env.MEDIA_BUCKET) {
    return jsonError(501, 'media_unavailable', 'The MEDIA_BUCKET R2 binding is not configured on this worker.');
  }
  const bucket = env.MEDIA_BUCKET;

  if (method === 'HEAD') {
    const obj = await bucket.head(key).catch(() => null);
    if (!obj) return jsonError(404, 'media_not_found', `No MEDIA_BUCKET object at key "${key}".`);
    const headers = mediaHeaders(obj, key);
    headers.set('content-length', String(obj.size));
    return new Response(null, { status: 200, headers });
  }

  const rangeHeader = request.headers.get('range');
  if (rangeHeader) {
    const head = await bucket.head(key).catch(() => null);
    if (!head) return jsonError(404, 'media_not_found', `No MEDIA_BUCKET object at key "${key}".`);
    const range = parseRangeHeader(rangeHeader, head.size);
    if (range === 'unsatisfiable') {
      return jsonError(416, 'range_not_satisfiable', `Range "${rangeHeader}" lies outside the object (size ${head.size}).`, {}, { 'content-range': `bytes */${head.size}` });
    }
    if (range) {
      const obj = await bucket.get(key, { range: { offset: range.offset, length: range.length } }).catch(() => null);
      if (!obj) return jsonError(404, 'media_not_found', `No MEDIA_BUCKET object at key "${key}".`);
      const headers = mediaHeaders(obj, key);
      headers.set('content-length', String(range.length));
      headers.set('content-range', `bytes ${range.offset}-${range.offset + range.length - 1}/${head.size}`);
      return new Response(obj.body, { status: 206, headers });
    }
    // malformed Range → fall through to the full 200 below
  }

  const obj = await bucket.get(key).catch(() => null);
  if (!obj) return jsonError(404, 'media_not_found', `No MEDIA_BUCKET object at key "${key}".`);
  const headers = mediaHeaders(obj, key);
  headers.set('content-length', String(obj.size));
  return new Response(obj.body, { status: 200, headers });
}

/* ---------------------------------------------------- GET /player/health -- */

function handleHealth(env: EdgeEnv, cfg: EdgeConfig): Response {
  return jsonOk({
    ok: true,
    worker: 'animaxia-edge-player',
    r2: !!env.MEDIA_BUCKET,
    r2WriteThrough: cfg.player.r2WriteThrough,
    allowHosts: cfg.player.allowHosts.length,
  });
}

/* ------------------------------------------------------------- routing ---- */

async function route(request: Request, env: EdgeEnv, ctx: EdgeCtx): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method.toUpperCase();
  const readable = method === 'GET' || method === 'HEAD';

  // FAZA 11: resolve the tenant once per request (header → JWT claim →
  // 'global'); scopes the allowlist resolution + manifest/sources caches.
  const tenant = await resolveTenantOf(request, env);
  // FAZA 13: resolve the shard the same way (valid client header override >
  // tenant > content path > 0) — scopes the manifest/sources cache keys and
  // rides upstream to the monolith.
  const shard = resolveShardOf(request, tenant, env);

  if (path === '/player/manifest/variant') {
    if (!readable) return methodNotAllowed(method, 'GET');
    return handleVariant(request, env, url, await loadEdgeConfig(env), tenant);
  }

  if (path === '/hls' || path === '/player/hls') {
    if (!readable) return methodNotAllowed(method, 'GET');
    return handleSegment(request, env, ctx, url, await loadEdgeConfig(env), tenant);
  }

  const manifestMatch = /^\/player\/manifest\/([^/]+)$/.exec(path);
  if (manifestMatch) {
    if (!readable) return methodNotAllowed(method, 'GET');
    const id = Number(manifestMatch[1]);
    if (!Number.isInteger(id) || id <= 0) {
      return jsonError(400, 'bad_id', `Invalid content id "${manifestMatch[1]}" — expected a positive integer.`);
    }
    return handleManifest(request, env, ctx, id, await loadEdgeConfig(env), tenant, shard);
  }

  const sourcesMatch = /^\/player\/sources\/([^/]+)$/.exec(path);
  if (sourcesMatch) {
    if (!readable) return methodNotAllowed(method, 'GET');
    const id = Number(sourcesMatch[1]);
    if (!Number.isInteger(id) || id <= 0) {
      return jsonError(400, 'bad_id', `Invalid content id "${sourcesMatch[1]}" — expected a positive integer.`);
    }
    return handleSources(request, env, ctx, id, await loadEdgeConfig(env), tenant, shard);
  }

  if (path === '/player/media' || path.startsWith('/player/media/')) {
    return handleMedia(request, env, url);
  }

  if (path === '/player/health' || path === '/health') {
    if (!readable) return methodNotAllowed(method, 'GET');
    return handleHealth(env, await loadEdgeConfig(env));
  }

  return jsonError(404, 'not_found', `No player-worker route for ${method} ${path}`);
}

/* ------------------------------------------------------------- entry ----- */

const worker: EdgeWorker = {
  fetch: withMetrics('player', async (request: Request, env: EdgeEnv, ctx: EdgeCtx): Promise<Response> => {
    let inner: Response;
    if (request.method === 'OPTIONS') {
      inner = new Response(null, { status: 204 }); // withCors answers preflights
    } else {
      try {
        inner = await route(request, env, ctx);
      } catch (err) {
        inner = jsonError(500, 'internal_error', `Unhandled player-worker error: ${String((err as Error)?.message ?? err)}`);
      }
    }
    return withCors(withSecurityHeaders(inner), request);
  }), // FAZA 9 ops: /metrics + request counters
};

export default worker;
