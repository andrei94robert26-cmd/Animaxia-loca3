#!/usr/bin/env bun
/**
 * smoke-searchux.mjs — FAZA 33 (PLAN 100X · WS3): stratul UX de căutare.
 *
 * Verifică END-TO-END (prin gateway-ul public :81, identic cu instanța publică):
 *   S1  /api/searchux/status — formă completă + reaper ops activ
 *   S2  /suggest — sugestii reale prin pipeline-ul protejat (loopback), cache
 *       hit la al doilea apel identic (0ms), did-you-mean onest la greșeli de
 *       tastare (fuzzy pe stratul UX, NU în motor), rate-limit 400 la q gol
 *   S3  /trending — pool anonimizat (fără IP/identitate), track accepted
 *   S4  /facets — fațete reale per căutare (tip/gen/ani/surse cu numărători),
 *       cache hit la repeat, whitelist filtre
 *   S5  REGRESIE PROTEJATĂ: /api/search/autocomplete (FAZA 18) neatins,
 *       /api/searchaccel/status (FAZA 29-P) neatins, /api/hub/browse (FAZA 20)
 *       neatins, /api/ai/suite/status (FAZA 32) 18/18
 *
 * Regula de aur respectată: ZERO modificări pe componentele protejate —
 * searchux doar LE CONSUMĂ prin loopback; testul verifică că rămân intacte.
 */

const GW = process.env.GW_URL || 'http://127.0.0.1:81';
let passed = 0;
let failed = 0;
const failures = [];

function ok(name, cond, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`  ✅ ${name}`);
  } else {
    failed += 1;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function getJson(path, { timeoutMs = 30000 } = {}) {
  const res = await fetch(`${GW}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function postJson(path, payload) {
  const res = await fetch(`${GW}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

console.log('\n════════ S1 · /api/searchux/status — formă + reaper ════════');
{
  const { status, body } = await getJson('/api/searchux/status?XTransformPort=4000');
  ok('S1.1 status 200', status === 200, `got ${status}`);
  ok('S1.2 service=searchux phase=FAZA 33', body?.service === 'searchux' && /FAZA 33/.test(String(body?.phase)));
  ok('S1.3 config onestă (TTL 60s, LRU, rate limit)', body?.config?.ttlMs === 60000 && body?.config?.maxKeys >= 2000);
  ok('S1.4 reaper ops prezent (mitigare curatorScan, event-driven NEON FREE PLAN)', typeof body?.reaper?.reapAfterSec === 'number' && /event-driven/.test(String(body?.reaper?.mode)) && typeof body?.reaper?.runs === 'number');
  ok('S1.5 trending anonimizat', body?.trending?.anonymized === true);
  ok('S1.6 cache backend documentat onest (redis shim PING-only)', /in-process LRU/.test(String(body?.config?.cacheBackend)));
}

console.log('\n════════ S2 · /suggest — instant + cache + did-you-mean ════════');
{
  /* NOTĂ: interogarea de test trebuie să aibă potriviri în motorul protejat
   * (q=dragon → Dragon Ball etc.); comportamentul motorului pentru alte
   * interogări (ex. „pokemon" vs „Pokémon" cu accent) rămâne al său — protejat. */
  const first = await getJson('/api/searchux/suggest?XTransformPort=4000&q=dragon&limit=5', { timeoutMs: 60000 });
  ok('S2.1 primul apel 200', first.status === 200, `got ${first.status}`);
  ok(
    'S2.3 sugestii reale prin pipeline-ul protejat',
    Array.isArray(first.body?.suggestions) && first.body.suggestions.length > 0 &&
      first.body.suggestions.some((s) => /dragon/i.test(String(s.title || ''))),
    JSON.stringify((first.body?.suggestions || []).slice(0, 2)).slice(0, 120),
  );
  const withThumb = (first.body?.suggestions || []).find((s) => s.thumbnail);
  ok('S2.4 sugestii cu thumbnail + rating', Boolean(withThumb));

  /* Cache miss→hit: query UNIC per rulare (fără dependență de starea anterioară). */
  const uniq = `zzq ${Date.CURRENT_TIMESTAMP}`;
  const miss = await getJson(`/api/searchux/suggest?XTransformPort=4000&q=${encodeURIComponent(uniq)}&limit=5`, { timeoutMs: 60000 });
  ok('S2.2 cache=miss la query unic', miss.body?.cache === 'miss', `got ${miss.body?.cache}`);
  const second = await getJson(`/api/searchux/suggest?XTransformPort=4000&q=${encodeURIComponent(uniq)}&limit=5`);
  ok('S2.5 cache=hit la repeat', second.body?.cache === 'hit', `got ${second.body?.cache}`);
  ok('S2.6 hit sub 5ms (instant)', typeof second.body?.took === 'number' && second.body.took < 5, `took=${second.body?.took}ms`);
  const bad = await getJson('/api/searchux/suggest?XTransformPort=4000&q=&limit=5');
  ok('S2.7 400 onest la q gol', bad.status === 400, `got ${bad.status}`);

  /* did-you-mean DETERMINIST: termen unic per rulare (garantat absent din
   * catalog și din cache-ul de 60s) + greșeală de tastare la distanță 1 —
   * motorul nu are NIMIC de potrivit, stratul UX propune corecția. */
  const stamp = Date.CURRENT_TIMESTAMP;
  const trackedTerm = `dymprobe ${stamp} alpha`;
  const typoTerm = `dymprobe ${stamp} alpka`; // distanță Levenshtein 1
  await postJson('/api/searchux/track?XTransformPort=4000', { q: trackedTerm });
  const typo = await getJson(`/api/searchux/suggest?XTransformPort=4000&q=${encodeURIComponent(typoTerm)}&limit=3`, { timeoutMs: 40000 });
  ok('S2.8 typo 200 (miss proaspăt, termen unic)', typo.status === 200 && typo.body?.cache === 'miss', `got ${typo.status} cache=${typo.body?.cache}`);
  const dym = typo.body?.didYouMean || [];
  ok(
    'S2.9 did-you-mean propune termenul corect la distanță 1',
    Array.isArray(dym) && dym.some((c) => c.q === trackedTerm),
    JSON.stringify(dym).slice(0, 140),
  );
  ok('S2.10 did-you-mean fără auto-potrivire (distance>0)', dym.every((c) => c.distance > 0));
}

console.log('\n════════ S3 · /trending + /track — anonimizat ════════');
{
  const track = await postJson('/api/searchux/track?XTransformPort=4000', { q: 'smoke searchux test' });
  ok('S3.1 track 202 accepted', track.status === 202, `got ${track.status}`);
  ok('S3.2 track anonimizat', track.body?.anonymized === true);
  const bad = await postJson('/api/searchux/track?XTransformPort=4000', { q: '' });
  ok('S3.3 track 400 la q gol', bad.status === 400, `got ${bad.status}`);
  const tr = await getJson('/api/searchux/trending?XTransformPort=4000&limit=10');
  ok('S3.4 trending 200', tr.status === 200);
  ok('S3.5 trending conține termenul urmărit', (tr.body?.top || []).some((t) => t.q === 'smoke searchux test'));
  ok('S3.6 trending pool anonimizat (fără IP/user)', tr.body?.anonymized === true && typeof tr.body?.pool === 'number');
  ok(
    'S3.7 trending items au DOAR text+contor (zero identitate)',
    (tr.body?.top || []).every((t) => typeof t.q === 'string' && typeof t.count === 'number' && !('ip' in t) && !('user' in t)),
  );
}

console.log('\n════════ S4 · /facets — fațete per căutare ════════');
{
  const f1 = await getJson('/api/searchux/facets?XTransformPort=4000&q=dragon', { timeoutMs: 60000 });
  ok('S4.1 facets 200', f1.status === 200, `got ${f1.status}`);
  const facets = f1.body?.facets;
  ok('S4.2 fațete prezente (types/genres/years/sources)', Boolean(facets?.types && facets?.genres && facets?.years && facets?.sources));
  ok('S4.3 eșantion din motorul real (sampled>0, total>0)', (f1.body?.sampled ?? 0) > 0 && (f1.body?.total ?? 0) > 0, `sampled=${f1.body?.sampled} total=${f1.body?.total}`);
  ok(
    'S4.4 fațetele au numărători valide',
    [...(facets?.types || []), ...(facets?.genres || [])].every((x) => typeof x.count === 'number' && x.count > 0),
  );
  const f2 = await getJson('/api/searchux/facets?XTransformPort=4000&q=dragon');
  ok('S4.5 cache=hit la repeat', f2.body?.cache === 'hit', `got ${f2.body?.cache}`);
  const f3 = await getJson('/api/searchux/facets?XTransformPort=4000&q=dragon&genre=negatif-inexistent-xyz');
  ok('S4.6 filtrele trec prin whitelist (200 chiar și fără rezultate)', f3.status === 200);
}

console.log('\n════════ S5 · REGRESIE PROTEJATĂ (FAZA 18 / 29-P / 20 / 32) ════════');
{
  const ac = await getJson('/api/search/autocomplete?XTransformPort=4000&q=dragon', { timeoutMs: 60000 });
  ok('S5.1 FAZA 18 autocomplete neatins (200 + sugestii)', ac.status === 200 && (ac.body?.suggestions || []).length > 0, `got ${ac.status}`);
  const accel = await getJson('/api/searchaccel/status?XTransformPort=4000');
  ok('S5.2 FAZA 29-P accel neatins (service=searchaccel)', accel.status === 200 && accel.body?.service === 'searchaccel');
  const hub = await getJson('/api/hub/browse?XTransformPort=4000&limit=4');
  ok('S5.3 FAZA 20 hub neatins (200)', hub.status === 200);
  const suite = await getJson('/api/ai/suite/status?XTransformPort=4000');
  ok(
    'S5.4 FAZA 32 AI suite 18/18 motoare',
    suite.status === 200 && Object.keys(suite.body?.engines || {}).length === 18,
    `engines=${Object.keys(suite.body?.engines || {}).length}`,
  );
  const adv = await getJson('/api/search/advanced?XTransformPort=4000&q=dragon&limit=3', { timeoutMs: 60000 });
  ok('S5.5 FAZA 18 motor FTS integru (engine=animaxia-neon-fts)', adv.body?.engine === 'animaxia-neon-fts', `engine=${adv.body?.engine}`);
}

console.log('\n════════════════════════════════════════════════');
console.log(`REZULTAT: ${passed} PASSED · ${failed} FAILED`);
if (failed > 0) {
  console.log('\nEșecuri:');
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log('✅ FAZA 33 searchux — TOATE verificările verzi. Motorul protejat neatins.');
