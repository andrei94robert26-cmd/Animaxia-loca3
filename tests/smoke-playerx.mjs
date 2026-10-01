#!/usr/bin/env bun
/**
 * smoke-playerx.mjs — FAZA 34 (PLAN 100X · WS4): stratul player experience.
 *
 * Verifică END-TO-END, direct contra backend-ului (:4000, ca smoke-faza21),
 * contractul înghețat al modului playerx (FAZA-34-b/c construiesc pe EXACT
 * aceste forme):
 *   S1  /api/playerx/status — formă completă + contoare oneste
 *   S2  /api/playerx/markers/:id — estimări deterministe: anime intro 2/90,
 *       tv recap+intro(+outro), movie onest [] ; 400 id invalid ; 404 inexistent
 *   S3  markers curați (auth): upsert → override → cache invalidat → DELETE →
 *       înapoi la estimat ; 401 fără token ; 400 body invalid
 *   S4  /markers/use — contorul skipUses crește (KPI WS4) ; 400 kind invalid
 *   S5  /subtitle-settings — 401 anonim ; PUT valid + GET roundtrip ; 400 cu
 *       câmpul vinovat numit (fontFamily / fontSizePct / lipsă textColor)
 *   S6  voturi party — creare party real (FAZA 10 protejat, doar consumat),
 *       vot membru, vot non-membru 403, al doilea utilizator, egalitate
 *       departajată determinist (votul cel mai devreme), închidere DOAR de
 *       gazdă (403 altfel), petrecere încheiată → 404 + curățare leneșă
 *   S7  REGRESIE PROTEJATĂ: /api/content/:id/player (FAZA 17), /api/search/
 *       autocomplete (FAZA 18), /api/hub/stats (FAZA 20), /api/ai/suite/status
 *       (FAZA 32), /api/searchaccel/status (FAZA 29-P), /api/searchux/status
 *       (FAZA 33) — toate neatinsе.
 *
 * Determinism (rulabil de mai multe ori la rând):
 *   • useri de test FRESH per rulare (nonce în email/username — ca faza21);
 *   • markerul curat din S3 e șters la final (și preventiv la început —
 *     idempotent chiar și după un run eșuat);
 *   • petrecerea din S6 e încheiată de gazdă la final, iar voturile stocate
 *     sunt curățate leneș de GET-ul 404 final (votes.json revine curat);
 *   • setările de subtitrări rămân în data/playerx/settings.json sub cheile
 *     userid-urilor de test de unică folosință (inerte, documentat onest);
 *   • toate comparațiile de contoare sunt RELATIVE (before/after), nu absolute;
 *   • fiecare rulare folosește un X-Forwarded-For unic (TEST-NET-2, doc-only)
 *     => bucket de rate-limit izolat de traficul de pe 127.0.0.1.
 *
 * Usage:  bun tests/smoke-playerx.mjs
 * Env:    API_ORIGIN  default http://127.0.0.1:4000
 */

const BASE = process.env.API_ORIGIN || 'http://127.0.0.1:4000';
const NONCE = Date.now();
const XFF = `198.51.100.${100 + (NONCE % 100)}`; // TEST-NET-2 (documentație) — izolare rate-limit

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

async function call(method, path, { token, body, timeoutMs = 30000 } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'X-Forwarded-For': XFF,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json, headers: res.headers };
}

const get = (path, token, opts) => call('GET', path, { token, ...opts });
const post = (path, body, token, opts) => call('POST', path, { body, token, ...opts });
const put = (path, body, token, opts) => call('PUT', path, { body, token, ...opts });
const del = (path, token, opts) => call('DELETE', path, { token, ...opts });

/* ---------------------------------- setup ----------------------------------- */

console.log(`── Setup: useri fresh + conținut real descoperit la runtime (BASE=${BASE}, XFF=${XFF}) ──`);

async function registerUser(label) {
  const email = `faza34-${label}-${NONCE}@animaxia.local`;
  const username = `fz34${label}${NONCE % 100000}`;
  const { status, body } = await post('/api/auth/register', { email, username, password: `faza34-pass-${label}` });
  if (status !== 201 || !body?.accessToken) {
    console.error(`SETUP FAILED: register ${label} → ${status} ${JSON.stringify(body).slice(0, 120)}`);
    process.exit(1);
  }
  return { id: body.user.id, username, token: body.accessToken };
}

const userA = await registerUser('a'); // gazda petrecerii + markeri curați + setări
const userB = await registerUser('b'); // al doilea votant (membru)
const userC = await registerUser('c'); // non-membru (doar pentru 403)
console.log(`  useri: A=${userA.id} B=${userB.id} C=${userC.id}`);

async function firstContent(type, predicate = () => true, limit = 50) {
  const { status, body } = await get(`/api/all?limit=${limit}&type=${type}`);
  if (status !== 200 || !Array.isArray(body?.data) || body.data.length === 0) return null;
  return body.data.find(predicate) ?? body.data[0];
}

const animeA = await firstContent('anime'); // S2 — estimări (read-only)
const animeB = (await firstContent('anime', (c) => c.id !== animeA?.id)) ?? animeA; // S3 — marker curat
const movieA = await firstContent('movie', () => true, 10); // S2 — onest []
const tvA = await firstContent('tv', (c) => Number(c?.metadata?.runtime) >= 25); // S2 — recap+intro+outro
if (!animeA || !movieA || !tvA) {
  console.error(`SETUP FAILED: conținut real lipsă (anime=${Boolean(animeA)} movie=${Boolean(movieA)} tv=${Boolean(tvA)})`);
  process.exit(1);
}
const tvDurSec = Number(tvA?.metadata?.duration) > 0
  ? Number(tvA.metadata.duration)
  : Number(tvA?.metadata?.runtime) * 60;
console.log(`  conținut: animeA=#${animeA.id} animeB=#${animeB.id} movieA=#${movieA.id} tvA=#${tvA.id} (runtime ${tvA.metadata.runtime}min)`);

/* curățare preventivă: dacă un run anterior a eșuat în S3, markerul curat
 * rămas pe animeB ar strica determinismul — DELETE idempotent înainte de test */
await del(`/api/playerx/markers/${animeB.id}/intro`, userA.token);

console.log('\n════════ S1 · /api/playerx/status — formă + contoare oneste ════════');
let statusBefore;
{
  const { status, body } = await get('/api/playerx/status');
  statusBefore = body;
  ok('S1.1 status 200 + ok', status === 200 && body?.ok === true, `got ${status}`);
  ok('S1.2 service=playerx phase=faza-34', body?.service === 'playerx' && body?.phase === 'faza-34');
  ok('S1.3 storage file + storageDir data/playerx', body?.storage === 'file' && body?.storageDir === 'data/playerx');
  ok('S1.4 uptimeSec/generatedAt oneste', typeof body?.uptimeSec === 'number' && body.uptimeSec >= 0 && !Number.isNaN(Date.parse(body?.generatedAt ?? '')));
  const s = body?.stats ?? {};
  const keys = ['markersCurated', 'markersRequests', 'skipUses', 'settingsSaved', 'votesCast', 'votesClosed', 'activeVotes'];
  ok(
    'S1.5 stats complet (7 contoare) și ≥ 0',
    keys.every((k) => typeof s[k] === 'number' && s[k] >= 0),
    JSON.stringify(s),
  );
}

console.log('\n════════ S2 · /markers/:id — estimări deterministe (public) ════════');
{
  const bad1 = await get('/api/playerx/markers/abc');
  ok('S2.1 400 la id invalid (abc)', bad1.status === 400 && bad1.body?.error === 'ID invalid', `got ${bad1.status}`);
  const bad2 = await get('/api/playerx/markers/0');
  ok('S2.2 400 la id 0', bad2.status === 400, `got ${bad2.status}`);
  const missing = await get('/api/playerx/markers/999999');
  ok('S2.3 404 la conținut inexistent', missing.status === 404 && missing.body?.error === 'Conținut inexistent', `got ${missing.status}`);

  const anime = await get(`/api/playerx/markers/${animeA.id}`);
  const intro = (anime.body?.data ?? []).find((m) => m.kind === 'intro');
  ok(
    'S2.4 anime → intro estimat 2..90 determinist',
    anime.status === 200 && intro && intro.startsec === 2 && intro.endsec === 90 && intro.source === 'estimated' && intro.label === 'Intro',
    JSON.stringify(anime.body?.data ?? []).slice(0, 140),
  );
  ok('S2.5 anime → notă de confirmare prezentă (doar estimat)', anime.body?.note === 'markeri estimați determinist — confirmă-i pentru a-i salva');
  const cacheHeader = String(anime.headers?.get('cache-control') ?? '');
  ok('S2.6 header Cache-Control public max-age=60', /public/.test(cacheHeader) && /max-age=60/.test(cacheHeader), cacheHeader);

  const movie = await get(`/api/playerx/markers/${movieA.id}`);
  ok(
    'S2.7 movie → onest, zero markeri (fără estimări inventate)',
    movie.status === 200 && Array.isArray(movie.body?.data) && movie.body.data.length === 0 && !('note' in (movie.body ?? {})),
    JSON.stringify(movie.body ?? {}).slice(0, 120),
  );

  const tv = await get(`/api/playerx/markers/${tvA.id}`);
  const data = tv.body?.data ?? [];
  const recap = data.find((m) => m.kind === 'recap');
  const tvIntro = data.find((m) => m.kind === 'intro');
  const outro = data.find((m) => m.kind === 'outro');
  ok(
    'S2.8 tv → recap 0..42 + intro 48..110 estimate',
    tv.status === 200 && recap && recap.startsec === 0 && recap.endsec === 42 && recap.source === 'estimated' &&
      tvIntro && tvIntro.startsec === 48 && tvIntro.endsec === 110,
    JSON.stringify(data.map((m) => `${m.kind}:${m.startsec}-${m.endsec}`)),
  );
  if (tvDurSec > 300) {
    ok(
      'S2.9 tv lung → outro max(170, dur-90)..dur-6',
      outro && outro.startsec === Math.max(170, tvDurSec - 90) && outro.endsec === tvDurSec - 6,
      `outro=${JSON.stringify(outro)} dur=${tvDurSec}`,
    );
  } else {
    ok('S2.9 tv scurt → fără outro (durationSec ≤ 300)', !outro);
  }
  const startsecs = data.map((m) => m.startsec);
  ok('S2.10 markerii sunt sortați crescător pe startsec', startsecs.every((v, i) => i === 0 || startsecs[i - 1] <= v), JSON.stringify(startsecs));
}

console.log('\n════════ S3 · markers curați — ciclul de viață (auth) ════════');
{
  const anon = await post(`/api/playerx/markers/${animeB.id}`, { kind: 'intro', startsec: 5, endsec: 80 });
  ok('S3.1 POST fără token → 401', anon.status === 401, `got ${anon.status}`);

  const badBody = await post(`/api/playerx/markers/${animeB.id}`, { kind: 'intro', startsec: 50, endsec: 50 }, userA.token);
  ok('S3.2 POST endsec ≤ startsec → 400', badBody.status === 400, `got ${badBody.status}`);
  const badKind = await post(`/api/playerx/markers/${animeB.id}`, { kind: 'opening', startsec: 5, endsec: 80 }, userA.token);
  ok('S3.3 POST kind invalid → 400', badKind.status === 400, `got ${badKind.status}`);
  const badContent = await post('/api/playerx/markers/999999', { kind: 'intro', startsec: 5, endsec: 80 }, userA.token);
  ok('S3.4 POST conținut inexistent → 404', badContent.status === 404 && badContent.body?.error === 'Conținut inexistent', `got ${badContent.status}`);

  const upsert = await post(`/api/playerx/markers/${animeB.id}`, { kind: 'intro', startsec: 5, endsec: 80 }, userA.token);
  ok(
    'S3.5 POST upsert → marker curat',
    upsert.status === 200 && upsert.body?.ok === true && upsert.body?.marker?.source === 'curated' &&
      upsert.body.marker.startsec === 5 && upsert.body.marker.endsec === 80 && upsert.body.marker.id === 'intro',
    JSON.stringify(upsert.body ?? {}).slice(0, 140),
  );

  const after = await get(`/api/playerx/markers/${animeB.id}`);
  const introAfter = (after.body?.data ?? []).find((m) => m.kind === 'intro');
  ok(
    'S3.6 GET reflectă override-ul (cache invalidat)',
    after.status === 200 && introAfter && introAfter.startsec === 5 && introAfter.endsec === 80 && introAfter.source === 'curated',
    JSON.stringify(after.body?.data ?? []),
  );
  ok('S3.7 GET fără markeri estimați → nota dispare', !('note' in (after.body ?? {})));

  const anonDel = await del(`/api/playerx/markers/${animeB.id}/intro`);
  ok('S3.8 DELETE fără token → 401', anonDel.status === 401, `got ${anonDel.status}`);
  const removed = await del(`/api/playerx/markers/${animeB.id}/intro`, userA.token);
  ok('S3.9 DELETE → ok', removed.status === 200 && removed.body?.ok === true, `got ${removed.status}`);

  const back = await get(`/api/playerx/markers/${animeB.id}`);
  const introBack = (back.body?.data ?? []).find((m) => m.kind === 'intro');
  ok(
    'S3.10 GET → înapoi la estimat 2..90',
    introBack && introBack.startsec === 2 && introBack.endsec === 90 && introBack.source === 'estimated',
    JSON.stringify(back.body?.data ?? []),
  );
  const delMissing = await del(`/api/playerx/markers/${animeB.id}/intro`, userA.token);
  ok('S3.11 DELETE marker inexistent → 404', delMissing.status === 404, `got ${delMissing.status}`);
}

console.log('\n════════ S4 · /markers/use — contorul KPI „utilizare skip-intro" ════════');
{
  const before = statusBefore?.stats?.skipUses ?? 0;
  const bad = await post('/api/playerx/markers/use', { contentId: animeA.id, kind: 'bogus' });
  ok('S4.1 kind invalid → 400', bad.status === 400, `got ${bad.status}`);
  const badId = await post('/api/playerx/markers/use', { contentId: -7, kind: 'intro' });
  ok('S4.2 contentId invalid → 400', badId.status === 400, `got ${badId.status}`);
  const used = await post('/api/playerx/markers/use', { contentId: animeA.id, kind: 'intro' });
  ok(
    'S4.3 POST use → ok + skipUses incrementat',
    used.status === 200 && used.body?.ok === true && typeof used.body?.skipUses === 'number' && used.body.skipUses >= before + 1,
    `before=${before} after=${used.body?.skipUses}`,
  );
  const statusNow = await get('/api/playerx/status');
  ok(
    'S4.4 /status reflectă contorul durabil',
    (statusNow.body?.stats?.skipUses ?? -1) >= before + 1,
    `status.skipUses=${statusNow.body?.stats?.skipUses} before=${before}`,
  );
}

console.log('\n════════ S5 · /subtitle-settings — validare strictă + roundtrip ════════');
{
  const anon = await get('/api/playerx/subtitle-settings');
  ok('S5.1 GET anonim → 401', anon.status === 401, `got ${anon.status}`);

  const settings = {
    fontFamily: 'Trebuchet MS',
    fontSizePct: 120,
    textColor: '#ffffff',
    bgColor: '#000000',
    bgOpacity: 0.5,
    edge: 'shadow',
    position: 'bottom',
    marginPct: 4,
  };
  const saved = await put('/api/playerx/subtitle-settings', settings, userA.token);
  ok('S5.2 PUT valid → ok', saved.status === 200 && saved.body?.ok === true, `got ${saved.status} ${JSON.stringify(saved.body).slice(0, 80)}`);

  const roundtrip = await get('/api/playerx/subtitle-settings', userA.token);
  const got = roundtrip.body?.settings ?? {};
  const same = Object.keys(settings).every((k) => got[k] === settings[k]) && Object.keys(got).length === Object.keys(settings).length;
  ok('S5.3 GET roundtrip — egalitate exactă pe toate cele 8 câmpuri', roundtrip.status === 200 && same, JSON.stringify(got));

  const badFont = await put('/api/playerx/subtitle-settings', { ...settings, fontFamily: 'Comic Sans' }, userA.token);
  ok('S5.4 PUT font invalid → 400 cu fontFamily numit', badFont.status === 400 && /fontFamily/.test(String(badFont.body?.error)), JSON.stringify(badFont.body));

  const badSize = await put('/api/playerx/subtitle-settings', { ...settings, fontSizePct: 400 }, userA.token);
  ok('S5.5 PUT fontSizePct 400 → 400 cu câmpul numit', badSize.status === 400 && /fontSizePct/.test(String(badSize.body?.error)), JSON.stringify(badSize.body));

  const { textColor, ...missing } = settings;
  void textColor;
  const badMissing = await put('/api/playerx/subtitle-settings', missing, userA.token);
  ok('S5.6 PUT fără textColor → 400 cu câmpul numit', badMissing.status === 400 && /textColor/.test(String(badMissing.body?.error)), JSON.stringify(badMissing.body));
}

console.log('\n════════ S6 · voturi party — pe o petrecere REALĂ (FAZA 10 doar consumată) ════════');
let createdPartyId = null;
{
  /* Creare party real prin API-ul protejat /api/social/party (FAZA 10). */
  const created = await post('/api/social/party', { contentId: animeA.id, title: `FAZA 34 smoke ${NONCE}` }, userA.token);
  if (created.status !== 201 || !created.body?.party?.id) {
    console.error(`SETUP S6 FAILED: creare party → ${created.status} ${JSON.stringify(created.body).slice(0, 120)}`);
    process.exit(1);
  }
  createdPartyId = created.body.party.id;
  console.log(`  party #${createdPartyId} (host ${created.body.party.host.username}, content #${created.body.party.content.id})`);

  const empty = await get(`/api/playerx/party/${createdPartyId}/votes`);
  ok(
    'S6.1 GET voturi goale — open, tally/voters goale, createdAt null',
    empty.status === 200 && empty.body?.status === 'open' && empty.body?.partyId === createdPartyId &&
      empty.body?.contentId === animeA.id && empty.body?.winner === null &&
      Object.keys(empty.body?.tally ?? {}).length === 0 && (empty.body?.voters ?? []).length === 0 &&
      empty.body?.createdAt === null,
    JSON.stringify(empty.body ?? {}).slice(0, 160),
  );

  const voteA = await post(`/api/playerx/party/${createdPartyId}/vote`, { contentId: animeA.id }, userA.token);
  ok(
    'S6.2 gazda (membru) votează → tally {animeA:1}',
    voteA.status === 200 && voteA.body?.tally?.[String(animeA.id)] === 1 && voteA.body?.voters?.length === 1,
    JSON.stringify(voteA.body ?? {}).slice(0, 140),
  );

  const joined = await post(`/api/social/party/${createdPartyId}/join`, {}, userB.token);
  ok('S6.3 al doilea utilizator se alătură petrecerii', joined.status === 200 && joined.body?.ok === true, `got ${joined.status}`);

  const voteB = await post(`/api/playerx/party/${createdPartyId}/vote`, { contentId: movieA.id }, userB.token);
  ok(
    'S6.4 al doilea membru votează alt titlu → egalitate 1-1',
    voteB.status === 200 && voteB.body?.tally?.[String(animeA.id)] === 1 && voteB.body?.tally?.[String(movieA.id)] === 1 &&
      voteB.body?.voters?.length === 2,
    JSON.stringify(voteB.body ?? {}).slice(0, 160),
  );

  const state = await get(`/api/playerx/party/${createdPartyId}/votes`);
  ok(
    'S6.5 GET — tally + votanți în ordinea votării + createdAt/updatedAt setate',
    state.status === 200 && state.body?.status === 'open' && state.body?.voters?.[0]?.userid === userA.id &&
      state.body?.voters?.[1]?.userid === userB.id && state.body?.createdAt !== null && state.body?.updatedAt !== null,
    JSON.stringify(state.body ?? {}).slice(0, 160),
  );

  const nonMember = await post(`/api/playerx/party/${createdPartyId}/vote`, { contentId: animeA.id }, userC.token);
  ok('S6.6 non-membru → 403 „Doar membrii pot vota"', nonMember.status === 403 && nonMember.body?.error === 'Doar membrii pot vota', JSON.stringify(nonMember.body));

  const notHost = await del(`/api/playerx/party/${createdPartyId}/votes`, userB.token);
  ok('S6.7 DELETE de non-gazdă → 403', notHost.status === 403, `got ${notHost.status}`);

  const closed = await del(`/api/playerx/party/${createdPartyId}/votes`, userA.token);
  ok(
    'S6.8 DELETE de gazdă → închidere + câștigător departajat determinist (votul cel mai devreme)',
    closed.status === 200 && closed.body?.ok === true && closed.body?.winner === animeA.id &&
      closed.body?.tally?.[String(animeA.id)] === 1 && closed.body?.tally?.[String(movieA.id)] === 1,
    JSON.stringify(closed.body ?? {}),
  );

  const afterClose = await get(`/api/playerx/party/${createdPartyId}/votes`);
  ok(
    'S6.9 GET după închidere — status closed + winner păstrat',
    afterClose.status === 200 && afterClose.body?.status === 'closed' && afterClose.body?.winner === animeA.id,
    JSON.stringify(afterClose.body ?? {}).slice(0, 140),
  );

  /* Curățare: gazda părăsește petrecerea → status ended → voturile stocate
   * se curăță leneș la următorul GET (contract: 404 + prune). */
  const left = await post(`/api/social/party/${createdPartyId}/leave`, {}, userA.token);
  ok('S6.10 curățare: gazda părăsește petrecerea (ended)', left.status === 200 && left.body?.status === 'ended', JSON.stringify(left.body));

  const pruned = await get(`/api/playerx/party/${createdPartyId}/votes`);
  ok(
    'S6.11 petrecere încheiată → 404 «Petrecere inexistentă sau încheiată» + curățare leneșă',
    pruned.status === 404 && pruned.body?.error === 'Petrecere inexistentă sau încheiată',
    JSON.stringify(pruned.body),
  );

  const badParty = await get('/api/playerx/party/99999/votes');
  ok('S6.12 petrecere inexistentă → 404', badParty.status === 404, `got ${badParty.status}`);
  const badPartyId = await get('/api/playerx/party/abc/votes');
  ok('S6.13 id petrecere invalid → 400', badPartyId.status === 400, `got ${badPartyId.status}`);

  const statusAfter = await get('/api/playerx/status');
  ok(
    'S6.14 /status — activeVotes revenit la bază (votul test a fost închis+curățat)',
    (statusAfter.body?.stats?.activeVotes ?? -1) === (statusBefore?.stats?.activeVotes ?? 0),
    `before=${statusBefore?.stats?.activeVotes} after=${statusAfter.body?.stats?.activeVotes}`,
  );
  ok(
    'S6.15 /status — votesCast/votesClosed au crescut onest',
    (statusAfter.body?.stats?.votesCast ?? -1) > (statusBefore?.stats?.votesCast ?? 0) &&
      (statusAfter.body?.stats?.votesClosed ?? -1) > (statusBefore?.stats?.votesClosed ?? 0),
    `cast ${statusBefore?.stats?.votesCast}→${statusAfter.body?.stats?.votesCast}, closed ${statusBefore?.stats?.votesClosed}→${statusAfter.body?.stats?.votesClosed}`,
  );
}

console.log('\n════════ S7 · REGRESIE PROTEJATĂ (FAZA 17 / 18 / 20 / 29-P / 32 / 33) ════════');
{
  const player = await get(`/api/content/${animeA.id}/player`, null, { timeoutMs: 30000 });
  ok('S7.1 FAZA 17 player resolver neatins (200)', player.status === 200, `got ${player.status}`);

  const ac = await get('/api/search/autocomplete?q=dragon', null, { timeoutMs: 60000 });
  ok('S7.2 FAZA 18 autocomplete neatins (200)', ac.status === 200, `got ${ac.status}`);

  const hub = await get('/api/hub/stats', null, { timeoutMs: 30000 });
  ok('S7.3 FAZA 20 hub neatins (200)', hub.status === 200, `got ${hub.status}`);

  const suite = await get('/api/ai/suite/status', null, { timeoutMs: 30000 });
  ok(
    'S7.4 FAZA 32 AI suite neatinsă (18 motoare)',
    suite.status === 200 && Object.keys(suite.body?.engines ?? {}).length === 18,
    `engines=${Object.keys(suite.body?.engines ?? {}).length}`,
  );

  const accel = await get('/api/searchaccel/status', null, { timeoutMs: 30000 });
  ok('S7.5 FAZA 29-P accel neatins (service=searchaccel)', accel.status === 200 && accel.body?.service === 'searchaccel', `got ${accel.status}`);

  const searchux = await get('/api/searchux/status', null, { timeoutMs: 30000 });
  ok('S7.6 FAZA 33 searchux neatins (service=searchux)', searchux.status === 200 && searchux.body?.service === 'searchux', `got ${searchux.status}`);

  const health = await get('/api/health', null, { timeoutMs: 30000 });
  ok(
    'S7.7 /api/health 200 + totalItems 18925 (zero regresie de date)',
    health.status === 200 && health.body?.db?.totalItems === 18925,
    `totalItems=${health.body?.db?.totalItems}`,
  );
}

console.log('\n══════════════════════════════════════════════');
console.log(`REZULTAT: ${passed} PASSED · ${failed} FAILED`);
if (failed > 0) {
  console.log('\nEșecuri:');
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log('✅ FAZA 34 playerx — TOATE verificările verzi. Contractul înghețat respectat; player-ul FAZA 17 și suite-urile protejate neatinsе.');
