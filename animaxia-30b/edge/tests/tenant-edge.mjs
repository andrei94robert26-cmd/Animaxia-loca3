#!/usr/bin/env bun
/**
 * tests/tenant-edge.mjs — FAZA 11 hermetic multi-tenant suite for the
 * Animaxia edge layer. Runs the REAL worker modules (gateway + auth + ai +
 * search + player) through tests/local-harness.ts against an in-process
 * stubbed cloud + HLS origin: no network, no Cloudflare credentials.
 *
 *   bun tests/tenant-edge.mjs        (from animaxia-edge/)
 *
 * Covers (FAZA 11 task 11-4):
 *   1. shared/tenant.ts unit semantics (slug validation, key prefixes)
 *   2. tenant-aware JWT dual-path verification (auth worker /auth/verify)
 *   3. gateway tenant resolution + x-animaxia-tenant forwarding to origin
 *   4. gateway per-tenant response-cache isolation (same path, 3 tenants)
 *   5. gateway per-tenant rate-limit buckets (user scoped per tenant)
 *   6. ai worker per-tenant L1 answer cache (ans:rag / emb:vec keys)
 *   7. search worker per-tenant catalog snapshots (KV keys t:<slug>:catalog:v1)
 *   8. player worker per-tenant HLS allowlist (KV override, global fallback)
 *   9. legacy behavior: no tenant signal anywhere → identical to pre-FAZA-11
 *  10. tenant + shard key isolation (FAZA 13: s<shard>: segment after the
 *      tenant prefix — t:<slug>:s<N>:…, global → s0:…)
 *
 * Exits non-zero when any check fails.
 */

import {
  makeEnv,
  edgeFetch,
  callWorker,
  resetHarness,
  installFetchStub,
  installCaches,
  cachesStub,
  kvStore,
  flushServiceWaitUntils,
} from './local-harness.ts';
import authWorker from '../auth/src/index.ts';
import { edgeSignJwt, sha256Hex, resetSecretCache } from '../shared/jwt.ts';
import { resetConfigCache } from '../shared/config.ts';
import {
  TENANT_HEADER,
  GLOBAL_TENANT,
  isValidTenantSlug,
  tenantKeyPrefix,
  tenantCatalogKey,
  tenantPlayerAllowlistKey,
  tenantUserKey,
  resolveTenantSlug,
  resetTenantAllowlistCache,
} from '../shared/tenant.ts';
import { SHARD_HEADER, computeShardIdFromTenant } from '../shared/shard.ts'; // FAZA 13 sharding

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

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });

/* ------------------------------------------------------------ stub data ---- */

const CATALOG = [
  { id: 1, type: 'anime', title: 'Naruto', metadata: { year: '2002', genres: ['action'], rating: 8.4 }, thumbnail: 'https://img/naruto.jpg' },
  { id: 2, type: 'movie', title: 'Sintel', metadata: { year: '2010', rating: 8.0 }, thumbnail: 'https://img/sintel.jpg' },
];

const PLAYER_PAYLOAD = {
  content: { id: 1, title: 'Naruto', type: 'anime', thumbnail: 'https://img/naruto.jpg' },
  mode: 'hybrid',
  allowedTypes: ['m3u8', 'mp4'],
  sources: [
    { type: 'm3u8', url: 'https://test-streams.mux.dev/x/manifest.m3u8', label: 'HLS demo' },
    { type: 'mp4', url: 'https://cdn.example.com/bunny.mp4', label: 'MP4 demo' },
  ],
  primary: null,
  nextUp: null,
};

const MASTER_M3U8 = ['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=800000', '360/playlist.m3u8', ''].join('\n');

const cloud = {
  calls: [],          // { path, tenant } — the tenant header the origin received
  allCalls: 0,
};

function tenantOf(call) {
  return call.tenant;
}

function callsFor(path) {
  return cloud.calls.filter((c) => c.path === path);
}

async function cloudHandler({ url, headers }) {
  const path = url.pathname;
  const tenant = headers.get(TENANT_HEADER) || '(none)';
  cloud.calls.push({ path: `${path}${url.search}`, tenant, headerSeen: headers.get(TENANT_HEADER) });
  cloud.allCalls += 1;
  if (path === '/api/health') return json({ status: 'ok', db: { connected: true, totalItems: CATALOG.length }, cache: { hitRate: 0 }, rateLimit: { trackedClients: 0 }, providers: [], player: {}, ai: {} });
  if (path === '/api/all') return json({ data: CATALOG, totalPages: 1, total: CATALOG.length });
  if (path === '/api/search/advanced') return json({ took: 1, total: CATALOG.length, max_score: 5, data: CATALOG });
  if (path === '/api/ai/rag/recommend') return json({ ok: true, provider: 'stub', mode: 'recommendations', data: CATALOG });
  if (path === '/api/vector/search') return json({ ok: true, backend: 'pgvector', data: CATALOG });
  if (path === '/api/mobile/player/1') return json(PLAYER_PAYLOAD);
  return json({ ok: true, path });
}

async function hlsHandler({ url }) {
  if (url.pathname.endsWith('.ts')) return new Response(new Uint8Array(188 * 4).fill(0x47), { status: 200 });
  return new Response(MASTER_M3U8, { status: 200, headers: { 'content-type': 'application/vnd.apple.mpegurl' } });
}

/* ---------------------------------------------------------------- main ----- */

const JWT_SECRET = 'tenant-suite-secret';

async function setConfig(patch) {
  await kvStore('EDGE_CONFIG').setJson('config', patch);
  resetConfigCache();
}

async function main() {
  console.log('Animaxia Edge — FAZA 11 tenant suite (hermetic, real worker code, stub cloud)');
  resetHarness();
  resetSecretCache();
  resetTenantAllowlistCache();

  const env = makeEnv({
    env: { JWT_SECRET, EDGE_ADMIN_JWT: 'admin-jwt', EDGE_INTERNAL_TOKEN: 'internal-token' },
  });

  const restoreFetch = installFetchStub({
    '127.0.0.1': cloudHandler,
    'test-streams.mux.dev': hlsHandler,
  });
  const restoreCaches = installCaches(cachesStub());

  /* Tenant-signing helper — mirrors the monolith derivation. */
  const tenantSecret = (slug) => sha256Hex(`${JWT_SECRET}:tenant:${slug}`);
  const signTenant = async (slug, sub = 42) => {
    const secret = slug === GLOBAL_TENANT ? JWT_SECRET : await tenantSecret(slug);
    const payload = { sub, email: 'qa@animaxia.test', plan: 'free', typ: 'access' };
    if (slug !== GLOBAL_TENANT) payload.tenant = slug;
    return edgeSignJwt(payload, secret, 900);
  };

  try {
    /* ============================================ 1. shared/tenant unit ==== */
    suite('1. shared/tenant.ts unit semantics');
    {
      check('isValidTenantSlug: acme ✓, GLOBAL ✓, bad ✗', isValidTenantSlug('acme') && isValidTenantSlug('global') && !isValidTenantSlug('Bad Slug') && !isValidTenantSlug('-nope'));
      check('tenantKeyPrefix: global → "" (legacy keys unchanged)', tenantKeyPrefix('global') === '');
      check('tenantKeyPrefix: acme → "t:acme:"', tenantKeyPrefix('acme') === 't:acme:');
      check('tenantCatalogKey: demo → t:demo:catalog:v1', tenantCatalogKey('demo', 'catalog:v1') === 't:demo:catalog:v1');
      check('tenantCatalogKey: global → catalog:v1 (legacy)', tenantCatalogKey('global', 'catalog:v1') === 'catalog:v1');
      check('tenantUserKey: acme → t:acme:user:42', tenantUserKey('acme', 42) === 't:acme:user:42');
      check('tenantUserKey: global → user:42 (legacy)', tenantUserKey('global', 42) === 'user:42');
      check('tenantPlayerAllowlistKey', tenantPlayerAllowlistKey('acme') === 't:acme:player:allowlist');
      const req = (h) => new Request('https://edge.animaxia.test/api/all', { headers: h });
      check('resolveTenantSlug: header wins', resolveTenantSlug(req({ [TENANT_HEADER]: 'demo' }), { tenant: 'acme' }) === 'demo');
      check('resolveTenantSlug: JWT claim fallback', resolveTenantSlug(req({}), { tenant: 'acme' }) === 'acme');
      check('resolveTenantSlug: default global', resolveTenantSlug(req({}), null) === 'global');
      check('resolveTenantSlug: invalid header ignored', resolveTenantSlug(req({ [TENANT_HEADER]: 'BAD SLUG' }), null) === 'global');
    }

    /* ====================================== 2. tenant-aware JWT verify ===== */
    suite('2. tenant-aware JWT dual-path verification');
    {
      const acmeTok = await signTenant('acme');
      const demoTok = await signTenant('demo');
      const legacyTok = await edgeSignJwt({ sub: 42, email: 'qa@animaxia.test', plan: 'free', typ: 'access' }, JWT_SECRET, 900);

      // Auth worker GET /auth/verify — acme token signed with the derived secret.
      let { response } = await callWorker(authWorker, new Request('https://edge.animaxia.test/auth/verify', {
        method: 'GET', headers: { authorization: `Bearer ${acmeTok}` },
      }), env);
      check('acme tenant token verifies (200)', response.status === 200);
      let body = await response.json();
      check('verify response carries tenant=acme', body.tenant === 'acme');

      // Legacy token (base secret, no claim) — unchanged behavior.
      ({ response } = await callWorker(authWorker, new Request('https://edge.animaxia.test/auth/verify', {
        method: 'GET', headers: { authorization: `Bearer ${legacyTok}` },
      }), env));
      check('legacy token still verifies (200)', response.status === 200);
      body = await response.json();
      check('legacy token → tenant=global', body.tenant === 'global');

      // Forged: tenant claim but base-secret signature → rejected.
      const forged = await edgeSignJwt({ sub: 42, typ: 'access', tenant: 'acme' }, JWT_SECRET, 900);
      ({ response } = await callWorker(authWorker, new Request('https://edge.animaxia.test/auth/verify', {
        method: 'GET', headers: { authorization: `Bearer ${forged}` },
      }), env));
      check('forged tenant claim + base signature → 401', response.status === 401);

      // Cross-tenant: signed for demo, claim says acme → rejected.
      void demoTok;
      const crossTok = await edgeSignJwt({ sub: 42, typ: 'access', tenant: 'acme' }, await tenantSecret('demo'), 900);
      ({ response } = await callWorker(authWorker, new Request('https://edge.animaxia.test/auth/verify', {
        method: 'GET', headers: { authorization: `Bearer ${crossTok}` },
      }), env));
      check('cross-tenant secret mismatch → 401', response.status === 401);

      // Expired tenant token → 401.
      const expired = await edgeSignJwt({ sub: 42, typ: 'access', tenant: 'acme' }, await tenantSecret('acme'), -10);
      ({ response } = await callWorker(authWorker, new Request('https://edge.animaxia.test/auth/verify', {
        method: 'GET', headers: { authorization: `Bearer ${expired}` },
      }), env));
      check('expired tenant token → 401', response.status === 401);
    }

    /* ============================ 3. gateway tenant forwarding ============= */
    suite('3. gateway tenant resolution + origin forwarding');
    {
      cloud.calls = [];
      // Header signal (anonymous).
      let { response } = await edgeFetch(env, '/api/health', { headers: { [TENANT_HEADER]: 'acme' } });
      check('anonymous + X-Animaxia-Tenant → 200', response.status === 200);
      check('origin received tenant=acme', callsFor('/api/health').length === 1 && tenantOf(callsFor('/api/health')[0]) === 'acme');

      // JWT claim signal (authorized — different user to dodge rate buckets).
      const demoTok = await (async () => {
        const sec = await tenantSecret('demo');
        return edgeSignJwt({ sub: 77, typ: 'access', tenant: 'demo' }, sec, 900);
      })();
      ({ response } = await edgeFetch(env, '/api/auth/me', { headers: { authorization: `Bearer ${demoTok}`, [TENANT_HEADER]: '' } }));
      check('JWT tenant claim request → 200', response.status === 200);
      check('origin received tenant=demo (from JWT claim)', callsFor('/api/auth/me').length === 1 && tenantOf(callsFor('/api/auth/me')[0]) === 'demo');

      // No signal → global forwarded explicitly.
      await edgeFetch(env, '/api/auth/me');
      check('no tenant signal → origin received global', callsFor('/api/auth/me').length === 2 && tenantOf(callsFor('/api/auth/me')[1]) === 'global');

      // /edge/status advertises the multi-tenant layer.
      ({ response } = await edgeFetch(env, '/edge/status'));
      const body = await response.json();
      check('/edge/status exposes multiTenant config', body.config?.multiTenant?.header === TENANT_HEADER && body.config?.multiTenant?.defaultTenant === 'global');
    }

    /* ======================= 4. gateway per-tenant cache isolation ========= */
    suite('4. gateway per-tenant response-cache isolation');
    {
      cloud.calls = [];
      // /api/all is on the default cacheable prefixes and we send no auth.
      let { response } = await edgeFetch(env, '/api/all', { headers: { [TENANT_HEADER]: 'acme' } });
      check('acme GET /api/all → 200', response.status === 200);
      check('acme first call → MISS', response.headers.get('x-edge-cache') === 'MISS');

      ({ response } = await edgeFetch(env, '/api/all', { headers: { [TENANT_HEADER]: 'acme' } }));
      check('acme second call → HIT', response.headers.get('x-edge-cache') === 'HIT');

      ({ response } = await edgeFetch(env, '/api/all', { headers: { [TENANT_HEADER]: 'demo' } }));
      check('demo same path → MISS (isolated cache entry)', response.headers.get('x-edge-cache') === 'MISS');

      ({ response } = await edgeFetch(env, '/api/all'));
      check('global same path → MISS (third entry)', response.headers.get('x-edge-cache') === 'MISS');

      check('origin saw exactly 3 /api/all fetches (1 per tenant)', callsFor('/api/all').length === 3);
      const tenants = callsFor('/api/all').map(tenantOf).sort();
      check('each cache fill forwarded its own tenant', JSON.stringify(tenants) === JSON.stringify(['acme', 'demo', 'global']));
    }

    /* ==================== 5. gateway per-tenant rate buckets =============== */
    suite('5. gateway per-tenant rate-limit buckets');
    {
      await setConfig({ rateLimit: { ipPerMin: 600, userPerMin: 1, heavyPerMin: 30 } });
      cloud.calls = [];
      const tok = (slug) => (async () => {
        if (slug === GLOBAL_TENANT) return edgeSignJwt({ sub: 4242, typ: 'access' }, JWT_SECRET, 900);
        return edgeSignJwt({ sub: 4242, typ: 'access', tenant: slug }, await tenantSecret(slug), 900);
      })();

      // user 4242 on tenant acme: 1 allowed, 2nd limited.
      const acme = await tok('acme');
      let { response } = await edgeFetch(env, '/api/auth/me', { headers: { authorization: `Bearer ${acme}` } });
      check('user 4242 @acme call 1 → 200', response.status === 200);
      ({ response } = await edgeFetch(env, '/api/auth/me', { headers: { authorization: `Bearer ${acme}` } }));
      check('user 4242 @acme call 2 → 429 (bucket exhausted)', response.status === 429);

      // Same user id, different tenant → independent bucket.
      const demo = await tok('demo');
      ({ response } = await edgeFetch(env, '/api/auth/me', { headers: { authorization: `Bearer ${demo}` } }));
      check('same user @demo call 1 → 200 (separate bucket)', response.status === 200);

      // Same user id, global tenant → legacy bucket (also separate).
      const glob = await tok(GLOBAL_TENANT);
      ({ response } = await edgeFetch(env, '/api/auth/me', { headers: { authorization: `Bearer ${glob}` } }));
      check('same user @global → 200 (legacy bucket untouched)', response.status === 200);

      await kvStore('EDGE_CONFIG').delete('config');
      resetConfigCache();
    }

    /* ==================== 6. ai worker per-tenant answer cache ============= */
    suite('6. ai worker per-tenant L1/L2 caches');
    {
      cloud.calls = [];
      const ragBody = JSON.stringify({ query: 'ninja adventure', limit: 2 });
      const post = (slug) => edgeFetch(env, '/ai/rag/recommend', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(slug ? { [TENANT_HEADER]: slug } : {}) },
        body: ragBody,
      });

      let { response } = await post('acme');
      check('acme RAG call 1 → 200', response.status === 200);
      check('acme RAG call 1 → miss (x-edge-ai)', response.headers.get('x-edge-ai') === 'miss');
      await flushServiceWaitUntils(); // L1 store runs in ctx.waitUntil

      ({ response } = await post('acme'));
      check('acme RAG call 2 → hit', response.headers.get('x-edge-ai') === 'hit');

      ({ response } = await post('demo'));
      const demoState = response.headers.get('x-edge-ai');
      check('demo same query → NOT hit (isolated answer cache)', demoState !== 'hit');

      // KV holds tenant-scoped answer keys.
      // FAZA 13: shard segment right after the tenant prefix (acme → s1 under FAZA 14 mod 30).
      const acmeShard = computeShardIdFromTenant('acme');
      const acmeKey = `t:acme:s${acmeShard}:ans:rag:${await sha256Hex(`/ai/rag/recommend\n${ragBody}`)}`;
      const raw = await kvStore('EMBEDDINGS_CACHE').get(acmeKey);
      check('EMBEDDINGS_CACHE holds t:acme:s1:ans:rag:* key', raw !== null && String(raw).includes('"ok":true'));
      const legacyKey = `ans:rag:${await sha256Hex(`/ai/rag/recommend\n${ragBody}`)}`;
      check('legacy global key NOT written for tenant acme', (await kvStore('EMBEDDINGS_CACHE').get(legacyKey)) === null);
    }

    /* ==================== 7. search worker per-tenant catalog ============== */
    suite('7. search worker per-tenant catalog snapshots');
    {
      cloud.calls = [];
      let { response } = await edgeFetch(env, `/search?q=${encodeURIComponent('naruto')}`, { headers: { [TENANT_HEADER]: 'acme' } });
      check('acme /search → 200', response.status === 200);
      const body = await response.json();
      check('acme /search answered from edge + tenant echo', body.ok === true && body.source === 'edge' && body.tenant === 'acme');

      // The snapshot went into the tenant-scoped KV key, not the legacy one.
      // FAZA 13: shard segment right after the tenant prefix (acme → s1 under FAZA 14 mod 30).
      const scoped = await kvStore('SEARCH_CACHE').get(`t:acme:s${computeShardIdFromTenant('acme')}:catalog:v1`, 'json');
      check('SEARCH_CACHE holds t:acme:s1:catalog:v1 snapshot', scoped !== null && Array.isArray(scoped.items) && scoped.items.length === CATALOG.length);
      const legacy = await kvStore('SEARCH_CACHE').get('catalog:v1', 'json');
      check('legacy catalog:v1 key untouched by acme traffic', legacy === null);

      // /search/health?tenant=acme peeks the tenant snapshot.
      ({ response } = await edgeFetch(env, '/search/health?tenant=acme'));
      const health = await response.json();
      check('/search/health?tenant=acme shows the snapshot', health.ok === true && health.tenant === 'acme' && health.catalog?.items === CATALOG.length);
    }

    /* ==================== 8. player per-tenant HLS allowlist =============== */
    suite('8. player worker per-tenant allowlist');
    {
      resetTenantAllowlistCache();
      // Global allowlist narrowed to a host nobody uses; acme gets its own
      // KV allowlist containing the real HLS host.
      await setConfig({ player: { allowHosts: ['unused.example.com'] } });
      await kvStore('EDGE_CACHE').put(tenantPlayerAllowlistKey('acme'), JSON.stringify(['test-streams.mux.dev']));

      // Tenant acme → KV allowlist allows the HLS host (manifest route).
      let { response } = await edgeFetch(env, '/player/manifest/1', { headers: { [TENANT_HEADER]: 'acme' } });
      check('acme /player/manifest/1 → 200', response.status === 200);
      check('acme manifest rewritten at the edge (x-edge-player)', response.headers.get('x-edge-player') === 'rewritten');
      const manifestBody = await response.text();
      check('acme manifest body has the rewritten variant line', manifestBody.includes('/player/manifest/variant?src='));

      // Global tenant → narrowed global allowlist blocks the same host.
      ({ response } = await edgeFetch(env, '/player/manifest/1'));
      check('global /player/manifest/1 → 403 host_not_allowed (KV override only for acme)', response.status === 403);
      const err = await response.json();
      check('403 names the tenant (global)', err?.tenant === 'global');

      await kvStore('EDGE_CACHE').delete(tenantPlayerAllowlistKey('acme'));
      await kvStore('EDGE_CONFIG').delete('config');
      resetConfigCache();
      resetTenantAllowlistCache();
    }

    /* ============================ 9. legacy no-signal behavior ============= */
    suite('9. legacy behavior (no tenant signal)');
    {
      cloud.calls = [];
      const legacyTok = await edgeSignJwt({ sub: 99, email: 'legacy@animaxia.test', plan: 'free', typ: 'access' }, JWT_SECRET, 900);
      const { response } = await edgeFetch(env, '/api/auth/me', { headers: { authorization: `Bearer ${legacyTok}` } });
      check('legacy token through gateway → 200', response.status === 200);
      check('origin saw tenant=global', callsFor('/api/auth/me').length === 1 && tenantOf(callsFor('/api/auth/me')[0]) === 'global');
    }

    /* ==================== 10. tenant + shard key isolation (FAZA 13) ======= */
    suite('10. tenant + shard key isolation (FAZA 13)');
    {
      // Stable tenant→shard mapping (default SHARDCOUNT 30 (FAZA 14)).
      check('tenant shards: demo → 6, acme → 1 (fnv1a stable under mod 30)', computeShardIdFromTenant('demo') === 6 && computeShardIdFromTenant('acme') === 1);

      // Same path under two tenants (+ global) → different keys, each carrying
      // its shard segment right after the tenant prefix.
      const unique = `?shard-iso=${Date.now()}`;
      const acme = await edgeFetch(env, `/api/all${unique}`, { headers: { [TENANT_HEADER]: 'acme' } });
      check('acme request echoes its resolved shard (1)', acme.response.headers.get(SHARD_HEADER) === '1');
      const demo = await edgeFetch(env, `/api/all${unique}`, { headers: { [TENANT_HEADER]: 'demo' } });
      check('demo request echoes its resolved shard (6)', demo.response.headers.get(SHARD_HEADER) === '6');
      const glob = await edgeFetch(env, `/api/all${unique}`);
      check('global request echoes shard 0', glob.response.headers.get(SHARD_HEADER) === '0');

      const keys = kvStore('EDGE_CACHE').dumpKeys('cache:').filter((k) => k.includes(`/api/all${unique}`));
      check(
        '3 isolated gateway cache entries (t:acme:s1: / t:demo:s6: / s0:)',
        keys.length === 3
          && keys.includes(`cache:t:acme:s1:api:/api/all${unique}`)
          && keys.includes(`cache:t:demo:s6:api:/api/all${unique}`)
          && keys.includes(`cache:s0:api:/api/all${unique}`),
        JSON.stringify(keys),
      );
      check('a tenant hashing to shard 6 (demo) produces t:demo:s6: keys', keys.some((k) => k.includes('t:demo:s6:')));
      check('no un-sharded legacy key for the same path', !keys.includes(`cache:api:/api/all${unique}`) && !keys.includes(`cache:t:acme:api:/api/all${unique}`));
    }
  } finally {
    restoreFetch();
    restoreCaches();
  }

  console.log('\n────────────────────────────────────────────────────────────');
  console.log(`tenant suite: ${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log('\nfailures:');
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('tenant suite crashed:', err);
  process.exit(1);
});
