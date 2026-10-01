#!/usr/bin/env bun
/**
 * tests/smoke-edge.mjs — hermetic smoke suite for the FAZA 8 Animaxia edge
 * layer. Runs the REAL worker modules (gateway + search + ai + auth + player
 * + analytics + cron) through tests/local-harness.ts against an in-process
 * stubbed cloud + HLS origin: no network, no Cloudflare credentials.
 *
 *   bun tests/smoke-edge.mjs        (from animaxia-edge/)
 *
 * Exits non-zero when any check fails.
 */

import {
  makeEnv,
  edgeFetch,
  callWorker,
  consumeQueue,
  resetHarness,
  installFetchStub,
  installCaches,
  cachesStub,
  kvStore,
  r2Store,
  queue,
  rateLimiter,
  flushServiceWaitUntils,
  HarnessCtx,
} from './local-harness.ts';
import analyticsWorker from '../analytics/src/index.ts';
import cronWorker from '../cron/src/index.ts';
import searchWorker from '../search/src/index.ts';
import { edgeSignJwt } from '../shared/jwt.ts';
import { resetConfigCache } from '../shared/config.ts';
import { resetEdgeMetrics } from '../shared/metrics.ts'; // FAZA 9 ops
import {
  SHARD_HEADER,
  fnv1a,
  shardCountOf,
  computeShardIdFromContentId,
  computeShardIdFromTenant,
  resolveShardFromTenantOrContent,
  resolveShardOf,
  clientShardOf,
  shardKeySegment,
} from '../shared/shard.ts'; // FAZA 13 sharding

/* ------------------------------------------------------------- reporting --- */

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, extra = '') {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    failures.push(`${name}${extra ? ` — ${extra}` : ''}`);
    console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

function suite(name) {
  console.log(`\n━ ${name}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });

/* ------------------------------------------------------------ stub data ---- */

const CATALOG = [
  { id: 1, type: 'anime', title: 'Naruto', metadata: { year: '2002', genres: ['action'], rating: 8.4 }, thumbnail: 'https://img/naruto.jpg' },
  { id: 2, type: 'anime', title: 'One Piece', metadata: { year: '1999', genres: ['adventure'], rating: 9.0 }, thumbnail: 'https://img/op.jpg' },
  { id: 3, type: 'anime', title: 'Attack on Titan', metadata: { year: '2013', rating: 9.1 }, thumbnail: 'https://img/aot.jpg' },
  { id: 4, type: 'movie', title: 'Big Buck Bunny', metadata: { year: '2008', rating: 7.5 }, thumbnail: 'https://img/bbb.jpg' },
  { id: 5, type: 'movie', title: 'Sintel', metadata: { year: '2010', rating: 8.0 }, thumbnail: 'https://img/sintel.jpg' },
  { id: 6, type: 'tv', title: 'Made in Korea', metadata: { year: '2026', rating: 7.9 }, thumbnail: 'https://img/mik.jpg' },
];

const PLAYER_PAYLOAD = {
  content: { id: 1, title: 'Naruto', type: 'anime', thumbnail: 'https://img/naruto.jpg', rating: 8.4, year: 2002, overview: 'Ninja adventures.' },
  mode: 'hybrid',
  allowedTypes: ['m3u8', 'mp4', 'youtube'],
  sources: [
    { type: 'm3u8', url: 'https://test-streams.mux.dev/x/manifest.m3u8', label: 'HLS demo' },
    { type: 'mp4', url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4', label: 'MP4 demo' },
  ],
  primary: null,
  nextUp: null,
};

const MASTER_M3U8 = [
  '#EXTM3U',
  '#EXT-X-VERSION:6',
  '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360',
  '360/playlist.m3u8',
  '',
].join('\n');

const MEDIA_M3U8 = [
  '#EXTM3U',
  '#EXT-X-TARGETDURATION:10',
  '#EXTINF:9.0,',
  'seg0.ts',
  '#EXTINF:9.0,',
  'seg1.ts',
  '#EXT-X-ENDLIST',
  '',
].join('\n');

const SEGMENT_BYTES = new Uint8Array(188 * 10).fill(0x47);

/* ----------------------------------------------------------- stub cloud ---- */

const cloud = {
  calls: [],
  failPaths: new Set(),
  counts: {},
};

function cloudCount(path) {
  return cloud.calls.filter((c) => c.path === path).length;
}

function resetCloud() {
  cloud.calls = [];
  cloud.failPaths.clear();
  cloud.counts = {};
}

async function cloudHandler({ url, method, headers, bodyText }) {
  const path = url.pathname;
  cloud.calls.push({ path: `${path}${url.search}`, method, shard: headers.get(SHARD_HEADER) }); // FAZA 13: shard header seen upstream

  if (cloud.failPaths.has(path)) {
    return json({ error: 'forced_failure' }, 503);
  }
  if (path === '/api/health') return json({ status: 'ok', service: 'animaxia-backend', db: { connected: true, totalItems: 78 } });
  if (path === '/api/all') return json({ data: CATALOG, totalPages: 1, total: CATALOG.length });
  if (path === '/api/search/advanced') return json({ took: 1, total: CATALOG.length, max_score: 5, data: CATALOG.slice(0, 5) });
  if (path === '/api/search/autocomplete') {
    return json({ suggestions: CATALOG.slice(0, 5).map(({ id, title, type, thumbnail }) => ({ id, title, type, thumbnail })) });
  }
  if (path === '/api/auth/login' || path === '/api/auth/register') {
    return json({ ok: true, user: { id: 42, email: 'smoke@animaxia.io', plan: 'free' }, accessToken: 'stub-access', refreshToken: 'stub-refresh-1', expiresIn: 900 });
  }
  if (path === '/api/auth/refresh') {
    const body = JSON.parse((await bodyText()) || '{}');
    return json({ ok: true, accessToken: `rotated-${body.refreshToken}`, refreshToken: 'new-refresh', expiresIn: 900 });
  }
  if (path === '/api/auth/logout') return json({ ok: true, revoked: true });
  if (path === '/api/auth/me') return json({ user: { id: 42, email: 'smoke@animaxia.io' }, stats: { watchlist: 0, history: 0, comments: 0 } });
  if (path === '/api/mobile/player/1') return json(PLAYER_PAYLOAD);
  if (path === '/api/analytics/views') return json({ ok: true });
  if (path === '/api/ai/rag/recommend' || path === '/api/ai/rag/chat') return json({ ok: true, provider: 'stub', data: CATALOG.slice(0, 3) });
  if (path === '/api/ai/assistant') {
    return new Response('data: {"t":"hello"}\n\ndata: [DONE]\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    });
  }
  if (path === '/api/ai/cloud/status') return json({ ok: true, provider: 'stub', degraded: false });
  if (path === '/api/ai/tools') return json({ ok: true, tools: [] });
  if (path === '/api/vector/search') return json({ ok: true, backend: 'stub', dims: 384, took: 3, data: [{ id: 1, title: 'Naruto', score: 0.92 }] });
  if (path === '/api/movies' || path === '/api/anime') return json({ data: [] });
  if (path === '/api/workers/refresh') return json({ ok: true, refreshed: [] });
  // FAZA 12 (miner) stubs: scheduling returns immediately with the tenant
  // count; status is the public health snapshot.
  if (path === '/api/miner/jobs') return json({ ok: true, allTenants: true, count: 3 }, 201);
  if (path === '/api/miner/status') return json({ ok: true, service: 'animaxia-miner', pool: { maxConcurrent: 2, running: 0 }, jobs: { byStatus: { done: 3 } } });
  return json({ error: 'stub_not_found', path }, 404);
}

const hlsState = { segmentCalls: 0 };

async function hlsHandler({ url }) {
  if (url.pathname === '/x/manifest.m3u8') {
    return new Response(MASTER_M3U8, { status: 200, headers: { 'content-type': 'application/vnd.apple.mpegurl' } });
  }
  if (url.pathname === '/x/360/playlist.m3u8') {
    return new Response(MEDIA_M3U8, { status: 200, headers: { 'content-type': 'application/vnd.apple.mpegurl' } });
  }
  if (url.pathname.endsWith('.ts')) {
    hlsState.segmentCalls += 1;
    return new Response(SEGMENT_BYTES, { status: 200, headers: { 'content-type': 'video/mp2t' } });
  }
  return new Response('not found', { status: 404 });
}

/* ----------------------------------------------------------------- main ---- */

const ADMIN_JWT = 'smoke-admin-jwt';
const INTERNAL_TOKEN = 'smoke-internal-token';
const JWT_SECRET = 'smoke-secret-1';

async function setConfig(patch) {
  await kvStore('EDGE_CONFIG').setJson('config', patch);
  resetConfigCache();
}

async function clearConfig() {
  await kvStore('EDGE_CONFIG').delete('config');
  resetConfigCache();
}

async function main() {
  console.log('Animaxia Edge — smoke suite (hermetic, real worker code, stub cloud)');
  resetHarness();

  const env = makeEnv({
    env: { JWT_SECRET, EDGE_ADMIN_JWT: ADMIN_JWT, EDGE_INTERNAL_TOKEN: INTERNAL_TOKEN },
  });

  const restoreFetch = installFetchStub({
    '127.0.0.1': cloudHandler,
    'test-streams.mux.dev': hlsHandler,
  });
  const restoreCaches = installCaches(cachesStub());

  try {
    /* ============================================== 1. gateway basics ==== */
    suite('1. gateway basics');
    {
      let { response } = await edgeFetch(env, '/');
      check('GET / → 200 gateway info', response.status === 200);
      let body = await response.json();
      check('gateway identity', body.ok === true && body.worker === 'animaxia-edge-gateway');

      ({ response } = await edgeFetch(env, '/edge/health'));
      check('GET /edge/health → 200', response.status === 200);

      ({ response } = await edgeFetch(env, '/edge/status'));
      body = await response.json();
      check(
        '/edge/status lists all 5 service bindings',
        body.bindings.services.length === 5 && body.bindings.services.includes('SVC_AI'),
      );
      check('/edge/status exposes cache config', body.config.cache.ttlSec === 60);
      check('/edge/status exposes rate limits', body.config.rateLimit.ipPerMin === 600);

      ({ response } = await edgeFetch(env, '/definitely-not-a-route'));
      check('unknown route → 404 not_found', response.status === 404);

      ({ response } = await edgeFetch(env, '/api/all', { method: 'OPTIONS' }));
      check('CORS preflight → 204', response.status === 204);
      check('CORS preflight allow-origin *', response.headers.get('access-control-allow-origin') === '*');

      ({ response } = await edgeFetch(env, '/edge/health'));
      check('security header nosniff', response.headers.get('x-content-type-options') === 'nosniff');
      check('x-request-id present', (response.headers.get('x-request-id') || '').startsWith('edge-'));
      check('x-ratelimit-limit present', response.headers.get('x-ratelimit-limit') !== null);
      check('referrer policy hardened', response.headers.get('referrer-policy') === 'strict-origin-when-cross-origin');
    }

    /* ======================================================== 2. WAF ==== */
    suite('2. WAF rules');
    {
      let { response, ctx } = await edgeFetch(env, '/api/all', { headers: { 'user-agent': 'curl/8.4.0' } });
      check('bot UA blocked (403)', response.status === 403);
      let body = await response.json();
      check('bot block code + rule', body.error === 'waf_blocked' && body.rule === 'bot');
      check('x-edge-waf header', response.headers.get('x-edge-waf') === 'bot');
      await ctx.flush();

      ({ response } = await edgeFetch(env, `/api/search?q=${encodeURIComponent("' OR '1'='1")}`));
      body = await response.json();
      check('SQLi blocked', response.status === 403 && body.rule === 'sqli');

      ({ response } = await edgeFetch(env, `/api/search?q=${encodeURIComponent('<script>alert(1)</script>')}`));
      body = await response.json();
      check('XSS blocked', response.status === 403 && body.rule === 'xss');

      ({ response } = await edgeFetch(env, '/media/%2e%2e%2fetc/passwd'));
      body = await response.json();
      check('path traversal blocked', response.status === 403 && body.rule === 'traversal');

      ({ response } = await edgeFetch(env, '/api/search?q=%00'));
      body = await response.json();
      check('null byte blocked', response.status === 403 && body.rule === 'null-byte');

      ({ response } = await edgeFetch(env, `/api/search?q=${'a'.repeat(9000)}`));
      body = await response.json();
      check('oversized query blocked', response.status === 403 && body.rule === 'query-size');

      resetCloud();
      ({ response } = await edgeFetch(env, `/api/search/advanced?q=${encodeURIComponent("O'Reilly")}`));
      check("benign \"O'Reilly\" passes the WAF", response.status === 200);
      ({ response } = await edgeFetch(env, `/api/search/advanced?q=${encodeURIComponent('one or two')}`));
      check('benign "one or two" passes the WAF', response.status === 200);

      ({ response } = await edgeFetch(env, '/edge/waf/events'));
      check('WAF events admin requires auth', response.status === 401);
      ({ response } = await edgeFetch(env, '/edge/waf/events', { headers: { authorization: `Bearer ${ADMIN_JWT}` } }));
      body = await response.json();
      check('WAF events recorded + readable', response.status === 200 && body.events.length >= 1);
    }

    /* ================================================ 3. rate limiting ==== */
    suite('3. global rate limiting (per-IP + per-user + heavy)');
    {
      await setConfig({ rateLimit: { ipPerMin: 3, userPerMin: 100, heavyPerMin: 100 } });
      rateLimiter().reset();

      let last;
      for (let i = 0; i < 4; i += 1) {
        last = await edgeFetch(env, '/edge/health', { headers: { 'x-forwarded-for': '9.9.9.9' } });
      }
      check('4th request from one IP → 429', last.response.status === 429);
      check('429 body is rate_limited', (await last.response.json()).error === 'rate_limited');
      check('Retry-After present', Number(last.response.headers.get('retry-after')) >= 1);
      check('X-RateLimit-Limit echoes the limit', last.response.headers.get('x-ratelimit-limit') === '3');

      await setConfig({ rateLimit: { ipPerMin: 600, userPerMin: 2, heavyPerMin: 100 } });
      rateLimiter().reset();
      const token = await edgeSignJwt({ sub: 42, email: 'smoke@animaxia.io', plan: 'free', typ: 'access' }, JWT_SECRET, 900);
      for (let i = 0; i < 3; i += 1) {
        last = await edgeFetch(env, '/edge/health', {
          headers: { 'x-forwarded-for': '8.8.8.8', authorization: `Bearer ${token}` },
        });
      }
      check('3rd authenticated request → 429 (per-user)', last.response.status === 429);
      check('per-user limit echoed', last.response.headers.get('x-ratelimit-limit') === '2');

      await setConfig({ rateLimit: { ipPerMin: 600, userPerMin: 100, heavyPerMin: 2 } });
      rateLimiter().reset();
      for (let i = 0; i < 3; i += 1) {
        last = await edgeFetch(env, '/ai/embeddings', {
          method: 'POST',
          headers: { 'x-forwarded-for': '7.7.7.7', 'content-type': 'application/json' },
          body: JSON.stringify({ text: 'x' }),
        });
      }
      check('anonymous heavy path → per-IP heavy 429', last.response.status === 429);
      check('heavy limit echoed', last.response.headers.get('x-ratelimit-limit') === '2');

      await clearConfig();
      rateLimiter().reset();
    }

    /* ============================================ 4. cache: SWR + SIE ==== */
    suite('4. edge cache: MISS → HIT → STALE (SWR) → STALE-ERROR (SIE)');
    {
      await setConfig({ edge: { cacheTtlSec: 1, swrSec: 1, staleIfErrorSec: 86400 } });
      resetCloud();

      let { response } = await edgeFetch(env, '/api/health');
      check('first GET /api/health → MISS', response.headers.get('x-edge-cache') === 'MISS');
      check('upstream body served', (await response.json()).db.totalItems === 78);
      check('cloud called once', cloudCount('/api/health') === 1);

      ({ response } = await edgeFetch(env, '/api/health'));
      check('second GET → HIT', response.headers.get('x-edge-cache') === 'HIT');
      check('no extra upstream call on HIT', cloudCount('/api/health') === 1);

      cloud.failPaths.add('/api/health');
      await sleep(1100); // beyond the 1s fresh window, inside the 1s SWR window
      ({ response } = await edgeFetch(env, '/api/health'));
      check('origin failing within SWR → STALE served', response.headers.get('x-edge-cache') === 'STALE');
      check('STALE body still complete', (await response.json()).status === 'ok');

      await sleep(1100); // beyond SWR → blocking revalidation → origin still failing
      ({ response } = await edgeFetch(env, '/api/health'));
      check('beyond SWR + origin down → STALE-ERROR', response.headers.get('x-edge-cache') === 'STALE-ERROR');
      check('SIE body still complete', (await response.json()).status === 'ok');

      cloud.failPaths.delete('/api/health');
      await clearConfig();

      resetCloud();
      const token = await edgeSignJwt({ sub: 42, typ: 'access' }, JWT_SECRET, 900);
      ({ response } = await edgeFetch(env, '/api/all', { headers: { authorization: `Bearer ${token}` } }));
      check('authorized GET bypasses the cache', response.status === 200 && response.headers.get('x-edge-cache') === null);
      check('bypass still reaches the cloud', cloudCount('/api/all') === 1);
    }

    /* ================================================= 5. R2 media ======== */
    suite('5. R2 media (/media/*)');
    {
      const mp4 = new Uint8Array(2048).fill(7);
      await r2Store('MEDIA_BUCKET').putBytes('offline-test.mp4', mp4, { contentType: 'video/mp4' });
      await r2Store('MEDIA_BUCKET').putBytes('thumbnails/poster.jpg', new Uint8Array(100).fill(3), { contentType: 'image/jpeg' });

      let { response } = await edgeFetch(env, '/media/offline-test.mp4');
      check('GET offline-test.mp4 → 200', response.status === 200);
      check('content-type video/mp4', response.headers.get('content-type') === 'video/mp4');
      check('content-length 2048', response.headers.get('content-length') === '2048');
      check('accept-ranges bytes', response.headers.get('accept-ranges') === 'bytes');
      check('etag present', (response.headers.get('etag') || '') !== '');
      check('immutable-ish cache-control', (response.headers.get('cache-control') || '').includes('max-age=86400'));

      ({ response } = await edgeFetch(env, '/media/offline-test.mp4', { method: 'HEAD' }));
      check('HEAD → 200 with length', response.status === 200 && response.headers.get('content-length') === '2048');

      ({ response } = await edgeFetch(env, '/media/offline-test.mp4', { headers: { range: 'bytes=0-99' } }));
      check('range 0-99 → 206', response.status === 206);
      check('content-range correct', response.headers.get('content-range') === 'bytes 0-99/2048');
      check('partial length 100', response.headers.get('content-length') === '100');

      ({ response } = await edgeFetch(env, '/media/offline-test.mp4', { headers: { range: 'bytes=-50' } }));
      check('suffix range → 206 (last 50 bytes)', response.status === 206 && response.headers.get('content-length') === '50');

      ({ response } = await edgeFetch(env, '/media/offline-test.mp4', { headers: { range: 'bytes=999999-' } }));
      check('unsatisfiable range → 416', response.status === 416);

      ({ response } = await edgeFetch(env, '/media/missing.bin'));
      check('missing object → 404 media_not_found', response.status === 404);

      ({ response } = await edgeFetch(env, '/media/thumbnails/poster.jpg'));
      check('nested thumbnail key → 200 image/jpeg', response.status === 200 && response.headers.get('content-type') === 'image/jpeg');
    }

    /* ================================================ 6. edge search ===== */
    suite('6. edge search (fuzzy + autocomplete)');
    {
      let { response } = await edgeFetch(env, '/search?q=naruto');
      check('GET /search?q=naruto → 200', response.status === 200);
      check('served from the edge', response.headers.get('x-edge-search') === 'edge');
      let body = await response.json();
      check('results source=edge', body.source === 'edge');
      check('top result is Naruto', body.results[0]?.id === 1 && body.results[0]?.title === 'Naruto');
      check('scores are numbers > 0', typeof body.results[0]?.score === 'number' && body.results[0].score > 0);

      ({ response } = await edgeFetch(env, '/search?q=narutp'));
      body = await response.json();
      check('fuzzy: "narutp" still finds Naruto', body.results.some((r) => r.title === 'Naruto'));

      ({ response } = await edgeFetch(env, '/search?q=zzzzzzzz'));
      body = await response.json();
      check('no match → empty results', body.results.length === 0);

      ({ response } = await edgeFetch(env, '/search'));
      check('missing q → 400 bad_query', response.status === 400);

      ({ response } = await edgeFetch(env, `/search?q=${'x'.repeat(200)}`));
      check('oversized q → 400', response.status === 400);

      ({ response } = await edgeFetch(env, '/autocomplete?q=bi'));
      body = await response.json();
      check('autocomplete "bi" → Big Buck Bunny first', body.suggestions[0]?.title === 'Big Buck Bunny');

      ({ response } = await edgeFetch(env, '/search/health'));
      body = await response.json();
      check('catalog snapshot has all 6 items', body.catalog?.items === 6);

      ({ response } = await edgeFetch(env, '/search/refresh', { method: 'POST' }));
      check('refresh requires admin auth', response.status === 401);
      ({ response } = await edgeFetch(env, '/search/refresh', {
        method: 'POST',
        headers: { authorization: `Bearer ${ADMIN_JWT}` },
      }));
      body = await response.json();
      check('authorized refresh rebuilds the catalog', response.status === 200 && body.items === 6);
    }

    /* ================================================== 7. edge auth ====== */
    suite('7. edge auth (verify / replay / device / refresh guard)');
    {
      const valid = await edgeSignJwt({ sub: 42, email: 'smoke@animaxia.io', plan: 'free', typ: 'access' }, JWT_SECRET, 900);

      let { response } = await edgeFetch(env, '/auth/verify');
      check('verify without token → 401 auth_missing', response.status === 401 && (await response.json()).error === 'auth_missing');

      ({ response } = await edgeFetch(env, '/auth/verify', { headers: { authorization: `Bearer ${valid}` } }));
      check('verify valid token → 200', response.status === 200);
      let body = await response.json();
      check('verify returns the user', body.user?.sub === 42 && body.user?.plan === 'free');
      check('verify reports all checks', body.checks?.signature === true && !!body.checks?.replay);

      const expired = await edgeSignJwt({ sub: 42, typ: 'access' }, JWT_SECRET, -10);
      ({ response } = await edgeFetch(env, '/auth/verify', { headers: { authorization: `Bearer ${expired}` } }));
      check('expired token → 401 auth_expired', response.status === 401 && (await response.json()).error === 'auth_expired');

      ({ response } = await edgeFetch(env, '/auth/verify', { headers: { authorization: `Bearer ${valid}x` } }));
      check('tampered signature → 401 auth_invalid', response.status === 401 && (await response.json()).error === 'auth_invalid');

      // device-bound wrapper tokens (jti + dvp)
      ({ response } = await edgeFetch(env, '/auth/device/token', {
        method: 'POST',
        headers: { authorization: `Bearer ${valid}`, 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId: 'dev-1' }),
      }));
      check('mint device token → 200', response.status === 200);
      body = await response.json();
      check('device token is device-bound', body.deviceBound === true && typeof body.token === 'string');

      ({ response } = await edgeFetch(env, '/auth/verify', {
        headers: { authorization: `Bearer ${body.token}`, 'x-animaxia-device': 'dev-1' },
      }));
      check('device token verifies with matching header', response.status === 200);

      ({ response } = await edgeFetch(env, '/auth/verify', {
        headers: { authorization: `Bearer ${body.token}`, 'x-animaxia-device': 'dev-1' },
      }));
      check('second presentation → 401 auth_replay (anti-replay)', response.status === 401 && (await response.json()).error === 'auth_replay');

      const second = await (await edgeFetch(env, '/auth/device/token', {
        method: 'POST',
        headers: { authorization: `Bearer ${valid}`, 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId: 'dev-1' }),
      })).response.json();
      ({ response } = await edgeFetch(env, '/auth/verify', {
        headers: { authorization: `Bearer ${second.token}`, 'x-animaxia-device': 'dev-2' },
      }));
      check('device hash mismatch → 401 auth_device', response.status === 401 && (await response.json()).error === 'auth_device');

      // refresh replay guard
      ({ response } = await edgeFetch(env, '/auth/refresh', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: 'rt-abc' }),
      }));
      check('refresh passthrough → 200 rotated', response.status === 200 && response.headers.get('x-edge-auth') === 'refresh-rotated');
      await flushServiceWaitUntils();
      ({ response } = await edgeFetch(env, '/auth/refresh', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: 'rt-abc' }),
      }));
      check('replayed refresh token → 401 refresh_replay', response.status === 401 && (await response.json()).error === 'refresh_replay');

      // plain passthroughs
      ({ response } = await edgeFetch(env, '/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'smoke@animaxia.io', password: 'secret123' }),
      }));
      check('login passthrough → cloud session shape', response.status === 200 && (await response.json()).ok === true);

      ({ response } = await edgeFetch(env, '/auth/me', { headers: { authorization: `Bearer ${valid}` } }));
      check('/auth/me passthrough', response.status === 200 && (await response.json()).user?.id === 42);

      ({ response } = await edgeFetch(env, '/auth/logout', {
        method: 'POST',
        headers: { authorization: `Bearer ${valid}`, 'content-type': 'application/json' },
        body: '{}',
      }));
      check('logout passthrough', response.status === 200);

      ({ response } = await edgeFetch(env, '/auth/health'));
      body = await response.json();
      check('auth health exposes the secret SOURCE only', response.status === 200 && body.secretFrom === 'JWT_SECRET' && body.replayRegistry === true);
    }

    /* ==================================================== 8. edge AI ====== */
    suite('8. edge AI (answer cache + retrieval pre-warm + streaming)');
    {
      resetCloud();
      let { response } = await edgeFetch(env, '/ai/rag/recommend', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: 'ninjas', limit: 3 }),
      });
      check('rag recommend miss → 200', response.status === 200 && response.headers.get('x-edge-ai') === 'miss');
      await flushServiceWaitUntils();

      ({ response } = await edgeFetch(env, '/ai/rag/recommend', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: 'ninjas', limit: 3 }),
      }));
      check('same request → x-edge-ai hit', response.headers.get('x-edge-ai') === 'hit');
      check('cloud saw exactly one rag call', cloudCount('/api/ai/rag/recommend') === 1);

      const token = await edgeSignJwt({ sub: 42, typ: 'access' }, JWT_SECRET, 900);
      ({ response } = await edgeFetch(env, '/ai/rag/recommend', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ query: 'ninjas', limit: 3 }),
      }));
      check('authorized request → bypass-auth (never cached)', response.headers.get('x-edge-ai') === 'bypass-auth');
      check('bypass reached the cloud', cloudCount('/api/ai/rag/recommend') === 2);

      ({ response } = await edgeFetch(env, '/ai/embeddings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'ninjas' }),
      }));
      check('embeddings hit via rag pre-warm (L2)', response.headers.get('x-edge-ai') === 'hit');

      ({ response } = await edgeFetch(env, '/ai/embeddings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'pirates' }),
      }));
      check('embeddings fresh text → miss', response.headers.get('x-edge-ai') === 'miss');
      await flushServiceWaitUntils();
      ({ response } = await edgeFetch(env, '/ai/embeddings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'pirates' }),
      }));
      check('embeddings second time → hit', response.headers.get('x-edge-ai') === 'hit');

      ({ response } = await edgeFetch(env, '/ai/embeddings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '' }),
      }));
      check('empty text → 400 invalid_text', response.status === 400);

      ({ response } = await edgeFetch(env, '/ai/cloud/status'));
      check('cloud status cached passthrough → 200', response.status === 200);
      await flushServiceWaitUntils();
      await edgeFetch(env, '/ai/cloud/status');
      check('cloud status served from cache on repeat', cloudCount('/api/ai/cloud/status') === 1);

      ({ response } = await edgeFetch(env, '/ai/assistant', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'hi' }),
      }));
      check('assistant SSE passthrough keeps event-stream', (response.headers.get('content-type') || '').includes('text/event-stream'));
      check('assistant tagged as stream', response.headers.get('x-edge-ai') === 'stream');
      check('assistant body preserved', (await response.text()).includes('data:'));

      ({ response } = await edgeFetch(env, '/ai/health'));
      check('ai health → 200', response.status === 200);
    }

    /* ================================================ 9. edge player ===== */
    suite('9. edge player (HLS manifest rewrite + segment cache)');
    {
      let { response } = await edgeFetch(env, '/player/manifest/1');
      check('manifest → 200', response.status === 200);
      check('content-type is m3u8', response.headers.get('content-type') === 'application/vnd.apple.mpegurl');
      check('tagged rewritten', response.headers.get('x-edge-player') === 'rewritten');
      const manifestBody = await response.text();
      check('variant line rewritten to edge', manifestBody.includes('/player/manifest/variant?src='));

      resetCloud();
      ({ response } = await edgeFetch(env, '/player/manifest/1'));
      check('manifest repeat served entirely from cache (zero cloud calls)', response.status === 200 && cloudCount('/api/mobile/player/1') === 0);
      check('cached manifest still m3u8', response.headers.get('content-type') === 'application/vnd.apple.mpegurl');
      check('cached manifest still tagged rewritten', response.headers.get('x-edge-player') === 'rewritten');

      ({ response } = await edgeFetch(env, '/player/manifest/abc'));
      check('bad manifest id → 400', response.status === 400);

      const variantSrc = manifestBody.match(/variant\?src=([^&\s"']+)/)?.[1];
      check('variant src extracted', Boolean(variantSrc));
      ({ response } = await edgeFetch(env, `/player/manifest/variant?src=${variantSrc}`));
      check('variant playlist → 200 m3u8', response.status === 200 && response.headers.get('content-type') === 'application/vnd.apple.mpegurl');
      const mediaBody = await response.text();
      check('segments rewritten to /hls', mediaBody.includes('/hls?u='));

      const segUrl = mediaBody.match(/\/hls\?u=([^&\s"']+)/)?.[1];
      ({ response } = await edgeFetch(env, `/hls?u=${segUrl}`));
      check('segment proxy → 200', response.status === 200);
      check('segment content-type mp2t', response.headers.get('content-type') === 'video/mp2t');
      const segCallsAfterFirst = hlsState.segmentCalls;
      ({ response } = await edgeFetch(env, `/hls?u=${segUrl}`));
      check('segment served from L1 on repeat', response.headers.get('x-edge-cache') === 'HIT' && hlsState.segmentCalls === segCallsAfterFirst);
      check('segment cache-control long', (response.headers.get('cache-control') || '').includes('max-age=3600'));

      ({ response } = await edgeFetch(env, `/hls?u=${encodeURIComponent('https://evil.example.com/seg.ts')}`));
      check('non-allowlisted segment host → 403', response.status === 403);
      ({ response } = await edgeFetch(env, '/hls'));
      check('missing u → 400', response.status === 400);

      ({ response } = await edgeFetch(env, '/player/sources/1'));
      const sourcesBody = await response.json();
      check('sources passthrough → cloud player payload', response.status === 200 && Array.isArray(sourcesBody.sources));

      ({ response } = await edgeFetch(env, '/player/health'));
      check('player health → 200 with R2', response.status === 200 && (await response.json()).r2 === true);
    }

    /* ============================================= 10. edge analytics ==== */
    suite('10. edge analytics (queue + trending + flush)');
    {
      queue().clear();
      resetCloud();

      let { response } = await edgeFetch(env, '/analytics/view', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contentId: 1, title: 'Naruto', event: 'view' }),
      });
      check('view → queued', response.status === 200 && (await response.json()).delivery === 'queue');

      await edgeFetch(env, '/analytics/event', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contentId: 1, title: 'Naruto', event: 'play' }),
      });
      await edgeFetch(env, '/beacon', {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: JSON.stringify({ contentId: 1, event: 'complete' }),
      });
      await edgeFetch(env, '/analytics/view', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contentId: 2, title: 'Sintel' }),
      });
      check('all 4 events captured by the queue', queue().messages.length === 4);

      ({ response } = await edgeFetch(env, '/analytics/trending?window=1h'));
      let body = await response.json();
      check('trending window=1h → 200', response.status === 200);
      check('top row is content 1 with score 6 (1 view + 2×play + 3×complete)', body.rows[0]?.contentId === 1 && body.rows[0]?.score === 6);
      check('second row is content 2 with score 1', body.rows[1]?.contentId === 2 && body.rows[1]?.score === 1);

      ({ response } = await edgeFetch(env, '/analytics/view', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contentId: 0 }),
      }));
      check('invalid contentId → 400', response.status === 400);
      ({ response } = await edgeFetch(env, '/analytics/view', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contentId: 1, event: 'teleport' }),
      }));
      check('invalid event → 400', response.status === 400);

      await consumeQueue(analyticsWorker, env, [{ contentId: 5, event: 'view', ts: Date.now() }]);
      check('queue consumer delivers to cloud /api/analytics/views', cloudCount('/api/analytics/views') === 1);

      // buffer path (no queue binding) + flush
      const envB = makeEnv({
        without: ['ANALYTICS_QUEUE'],
        env: { EDGE_INTERNAL_TOKEN: INTERNAL_TOKEN },
      });
      let direct = await callWorker(analyticsWorker, new Request('https://edge.animaxia.test/analytics/view', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contentId: 7, title: 'Buffered', event: 'view' }),
      }), envB);
      check('without queue → buffered delivery', (await direct.response.json()).delivery === 'buffer');
      direct = await callWorker(analyticsWorker, new Request('https://edge.animaxia.test/analytics/view', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contentId: 7, title: 'Buffered', event: 'view' }),
      }), envB);
      await direct.ctx.flush();

      direct = await callWorker(analyticsWorker, new Request('https://edge.animaxia.test/analytics/flush', { method: 'POST' }), envB);
      check('flush without internal auth → 401', direct.response.status === 401);
      direct = await callWorker(analyticsWorker, new Request('https://edge.animaxia.test/analytics/flush', {
        method: 'POST',
        headers: { 'x-internal-token': INTERNAL_TOKEN },
      }), envB);
      const flushBody = await direct.response.json();
      check('flush drains the buffer to the cloud', direct.response.status === 200 && flushBody.drained === 2);
      check('cloud received both buffered views', cloudCount('/api/analytics/views') === 3);

      ({ response } = await edgeFetch(env, '/analytics/health'));
      check('analytics health → 200', response.status === 200);
    }

    /* =================================================== 11. cron jobs ==== */
    suite('11. cron jobs (manual runs + edge-only cleanups)');
    {
      let direct = await callWorker(cronWorker, new Request('https://edge.animaxia.test/cron/health'), env);
      check('cron health → 7 jobs (FAZA 12: +miner-sync)', direct.response.status === 200 && (await direct.response.json()).jobs === 7);

      direct = await callWorker(cronWorker, new Request('https://edge.animaxia.test/cron/run/daily-picks'), env);
      check('manual run requires auth', direct.response.status === 401);

      direct = await callWorker(cronWorker, new Request('https://edge.animaxia.test/cron/run/daily-picks', {
        headers: { 'x-internal-token': INTERNAL_TOKEN },
      }), env);
      const result = await direct.response.json();
      check('daily-picks run ok against the cloud', direct.response.status === 200 && result.ok === true);



      await kvStore('EDGE_CACHE').put('waf:1:old', '{}');
      await kvStore('EDGE_CACHE').put('cron:log:1:old', '{}');
      direct = await callWorker(cronWorker, new Request('https://edge.animaxia.test/cron/run/cleanup-logs', {
        headers: { 'x-internal-token': INTERNAL_TOKEN },
      }), env);
      await direct.ctx.flush();
      check('cleanup-logs purges waf + cron:log keys', (await kvStore('EDGE_CACHE').get('waf:1:old')) === null && (await kvStore('EDGE_CACHE').get('cron:log:1:old')) === null);

      await kvStore('EDGE_RATELIMIT').put('rl:old:1', '5');
      await kvStore('EDGE_REPLAY').put('replay:old', '1');
      direct = await callWorker(cronWorker, new Request('https://edge.animaxia.test/cron/run/cleanup-sessions', {
        headers: { 'x-internal-token': INTERNAL_TOKEN },
      }), env);
      await direct.ctx.flush();
      check('cleanup-sessions purges rl + replay keys', (await kvStore('EDGE_RATELIMIT').get('rl:old:1')) === null && (await kvStore('EDGE_REPLAY').get('replay:old')) === null);

      direct = await callWorker(cronWorker, new Request('https://edge.animaxia.test/cron/jobs', {
        headers: { 'x-internal-token': INTERNAL_TOKEN },
      }), env);
      const jobsBody = await direct.response.json();
      check('cron jobs listing', direct.response.status === 200 && Object.keys(jobsBody.jobs).length === 7 && Array.isArray(jobsBody.results));

      // FAZA 12 (miner): dedicated runner POSTs {daily-sync, allTenants} to
      // the cloud and reports the queued tenant-sync count.
      direct = await callWorker(cronWorker, new Request('https://edge.animaxia.test/cron/run/miner-sync', {
        headers: { 'x-internal-token': INTERNAL_TOKEN },
      }), env);
      const minerRun = await direct.response.json();
      check('miner-sync run queues per-tenant jobs', direct.response.status === 200 && minerRun.ok === true && /queued 3 tenant sync/i.test(String(minerRun.detail)));

      direct = await callWorker(cronWorker, new Request('https://edge.animaxia.test/cron/run/nope', {
        headers: { 'x-internal-token': INTERNAL_TOKEN },
      }), env);
      check('unknown job → 404 (after miner-sync)', direct.response.status === 404);

      const schedCtx = new HarnessCtx();
      await cronWorker.scheduled({ cron: '*/5 * * * *', scheduledTime: Date.now() }, env, schedCtx);
      await schedCtx.flush();
      check('scheduled */5 flush trigger completes without throwing', true);
    }

    /* ============================================== 12. websocket path ==== */
    suite('12. WebSocket endpoint (/ws/assistant)');
    {
      let { response } = await edgeFetch(env, '/ws/assistant');
      check('plain GET → 426 upgrade_required', response.status === 426);
      check('upgrade hint header', response.headers.get('upgrade') === 'websocket');

      ({ response } = await edgeFetch(env, '/ws/assistant', { headers: { upgrade: 'websocket' } }));
      check('bun runtime without WebSocketPair → explicit 501', response.status === 501 && (await response.json()).error === 'ws_unsupported_runtime');
    }

    /* ==================================== 13. edge metrics (FAZA 9 ops) ==== */
    suite('13. edge metrics (FAZA 9 ops)');
    {
      resetEdgeMetrics(); // deterministic counters for this suite only

      // FAZA 12 (miner): gateway /edge/miner/status proxies the cloud status
      // (public, no-store) — checked here so the reset above also covers the
      // per-isolate miner counter.
      {
        const ms = await edgeFetch(env, '/edge/miner/status');
        const msBody = await ms.response.json();
        check('gateway /edge/miner/status proxies cloud status', ms.response.status === 200 && msBody.service === 'animaxia-miner' && msBody.pool?.maxConcurrent === 2);
        check('gateway /edge/miner/status is no-store', ms.response.headers.get('cache-control') === 'no-store');
      }

      // gateway /edge/metrics is admin-guarded like the other /edge/* routes
      let { response } = await edgeFetch(env, '/edge/metrics');
      check('gateway /edge/metrics without auth → 401', response.status === 401);

      ({ response } = await edgeFetch(env, '/edge/metrics', { headers: { 'x-internal-token': INTERNAL_TOKEN } }));
      check('gateway /edge/metrics with internal token → 200', response.status === 200);
      check('prometheus content-type', (response.headers.get('content-type') || '').startsWith('text/plain'));
      const emptyText = await response.text();
      check('prometheus render declares requests_total family', emptyText.includes('# TYPE animaxia_edge_requests_total counter'));

      // gateway traffic → counters + latency + cache-tag series appear
      await edgeFetch(env, '/edge/health');
      await edgeFetch(env, '/api/all');
      await edgeFetch(env, '/api/all?q=metrics-suite');

      ({ response } = await edgeFetch(env, '/edge/metrics', { headers: { 'x-internal-token': INTERNAL_TOKEN } }));
      const text = await response.text();
      check(
        'requests counter recorded for /edge/health',
        /animaxia_edge_requests_total\{module="gateway",route="\/edge\/health",status="200"\} [1-9]/.test(text),
      );
      check(
        'requests counter recorded for /api/all',
        /animaxia_edge_requests_total\{module="gateway",route="\/api\/all",status="200"\} [1-9]/.test(text),
      );
      check(
        'latency histogram recorded',
        /animaxia_edge_request_latency_ms_count\{module="gateway",route="\/edge\/health"\} [1-9]/.test(text),
      );
      check(
        'cache events counter recorded from x-edge-cache tag',
        /animaxia_edge_cache_events_total\{module="gateway",state="[a-z-]+"\} [1-9]/.test(text),
      );

      // WAF block counter (attack-tool UA → bot rule)
      await edgeFetch(env, '/api/all', { headers: { 'user-agent': 'sqlmap/1.5.2' } });
      ({ response } = await edgeFetch(env, '/edge/metrics', { headers: { 'x-internal-token': INTERNAL_TOKEN } }));
      const wafText = await response.text();
      check(
        'waf blocks counter incremented (rule=bot)',
        /animaxia_edge_waf_blocks_total\{rule="bot"\} [1-9]/.test(wafText),
      );

      // sub-worker /metrics: public, prometheus + json, module label isolation
      let sub = await callWorker(searchWorker, new Request('https://edge.animaxia.test/search?q=big'), env);
      check('search query through the worker → 200', sub.response.status === 200);
      sub = await callWorker(searchWorker, new Request('https://edge.animaxia.test/metrics?format=json'), env);
      check('search /metrics?format=json → 200', sub.response.status === 200);
      const mj = await sub.response.json();
      const searchSeries = (mj.counters || []).filter(
        (c) => c.name === 'animaxia_edge_requests_total' && c.labels.module === 'search',
      );
      check(
        'json snapshot carries module="search" series',
        searchSeries.length > 0 && searchSeries.every((c) => c.value >= 1),
        JSON.stringify(searchSeries).slice(0, 120),
      );
      sub = await callWorker(searchWorker, new Request('https://edge.animaxia.test/metrics'), env);
      const promSearch = await sub.response.text();
      check(
        'search /metrics prometheus render has module label',
        promSearch.includes('animaxia_edge_requests_total{module="search"'),
      );
    }
    /* ======================================== 14. sharding (FAZA 13/14) == */
    suite('14. sharding (FAZA 13 keys + header; FAZA 14: default 30 shards × 1B)');
    {
      // --- pure shard math (shared/shard.ts, pinned FAZA 13 spec + FAZA 14
      //     topology: 30 logical shards × 1B ids = 30B logical address space)
      check('fnv1a known vectors (FNV-1a 32-bit)', fnv1a('') === 2166136261 && fnv1a('a') === 3826002220 && fnv1a('hello') === 1335831723);
      check('fnv1a stable across calls', fnv1a('tenant:acme') === fnv1a('tenant:acme'));

      check('shardCountOf: default 30 (FAZA 14)', shardCountOf() === 30 && shardCountOf({}) === 30);
      check('shardCountOf: SHARDCOUNT honored + guarded', shardCountOf({ SHARDCOUNT: '8' }) === 8 && shardCountOf({ SHARDCOUNT: '0' }) === 30 && shardCountOf({ SHARDCOUNT: 'abc' }) === 30 && shardCountOf({ SHARDCOUNT: '' }) === 30);

      const pinned = { SHARDCOUNT: '30' }; // FAZA 14 pinned topology (30 × 1B)
      check('content shard: 5/42/999999999 → 0 (SERIAL ids are shard-0, legacy compatible)', computeShardIdFromContentId(5, pinned) === 0 && computeShardIdFromContentId('42', pinned) === 0 && computeShardIdFromContentId(999_999_999, pinned) === 0);
      check('content shard: 1.5B → 1, 2.5B → 2, 3.5B → 3, 4.5B → 4 (no wrap under 30)', computeShardIdFromContentId(1_500_000_000, pinned) === 1 && computeShardIdFromContentId(2_500_000_000, pinned) === 2 && computeShardIdFromContentId(3_500_000_000, pinned) === 3 && computeShardIdFromContentId(4_500_000_000, pinned) === 4);
      check('content shard: 30.5B → 0 (wrap above the 30B logical address space)', computeShardIdFromContentId(30_500_000_000, pinned) === 0);
      check('content shard: garbage → 0', computeShardIdFromContentId('nope', pinned) === 0 && computeShardIdFromContentId(-7, pinned) === 0);

      const acmeShard = computeShardIdFromTenant('acme', pinned);
      check('tenant shard: acme stable (=== 1) and within 0..29 (FAZA 14)', acmeShard === computeShardIdFromTenant('acme', pinned) && acmeShard === 1 && acmeShard >= 0 && acmeShard <= 29);
      check('tenant shard: demo === 6 (fnv1a stable under mod 30)', computeShardIdFromTenant('demo', pinned) === 6);
      check('shardKeySegment: 0 → "s0:", 2 → "s2:"', shardKeySegment(0) === 's0:' && shardKeySegment(2) === 's2:');

      // --- resolveShardFromTenantOrContent (pinned edge resolution) -------
      const req = (path, headers = {}) => new Request(`https://edge.animaxia.test${path}`, { headers });
      check('resolve: /api/content/42 global → 0', resolveShardFromTenantOrContent(req('/api/content/42'), 'global', pinned) === 0);
      check('resolve: /player/1500000000 global → 1', resolveShardFromTenantOrContent(req('/player/1500000000'), 'global', pinned) === 1);
      check('resolve: /content/2500000000 global → 2', resolveShardFromTenantOrContent(req('/content/2500000000'), 'global', pinned) === 2);
      check('resolve: tenant acme wins over content path', resolveShardFromTenantOrContent(req('/api/content/2500000000'), 'acme', pinned) === acmeShard);
      check('resolve: garbage path → 0', resolveShardFromTenantOrContent(req('/definitely/no/numbers/here'), 'global', pinned) === 0);
      check('resolve: /player/manifest/42 (non-numeric after player) → 0', resolveShardFromTenantOrContent(req('/player/manifest/42'), 'global', pinned) === 0);

      // --- client header override (resolution order: header > tenant > content > 0)
      check('client header x-animaxia-shard: 2 honored even on /api/content/42', resolveShardOf(req('/api/content/42', { [SHARD_HEADER]: '2' }), 'global', pinned) === 2);
      check('invalid client header values fall back to recompute', clientShardOf(req('/api/content/42', { [SHARD_HEADER]: '30' }), pinned) === null
        && clientShardOf(req('/x', { [SHARD_HEADER]: '-1' }), pinned) === null
        && clientShardOf(req('/x', { [SHARD_HEADER]: 'abc' }), pinned) === null
        && resolveShardOf(req('/api/content/42', { [SHARD_HEADER]: '99' }), 'global', pinned) === 0);

      // --- gateway integration (real worker via the harness) --------------
      resetCloud();
      const unique = `?shard-suite=${Date.now()}`;
      let { response } = await edgeFetch(env, `/api/movies${unique}`);
      check('gateway global response carries x-animaxia-shard: 0', response.headers.get(SHARD_HEADER) === '0');
      check('gateway global cache key has the s0: segment (EDGE_CACHE L2)', (await kvStore('EDGE_CACHE').get(`cache:s0:api:/api/movies${unique}`)) !== null);
      check('legacy un-sharded global key NOT written', (await kvStore('EDGE_CACHE').get(`cache:api:/api/movies${unique}`)) === null);
      check('upstream saw x-animaxia-shard: 0 (global)', cloud.calls.length === 1 && cloud.calls[0].shard === '0');

      ({ response } = await edgeFetch(env, `/api/movies${unique}`, { headers: { 'x-animaxia-tenant': 'acme' } }));
      check('gateway acme response carries x-animaxia-shard: 1 (tenant hash, FAZA 14)', response.headers.get(SHARD_HEADER) === String(acmeShard));
      check(`gateway acme cache key has the t:acme:s${acmeShard}: segment`, (await kvStore('EDGE_CACHE').get(`cache:t:acme:s${acmeShard}:api:/api/movies${unique}`)) !== null);
      check('upstream saw x-animaxia-shard: 1 (tenant acme)', cloud.calls.length === 2 && cloud.calls[1].shard === '1');

      ({ response } = await edgeFetch(env, `/api/movies${unique}`, { headers: { [SHARD_HEADER]: '2' } }));
      check('gateway honors a valid client shard header end-to-end (2)', response.headers.get(SHARD_HEADER) === '2');
      check(`client-header shard isolates its own cache key (s2:)`, (await kvStore('EDGE_CACHE').get(`cache:s2:api:/api/movies${unique}`)) !== null);
      check('upstream saw x-animaxia-shard: 2 (client override)', cloud.calls.length === 3 && cloud.calls[2].shard === '2');

      // --- /edge/status advertises the sharding layer ---------------------
      ({ response } = await edgeFetch(env, '/edge/status'));
      const status = await response.json();
      check('/edge/status exposes sharding config (FAZA 13)', status.config?.sharding?.header === SHARD_HEADER && status.config?.sharding?.defaultShard === 0 && status.config?.sharding?.cacheKeyIsolation === true);

      // --- sub-worker key formats (ai / search / player) ------------------
      await edgeFetch(env, '/ai/rag/recommend', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: 'shard-suite', limit: 1 }),
      });
      await flushServiceWaitUntils();
      const embKeys = kvStore('EMBEDDINGS_CACHE').dumpKeys();
      check('ai worker writes shard-scoped global keys (s0:ans:rag:…)', embKeys.some((k) => k.startsWith('s0:ans:rag:')));
      check('ai worker legacy un-sharded ans: key NOT written', !embKeys.some((k) => /^ans:rag:/.test(k)));

      await edgeFetch(env, '/search?q=shard-suite');
      check('search worker catalog snapshot key is s0:catalog:v1 (global)', (await kvStore('SEARCH_CACHE').get('s0:catalog:v1', 'json')) !== null);

      await edgeFetch(env, '/player/sources/1');
      check('player worker sources cache key is s0:player:sources:1', (await kvStore('EDGE_CACHE').get('cache:s0:player:sources:1')) !== null);
    }
  } finally {
    restoreFetch();
    restoreCaches();
  }

  console.log(`\n────────────────────────────────────────`);
  console.log(`smoke: ${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log('failures:');
    for (const f of failures) console.log(`  ✗ ${f}`);
  }
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('smoke suite crashed:', err);
  process.exit(1);
});
