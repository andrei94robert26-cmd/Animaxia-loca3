/**
 * worker/src/index.ts — animaxia-edge-gateway, the front door of the FAZA 8
 * Animaxia edge layer.
 *
 * Request pipeline (in order):
 *   1. request id + CORS preflight short-circuit
 *   2. KV runtime config (shared/config.ts, EDGE_CONFIG "config" key)
 *   3. maintenance mode (503, /edge/* exempt)
 *   4. WAF (shared/waf.ts): bots / SQLi / XSS / traversal / null-byte /
 *      oversized query — blocked requests logged to EDGE_CACHE waf:{ts}:{id}
 *   5. identity sniff (shared/jwt.ts) — only to pick the rate-limit tier;
 *      the origin always re-verifies Authorization itself
 *   6. global rate limiting (shared/rate-limit.ts): per-IP always, per-user
 *      when a valid access token is present, heavy tier on /ai/* + /vector/*
 *      (also for anonymous callers, keyed per-IP)
 *   7. smart routing (service bindings first, cloud fallbacks when a
 *      sub-worker is not deployed)
 *   8. response decoration: security headers + CORS + x-request-id +
 *      X-RateLimit-* trio
 *
 * Routing table:
 *   /  and /edge/health       public liveness + route directory
 *   /edge/status              config + bindings summary (no secrets)
 *   /edge/metrics             admin — FAZA 9 ops metrics (Prometheus / JSON)
 *   /edge/waf/events          admin — recent WAF blocks
 *   /edge/cache/purge         admin POST { prefix }
 *   /edge/cache/invalidate    admin POST { key }
 *   /api/*                    cloud gateway — public GETs cached
 *                             (60s fresh + SWR + stale-if-error)
 *   /ai/*                     SVC_AI → ai upstream (streaming passthrough)
 *   /vector/*                 vector upstream (heavy tier)
 *   /mobile/*                 mobile upstream — public GETs cached
 *   /search, /search/*, /autocomplete
 *                             SVC_SEARCH → cloud /api/search/*
 *   /auth/*                   SVC_AUTH → cloud /api/auth/*
 *   /player/*, /hls           SVC_PLAYER → cloud /api/mobile/player/*
 *   /analytics/*, /beacon     SVC_ANALYTICS → cloud /api/analytics/*
 *   /media/*                  R2 MEDIA_BUCKET (thumbnails, offline-test.mp4)
 *   /ws/*                     WebSocket proxy → WS_ORIGIN (assistant live)
 */

import type { EdgeEnv, EdgeCtx, RateResult, ServiceBindingLike } from '../../shared/types';
import { loadEdgeConfig, type EdgeConfig } from '../../shared/config';
import { wafInspect, wafLog, wafRecent } from '../../shared/waf';
import { checkRateLimit, rateLimitHeaders, rateLimitedResponse } from '../../shared/rate-limit';
import {
  cachedJsonFetch,
  cacheInvalidate,
  cachePurgePrefix,
  edgeCacheApi,
  type CacheOptions,
} from '../../shared/cache';
import { verifyEdgeJwt, bearerOf } from '../../shared/jwt';
import {
  jsonOk,
  jsonError,
  withCors,
  withSecurityHeaders,
  clientIpOf,
  requestIdOf,
  requireInternalAuth,
  isAuthorized,
  readJsonBody,
} from '../../shared/http';
import { upstreamFetch, buildForwardedHeaders, type OriginKind, type UpstreamArgs } from '../../shared/upstream';
import { withMetrics, edgeMetrics, metricsResponse } from '../../shared/metrics'; // FAZA 9 ops
import { TENANT_HEADER, GLOBAL_TENANT, resolveTenantSlug, tenantKeyPrefix, tenantUserKey } from '../../shared/tenant'; // FAZA 11 multi-tenant
import { SHARD_HEADER, resolveShardOf, shardKeySegment } from '../../shared/shard'; // FAZA 13 shard-aware edge
import { parseOriginRegions, regionForRequest, pickUpstream, type EdgeRegion } from '../../shared/geo'; // FAZA 22 — global geo-routing (ORIGIN_REGIONS gate)
import { serveR2Media } from './media';
import { proxyWebSocket } from './websocket';

// The Durable Object class must be exported from the main module (wrangler).
export { RateLimiterDurable } from './ratelimiter-do';

const VERSION = '1.0.0';
const MAX_BODY_BYTES = 4 * 1024 * 1024;

interface GatewayState {
  requestId: string;
  ip: string;
  url: URL;
  cfg: EdgeConfig;
  user: { sub: number | string; plan?: string } | null;
  rate: RateResult | null;
  tenant: string; // FAZA 11 — resolved tenant slug ('global' default)
  shard: number;  // FAZA 13 — resolved shard id (header override > tenant > content path > 0)
}

export default {
  // FAZA 9 ops: withMetrics observes requests (counters/latency/cache tags);
  // metricsPath null — /edge/metrics is served below, behind requireInternalAuth
  // like every other /edge/* management route.
  fetch: withMetrics('gateway', async (request: Request, env: EdgeEnv, ctx: EdgeCtx): Promise<Response> => {
    const requestId = requestIdOf(request);

    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return decorate(jsonError(400, 'bad_request', 'Unparseable request URL.'), request, requestId, null);
    }

    // CORS preflights are harmless — answer before anything else.
    if (request.method === 'OPTIONS') {
      return decorate(new Response(null, { status: 204 }), request, requestId, null);
    }

    const cfg = await loadEdgeConfig(env);

    if (cfg.maintenance && !url.pathname.startsWith('/edge/') && url.pathname !== '/') {
      return decorate(
        jsonError(503, 'maintenance', 'Animaxia edge is in maintenance mode. Try again shortly.'),
        request,
        requestId,
        null,
      );
    }

    // --- WAF ---------------------------------------------------------------
    const verdict = wafInspect(request, url, cfg);
    if (verdict.blocked) {
      edgeMetrics.inc('animaxia_edge_waf_blocks_total', { rule: String(verdict.rule ?? 'unknown') }); // FAZA 9 ops
      ctx.waitUntil(wafLog(env, ctx, request, url, verdict).catch(() => undefined));
      return decorate(
        jsonError(
          403,
          'waf_blocked',
          `Request blocked by the Animaxia edge WAF (${verdict.rule}).`,
          { rule: verdict.rule, reason: verdict.reason },
        ),
        request,
        requestId,
        null,
        { 'x-edge-waf': String(verdict.rule) },
      );
    }

    // --- identity sniff (rate tiers only; origin re-verifies) ---------------
    const token = bearerOf(request);
    const payload = token ? await verifyEdgeJwt(token, env) : null; // FAZA 11: dual-path (tenant-aware) verify
    const user = payload ? { sub: payload.sub ?? 'unknown', plan: payload.plan } : null;

    // --- FAZA 11: tenant resolution (X-Animaxia-Tenant → JWT claim → global).
    //     Used for per-tenant rate buckets, cache-key isolation and the
    //     forwarded tenant header; the origin re-validates the tenant itself.
    const tenant = resolveTenantSlug(request, payload);

    // --- FAZA 13: shard resolution (valid client X-Animaxia-Shard override >
    //     tenant > content path > 0, shared/shard.ts). Threaded like the
    //     tenant: cache-key isolation, upstream header, response header.
    const shard = resolveShardOf(request, tenant, env);

    // --- global rate limits --------------------------------------------------
    const ip = clientIpOf(request);
    const ipRate = await checkRateLimit(env, { key: `ip:${ip}`, limit: cfg.rateLimit.ipPerMin, windowSec: 60 });
    let effectiveRate: RateResult = ipRate;
    if (!ipRate.allowed) {
      return decorate(rateLimitedResponse(ipRate), request, requestId, ipRate);
    }

    if (user) {
      const heavy = isHeavyPath(url.pathname);
      // FAZA 11: user buckets are tenant-scoped (global keeps the legacy key).
      const userRate = await checkRateLimit(env, {
        key: tenantUserKey(tenant, user.sub),
        limit: heavy ? cfg.rateLimit.heavyPerMin : cfg.rateLimit.userPerMin,
        windowSec: 60,
      });
      effectiveRate = userRate;
      if (!userRate.allowed) {
        return decorate(rateLimitedResponse(userRate), request, requestId, userRate);
      }
    } else if (isHeavyPath(url.pathname)) {
      // Anonymous callers on expensive prefixes get a heavy per-IP tier too.
      const ipHeavy = await checkRateLimit(env, {
        key: `ip-heavy:${ip}`,
        limit: cfg.rateLimit.heavyPerMin,
        windowSec: 60,
      });
      effectiveRate = ipHeavy;
      if (!ipHeavy.allowed) {
        return decorate(rateLimitedResponse(ipHeavy), request, requestId, ipHeavy);
      }
    }

    const state: GatewayState = { requestId, ip, url, cfg, user, rate: effectiveRate, tenant, shard };

    let out: Response;
    try {
      out = await dispatch(request, env, ctx, state);
    } catch (err) {
      out = jsonError(502, 'edge_error', 'The edge worker hit an unexpected error.', {
        detail: String((err as Error)?.message ?? err),
      });
    }

    // WebSocket handshakes carry the socket on the Response object —
    // re-wrapping them would break the connection.
    if (out.status === 101) return out;

    // FAZA 13: the resolved shard rides back to the client (additive header
    // on top of the standard decoration, mirrors X-Animaxia-Tenant upstream).
    return decorate(out, request, requestId, state.rate, { [SHARD_HEADER]: String(state.shard) });
  }, { metricsPath: null }),
} satisfies { fetch: (request: Request, env: EdgeEnv, ctx: EdgeCtx) => Promise<Response> };

/* ============================================================ routing ===== */

async function dispatch(request: Request, env: EdgeEnv, ctx: EdgeCtx, st: GatewayState): Promise<Response> {
  const { url, cfg } = st;
  const path = url.pathname;
  const method = request.method;

  /* ------------------------------------------------- /edge/* management --- */
  if (path === '/' || path === '/edge/health') {
    return jsonOk({
      ok: true,
      worker: 'animaxia-edge-gateway',
      version: VERSION,
      edgeEnv: env.EDGE_ENV ?? 'development',
      routes: ['/edge/health', '/edge/status', '/edge/metrics', '/api/*', '/ai/*', '/vector/*', '/mobile/*', '/search', '/autocomplete', '/auth/*', '/player/*', '/hls', '/analytics/*', '/beacon', '/media/*', '/ws/*', '/edge/miner/status'],
      at: new Date().toISOString(),
    });
  }

  if (path === '/edge/status') {
    const envRecord = env as unknown as Record<string, unknown>;
    return jsonOk({
      ok: true,
      version: VERSION,
      config: {
        maintenance: cfg.maintenance,
        cache: { ttlSec: cfg.edge.cacheTtlSec, swrSec: cfg.edge.swrSec, staleIfErrorSec: cfg.edge.staleIfErrorSec },
        rateLimit: cfg.rateLimit,
        multiTenant: { header: TENANT_HEADER, defaultTenant: GLOBAL_TENANT, cacheKeyIsolation: true }, // FAZA 11
        sharding: { header: SHARD_HEADER, defaultShard: 0, cacheKeyIsolation: true }, // FAZA 13
        waf: {
          enabled: cfg.waf.enabled,
          blockBots: cfg.waf.blockBots,
          sql: cfg.waf.sql,
          xss: cfg.waf.xss,
          traversal: cfg.waf.traversal,
        },
        auth: { deviceBinding: cfg.auth.deviceBinding, enforceReplay: cfg.auth.enforceReplay },
      },
      bindings: {
        kv: ['EDGE_CONFIG', 'EDGE_CACHE', 'EDGE_RATELIMIT'].filter((k) => Boolean(envRecord[k])),
        r2Media: Boolean(env.MEDIA_BUCKET),
        rateLimiterDo: Boolean(env.RATE_LIMITER),
        services: ['SVC_SEARCH', 'SVC_AI', 'SVC_AUTH', 'SVC_PLAYER', 'SVC_ANALYTICS'].filter((k) => Boolean(envRecord[k])),
      },
    });
  }

  // FAZA 12 (miner): miner service status, proxied from the cloud monolith
  // (pool + jobs + per-tenant sources + manifests) with a per-isolate
  // counter. Public read like /edge/status — no secrets in the payload.
  if (path === '/edge/miner/status') {
    edgeMetrics.inc('animaxia_edge_miner_status_checks_total');
    try {
      const upstream = await upstreamFetch({ env, kind: 'cloud', path: '/api/miner/status', method: 'GET' });
      const body = await upstream.text();
      return new Response(body, {
        status: upstream.status,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      });
    } catch (err) {
      return jsonError(502, 'miner_unavailable', `cloud /api/miner/status fetch failed: ${String((err as Error)?.message ?? err)}`);
    }
  }

  if (path === '/edge/metrics') {
    // FAZA 9 ops: per-isolate metrics (Prometheus text or ?format=json).
    if (!requireInternalAuth(request, env)) {
      return jsonError(401, 'unauthorized', 'EDGE_ADMIN_JWT bearer or EDGE_INTERNAL_TOKEN header required.');
    }
    return metricsResponse(url, 'gateway');
  }

  if (path === '/edge/waf/events') {
    if (!requireInternalAuth(request, env)) {
      return jsonError(401, 'unauthorized', 'EDGE_ADMIN_JWT bearer or EDGE_INTERNAL_TOKEN header required.');
    }
    return jsonOk({ ok: true, events: await wafRecent(env, 25) });
  }

  if (path === '/edge/cache/purge' && method === 'POST') {
    if (!requireInternalAuth(request, env)) {
      return jsonError(401, 'unauthorized', 'EDGE_ADMIN_JWT bearer or EDGE_INTERNAL_TOKEN header required.');
    }
    const body = await readJsonBody(request);
    const prefix = typeof body?.prefix === 'string' ? body.prefix : '';
    const deleted = await cachePurgePrefix(env, prefix);
    return jsonOk({ ok: true, prefix, deleted });
  }

  if (path === '/edge/cache/invalidate' && method === 'POST') {
    if (!requireInternalAuth(request, env)) {
      return jsonError(401, 'unauthorized', 'EDGE_ADMIN_JWT bearer or EDGE_INTERNAL_TOKEN header required.');
    }
    const body = await readJsonBody(request);
    const key = typeof body?.key === 'string' ? body.key : '';
    if (!key) return jsonError(400, 'bad_request', 'Body must be { "key": "<cache key>" }.');
    await cacheInvalidate(env, key);
    return jsonOk({ ok: true, key });
  }

  if (path.startsWith('/edge/')) {
    return jsonError(404, 'not_found', `Unknown management endpoint ${method} ${path}.`);
  }

  /* ----------------------------------------------------- module prefixes --- */

  if (path === '/autocomplete' || path === '/search' || path.startsWith('/search/')) {
    return viaService(request, env.SVC_SEARCH, async () => {
      if (method !== 'GET') {
        return jsonError(501, 'edge_search_worker_not_bound', 'Only GET /search and /autocomplete work without the search worker.');
      }
      const target = path === '/autocomplete' ? '/api/search/autocomplete' : '/api/search/advanced';
      return passthrough(request, env, 'cloud', target, st.tenant, st.shard);
    });
  }

  if (path.startsWith('/auth/')) {
    return viaService(request, env.SVC_AUTH, async () => {
      const suffix = path.slice('/auth'.length);
      const passthroughPaths = ['/login', '/register', '/refresh', '/logout', '/me', '/forgot-password', '/reset-password'];
      if ((method !== 'GET' && method !== 'POST') || !passthroughPaths.includes(suffix)) {
        return jsonError(
          501,
          'edge_auth_worker_not_bound',
          `${path} needs the auth worker (JWT verify / anti-replay / device tokens). Plain auth passthrough works only for ${passthroughPaths.join(', ')}.`,
        );
      }
      return passthrough(request, env, 'cloud', `/api/auth${suffix}`, st.tenant, st.shard);
    });
  }

  if (path.startsWith('/player/') || path === '/hls' || path.startsWith('/hls/')) {
    return viaService(request, env.SVC_PLAYER, async () => {
      const sourcesMatch = /^\/player\/sources\/(\d+)$/.exec(path);
      if (sourcesMatch) {
        return passthrough(request, env, 'mobile', `/mobile/player/${sourcesMatch[1]}`, st.tenant, st.shard);
      }
      return jsonError(
        501,
        'edge_player_worker_not_bound',
        `${path} needs the player worker (HLS manifest rewrite + segment caching). R2 objects remain available on /media/*.`,
      );
    });
  }

  if (path.startsWith('/analytics/') || path === '/beacon') {
    return viaService(request, env.SVC_ANALYTICS, async () => {
      const target = path === '/beacon'
        ? '/api/analytics/views'
        : `/api/analytics${path.slice('/analytics'.length)}`;
      return passthrough(request, env, 'cloud', target, st.tenant, st.shard);
    });
  }

  if (path.startsWith('/ai/')) {
    // Heavy tier is applied above. Streaming flows through untouched;
    // SVC_AI owns the answer/embeddings caches.
    return viaService(request, env.SVC_AI, () => passthrough(request, env, 'ai', path, st.tenant, st.shard));
  }

  if (path.startsWith('/vector/')) {
    return passthrough(request, env, 'vector', path, st.tenant, st.shard);
  }

  if (path.startsWith('/mobile/')) {
    return cachedOrPassthrough(request, env, ctx, st, 'mobile');
  }

  if (path.startsWith('/api/')) {
    return cachedOrPassthrough(request, env, ctx, st, 'cloud');
  }

  if (path.startsWith('/media/')) {
    return serveR2Media(request, env, url);
  }

  if (path.startsWith('/ws/')) {
    return proxyWebSocket(request, env, url);
  }

  return jsonError(404, 'not_found', `No edge route for ${method} ${path}.`);
}

/* ============================================================ helpers ===== */

/** Route to a sub-worker service binding, or run the cloud fallback. */
async function viaService(
  request: Request,
  svc: ServiceBindingLike | undefined,
  fallback: () => Promise<Response>,
): Promise<Response> {
  if (svc) return svc.fetch(request);
  return fallback();
}

function isHeavyPath(path: string): boolean {
  return path.startsWith('/ai/') || path.startsWith('/vector/');
}

/* ==================================================== FAZA 22 geo-routing = */

// FAZA 22 — global geo-routing (ORIGIN_REGIONS gate). In-memory regional
// health: a region whose fetch failed is skipped for 30s; any success clears
// the marker. Per-isolate only (each colo tracks its own view) — the
// authoritative cross-region state is the FAZA 22 perimeter (redis-global).
const GEO_UNHEALTHY_TTL_MS = 30_000;
const geoUnhealthyUntil = new Map<EdgeRegion, number>();

function geoRegionHealthy(region: EdgeRegion): boolean {
  const until = geoUnhealthyUntil.get(region);
  return until === undefined || until <= Date.now();
}

function geoMarkUnhealthy(region: EdgeRegion): void {
  geoUnhealthyUntil.set(region, Date.now() + GEO_UNHEALTHY_TTL_MS);
}

function geoMarkHealthy(region: EdgeRegion): void {
  geoUnhealthyUntil.delete(region);
}

/**
 * FAZA 22 — global geo-routing (ORIGIN_REGIONS gate) for cloud-kind fetches.
 *
 * OFF (default — env.ORIGIN_REGIONS unset/invalid, shared/geo.ts returns
 * null): plain upstreamFetch; behavior byte-identical to pre-FAZA-22.
 * ON (valid JSON with eu/us/asia https URLs): pick the upstream via
 * regionForRequest(request.cf) + pickUpstream/failoverChain, tracking
 * per-region health (30s unhealthy TTL, reset on success). A regional
 * 502/503/504 (network-failure envelope or origin 5xx) marks the region
 * unhealthy and retries the next one; when every region fails, the legacy
 * CLOUD_ORIGIN path runs unchanged (existing fallback — its own 502 envelope
 * if that is down too).
 *
 * The regional override is applied by spreading env with CLOUD_ORIGIN set to
 * the regional base — upstreamFetch's retry/timeout/no-store semantics stay
 * exactly the ones the legacy path uses.
 */
async function geoAwareCloudFetch(request: Request, args: UpstreamArgs): Promise<Response> {
  const origins = parseOriginRegions(args.env.ORIGIN_REGIONS);
  if (!origins) return upstreamFetch(args); // gate OFF → default path
  const region = regionForRequest(request.cf);
  let pick = pickUpstream(origins, region, geoRegionHealthy);
  while (pick) {
    const res = await upstreamFetch({ ...args, env: { ...args.env, CLOUD_ORIGIN: pick.upstream } });
    if (res.status === 502 || res.status === 503 || res.status === 504) {
      geoMarkUnhealthy(pick.via); // regional failure → next healthy region in the chain
      pick = pickUpstream(origins, region, geoRegionHealthy);
      continue;
    }
    geoMarkHealthy(pick.via);
    return res;
  }
  return upstreamFetch(args); // all regions failed → legacy fallback path
}

/**
 * Forward a request to an origin with the documented path rewrites
 * (shared/upstream.ts). POST/PUT/DELETE bodies are buffered (≤ 4 MB) so
 * upstreamFetch's retry can replay them. FAZA 11: the resolved tenant slug
 * is always forwarded as x-animaxia-tenant so the origin's resolveTenantOf
 * sees it even when the client never sent the header. FAZA 13: the resolved
 * shard id is forwarded as x-animaxia-shard the same way (a client-sent
 * valid value was already honored during resolution and survives verbatim).
 * FAZA 22: cloud-kind fetches go through geoAwareCloudFetch (a no-op
 * passthrough to upstreamFetch unless env.ORIGIN_REGIONS is configured).
 */
async function passthrough(
  request: Request,
  env: EdgeEnv,
  kind: OriginKind,
  targetPath: string,
  tenant: string = GLOBAL_TENANT,
  shard: number = 0, // FAZA 13
): Promise<Response> {
  const url = new URL(request.url);
  const needsBody = request.method !== 'GET' && request.method !== 'HEAD';
  const body = needsBody ? await request.clone().arrayBuffer().catch(() => null) : null;
  if (needsBody && body === null) {
    return jsonError(413, 'payload_too_large', `The edge buffers bodies up to ${MAX_BODY_BYTES} bytes.`);
  }
  const upstreamArgs: UpstreamArgs = {
    env,
    kind,
    path: targetPath,
    search: url.search,
    method: request.method,
    headers: buildForwardedHeaders(request, { [TENANT_HEADER]: tenant, [SHARD_HEADER]: String(shard) }), // FAZA 13: shard header upstream
    body,
    timeoutMs: kind === 'ai' ? 120_000 : 15_000, // LLM endpoints may stream slowly
  };
  // FAZA 22 — global geo-routing (ORIGIN_REGIONS gate): cloud-kind only.
  return kind === 'cloud' ? geoAwareCloudFetch(request, upstreamArgs) : upstreamFetch(upstreamArgs);
}

/**
 * Cached public GET (config-driven prefixes, never for authorized requests)
 * with SWR + stale-if-error; everything else passes through.
 */
async function cachedOrPassthrough(
  request: Request,
  env: EdgeEnv,
  ctx: EdgeCtx,
  st: GatewayState,
  kind: OriginKind,
): Promise<Response> {
  const { url, cfg } = st;
  const path = url.pathname;
  const cacheable =
    request.method === 'GET'
    && !isAuthorized(request)
    && matchesPrefix(path, cfg.edge.cacheablePrefixes)
    && !matchesPrefix(path, cfg.edge.bypassPrefixes);

  if (!cacheable) {
    return passthrough(request, env, kind, path, st.tenant, st.shard);
  }

  const opts: CacheOptions = {
    ttlSec: cfg.edge.cacheTtlSec,
    swrSec: cfg.edge.swrSec,
    staleIfErrorSec: cfg.edge.staleIfErrorSec,
  };
  return cachedJsonFetch({
    env,
    ctx,
    // FAZA 11: per-tenant cache isolation ('' for global → legacy keys).
    // FAZA 13: shard segment right after the tenant prefix — global legacy
    // 'api:/api/all' becomes 's0:api:/api/all', tenant 't:acme:s3:api:/x'.
    // FAZA 22: the key stays region-agnostic on purpose — public GET bodies
    // are identical regardless of which regional origin filled the entry.
    key: `${tenantKeyPrefix(st.tenant)}${shardKeySegment(st.shard)}${kind === 'cloud' ? 'api' : kind}:${path}${url.search}`,
    fetchUpstream: () => {
      const upstreamArgs: UpstreamArgs = {
        env,
        kind,
        path,
        search: url.search,
        method: 'GET',
        headers: buildForwardedHeaders(request, { [TENANT_HEADER]: st.tenant, [SHARD_HEADER]: String(st.shard) }), // FAZA 13: shard header upstream
      };
      // FAZA 22 — global geo-routing (ORIGIN_REGIONS gate) on cloud fills.
      return kind === 'cloud' ? geoAwareCloudFetch(request, upstreamArgs) : upstreamFetch(upstreamArgs);
    },
    opts,
    cacheApi: edgeCacheApi(),
  });
}

/** Boundary-aware prefix match ('/api/tv' matches '/api/tv' and '/api/tv/5'). */
function matchesPrefix(path: string, prefixes: string[]): boolean {
  return prefixes.some((p) => path === p || path.startsWith(p.endsWith('/') ? p : `${p}/`));
}

/**
 * Final response decoration: hardening headers → x-request-id + rate trio →
 * CORS. Applied to everything except 101 WebSocket handshakes.
 */
function decorate(
  res: Response,
  request: Request,
  requestId: string,
  rate: RateResult | null,
  extra: Record<string, string> = {},
): Response {
  const secured = withSecurityHeaders(res);
  const headers = new Headers(secured.headers);
  headers.set('x-request-id', requestId);
  if (rate) {
    for (const [k, v] of Object.entries(rateLimitHeaders(rate))) headers.set(k, v);
  }
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  const rebuilt = new Response(secured.body, { status: secured.status, statusText: secured.statusText, headers });
  return withCors(rebuilt, request);
}
