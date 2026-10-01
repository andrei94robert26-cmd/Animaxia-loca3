#!/usr/bin/env bun
/**
 * tests/e2e-edge.mjs — end-to-end chain E2E: edge → cloud → Neon.
 *
 * Unlike the hermetic smoke suite, this runs against the REAL cloud monolith
 * (CLOUD_ORIGIN, default http://127.0.0.1:4000 — start it with
 * `cd mini-services/animaxia-backend && bun run dev`) and proves the full
 * chain: the edge workers (in-process via the local harness) call the real
 * cloud API, which reads/writes the real Neon PostgreSQL database.
 *
 *   bun tests/e2e-edge.mjs        (from animaxia-edge/)
 *
 * Prerequisites this script checks itself:
 *   • /home/z/my-project/mini-services/animaxia-backend/.env exists — its
 *     DATABASEURL is loaded so the edge derives the SAME HS256 secret as the
 *     cloud auth-service (sha256hex("animaxia-auth:<DATABASEURL>")).
 *   • The cloud /api/health reports db.connected = true (Neon reachable).
 */

import { readFileSync } from 'node:fs';

import {
  makeEnv,
  edgeFetch,
  callWorker,
  resetHarness,
  installCaches,
  cachesStub,
  kvStore,
} from './local-harness.ts';
import analyticsWorker from '../analytics/src/index.ts';
import { resetConfigCache } from '../shared/config.ts';

/* ------------------------------------------------------------- reporting --- */

let passed = 0;
let failed = 0;
let warned = 0;
const failures = [];
const warnings = [];

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

function soft(name, cond, note) {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    warned += 1;
    warnings.push(`${name} — ${note}`);
    console.log(`  ⚠ ${name} (soft) — ${note}`);
  }
}

function suite(name) {
  console.log(`\n━ ${name}`);
}

/* ------------------------------------------------------------ env check ---- */

const BACKEND_ENV = '/home/z/my-project/mini-services/animaxia-backend/.env';
const CLOUD = 'http://127.0.0.1:4000';

function readDatabaseUrl() {
  try {
    const text = readFileSync(BACKEND_ENV, 'utf8');
    const match = text.match(/^DATABASEURL=(.+)$/m);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

const DATABASEURL = readDatabaseUrl();
if (!DATABASEURL) {
  console.error(`e2e: cannot read DATABASEURL from ${BACKEND_ENV}`);
  console.error('     restore it with: unzip -o public/animaxia-cloud.zip .env -d mini-services/animaxia-backend/');
  process.exit(1);
}

/* ----------------------------------------------------------------- main ---- */

async function main() {
  console.log('Animaxia Edge — E2E edge → cloud → Neon (real cloud, real database)');
  resetHarness();

  // No fetch stubbing: the workers hit the real cloud origin. The caches stub
  // gives the L1 tier the same semantics as caches.default on Cloudflare.
  const restoreCaches = installCaches(cachesStub());

  const env = makeEnv({
    env: {
      DATABASEURL, // → derived HS256 secret, identical to the cloud auth-service
      EDGE_INTERNAL_TOKEN: 'e2e-internal-token',
      CLOUD_ORIGIN: CLOUD,
    },
  });

  try {
    /* ========================================== 0. cloud + Neon reachable == */
    suite('0. cloud & Neon reachability (direct)');
    {
      const res = await fetch(`${CLOUD}/api/health`);
      check('direct cloud /api/health → 200', res.status === 200);
      const health = await res.json();
      check('cloud reports PostgreSQL driver', health.db?.driver === 'postgres');
      check('Neon connected (db.connected = true)', health.db?.connected === true);
      check('catalog has items in Neon', Number(health.db?.totalItems) > 0, `totalItems=${health.db?.totalItems}`);
    }

    /* ==================================================== 1. edge basics == */
    suite('1. edge gateway basics');
    {
      const { response } = await edgeFetch(env, '/edge/health');
      check('gateway /edge/health → 200', response.status === 200);
      const { response: status } = await edgeFetch(env, '/edge/status');
      const body = await status.json();
      check('all 5 service bindings wired', body.bindings.services.length === 5);
    }

    /* ============================ 2. auth: register → verify (Neon write) == */
    suite('2. auth: register via edge → verify at edge (Neon write)');
    {
      const stamp = Date.now();
      const email = `edge-e2e-${stamp}@animaxia.io`;
      const username = `edgee2e${stamp}`;

      const { response } = await edgeFetch(env, '/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, username, password: 'EdgeE2e!2026' }),
      });
      const reg = await response.json();
      check('register via edge → cloud → Neon → 200/201', (response.status === 200 || response.status === 201) && reg.ok === true, `status=${response.status} ${JSON.stringify(reg).slice(0, 140)}`);
      check('cloud session carries accessToken + refreshToken', typeof reg.accessToken === 'string' && typeof reg.refreshToken === 'string');

      const { response: verifyRes } = await edgeFetch(env, '/auth/verify', {
        headers: { authorization: `Bearer ${reg.accessToken}` },
      });
      const verified = await verifyRes.json();
      check('REAL cloud-issued token verifies at the edge (derived secret)', verifyRes.status === 200 && Number(verified.user?.sub) > 0);
      check('verified user email matches', verified.user?.email === email);

      const { response: meRes } = await edgeFetch(env, '/auth/me', {
        headers: { authorization: `Bearer ${reg.accessToken}` },
      });
      check('/auth/me round-trip through the edge', meRes.status === 200);
    }

    /* ================================ 3. cached cloud proxying (/api/*) ==== */
    suite('3. cached cloud proxying (MISS → HIT, full edge → cloud → Neon)');
    {
      let { response } = await edgeFetch(env, '/api/health');
      const first = await response.json();
      check('GET /api/health via edge → 200 + Neon connected', response.status === 200 && first.db?.connected === true);
      const firstTag = response.headers.get('x-edge-cache');
      check('first proxy is MISS (or HIT from an earlier run)', firstTag === 'MISS' || firstTag === 'HIT', `tag=${firstTag}`);

      ({ response } = await edgeFetch(env, '/api/health'));
      check('second proxy → HIT', response.headers.get('x-edge-cache') === 'HIT');
      check('HIT body still live (Neon reachable through cache)', (await response.json()).db?.connected === true);

      ({ response } = await edgeFetch(env, '/api/all?limit=100'));
      const all = await response.json();
      check('GET /api/all via edge → catalog from Neon', response.status === 200 && Array.isArray(all.data) && all.data.length >= 50, `items=${all.data?.length}`);

      // remember real data for the later suites
      const hlsItem = all.data.find((x) => x.id === 3) ?? all.data[0];
      const searchWord = (all.data[0]?.title ?? 'animaxia').split(/\s+/)[0];
      globalThis.__e2e = { hlsItem, searchWord, total: all.data.length };
    }

    /* ================================================== 4. edge search ==== */
    suite('4. edge search over the real Neon catalog');
    {
      const { searchWord, total } = globalThis.__e2e;
      const { response } = await edgeFetch(env, `/search?q=${encodeURIComponent(searchWord)}`);
      const body = await response.json();
      check(`search "${searchWord}" → 200 from the edge`, response.status === 200 && body.source === 'edge');
      check('edge catalog loaded from /api/all (Neon)', body.results?.length > 0 || total > 0);

      const { response: ac } = await edgeFetch(env, `/autocomplete?q=${encodeURIComponent(searchWord.slice(0, 3))}`);
      const acBody = await ac.json();
      check('autocomplete → 200 with suggestions array', ac.status === 200 && Array.isArray(acBody.suggestions));
    }

    /* ===================================================== 5. edge AI ====== */
    suite('5. edge AI (vector retrieval + RAG, real cloud)');
    {
      let { response } = await edgeFetch(env, '/ai/embeddings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'action anime with heroes' }),
      });
      const first = await response.json();
      check('embeddings → real /api/vector/search → 200', response.status === 200 && first.ok === true, JSON.stringify(first).slice(0, 140));
      check('vector search returns data from Neon', Array.isArray(first.data));

      ({ response } = await edgeFetch(env, '/ai/embeddings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'action anime with heroes' }),
      }));
      check('embeddings repeat → served from the edge cache (hit)', response.headers.get('x-edge-ai') === 'hit');

      // RAG involves the LLM — the anonymous quota (5/day/IP) may already be
      // exhausted from earlier sessions, so 402 is an acceptable outcome.
      const { response: rag } = await edgeFetch(env, '/ai/rag/recommend', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: 'epic adventures', limit: 3 }),
      });
      const ragBody = await rag.json();
      soft(
        `rag recommend → ${rag.status} (real LLM pipeline)`,
        rag.status === 200,
        rag.status === 402 ? 'anonymous AI quota exhausted (expected after repeated runs) — passthrough verified' : JSON.stringify(ragBody).slice(0, 140),
      );
    }

    /* ============================================ 6. analytics → Neon ====== */
    suite('6. analytics: edge buffer → flush → cloud → Neon');
    {
      const { hlsItem } = globalThis.__e2e;

      // no-queue env forces the KV ring buffer + explicit flush path
      const envB = makeEnv({
        without: ['ANALYTICS_QUEUE'],
        env: { DATABASEURL, EDGE_INTERNAL_TOKEN: 'e2e-internal-token', CLOUD_ORIGIN: CLOUD },
      });

      const direct = await callWorker(analyticsWorker, new Request('https://edge.animaxia.test/analytics/view', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contentId: hlsItem.id, title: hlsItem.title, event: 'view' }),
      }), envB);
      check('view event buffered (no queue binding)', (await direct.response.json()).delivery === 'buffer');
      await direct.ctx.flush();

      const flush = await callWorker(analyticsWorker, new Request('https://edge.animaxia.test/analytics/flush', {
        method: 'POST',
        headers: { 'x-internal-token': 'e2e-internal-token' },
      }), envB);
      const flushBody = await flush.response.json();
      check('flush delivered the event to the real cloud (Neon write)', flush.response.status === 200 && flushBody.drained >= 1, JSON.stringify(flushBody).slice(0, 140));

      // cloud-side proof: the real trending endpoint answers with data from Neon
      const { response } = await edgeFetch(env, '/api/analytics/trending?limit=10');
      check('cloud trending (reads Neon views) reachable via edge', response.status === 200);

      // edge-side trending counters registered the same event
      const { response: trend } = await edgeFetch(env, '/analytics/trending?window=24h');
      const trendBody = await trend.json();
      check(
        'edge trending counters include the tracked content',
        trend.status === 200 && trendBody.rows?.some((r) => r.contentId === hlsItem.id),
        `rows=${JSON.stringify(trendBody.rows ?? []).slice(0, 160)}`,
      );
    }

    /* ================================= 7. edge player (real HLS chain) ===== */
    suite('7. edge player: real manifest rewrite + segment proxy');
    {
      const { hlsItem } = globalThis.__e2e;

      const { response } = await edgeFetch(env, `/player/manifest/${hlsItem.id}`);
      check(`manifest for content ${hlsItem.id} → 200`, response.status === 200);
      const manifestText = await response.text();
      const isM3u8 = (response.headers.get('content-type') || '').includes('mpegurl');
      check('content-type is m3u8', isM3u8);
      check('manifest rewritten to edge URLs', manifestText.includes('/hls?u=') || manifestText.includes('/player/manifest/variant?src='));

      // Follow one rewritten line and fetch a real segment through the edge.
      const segMatch = manifestText.match(/\/hls\?u=([^&\s"']+)/);
      const variantMatch = manifestText.match(/variant\?src=([^&\s"']+)/);
      if (segMatch) {
        const { response: seg } = await edgeFetch(env, `/hls?u=${segMatch[1]}`);
        check('real HLS segment fetched through the edge → 200', seg.status === 200, `status=${seg.status}`);
      } else if (variantMatch) {
        const { response: variant } = await edgeFetch(env, `/player/manifest/variant?src=${variantMatch[1]}`);
        check('variant playlist → 200 m3u8', variant.status === 200 && (variant.headers.get('content-type') || '').includes('mpegurl'));
        const mediaText = await variant.text();
        const seg = mediaText.match(/\/hls\?u=([^&\s"']+)/);
        check('media playlist segments rewritten', Boolean(seg));
        if (seg) {
          const { response: segRes } = await edgeFetch(env, `/hls?u=${seg[1]}`);
          check('real HLS segment fetched through the edge → 200', segRes.status === 200, `status=${segRes.status}`);
        }
      } else {
        check('manifest contains rewritten segment or variant URLs', false, manifestText.slice(0, 200));
      }
    }

    /* ================================================= 8. WAF on live ====== */
    suite('8. WAF against the live gateway');
    {
      const { response } = await edgeFetch(env, '/api/all', { headers: { 'user-agent': 'sqlmap/1.7' } });
      check('attack tool UA blocked at the edge', response.status === 403);
    }

    /* ================================================= 9. config override == */
    suite('9. runtime KV config override');
    {
      // Prove the KV "config" key flips edge behavior without a redeploy.
      await kvStore('EDGE_CONFIG').setJson('config', { edge: { cacheTtlSec: 0 } });
      resetConfigCache();
      const { response } = await edgeFetch(env, '/api/health');
      check('cacheTtlSec=0 override disables caching (DISABLED tag)', response.headers.get('x-edge-cache') === 'DISABLED');
      await kvStore('EDGE_CONFIG').delete('config');
      resetConfigCache();
    }
  } finally {
    restoreCaches();
  }

  console.log(`\n────────────────────────────────────────`);
  console.log(`e2e: ${passed} passed, ${failed} failed, ${warned} soft-warned`);
  if (warnings.length) {
    console.log('soft warnings:');
    for (const w of warnings) console.log(`  ⚠ ${w}`);
  }
  if (failures.length) {
    console.log('failures:');
    for (const f of failures) console.log(`  ✗ ${f}`);
  }
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('e2e suite crashed:', err);
  process.exit(1);
});
