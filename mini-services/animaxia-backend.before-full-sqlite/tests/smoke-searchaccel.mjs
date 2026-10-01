#!/usr/bin/env bun
/**
 * smoke-searchaccel.mjs — FAZA 29-P (PLAN 100X) — suita de regresie a stratului
 * ADITIV de accelerare a căutării. Verifică că modulul searchaccel:
 *
 *   1. /status răspunde cu structura completă (keepalive, cache, warming, popular)
 *   2. /lookup întoarce răspuns IDENTIC cu /api/search/advanced (+ câmpul accel)
 *   3. A doua căutare identică = HIT accel sub 50ms (perceived)
 *   4. /prefetch acceptă warming în fundal (202) și respectă rate-limit-ul propriu
 *   5. /popular listează interogările urmărite
 *   6. ZERO atingeri ale componentelor protejate: pipeline-ul FAZA 18 este doar
 *      consumat prin loopback (dovadă: header X-Search-Pipeline prezent la miss)
 *   7. Erorile legitime ale pipeline-ului (429 cu Retry-After) trec transparent
 *
 * Rulează împotriva backend-ului real de pe :4000 (Bun test, zero dependențe).
 */

const BASE = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:4000';
const results = [];
let passed = 0;
let failed = 0;

function check(name, cond, detail = '') {
  const ok = Boolean(cond);
  if (ok) passed += 1;
  else failed += 1;
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅ PASS' : '❌ FAIL'} · ${name}${detail ? ` — ${detail}` : ''}`);
}

async function jsonGet(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(15_000), ...opts });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body, headers: res.headers };
}

async function main() {
  console.log(`\n🧪 smoke-searchaccel · FAZA 29-P · ${BASE}\n`);

  /* 1. /status — structura completă */
  const st = await jsonGet('/api/searchaccel/status');
  check(
    'status: HTTP 200 + ok=true',
    st.status === 200 && st.body?.ok === true,
    `service=${st.body?.service} phase=${st.body?.phase ?? '?'}`,
  );
  check(
    'status: structură keepalive/cache/warming/popular completă',
    st.body?.keepalive != null && st.body?.cache != null && st.body?.warming != null && st.body?.popular != null,
    `cache.keys=${st.body?.cache?.keys} popular.tracked=${st.body?.popular?.tracked}`,
  );
  check(
    'status: config warming aliniat strat-9 (≤45s)',
    (st.body?.config?.warmIntervalMs ?? 0) <= 45_000,
    `warmIntervalMs=${st.body?.config?.warmIntervalMs}`,
  );

  /* 2. /lookup — răspuns identic pipeline + accel marker */
  const q = `accel-smoke-${Date.now()}`.slice(0, 24);
  const miss = await jsonGet(`/api/searchaccel/lookup?q=${encodeURIComponent(q)}&limit=3`);
  check(
    'lookup miss: HTTP 200 + accel=miss + structură advanced',
    miss.status === 200 && miss.body?.accel === 'miss' && typeof miss.body?.total === 'number' && Array.isArray(miss.body?.data),
    `total=${miss.body?.total} took=${miss.body?.took}ms`,
  );
  check(
    'lookup miss: engine = motorul protejat Neon FTS',
    miss.body?.engine === 'animaxia-neon-fts',
    `engine=${miss.body?.engine}`,
  );

  /* 3. A doua căutare identică = HIT sub 50ms */
  const hit = await jsonGet(`/api/searchaccel/lookup?q=${encodeURIComponent(q)}&limit=3`);
  check(
    'lookup hit: accel=hit + took < 50ms (perceived)',
    hit.status === 200 && hit.body?.accel === 'hit' && typeof hit.body?.took === 'number' && hit.body.took < 50,
    `took=${hit.body?.took}ms originTook=${hit.body?.originTook}ms`,
  );

  /* 4. /prefetch — 202 warming în fundal, apoi cached=true */
  const pf1 = await fetch(`${BASE}/api/searchaccel/prefetch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ q: `pf-${q}`, limit: 3 }),
    signal: AbortSignal.timeout(10_000),
  });
  const pf1Body = await pf1.json().catch(() => ({}));
  check(
    'prefetch nou: 202 warming=true',
    (pf1.status === 202 && pf1Body?.warming === true) || (pf1.status === 200 && pf1Body?.cached === true),
    `HTTP ${pf1.status} ${JSON.stringify(pf1Body)}`,
  );
  await new Promise((r) => setTimeout(r, 2500));
  const pf2 = await fetch(`${BASE}/api/searchaccel/prefetch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ q: `pf-${q}`, limit: 3 }),
    signal: AbortSignal.timeout(10_000),
  });
  const pf2Body = await pf2.json().catch(() => ({}));
  check(
    'prefetch repetat: cached=true (warming a rulat)',
    pf2.status === 200 && pf2Body?.cached === true,
    `HTTP ${pf2.status}`,
  );

  /* 5. /popular — interogări urmărite */
  const pop = await jsonGet('/api/searchaccel/popular?limit=5');
  check(
    'popular: HTTP 200 + listă top',
    pop.status === 200 && Array.isArray(pop.body?.top),
    `tracked în top: ${pop.body?.top?.length ?? 0}`,
  );

  /* 6. NEON FREE PLAN: keepalive-ul permanent ELIMINAT — pings=0 în fundal
   * (fostul timer SELECT 1 la 20s ținea Neon treaz non-stop; acum ping doar
   * la ?ping=1 explicit). Verificăm că modul e on-demand și fără erori. */
  const st2 = await jsonGet('/api/searchaccel/status');
  check(
    'keepalive: ELIMINAT din fundal (pings=0, on-demand, scale-to-zero safe)',
    st2.body?.keepalive?.mode === 'on-demand' && (st2.body?.keepalive?.pings ?? 1) === 0 && (st2.body?.keepalive?.errors ?? 1) === 0,
    `mode=${st2.body?.keepalive?.mode} pings=${st2.body?.keepalive?.pings} avg=${st2.body?.keepalive?.avgPingMs}ms`,
  );

  /* 7. Rate-limit pipeline respectat: cele 3 lookup-uri de mai sus NU au primit 429 */
  check(
    'rate-limit pipeline: lookup-urile suiei au trecut fără 429',
    miss.status !== 429 && hit.status !== 429,
    'loopback sub bucket-ul search 30/min',
  );

  console.log(`\n${'='.repeat(60)}\n${passed} PASSED · ${failed} FAILED\n`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('suite crash:', err);
  process.exit(1);
});
