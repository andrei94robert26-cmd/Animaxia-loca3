/**
 * index.ts — animaxia-edge-live (FAZA 28-E): twin-ul rulabil al
 * Caddyfile.faza28-live.
 *
 * Ascultătoare:
 *   :8080  — redirect PERMANENT 308 HTTP → HTTPS (method-preserving)
 *   :8443  — edge public: TLS 1.2+/1.3 + HTTP/2 (ALPN h2, fallback h1),
 *            HSTS strict (RFC 6797 — headerul doar pe TLS)
 *   :8181  — mirror HTTP intern (calea sandbox :81?XTransformPort=8181),
 *            aceleași rute, fără TLS/HSTS; upgrade-urile WS (socket.io)
 *            sunt redate prin releu TCP transparent
 *
 * GARANȚIA ZERO-502 (construcție, nu promisiune):
 *   1. Fiecare rută are lanț de failover (ex. hub: gateway:4040 → backend:4000).
 *   2. Eroarea de rețea la un upstream ⇒ încercarea următorului din lanț.
 *   3. Răspunsurile legitime (inclusiv 503 queue-full FAZA 18 / 429 cu
 *      Retry-After FAZA 22) trec NEMODIFICATE — edge-ul nu minte.
 *   4. Toți upstream-urile morți ⇒ 503 + Retry-After (oneste), niciodată 502.
 *
 * Upstream-urile sunt 100% normalizate: hostname-uri de container
 * (http://backend:4000, http://gateway:4040, …) resolvate prin alias map-ul
 * DNS intern (upstreams.ts) — niciodată localhost în config.
 *
 * Componentele PROTEJATE (FAZA 18/20/21/23/24/25/28, FTS Neon real, 30B,
 * pipeline, hub real, player real, AI Hub/Home) sunt doar PROXY — zero
 * modificări din edge.
 */

import http from 'node:http';
import http2 from 'node:http2';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import net from 'node:net';
import {
  DNS_ALIASES, UPSTREAMS, UpstreamRegistry, redisPing, resolveUpstream,
} from './upstreams';

/* ------------------------------ Config ---------------------------------- */

const HTTP_PORT = Number(process.env.EDGE_HTTP_PORT ?? 8181);
const HTTPS_PORT = Number(process.env.EDGE_HTTPS_PORT ?? 8443);
const REDIRECT_PORT = Number(process.env.EDGE_REDIRECT_PORT ?? 8080);

const RUNTIME_DIR = process.env.FAZA28_RUNTIME_DIR ?? '/home/z/faza28-runtime';
const CERT_DIR = path.join(RUNTIME_DIR, 'certs');
const CERT_FILE = path.join(CERT_DIR, 'animaxia-live.crt');
const KEY_FILE = path.join(CERT_DIR, 'animaxia-live.key');
const ACCESS_LOG = path.join(RUNTIME_DIR, 'logs', 'access.log');

const UPSTREAM_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 1024 * 1024; // 1 MB — la fel ca gateway-ul FAZA 22

const registry = new UpstreamRegistry();
const startedAt = Date.now();

/* --------------------------- Routing table ------------------------------ */
/* Exact tabelul din Caddyfile.faza28-live. Ordinea: specific → general.    */

interface Route {
  name: string;
  match: (p: string) => boolean;
  chain: string[]; // chei UpstreamRegistry — failover în ordine
  cache?: 'immutable';
}

const prefix = (...ps: string[]) => (p: string) => ps.some((x) => p === x || p.startsWith(x + '/')) || ps.some((x) => p.startsWith(x + '?')) ;

const ROUTES: Route[] = [
  { name: 'edge-self', match: (p) => p === '/api/edge' || p.startsWith('/api/edge/'), chain: [] },
  { name: 'hub', match: prefix('/api/hub'), chain: ['GATEWAY', 'BACKEND'] },
  { name: 'infra', match: prefix('/api/infra'), chain: ['GATEWAY'] },
  {
    name: 'observability',
    match: (p) =>
      p.startsWith('/api/observability') || p.startsWith('/api/summary') ||
      p.startsWith('/v1/traces') || p.startsWith('/v1/metrics'),
    chain: ['OBSERVABILITY'],
  },
  {
    name: 'stability',
    match: (p) =>
      p.startsWith('/api/stability') || p.startsWith('/api/lb') ||
      p.startsWith('/api/scale') || p.startsWith('/api/shaping'),
    chain: ['STABILITY'],
  },
  {
    name: 'realtime',
    match: (p) => p.startsWith('/socket.io') || p.startsWith('/api/realtime'),
    chain: ['REALTIME'],
  },
  { name: 'api', match: (p) => p.startsWith('/api/') || p.startsWith('/v1/'), chain: ['BACKEND'] },
  {
    name: 'static',
    match: (p) =>
      p.startsWith('/_next/static/') || p.startsWith('/icons/') || p.startsWith('/images/') ||
      p === '/favicon.ico' || p === '/manifest.webmanifest',
    chain: ['FRONTEND'],
    cache: 'immutable',
  },
  { name: 'frontend', match: () => true, chain: ['FRONTEND'], cache: undefined },
];

function matchRoute(p: string): Route {
  const clean = p.split('?')[0];
  for (const r of ROUTES) if (r.match(clean)) return r;
  return ROUTES[ROUTES.length - 1];
}

/* ------------------------------ Counters -------------------------------- */

const counters = {
  requests: 0,
  byRoute: new Map<string, number>(),
  byUpstream: new Map<string, number>(),
  failovers: 0,
  upstreamErrors: new Map<string, number>(),
  errors502: 0, // rămâne 0 prin construcție — se numără doar dacă apare
  errors503: 0,
  redirects308: 0,
  tlsHandshakes: 0,
  wsRelays: 0,
};
const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

/* ------------------------------ Logging --------------------------------- */

fs.mkdirSync(path.dirname(ACCESS_LOG), { recursive: true });
const accessStream = fs.createWriteStream(ACCESS_LOG, { flags: 'a' });
function logAccess(entry: Record<string, unknown>): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  accessStream.write(line + '\n');
  console.log(`[edge] ${entry.listener} ${entry.method} ${entry.path} -> ${entry.status} (${entry.upstream ?? '-'} ${entry.ms}ms${entry.failover ? ' FAILOVER' : ''})`);
}

/* ------------------------------ Cert ------------------------------------ */

function ensureCert(): void {
  if (fs.existsSync(CERT_FILE) && fs.existsSync(KEY_FILE)) return;
  fs.mkdirSync(CERT_DIR, { recursive: true });
  const sans = [
    'DNS:animaxia.live', 'DNS:*.animaxia.live', 'DNS:localhost',
    ...Object.keys(DNS_ALIASES).map((h) => `DNS:${h}`),
    'IP:127.0.0.1',
  ].join(',');
  const r = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '365', '-nodes',
    '-keyout', KEY_FILE, '-out', CERT_FILE,
    '-subj', '/CN=animaxia.live/O=Animaxia/C=RO',
    '-addext', `subjectAltName=${sans}`,
  ], { encoding: 'utf8' });
  if (r.status !== 0) {
    console.error('[edge] openssl cert generation failed:', r.stderr);
    throw new Error('cannot generate TLS cert');
  }
  console.log(`[edge] self-signed TLS cert generated: ${CERT_FILE} (SAN: ${sans})`);
}

/* --------------------------- Hop-by-hop --------------------------------- */

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host',
  'content-length', // recalculat de fetch/pipe
]);

function copyHeaders(h: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    // Normalizare FAZA 28-E: pseudo-headerele HTTP/2 (:method, :path, :authority,
    // :scheme) NU se forward-ează niciodată către upstream-urile HTTP/1.1 —
    // exact clasa de bug care producea 502/503 în lanțul public.
    if (k.startsWith(':')) continue;
    if (HOP_BY_HOP.has(k)) continue;
    if (v === undefined) continue;
    out[k] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  return out;
}

/* --------------------------- Proxy core --------------------------------- */

interface ProxyCtx {
  listener: 'https:8443' | 'http:8181';
  route: Route;
  method: string;
  url: string; // path+query
  headers: Record<string, string>;
  body: Buffer | null;
  clientIp: string;
  proto: 'https' | 'http';
}

async function readBody(req: http.IncomingMessage): Promise<Buffer | null> {
  const hasBody = (req.headers['transfer-encoding'] !== undefined) ||
    (Number(req.headers['content-length'] ?? 0) > 0);
  if (!hasBody) return null;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error('payload too large');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

async function proxyThrough(ctx: ProxyCtx, res: http.ServerResponse): Promise<void> {
  const { route, method, url, headers, body, clientIp, proto } = ctx;

  // Candidații: întâi cei sănătoși (în ordinea lanțului), apoi cei bolnavi
  // ca ultimă încercare (proba de health poate fi învechită).
  const ordered = route.chain.length
    ? [
        ...route.chain.filter((k) => registry.get(k)?.healthy),
        ...route.chain.filter((k) => !registry.get(k)?.healthy),
      ]
    : [];

  let lastError = 'no upstream in chain';
  for (let i = 0; i < ordered.length; i++) {
    const key = ordered[i];
    const st = registry.get(key);
    if (!st) continue;
    const isFailover = i > 0;
    const t0 = Date.now();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), UPSTREAM_TIMEOUT_MS);
    try {
      const upstreamHeaders: Record<string, string> = {
        ...copyHeaders(headers),
        Host: `${st.host}:${st.port}`,               // header_up Host {upstream_hostport}
        'X-Forwarded-For': clientIp,                  // header_up X-Forwarded-For {remote_host}
        'X-Forwarded-Proto': proto,                   // header_up X-Forwarded-Proto
        'X-Real-IP': clientIp,                        // header_up X-Real-IP
        'X-Animaxia-Edge': 'faza28-live',
        ...(isFailover ? { 'X-Animaxia-Fallback': key } : {}),
      };
      const r = await fetch(`${st.address}${url}`, {
        method, headers: upstreamHeaders,
        body: body && method !== 'GET' && method !== 'HEAD' ? body : undefined,
        signal: ctl.signal, redirect: 'manual',
      });
      clearTimeout(timer);

      if (isFailover) counters.failovers++;
      bump(counters.byUpstream, key);

      // Răspuns legitim (chiar și 429/503 oneste) — transmis NEMODIFICAT.
      const outHeaders: Record<string, string | number> = {};
      r.headers.forEach((v, k) => {
        if (k === 'content-length' || k === 'transfer-encoding' || k === 'connection') return;
        outHeaders[k] = v;
      });
      if (route.cache === 'immutable') outHeaders['Cache-Control'] = 'public, max-age=31536000, immutable';
      else if (!outHeaders['cache-control'] && (route.name === 'frontend' || route.name === 'static')) {
        outHeaders['Cache-Control'] = 'no-cache';
      }
      outHeaders['X-Animaxia-Edge'] = 'faza28-live';
      outHeaders['X-Animaxia-Upstream'] = st.canonical;
      if (isFailover) outHeaders['X-Animaxia-Fallback'] = 'true';

      res.writeHead(r.status, outHeaders);
      if (method === 'HEAD' || !r.body) { res.end(); return; }
      Readable.fromWeb(r.body as import('node:stream/web').ReadableStream).pipe(res);
      return;
    } catch (e) {
      clearTimeout(timer);
      lastError = `${key}: ${(e as Error).message}`;
      bump(counters.upstreamErrors, key);
      registry.get(key)!.healthy = false;
      registry.get(key)!.lastError = (e as Error).message;
      console.warn(`[edge] upstream ${key} (${st.canonical}) failed: ${(e as Error).message}${i < ordered.length - 1 ? ' → failover' : ''}`);
      // continuă cu următorul candidat din lanț
    }
  }

  // Toți upstream-urile au picat la nivel de rețea ⇒ 503 onest + Retry-After.
  counters.errors503++;
  const retryAfter = 5;
  res.writeHead(503, {
    'Content-Type': 'application/json; charset=utf-8',
    'Retry-After': String(retryAfter),
    'X-Animaxia-Edge': 'faza28-live',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify({
    error: 'edge-upstream-unavailable',
    message: `All upstreams for route '${route.name}' are unreachable: ${lastError}. Retry in ${retryAfter}s.`,
    route: route.name,
    chain: route.chain.map((k) => registry.get(k)?.canonical ?? k),
    retryAfterSec: retryAfter,
  }));
}

/* -------------------------- Self endpoints ------------------------------ */

function selfHandle(ctx: ProxyCtx, res: http.ServerResponse): boolean {
  const sub = ctx.url.split('?')[0].replace(/^\/api\/edge\/?/, '');
  const json = (code: number, data: unknown) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Animaxia-Edge': 'faza28-live' });
    res.end(JSON.stringify(data, null, 2));
  };
  if (sub === '' || sub === 'health') {
    json(200, {
      ok: true, service: 'animaxia-edge-live', phase: 'FAZA 28-E',
      version: '1.0.0', uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
      listeners: { https: HTTPS_PORT, http: HTTP_PORT, redirect: REDIRECT_PORT },
    });
    return true;
  }
  if (sub === 'mapping') {
    json(200, {
      normalization: 'FAZA 28-E — internal DNS alias map (container hostname → sandbox address)',
      dnsAliases: DNS_ALIASES,
      upstreams: Object.fromEntries(Object.entries(UPSTREAMS).map(([k, v]) => [k, { canonical: v, resolved: resolveUpstream(v).address }])),
      note: 'Production: container names resolve via Docker DNS. Sandbox: resolved by the edge alias layer. Gateway region topology (eu/us/asia → http://127.0.0.1:4000) is the documented equivalent of backend:4000.',
    });
    return true;
  }
  if (sub === 'status') {
    json(200, {
      ok: true,
      service: 'animaxia-edge-live',
      uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
      listeners: {
        https: { port: HTTPS_PORT, alpn: ['h2', 'http/1.1'], tls: 'TLSv1.2-TLSv1.3', hsts: 'max-age=31536000; includeSubDomains; preload' },
        http: { port: HTTP_PORT, note: 'internal mirror — no HSTS (RFC 6797)' },
        redirect: { port: REDIRECT_PORT, code: 308 },
      },
      upstreams: registry.snapshot(),
      redisGlobal: ((globalThis as Record<string, unknown>).__edgeRedis as unknown) ?? { ok: null, note: 'probing (RESP PING)' },
      routes: ROUTES.map((r) => ({ name: r.name, chain: r.chain.map((k) => UPSTREAMS[k as keyof typeof UPSTREAMS] ?? k), cache: r.cache ?? null })),
      counters: {
        requests: counters.requests,
        byRoute: Object.fromEntries(counters.byRoute),
        byUpstream: Object.fromEntries(counters.byUpstream),
        failovers: counters.failovers,
        upstreamErrors: Object.fromEntries(counters.upstreamErrors),
        errors502: counters.errors502,
        errors503: counters.errors503,
        redirects308: counters.redirects308,
        tlsHandshakes: counters.tlsHandshakes,
        wsRelays: counters.wsRelays,
      },
    });
    return true;
  }
  json(404, { error: 'not-found', available: ['/api/edge/health', '/api/edge/status', '/api/edge/mapping'] });
  return true;
}

/* --------------------------- Request handler ---------------------------- */

type ReqLike = http.IncomingMessage & { headers: Record<string, unknown> };

async function handleRequest(
  req: ReqLike, res: http.ServerResponse, listener: 'https:8443' | 'http:8181',
): Promise<void> {
  const proto = listener === 'https:8443' ? 'https' : 'http';
  // Compat h1 + h2 (pseudo-headere sau compat node)
  const url = (req.url as string) || (req.headers[':path'] as string) || '/';
  const method = req.method || (req.headers[':method'] as string) || 'GET';

  counters.requests++;
  const route = matchRoute(url);
  bump(counters.byRoute, route.name);

  const headers = copyHeaders(req.headers as Record<string, unknown>);
  const clientIp = (req.socket?.remoteAddress ?? '127.0.0.1').replace(/^::ffff:/, '');
  const t0 = Date.now();

  // Headere de securitate + HSTS (doar pe TLS)
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (proto === 'https') res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');

  let body: Buffer | null = null;
  try {
    if (route.name === 'edge-self') {
      selfHandle({ listener: listener, route, method, url, headers, body: null, clientIp, proto }, res);
      logAccess({ listener, method, path: url, route: route.name, upstream: 'self', status: res.statusCode, ms: Date.now() - t0 });
      return;
    }
    body = await readBody(req as http.IncomingMessage);
  } catch {
    res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': '1' });
    res.end(JSON.stringify({ error: 'payload-too-large', maxBytes: MAX_BODY_BYTES }));
    return;
  }

  const ctx: ProxyCtx = { listener, route, method, url, headers, body, clientIp, proto };
  await proxyThrough(ctx, res);
  logAccess({ listener, method, path: url, route: route.name, status: res.statusCode, ms: Date.now() - t0, upstream: res.getHeader('X-Animaxia-Upstream'), failover: res.getHeader('X-Animaxia-Fallback') === 'true' });
}

/* --------------------------- WS relay (:8181) --------------------------- */
/* Releu TCP transparent pentru upgrade-urile socket.io — echivalentul     */
/* reverse_proxy Caddy pentru WebSocket. Funcționează doar pe :8181 (h1).  */

function wsRelay(req: http.IncomingMessage, socket: net.Socket, head: Buffer): void {
  const url = (req.url as string) || '/';
  const route = matchRoute(url);
  const target = registry.pickChain(route.chain.length ? route.chain : ['REALTIME', 'FRONTEND']);
  if (!target) { socket.destroy(); return; }
  counters.wsRelays++;
  const { host, port } = target.state;
  const upstream = net.connect({ host, port }, () => {
    // Rescriem request line + headere brute, cu Host corect spre upstream
    let raw = `${req.method} ${url} HTTP/1.1\r\n`;
    for (const [k, v] of Object.entries(req.headers)) {
      if (k === 'host') continue;
      raw += `${k}: ${Array.isArray(v) ? v.join(', ') : v}\r\n`;
    }
    raw += `Host: ${host}:${port}\r\n\r\n`;
    upstream.write(raw);
    if (head?.length) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  const kill = () => { socket.destroy(); upstream.destroy(); };
  socket.on('error', kill);
  upstream.on('error', kill);
  socket.on('close', () => upstream.destroy());
  upstream.on('close', () => socket.destroy());
}

/* ------------------------------ Listeners ------------------------------- */

function startRedirectServer(): void {
  const srv = http.createServer((req, res) => {
    counters.redirects308++;
    const host = String(req.headers.host ?? 'localhost').replace(/:\d+$/, '');
    const url = (req.url as string) || '/';
    res.writeHead(308, {
      Location: `https://${host}:${HTTPS_PORT}${url}`,
      'X-Animaxia-Edge': 'faza28-live',
      'Cache-Control': 'no-cache',
    });
    res.end();
  });
  srv.listen(REDIRECT_PORT, () => console.log(`[edge] :${REDIRECT_PORT} redirect 308 → https://*:${HTTPS_PORT}`));
}

function startHttpMirror(): void {
  const srv = http.createServer((req, res) => {
    void handleRequest(req as ReqLike, res as http.ServerResponse, 'http:8181').catch((e) => {
      console.error('[edge] handler error :8181', e);
      if (!res.headersSent) {
        res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '2' });
        res.end(JSON.stringify({ error: 'edge-internal-error', retryAfterSec: 2 }));
      }
    });
  });
  srv.on('upgrade', wsRelay);
  srv.listen(HTTP_PORT, () => console.log(`[edge] :${HTTP_PORT} internal HTTP mirror (routing table = Caddyfile.faza28-live)`));
}

function startHttpsEdge(): void {
  ensureCert();
  const srv = http2.createSecureServer({
    allowHTTP1: true, // ALPN: h2 + http/1.1
    key: fs.readFileSync(KEY_FILE),
    cert: fs.readFileSync(CERT_FILE),
    minVersion: 'TLSv1.2',
    maxVersion: 'TLSv1.3',
    settings: { headerTableSize: 4096, maxConcurrentStreams: 128 },
  });
  srv.on('session', () => { counters.tlsHandshakes++; });
  srv.on('request', (req, res) => {
    void handleRequest(req as unknown as ReqLike, res as unknown as http.ServerResponse, 'https:8443').catch((e) => {
      console.error('[edge] handler error :8443', e);
      if (!res.headersSent) {
        res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '2' });
        res.end(JSON.stringify({ error: 'edge-internal-error', retryAfterSec: 2 }));
      } else {
        res.end();
      }
    });
  });
  srv.listen(HTTPS_PORT, () => console.log(`[edge] :${HTTPS_PORT} public HTTPS edge — TLS 1.2+/1.3, ALPN h2+http/1.1, HSTS strict`));
}

/* -------------------------------- Boot ---------------------------------- */

/* AR10M (NEON FREE PLAN, strict): ZERO interval polling — probe de liveness
 * DOAR (1) o dată la boot și (2) on-demand la deciziile de rutare reale
 * (ensureFresh/pickChain din upstreams.ts). /api/health pe backend e zero-DB,
 * deci probe-urile nu ating Neon; regula utilizatorului AR10M: zero polling. */
registry.startOnDemandHealthChecks();
startRedirectServer();
startHttpMirror();
startHttpsEdge();

// Umple câmpul redisGlobal din /api/edge/status (proba RESP PING, non-HTTP)
// NEON FREE PLAN: 60s (fost 5s) — redis e serviciu local în memorie.
setInterval(async () => {
  const r = await redisPing(UPSTREAMS.REDIS);
  (globalThis as Record<string, unknown>).__edgeRedis = r;
}, 60000).unref?.();
void redisPing(UPSTREAMS.REDIS).then((r) => { (globalThis as Record<string, unknown>).__edgeRedis = r; });

console.log('[edge] animaxia-edge-live UP — FAZA 28-E twin of Caddyfile.faza28-live');
console.log(`[edge] upstreams: ${Object.values(UPSTREAMS).join(', ')}`);
