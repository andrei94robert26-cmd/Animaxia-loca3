/**
 * index.ts — animaxia-global-gateway (FAZA 22).
 *
 * Multi-region routing + distributed perimeter layers (anti-spam, rate-limit,
 * cooldown, cache) backed by Redis — the LOCAL RUNNABLE equivalent of the
 * production Cloudflare edge geo-routing (animaxia-edge workers) and the
 * global Redis (Upstash / Redis Cloud, see animaxia-cloud/domain/redis).
 *
 * The protected backend (FAZA 18 pipeline, FAZA 20 hubs, FAZA 21 features,
 * Neon FTS engine, 30B logical simulation, FAZA 13 sharding, FAZA 17 player,
 * AI Hub/Home) is NEVER modified — this gateway only fronts it.
 *
 * Routes:
 *   GET  /                                topology + layer description
 *   GET  /api/infra/health                liveness { ok, service, redisMode }
 *   GET  /api/infra/status                regions + health + cache + counters
 *   POST /api/infra/cache/purge           { prefix? } -> { purged }
 *   POST /api/infra/regions/:name/down    admin health override (failover tests)
 *   POST /api/infra/regions/:name/up
 *   *    (everything else)                proxied through the region chain
 *
 * Region selection: x-animaxia-region header or ?region= (eu|us|asia),
 * default eu. Failover chain: requested region -> other regions in order.
 */

import http from 'node:http';
import { RedisGateway } from './redis-client';
import { RegionTable, REGION_CHAIN, REGION_LABELS, type RegionName } from './regions';
import { PerimeterLayers, CLASS_LIMITS, CACHE_TTL_SEC } from './layers';

const PORT = 4040;
const UPSTREAM_TIMEOUT_MS = 15_000;
/* NEON FREE PLAN: liveness upstream la 60s (fost 5s) — sondele lovesc
 * /api/health (acum cache piggyback, zero Neon) și redis local; 60s e
 * suficient pentru failover, fără trafic continuu inutil. */
const HEALTH_INTERVAL_MS = 60_000;
const HEALTH_TIMEOUT_MS = 2_000;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_CACHEABLE_BYTES = 256 * 1024;
const TRUST_XFF = process.env.TRUST_XFF === '1';

const redis = new RedisGateway();
const table = new RegionTable();
const layers = new PerimeterLayers(redis);
const startedAt = Date.now();

/* ------------- FAZA 23 (observability): additive counters + OTLP span push -------------
 * Pure observation — no proxy/perimeter logic is changed. Failures are silent
 * (observability must never affect traffic). Env: OTEL_ENABLED (default on),
 * OTEL_EXPORTER_ENDPOINT (default http://localhost:4050 — the global collector
 * built in FAZA 23). Spans: 'gateway.proxy' {region, upstream, status,
 * durationMs, fallback, cache}; service.name=animaxia-gateway; traceId derived
 * from the x-request-id already generated per request. Batched every 3s,
 * fire-and-forget fetch with silent .catch, interval unref'd. */

const OTEL_ENABLED = (process.env.OTEL_ENABLED ?? '1') !== '0';
const OTEL_ENDPOINT = (process.env.OTEL_EXPORTER_ENDPOINT || 'http://localhost:4050').replace(/\/+$/, '');
const OTEL_FLUSH_MS = 3_000;
const OTEL_BATCH = 64;
const OTEL_QUEUE_LIMIT = 500;
const OTEL_TIMEOUT_MS = 2_000;

interface GwSpan {
  traceId: string;
  spanId: string;
  name: string;
  startMs: number;
  endMs: number;
  status: number;
  attributes: Record<string, string | number | boolean>;
}

const gwObs = {
  requests: new Map<string, number>(), // `${region}|${cache}` -> n (hit|miss|bypass)
  failovers: new Map<string, number>(), // `${from}|${to}` -> n
  upstreamErrors: new Map<string, number>(), // region -> n
  spansExported: 0,
  exportErrors: 0,
  spansDropped: 0,
  queue: [] as GwSpan[],
  flushing: false,
};

function gwBump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/** requests_total{region,cache} — called where the outcome is already known. */
function gwRequest(cache: 'hit' | 'miss' | 'bypass', region: string): void {
  try {
    gwBump(gwObs.requests, `${region}|${cache}`);
  } catch { /* silent */ }
}

/** Enqueue an OTLP span (bounded queue, drop-oldest-half amortized). */
function gwSpan(
  name: string,
  startMs: number,
  status: number,
  attrs: Record<string, string | number | boolean>,
  traceId: string,
): void {
  try {
    if (!OTEL_ENABLED) return;
    if (gwObs.queue.length >= OTEL_QUEUE_LIMIT) {
      const drop = OTEL_QUEUE_LIMIT >> 1;
      gwObs.queue.splice(0, drop);
      gwObs.spansDropped += drop;
    }
    gwObs.queue.push({
      traceId,
      spanId: crypto.randomUUID().replace(/-/g, '').slice(0, 16),
      name,
      startMs,
      endMs: Date.now(),
      status,
      attributes: attrs,
    });
  } catch { /* silent */ }
}

/** Flush ≤64 spans as canonical OTLP JSON — silent on any failure. */
async function gwFlushSpans(): Promise<void> {
  if (gwObs.flushing || gwObs.queue.length === 0) return;
  gwObs.flushing = true;
  const batch = gwObs.queue.splice(0, OTEL_BATCH);
  try {
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), OTEL_TIMEOUT_MS);
    const res = await fetch(`${OTEL_ENDPOINT}/v1/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        resourceSpans: [
          {
            resource: { attributes: [{ key: 'service.name', value: { stringValue: 'animaxia-gateway' } }] },
            scopeSpans: [
              {
                scope: { name: 'animaxia-gateway-observability', version: '1.0.0' },
                spans: batch.map((s) => ({
                  traceId: s.traceId,
                  spanId: s.spanId,
                  name: s.name,
                  kind: 1,
                  startTimeUnixNano: String(BigInt(Math.max(0, Math.trunc(s.startMs))) * 1000000n),
                  endTimeUnixNano: String(BigInt(Math.max(0, Math.trunc(s.endMs))) * 1000000n),
                  status: { code: s.status >= 500 ? 2 : 1 },
                  attributes: Object.entries(s.attributes).map(([key, v]) => ({
                    key,
                    value: typeof v === 'number' ? { intValue: v } : { stringValue: String(v) },
                  })),
                })),
              },
            ],
          },
        ],
      }),
      signal: ac.signal,
    });
    clearTimeout(to);
    if (res.ok) gwObs.spansExported += batch.length;
    else {
      gwObs.exportErrors++;
      gwObs.spansDropped += batch.length;
    }
  } catch {
    gwObs.exportErrors++;
    gwObs.spansDropped += batch.length;
  } finally {
    gwObs.flushing = false;
  }
}

if (OTEL_ENABLED) {
  const otelTimer = setInterval(() => {
    void gwFlushSpans();
  }, OTEL_FLUSH_MS);
  if (typeof otelTimer.unref === 'function') otelTimer.unref();
}

function gwEsc(v: string | number): string {
  return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** Prometheus text for GET /metrics (FAZA 23). */
function renderGatewayMetrics(): string {
  const L: string[] = [];
  const push = (s: string) => L.push(s);

  push('# TYPE animaxia_gateway_requests_total counter');
  for (const [key, n] of gwObs.requests) {
    const [region, cache] = key.split('|');
    push(`animaxia_gateway_requests_total{region="${gwEsc(region)}",cache="${gwEsc(cache)}"} ${n}`);
  }
  push('# TYPE animaxia_gateway_failovers_total counter');
  for (const [key, n] of gwObs.failovers) {
    const [from, to] = key.split('|');
    push(`animaxia_gateway_failovers_total{from="${gwEsc(from)}",to="${gwEsc(to)}"} ${n}`);
  }
  push('# TYPE animaxia_gateway_upstream_errors_total counter');
  for (const [region, n] of gwObs.upstreamErrors) {
    push(`animaxia_gateway_upstream_errors_total{region="${gwEsc(region)}"} ${n}`);
  }
  push('# TYPE animaxia_gateway_ratelimited_total counter');
  push(`animaxia_gateway_ratelimited_total ${layers.stats.rateLimited}`);
  push('# TYPE animaxia_gateway_antispam_total counter');
  push(`animaxia_gateway_antispam_total ${layers.stats.spamBlocked}`);
  push('# TYPE animaxia_gateway_cooldown_total counter');
  push(`animaxia_gateway_cooldown_total ${layers.stats.cooldownActive}`);
  push('# TYPE animaxia_gateway_cache_hits_total counter');
  push(`animaxia_gateway_cache_hits_total ${layers.stats.cacheHits}`);
  push('# TYPE animaxia_gateway_cache_misses_total counter');
  push(`animaxia_gateway_cache_misses_total ${layers.stats.cacheMisses}`);
  push('# TYPE animaxia_gateway_cache_bypasses_total counter');
  push(`animaxia_gateway_cache_bypasses_total ${layers.stats.cacheBypasses}`);
  push('# TYPE animaxia_gateway_failovers_all_total counter');
  push(`animaxia_gateway_failovers_all_total ${layers.stats.failovers}`);
  push('# TYPE animaxia_gateway_upstreams_healthy gauge');
  for (const r of REGION_CHAIN) {
    const healthy = table.regions[r].filter((u) => table.isHealthy(r, u)).length;
    push(`animaxia_gateway_upstreams_healthy{region="${r}"} ${healthy}`);
  }
  push('# TYPE animaxia_gateway_uptime_seconds gauge');
  push(`animaxia_gateway_uptime_seconds ${Math.round((Date.now() - startedAt) / 1000)}`);
  push('# TYPE animaxia_gateway_redis_mode gauge');
  push(`animaxia_gateway_redis_mode{mode="${gwEsc(redis.mode())}"} 1`);
  push('# TYPE animaxia_gateway_otel_spans_exported_total counter');
  push(`animaxia_gateway_otel_spans_exported_total ${gwObs.spansExported}`);
  push('# TYPE animaxia_gateway_otel_export_errors_total counter');
  push(`animaxia_gateway_otel_export_errors_total ${gwObs.exportErrors}`);
  push('# TYPE animaxia_gateway_otel_spans_dropped_total counter');
  push(`animaxia_gateway_otel_spans_dropped_total ${gwObs.spansDropped}`);
  push('# TYPE animaxia_gateway_otel_enabled gauge');
  push(`animaxia_gateway_otel_enabled ${OTEL_ENABLED ? 1 : 0}`);

  return `${L.join('\n')}\n`;
}
/* ------------------------- end FAZA 23 (observability) ------------------------- */

/* ------------------------------------------------------- upstream health --- */

async function checkUpstream(url: string): Promise<void> {
  const s = table.upstreams.get(url);
  if (!s) return;
  const t0 = Date.now();
  try {
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), HEALTH_TIMEOUT_MS);
    const res = await fetch(`${url}/api/health`, { signal: ac.signal });
    clearTimeout(to);
    s.healthy = res.ok;
    s.lastError = res.ok ? null : `HTTP ${res.status}`;
    s.latencyMs = Date.now() - t0;
    s.lastCheck = Date.now();
  } catch (e) {
    s.healthy = false;
    s.lastError = (e as Error).message;
    s.latencyMs = null;
    s.lastCheck = Date.now();
  }
}

for (const u of table.upstreams.keys()) void checkUpstream(u);
setInterval(() => {
  for (const u of table.upstreams.keys()) void checkUpstream(u);
}, HEALTH_INTERVAL_MS);

/* ------------------------------------------------------------- helpers --- */

function clientIpOf(req: http.IncomingMessage): string {
  if (TRUST_XFF) {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.length) return xff.split(',')[0].trim();
  }
  return req.socket.remoteAddress ?? 'unknown';
}

function baseHeaders(requestId: string, region?: RegionName, upstream?: string, fallback?: boolean): Record<string, string> {
  const h: Record<string, string> = {
    'x-request-id': requestId,
    'x-animaxia-redis': redis.mode(),
  };
  if (region) h['x-animaxia-region'] = region;
  if (upstream) h['x-animaxia-upstream'] = upstream;
  if (fallback) h['x-animaxia-fallback'] = 'true';
  return h;
}

function sendJson(res: http.ServerResponse, status: number, obj: unknown, extra?: Record<string, string>): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...(extra ?? {}) });
  res.end(JSON.stringify(obj));
}

function parseRegion(req: http.IncomingMessage, url: URL): RegionName | null {
  const fromHeader = req.headers['x-animaxia-region'];
  let r: string | undefined;
  if (typeof fromHeader === 'string' && fromHeader.length) r = fromHeader;
  else r = url.searchParams.get('region') ?? undefined;
  if (!r) return 'eu';
  if (!(REGION_CHAIN as string[]).includes(r)) return null;
  return r as RegionName;
}

async function readBody(req: http.IncomingMessage): Promise<string | null> {
  if (req.method === 'GET' || req.method === 'HEAD') return null;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error('payload_too_large');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/* -------------------------------------------------------------- proxying --- */

const HOP_BY_HOP = ['host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'content-length', 'x-forwarded-for'];
const STRIP_RESPONSE = ['content-encoding', 'transfer-encoding', 'content-length', 'connection', 'keep-alive'];

async function proxy(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  region: RegionName,
  ip: string,
  body: string | null,
  requestId: string,
  cacheKey: string | null,
): Promise<void> {
  const start = Date.now();

  // the backend must never see our own routing params
  const outUrl = new URL(url.toString());
  outUrl.searchParams.delete('region');
  outUrl.searchParams.delete('XTransformPort');

  const cands = table.candidates(region);
  if (!cands.length) {
    sendJson(res, 502, { error: 'all_regions_down', requestId }, baseHeaders(requestId));
    return;
  }

  for (const c of cands) {
    const target = new URL(outUrl.pathname + outUrl.search, c.upstream).toString();
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), UPSTREAM_TIMEOUT_MS);
    try {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (HOP_BY_HOP.includes(k)) continue;
        if (typeof v === 'string') headers[k] = v;
      }
      headers['x-forwarded-for'] = ip;
      const init: RequestInit = { method: req.method, headers, signal: ac.signal };
      if (body !== null && req.method !== 'GET' && req.method !== 'HEAD') init.body = body;

      const upRes = await fetch(target, init);
      const buf = Buffer.from(await upRes.arrayBuffer());
      clearTimeout(to);

      const respHeaders: Record<string, string> = {};
      upRes.headers.forEach((v, k) => {
        if (!STRIP_RESPONSE.includes(k)) respHeaders[k] = v;
      });

      // cache store (MISS path) — only clean 200s under the size cap
      if (cacheKey && upRes.status === 200 && buf.length <= MAX_CACHEABLE_BYTES) {
        await layers.cachePut(cacheKey, {
          status: 200,
          contentType: upRes.headers.get('content-type') ?? 'application/json',
          body: buf.toString('utf8'),
          storedAt: Date.now(),
        });
      }

      layers.stats.perRegion[c.region] = (layers.stats.perRegion[c.region] ?? 0) + 1;
      /* FAZA 23 (observability): requests_total{region,cache} + 'gateway.proxy' span. */
      gwRequest(cacheKey ? 'miss' : 'bypass', c.region);
      gwSpan(
        'gateway.proxy',
        start,
        upRes.status,
        {
          region: c.region,
          upstream: c.upstream,
          status: upRes.status,
          durationMs: Date.now() - start,
          fallback: c.fallback,
          cache: cacheKey ? 'miss' : 'bypass',
        },
        requestId.replace(/-/g, ''),
      );
      res.writeHead(upRes.status, {
        ...respHeaders,
        ...baseHeaders(requestId, c.region, c.upstream, c.fallback),
        'x-cache': cacheKey ? 'MISS' : 'BYPASS',
      });
      res.end(buf);
      console.log(
        `${req.method} ${url.pathname}${url.search} region=${c.region} upstream=${c.upstream} ` +
        `status=${upRes.status} ${Date.now() - start}ms ${cacheKey ? 'MISS' : 'BYPASS'}`,
      );
      return;
    } catch (e) {
      clearTimeout(to);
      table.markUnhealthy(c.upstream, (e as Error).message);
      layers.stats.failovers++;
      /* FAZA 23 (observability): upstream error + failover {from,to} bookkeeping. */
      gwBump(gwObs.upstreamErrors, c.region);
      const nextCand = cands[cands.indexOf(c) + 1];
      if (nextCand) gwBump(gwObs.failovers, `${c.region}|${nextCand.region}`);
      console.warn(`[gateway] upstream ${c.upstream} failed (${(e as Error).message}) — failing over`);
    }
  }

  sendJson(res, 502, { error: 'all_regions_down', requestId }, baseHeaders(requestId));
}

/* ---------------------------------------------------------------- server --- */

const server = http.createServer((req, res) => {
  void handle(req, res).catch((e) => {
    console.error('[gateway] handler error:', e);
    if (!res.headersSent) sendJson(res, 500, { error: 'gateway_internal_error' });
    else res.destroy();
  });
});

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  const requestId = crypto.randomUUID();
  const ip = clientIpOf(req);
  layers.stats.requests++;
  const gwStart = Date.now(); // FAZA 23 (observability): request clock for gateway spans
  const gwTraceId = requestId.replace(/-/g, ''); // FAZA 23: 32-hex trace id derived from x-request-id

  /* ---- local infra routes (never proxied) ---- */

  if (url.pathname === '/' && req.method === 'GET') {
    return sendJson(res, 200, {
      service: 'animaxia-global-gateway',
      faza: 22,
      regions: REGION_CHAIN.map((r) => ({ name: r, label: REGION_LABELS[r], upstreams: table.regions[r] })),
      layers: ['anti-spam', 'cooldown', 'rate-limit', 'cache'],
      redisMode: redis.mode(),
      trustXff: TRUST_XFF,
      note:
        'Local runnable equivalent of the production Cloudflare edge geo-routing. ' +
        'The protected backend (FAZA 18/20/21, Neon FTS, 30B logical) is never modified.',
    });
  }

  if (url.pathname === '/api/infra/health') {
    return sendJson(res, 200, { ok: true, service: 'global-gateway', redisMode: redis.mode() });
  }

  /* FAZA 23 (observability): Prometheus text — gateway counters + gauges (local, never proxied). */
  if (url.pathname === '/metrics' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
    res.end(renderGatewayMetrics());
    return;
  }

  if (url.pathname === '/api/infra/status' && req.method === 'GET') {
    const total = layers.stats.cacheHits + layers.stats.cacheMisses;
    return sendJson(res, 200, {
      ok: true,
      service: 'animaxia-global-gateway',
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      redisMode: redis.mode(),
      regions: REGION_CHAIN.map((r) => ({
        name: r,
        label: REGION_LABELS[r],
        upstreams: table.regions[r].map((u) => ({
          url: u,
          ...table.upstreams.get(u),
          forcedDown: table.overrides.get(`${r}|${u}`) === false,
        })),
      })),
      layers: {
        order: ['anti-spam', 'cooldown', 'rate-limit', 'cache'],
        limits: CLASS_LIMITS,
        cacheTtlSec: CACHE_TTL_SEC,
      },
      cache: {
        hits: layers.stats.cacheHits,
        misses: layers.stats.cacheMisses,
        bypasses: layers.stats.cacheBypasses,
        hitRate: total ? layers.stats.cacheHits / total : 0,
      },
      counters: { ...layers.stats, perRegion: { ...layers.stats.perRegion } },
    });
  }

  if (url.pathname === '/api/infra/cache/purge' && req.method === 'POST') {
    const body = await readBody(req).catch(() => null);
    let prefix = 'cache:';
    try {
      const j = JSON.parse(body ?? '{}') as { prefix?: string };
      if (typeof j.prefix === 'string' && j.prefix.length) prefix = j.prefix;
    } catch { /* default prefix */ }
    const purged = await layers.cachePurge(prefix);
    return sendJson(res, 200, { ok: true, purged, prefix });
  }

  const regionAdmin = url.pathname.match(/^\/api\/infra\/regions\/(eu|us|asia)\/(down|up)$/);
  if (regionAdmin && req.method === 'POST') {
    const r = regionAdmin[1] as RegionName;
    const down = regionAdmin[2] === 'down';
    table.setOverride(r, down);
    return sendJson(res, 200, {
      ok: true,
      region: r,
      action: regionAdmin[2],
      upstreams: table.regions[r].map((u) => ({ url: u, forcedDown: table.overrides.get(`${r}|${u}`) === false })),
    });
  }

  if (url.pathname.startsWith('/api/infra/')) {
    return sendJson(res, 404, { error: 'unknown_infra_route' }, baseHeaders(requestId));
  }

  /* ---- perimeter layers (defense-in-depth; FAZA 18 inside stays the authority) ---- */

  const region = parseRegion(req, url);
  if (!region) {
    return sendJson(res, 400, { error: 'invalid_region', allowed: REGION_CHAIN }, baseHeaders(requestId));
  }

  let body: string | null = null;
  try {
    body = await readBody(req);
  } catch {
    return sendJson(res, 413, { error: 'payload_too_large' }, baseHeaders(requestId));
  }

  // 1. anti-spam
  const spam = await layers.antiSpam(ip, req.method ?? 'GET', url.pathname, url.search, body);
  if (!spam.ok) {
    return sendJson(res, spam.status ?? 429, { error: spam.error, retryAfter: spam.retryAfter, layer: 'anti-spam' }, {
      'retry-after': String(spam.retryAfter ?? 30),
      ...baseHeaders(requestId),
    });
  }

  // 2. cooldown (checked before the limiter so locked clients short-circuit)
  const cd = await layers.cooldown(ip);
  if (!cd.ok) {
    return sendJson(res, cd.status ?? 429, { error: cd.error, retryAfter: cd.retryAfter, layer: 'cooldown' }, {
      'retry-after': String(cd.retryAfter ?? 60),
      ...baseHeaders(requestId),
    });
  }

  // 3. rate-limit (fixed window, distributed in Redis)
  const rl = await layers.rateLimit(ip, url.pathname);
  if (!rl.ok) {
    return sendJson(
      res,
      rl.status ?? 429,
      { error: rl.error, retryAfter: rl.retryAfter, layer: 'rate-limit', limit: CLASS_LIMITS[PerimeterLayers.routeClass(url.pathname)].limit },
      { 'retry-after': String(rl.retryAfter ?? 60), ...(rl.headers ?? {}), ...baseHeaders(requestId) },
    );
  }

  // 4. cache (public GET reads on /api/search/* and /api/hub/*)
  const cacheable = PerimeterLayers.cacheable(req.method ?? 'GET', url.pathname, Boolean(req.headers['authorization']));
  const key = cacheable ? PerimeterLayers.cacheKey(url.pathname, url.searchParams) : null;
  if (key) {
    const cached = await layers.cacheGet(key);
    if (cached) {
      res.writeHead(cached.status, {
        'content-type': cached.contentType,
        'x-cache': 'HIT',
        ...baseHeaders(requestId, region),
      });
      res.end(cached.body);
      console.log(`${req.method} ${url.pathname}${url.search} region=${region} cache=HIT`);
      /* FAZA 23 (observability): cache HIT counter + span (no upstream — served from cache). */
      gwRequest('hit', region);
      gwSpan(
        'gateway.proxy',
        gwStart,
        cached.status,
        { region, upstream: 'cache', status: cached.status, durationMs: Date.now() - gwStart, fallback: false, cache: 'hit' },
        gwTraceId,
      );
      return;
    }
  } else {
    layers.stats.cacheBypasses++;
  }

  await proxy(req, res, url, region, ip, body, requestId, key);
}

server.listen(PORT, () => {
  console.log(
    `global-gateway — multi-region routing (production: Cloudflare Workers geo-routing) ` +
    `listening on :${PORT}, redis=${redis.mode()}, trustXff=${TRUST_XFF}`,
  );
});
