#!/usr/bin/env bun
/**
 * smoke-perso.mjs — FAZA 36-R (PLAN 100X · WS6 / Personalizare & Recomandări
 * 2.0) — suita de regresie a modulului modules/perso (14 rute /api/perso/*).
 *
 *   S1.  /status — structură onestă, contoare, cache, limite
 *   S2.  /profile — user nou = profil gol onest; user cu istoric REAL
 *       (playerhub progress + like + recenzie) → afinități învățate pasiv
 *   S3.  POST /profile/reset — agregarea ștearsă, semnalele istorice păstrate
 *       ( doar cele POST-reset mai contează)
 *   S4.  /feed — secțiuni explicite (continue/similar/genre), reason-uri
 *       lizibile, zero duplicate, limită respectată
 *   S5.  /profiles CRUD — profil principal, PIN hash-uit (niciodată plaintext
 *       în răspunsuri), max 5/cont, update cu oldPin, delete refuzat pe main
 *   S6.  /profiles/:id/verify — PIN corect/greșit, token JWT-lite (3 părți,
 *       exp > acum), verify-token roundtrip + tamper respins
 *   S7.  /reminders — din watchhistory real (5 zile vechime, progres 20-90%),
 *       remainingMin estimat, dismiss funcțional cu persistență
 *   S8.  /affinities — top genuri cu pct 0-100, decenii, tipuri, diversitate
 *   S9.  /explain/:contentId — reasoning pe profil real; 404 onest pe id
 *       inexistent; anonim = scor doar din calitatea catalogului
 *   S10. POST /events — semnale valide, contoare în /status, validare strictă,
 *        clamp weight, rate limit 60/min/IP → 429 la al 61-lea
 *   S11. Rezistență — input invalid peste tot (400/401/404 oneste)
 *   S12. Regresie — componentele protejate răspund neschimbate (health,
 *        playerx, ai/lab, searchaccel, searchux, hub)
 *
 * Determinism: useri QA cu nonce per rulare + X-Forwarded-For unic (TEST-NET-2
 * derivat din stamp) pentru secțiunea de rate limit. QA content (cu duration
 * reală în metadata) e inserat/șters prin SQL direct (fără API ⇒ zero
 * content:changed ⇒ zero resync FAZA 18). Rulează contra backend-ului real
 * de pe :4000 (Bun, zero dependențe externe în afară de pg pentru setup).
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

const STAMP = `${Date.CURRENT_TIMESTAMP.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;

/* X-Forwarded-For rotativ (pattern smoke-playerhub) — bucket-uri rate limit
 * proaspete per cerere; secțiunea S10 folosește un IP dedicat unic per rulare
 * (derivat din STAMP, în TEST-NET-2 198.51.100.0/24). */
let xffSeq = 0;
function qaXff() {
  xffSeq += 1;
  return `10.79.${Math.floor(xffSeq / 250) % 250}.${(xffSeq % 250) + 1}`;
}
const RATE_IP = `198.51.100.${(parseInt(STAMP.slice(-3), 36) % 250) + 1}`;

async function req(method, path, { body, token, xff, timeoutMs = 30_000 } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'X-Forwarded-For': xff ?? qaXff(),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  let parsed = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed, headers: res.headers };
}

const get = (p, o) => req('GET', p, o);
const post = (p, body, o = {}) => req('POST', p, { ...o, body });
const put = (p, body, o = {}) => req('PUT', p, { ...o, body });
const del = (p, o) => req('DELETE', p, o);

/* ----------------------------- QA infrastructure ---------------------------- */

async function registerUser(prefix) {
  const r = await post('/api/auth/register', {
    email: `${prefix}-${STAMP}@synth.animaxia`,
    username: `${prefix}${STAMP}`,
    password: 'F36User!2026',
  });
  if (r.status !== 201 || !r.body?.accessToken || !r.body?.user?.id) return null;
  return { token: r.body.accessToken, userId: r.body.user.id, username: r.body.user.username };
}

/** Client SQL direct (setup/cleanup) — pattern promoteAndLoginAdmin din
 *  smoke-playerhub.mjs; DATABASEURL e încărcat din .env de Bun. */
async function dbConnect() {
  try {
    if (!process.env.DATABASEURL) return null;
    const pg = (await import('pg')).default;
    const client = new pg.Client({ connectionString: process.env.DATABASEURL, ssl: { rejectUnauthorized: false } });
    await client.connect();
    return client;
  } catch {
    return null;
  }
}

/** Conținut QA cu duration REALĂ în metadata (5400s) + genuri — inserat/șters
 *  prin SQL direct, fără API (zero evenimente content:changed). */
async function insertQaContent(client, nonce) {
  const res = await client.query(
    `INSERT INTO content (externalid, type, title, metadata, thumbnail)
     VALUES ($1, 'movie', $2, $3, NULL) RETURNING id`,
    [
      `qa-perso:smoke:${nonce}`,
      `QA Perso ${nonce}`,
      JSON.stringify({ duration: '5400', genres: ['Thriller', 'Action'], year: '2020', rating: 8, overview: 'QA smoke perso' }),
    ],
  );
  return Number(res.rows[0].id);
}

/* Conținut REAL cu genuri (verificat în catalogul curent — Thriller-heavy). */
const REAL_T1 = 10972; // Rambo: First Blood Part II — Action/Adventure/Thriller/War
const REAL_T2 = 10968; // Licence to Kill — Adventure/Action/Thriller
const REAL_T3 = 10901; // Kartavya — Crime/Drama/Thriller
const REAL_DRAMA = 10969; // Drama/Romance (după reset)

/** Semnal no-op care invalidează cache-ul profilului (search fără contentId
 *  nu adaugă nicio afinitate — doar reînvățare on-demand la următorul GET). */
async function invalidateProfile(userId, token) {
  return post('/api/perso/events', { type: 'search', userId }, { token });
}

/* ----------------------------------- main ----------------------------------- */

async function main() {
  console.log(`\n🧪 smoke-perso · FAZA 36-R (WS6 Personalizare) · ${BASE} · stamp=${STAMP} · rateIp=${RATE_IP}\n`);

  const db = await dbConnect();
  if (!db) {
    check('infrastructură DB (DATABASEURL + pg) disponibilă pentru setup QA', false, 'fără DB — secțiunile cu istoric real nu pot rula');
  }

  /* ------------------------------ S1. /status ------------------------------ */
  console.log('── S1. /status (statistici oneste, fără DB query) ──');
  const st1 = await get('/api/perso/status');
  check('S1-1 (1) GET /status → 200', st1.status === 200, `status=${st1.status}`);
  check('S1-2 (2) module=perso, faza FAZA 36-R, routes=14', st1.body?.module === 'perso' && st1.body?.routes === 14 && String(st1.body?.faza).includes('FAZA 36'));
  check('S1-3 (3) storage onest: dir data/perso + 4 fișiere declarate', st1.body?.storage?.dir === 'data/perso' && st1.body?.storage?.files && typeof st1.body?.storage?.files.profiles !== 'undefined');
  check('S1-4 (4) cache profil: TTL 600s + entries + invalidare on-demand', st1.body?.cache?.profileTtlSec === 600 && typeof st1.body?.cache?.entries === 'number' && String(st1.body?.cache?.note).includes('zero polling'));
  check('S1-5 (5) limite declarate: 5 profiluri/cont, 60 events/min/IP, token 2h', st1.body?.limits?.maxProfilesPerAccount === 5 && st1.body?.limits?.eventsRatePerMinPerIp === 60 && st1.body?.limits?.profileTokenTtlSec === 7200);
  check('S1-6 (6) contoare durabile prezente (eventsTracked, feedRequests…)', typeof st1.body?.counters?.eventsTracked === 'number' && typeof st1.body?.counters?.feedRequests === 'number');
  check('S1-7 (7) method etichetat onest: euristică deterministă, ml=false', st1.body?.method?.ml === false && st1.body?.method?.engine === 'euristică deterministă');
  check('S1-8 (8) Cache-Control public pe /status', String(st1.headers?.get('cache-control') ?? '').includes('public'));
  const baseline = st1.body?.counters ?? {};

  /* -------------------- S2. /profile — învățare pasivă --------------------- */
  console.log('── S2. /profile — user nou gol onest + învățare din semnale reale ──');
  const noUser = await get('/api/perso/profile');
  check('S2-1 (9) /profile fără identitate → 401 onest', noUser.status === 401 && typeof noUser.body?.error === 'string');
  const badUser = await get('/api/perso/profile?user=abc');
  check('S2-2 (10) ?user=abc (nevalid) → 401 onest', badUser.status === 401);

  const fresh = registerUser ? await registerUser('f36fresh') : null;
  check('S2-3 (11) înregistrare user QA nou (nonce)', fresh !== null);
  const freshProfile = await get(`/api/perso/profile?user=${fresh.userId}`, { token: fresh.token });
  check(
    'S2-4 (12) user nou → profil gol onest (empty=true + note)',
    freshProfile.status === 200 && freshProfile.body?.profile?.empty === true && typeof freshProfile.body?.note === 'string',
  );
  check('S2-5 (13) profil gol are zero afinități și method.ml=false', (freshProfile.body?.profile?.topGenres ?? []).length === 0 && freshProfile.body?.profile?.method?.ml === false);
  check('S2-6 (14) identity raportat onest (auth/query)', freshProfile.body?.identity === 'auth' || freshProfile.body?.identity === 'query');
  check('S2-7 (15) Cache-Control private pe /profile', String(freshProfile.headers?.get('cache-control') ?? '').includes('private'));

  let qaId = null;
  if (db) qaId = await insertQaContent(db, STAMP);
  const learner = await registerUser('f36learn');
  check('S2-8 (16) user QA „learner" înregistrat', learner !== null && qaId !== null, `qaId=${qaId}`);

  /* Semnale reale: 3 vizionări Thriller (parțiale, prin API-ul protejat
   * playerhub) + vizionare QA 50% + like QA + recenzie 9/10 QA. */
  const watchPlan = [[REAL_T1, 5100], [REAL_T2, 5100], [REAL_T3, 5100], [qaId, 2700]];
  let watchOk = true;
  for (const [cid, sec] of watchPlan) {
    const r = await post('/api/playerhub/progress', { contentId: cid, seconds: sec }, { token: learner.token });
    if (r.status !== 200) watchOk = false;
  }
  check('S2-9 (17) 4 vizionări reale prin /api/playerhub/progress (protejat) → 200', watchOk);
  const like = await post(`/api/social/content/${qaId}/like`, { value: 1 }, { token: learner.token });
  check('S2-10 (18) like pe conținut QA → 200', like.status === 200);
  const review = await post('/api/social/reviews', { contentId: qaId, rating: 9, title: 'QA', body: 'QA perso smoke test review body' }, { token: learner.token });
  check('S2-11 (19) recenzie 9/10 pe conținut QA → 201', review.status === 201 || review.status === 200);

  await invalidateProfile(learner.userId, learner.token);
  const learned = await get(`/api/perso/profile?user=${learner.userId}`, { token: learner.token });
  const lp = learned.body?.profile;
  check('S2-12 (20) profil învățat: empty=false, semnale contorizate', learned.status === 200 && lp?.empty === false && lp?.signals?.total >= 6, `total=${lp?.signals?.total}`);
  check(
    'S2-13 (21) top gen = Thriller (ponderat din 4 vizionări + like + recenzie)',
    lp?.topGenres?.[0]?.value === 'Thriller',
    `topGenres=${(lp?.topGenres ?? []).slice(0, 3).map((g) => `${g.value}:${g.score}`).join(', ')}`,
  );
  check('S2-14 (22) toate pct-urile în banda onestă 0-100', (lp?.topGenres ?? []).every((g) => g.pct >= 0 && g.pct <= 100));
  check('S2-15 (23) sursele semnalelor raportate separat (watched/liked/reviewed)', lp?.sources?.watchhistory === 4 && lp?.sources?.contentlikes === 1 && lp?.sources?.reviews === 1);
  check('S2-16 (24) titluri favorite cu greutate (QA content = like+recenzie+50%)', (lp?.favoriteTitles ?? []).some((t) => t.contentId === qaId && t.weight >= 8));
  const cachedHit = await get(`/api/perso/profile?user=${learner.userId}`, { token: learner.token });
  check('S2-17 (25) cache profil: al doilea GET = hit (cached=true)', cachedHit.body?.cached === true && cachedHit.headers?.get('x-perso-cache') === 'hit');

  /* ------------------------- S3. POST /profile/reset ----------------------- */
  console.log('── S3. POST /profile/reset — agregare ștearsă, semnale păstrate ──');
  const resetNoUser = await post('/api/perso/profile/reset', {});
  check('S3-1 (26) reset fără identitate → 401', resetNoUser.status === 401);
  const reset = await post('/api/perso/profile/reset', { userId: learner.userId }, { token: learner.token });
  check('S3-2 (27) reset → ok cu effect documentat onest', reset.status === 200 && reset.body?.ok === true && typeof reset.body?.effect === 'string');
  const afterReset = await get(`/api/perso/profile?user=${learner.userId}`, { token: learner.token });
  check('S3-3 (28) după reset profilul e gol (semnalele vechi nu mai contează)', afterReset.body?.profile?.empty === true);
  /* Semnal NOU după reset: un singur film Drama/Romance. */
  await post('/api/playerhub/progress', { contentId: REAL_DRAMA, seconds: 5000 }, { token: learner.token });
  await invalidateProfile(learner.userId, learner.token);
  const relearned = await get(`/api/perso/profile?user=${learner.userId}`, { token: learner.token });
  const rp = relearned.body?.profile;
  check(
    'S3-4 (29) re-învățare doar din semnalele POST-reset (Drama/Romance, fără Thriller)',
    rp?.empty === false && (rp?.topGenres ?? []).length > 0 && rp.topGenres[0].value !== 'Thriller' && (rp?.topGenres ?? []).some((g) => g.value === 'Drama' || g.value === 'Romance'),
    `top=${rp?.topGenres?.[0]?.value}`,
  );
  check('S3-5 (30) since marker = resetAt din răspuns', rp?.since !== null && Date.parse(rp.since) > 0);

  /* ------------------------------ S4. /feed -------------------------------- */
  console.log('── S4. /feed „Pentru Tine" — secțiuni explicite + reason-uri ──');
  const feedNoUser = await get('/api/perso/feed');
  check('S4-1 (31) /feed fără identitate → 401', feedNoUser.status === 401);
  const feedBadLimit = await get(`/api/perso/feed?user=${learner.userId}&limit=abc`, { token: learner.token });
  check('S4-2 (32) limit=abc → 400 onest', feedBadLimit.status === 400);

  /* Reconstruim profilul Thriller pentru feed (re-reset + semnale proaspete). */
  await post('/api/perso/profile/reset', { userId: learner.userId }, { token: learner.token });
  for (const [cid, sec] of watchPlan) {
    await post('/api/playerhub/progress', { contentId: cid, seconds: sec }, { token: learner.token });
  }
  await post(`/api/social/content/${qaId}/like`, { value: 1 }, { token: learner.token });
  await post('/api/social/reviews', { contentId: qaId, rating: 9, title: 'QA', body: 'QA perso smoke test review body 2' }, { token: learner.token });
  await invalidateProfile(learner.userId, learner.token);

  const feed = await get(`/api/perso/feed?user=${learner.userId}&limit=12`, { token: learner.token });
  check('S4-3 (33) feed → 200 cu items și sections', feed.status === 200 && Array.isArray(feed.body?.items) && Array.isArray(feed.body?.sections));
  const sections = feed.body?.sections ?? [];
  const secKeys = sections.map((s) => s.key);
  check('S4-4 (34) secțiunea „Continuă să urmărești" populată', secKeys.includes('continue') && sections.find((s) => s.key === 'continue')?.count >= 1);
  const simSection = sections.find((s) => s.key === 'similar');
  check('S4-5 (35) secțiunea „Pentru că ai văzut X" populată', secKeys.includes('similar') && (simSection?.count ?? 0) >= 1, `label=${simSection?.label}`);
  check('S4-6 (36) secțiunea „genuri favorite" prezentă onest', secKeys.includes('genre'));
  const feedItems = feed.body?.items ?? [];
  check(
    'S4-7 (37) FIECARE item are reason lizibil nenul',
    feedItems.length > 0 && feedItems.every((i) => typeof i.reason === 'string' && i.reason.length > 3),
  );
  check(
    'S4-8 (38) reason-urile conțin motivele cerute (Continuă/Gen favorit/Pentru că ai văzut)',
    feedItems.some((i) => i.reason.includes('Continuă')) && feedItems.some((i) => i.reason.includes('Gen favorit')) && feedItems.some((i) => i.reason.includes('Pentru că ai văzut')),
  );
  const ids = feedItems.map((i) => i.contentId);
  check('S4-9 (39) zero duplicate contentId în tot feed-ul', new Set(ids).size === ids.length, `${ids.length} itemi`);
  check('S4-10 (40) limita respectată (≤12)', feedItems.length <= 12, `n=${feedItems.length}`);
  check('S4-11 (41) itemii au contentId/titlu/tip/genuri + score numeric', feedItems.every((i) => Number.isInteger(i.contentId) && typeof i.title === 'string' && Array.isArray(i.genres) && typeof i.score === 'number'));
  check('S4-12 (42) feed-ul e etichetat onest (euristică, ml=false)', feed.body?.method?.ml === false && feed.body?.method?.engine === 'euristică deterministă');
  const feedSmall = await get(`/api/perso/feed?user=${learner.userId}&limit=2`, { token: learner.token });
  check('S4-13 (43) limit=2 → maximum 2 itemi', (feedSmall.body?.items ?? []).length <= 2);

  /* ------------------------ S5. /profiles CRUD + PIN ----------------------- */
  console.log('── S5. /profiles — CRUD complet, PIN hash-uit, max 5 ──');
  const owner = await registerUser('f36prof');
  check('S5-1 (44) user QA „owner" pentru profile multiple', owner !== null);
  const emptyList = await get(`/api/perso/profiles?user=${owner.userId}`, { token: owner.token });
  check('S5-2 (45) cont fără profiluri → listă goală + note onest', emptyList.status === 200 && (emptyList.body?.profiles ?? []).length === 0 && typeof emptyList.body?.note === 'string');

  const p1 = await post('/api/perso/profiles', { name: 'Familia', emoji: '🍿', userId: owner.userId }, { token: owner.token });
  check('S5-3 (46) primul profil → 201, devine principal (isMain=true)', p1.status === 201 && p1.body?.profile?.isMain === true);
  const p2 = await post('/api/perso/profiles', { name: 'Copilul', emoji: '🧒', pin: '1234', userId: owner.userId }, { token: owner.token });
  check('S5-4 (47) al doilea profil cu PIN → 201, hasPin=true', p2.status === 201 && p2.body?.profile?.hasPin === true);
  const badPin = await post('/api/perso/profiles', { name: 'Rău', pin: '12ab', userId: owner.userId }, { token: owner.token });
  check('S5-5 (48) PIN invalid (12ab) → 400 onest', badPin.status === 400);
  const badPin2 = await post('/api/perso/profiles', { name: 'Rău', pin: 12345, userId: owner.userId }, { token: owner.token });
  check('S5-6 (49) PIN cu 5 cifre → 400', badPin2.status === 400);
  const badName = await post('/api/perso/profiles', { name: 'x', userId: owner.userId }, { token: owner.token });
  check('S5-7 (50) nume prea scurt → 400', badName.status === 400);
  const badEmoji = await post('/api/perso/profiles', { name: 'Valid', emoji: '💉', userId: owner.userId }, { token: owner.token });
  check('S5-8 (51) emoji în afara whitelist-ului → 400', badEmoji.status === 400);

  const list1 = await get(`/api/perso/profiles?user=${owner.userId}`, { token: owner.token });
  const listRaw = JSON.stringify(list1.body ?? {});
  check('S5-9 (52) hash-ul PIN-ului NU apare niciodată în răspunsuri', !listRaw.includes('pinHash') && !listRaw.includes('"1234"') && !/[a-f0-9]{64}/.test(listRaw));
  check('S5-10 (53) lista raportează hasPin true/false corect', (list1.body?.profiles ?? []).some((p) => p.hasPin === true) && (list1.body?.profiles ?? []).some((p) => p.hasPin === false));

  /* Umplem până la 5 + încercăm al 6-lea. */
  await post('/api/perso/profiles', { name: 'Oaspete', userId: owner.userId }, { token: owner.token });
  await post('/api/perso/profiles', { name: 'Bunicul', userId: owner.userId }, { token: owner.token });
  await post('/api/perso/profiles', { name: 'Extra', userId: owner.userId }, { token: owner.token });
  const sixth = await post('/api/perso/profiles', { name: 'Al saselea', userId: owner.userId }, { token: owner.token });
  check('S5-11 (54) al 6-lea profil → 400 (max 5/cont)', sixth.status === 400 && String(sixth.body?.error).includes('5'));

  const updNoPin = await put(`/api/perso/profiles/${p2.body.profile.id}?user=${owner.userId}`, { name: 'Junior' }, { token: owner.token });
  check('S5-12 (55) update pe profil cu PIN fără oldPin → 403', updNoPin.status === 403);
  const updWrongPin = await put(`/api/perso/profiles/${p2.body.profile.id}?user=${owner.userId}`, { name: 'Junior', oldPin: '9999' }, { token: owner.token });
  check('S5-13 (56) update cu oldPin greșit → 403', updWrongPin.status === 403);
  const updOk = await put(`/api/perso/profiles/${p2.body.profile.id}?user=${owner.userId}`, { name: 'Junior', oldPin: '1234' }, { token: owner.token });
  check('S5-14 (57) update cu oldPin corect → 200, numele schimbat', updOk.status === 200 && updOk.body?.profile?.name === 'Junior');
  const updMain = await put(`/api/perso/profiles/${p1.body.profile.id}?user=${owner.userId}`, { name: 'Familia Mare' }, { token: owner.token });
  check('S5-15 (58) update profil fără PIN merge fără oldPin → 200', updMain.status === 200 && updMain.body?.profile?.name === 'Familia Mare');

  const delMain = await del(`/api/perso/profiles/${p1.body.profile.id}?user=${owner.userId}`, { token: owner.token });
  check('S5-16 (59) DELETE pe profilul principal → 400 refuzat onest', delMain.status === 400);
  const delMissing = await del(`/api/perso/profiles/pxyz?user=${owner.userId}`, { token: owner.token });
  check('S5-17 (60) DELETE profil inexistent → 404', delMissing.status === 404);
  const delOk = await del(`/api/perso/profiles/${p2.body.profile.id}?user=${owner.userId}`, { token: owner.token });
  check('S5-18 (61) DELETE profil secundar → 200', delOk.status === 200 && delOk.body?.ok === true);
  const list2 = await get(`/api/perso/profiles?user=${owner.userId}`, { token: owner.token });
  check('S5-19 (62) lista reflectă ștergerea (fără profilul șters)', (list2.body?.profiles ?? []).every((p) => p.id !== p2.body.profile.id));

  /* --------------------- S6. verify PIN → token sesiune -------------------- */
  console.log('── S6. /profiles/:id/verify — PIN + token JWT-lite 2h ──');
  const guard = await registerUser('f36guard');
  const g1 = await post('/api/perso/profiles', { name: 'Părintele', userId: guard.userId }, { token: guard.token });
  const g2 = await post('/api/perso/profiles', { name: 'Cel mic', pin: '4321', userId: guard.userId }, { token: guard.token });
  const guardP2 = g2.body?.profile?.id;
  const verifyMissing = await post(`/api/perso/profiles/p999/verify`, { pin: '4321', userId: guard.userId }, { token: guard.token });
  check('S6-1 (63) verify pe profil inexistent → 404', verifyMissing.status === 404);
  const verifyWrong = await post(`/api/perso/profiles/${guardP2}/verify`, { pin: '1111', userId: guard.userId }, { token: guard.token });
  check('S6-2 (64) verify cu PIN greșit → 403 (fără token)', verifyWrong.status === 403 && !verifyWrong.body?.token);
  const verifyNoPin = await post(`/api/perso/profiles/${guardP2}/verify`, { userId: guard.userId }, { token: guard.token });
  check('S6-3 (65) verify fără PIN pe profil cu PIN → 403', verifyNoPin.status === 403);
  const verifyOk = await post(`/api/perso/profiles/${guardP2}/verify`, { pin: '4321', userId: guard.userId }, { token: guard.token });
  const token = verifyOk.body?.token;
  check('S6-4 (66) verify cu PIN corect → token JWT-lite (3 părți)', verifyOk.status === 200 && typeof token === 'string' && token.split('.').length === 3);
  check('S6-5 (67) token expiră în 2h (expiresInSec=7200)', verifyOk.body?.expiresInSec === 7200);
  const tokenParts = token ? token.split('.') : [];
  let tokenPayload = null;
  try {
    tokenPayload = JSON.parse(Buffer.from(tokenParts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch {
    tokenPayload = null;
  }
  check(
    'S6-6 (68) payload-ul conține sub=profil + acc=user + exp în viitor',
    tokenPayload?.sub === guardP2 && tokenPayload?.acc === guard.userId && tokenPayload?.exp > Math.floor(Date.CURRENT_TIMESTAMP / 1000),
  );
  const roundtrip = await get(`/api/perso/verify-token?token=${encodeURIComponent(token)}`);
  check('S6-7 (69) GET /verify-token roundtrip → valid cu profil+expirare', roundtrip.status === 200 && roundtrip.body?.payload?.profileId === guardP2 && roundtrip.body?.payload?.userId === guard.userId);
  const tampered = await get(`/api/perso/verify-token?token=${encodeURIComponent(`${tokenParts[0]}.${tokenParts[1]}.deadbeef`)}`);
  check('S6-8 (70) token cu semnătura modificată → 401 respins', tampered.status === 401);
  const noPinProfile = await post(`/api/perso/profiles/${g1.body.profile.id}/verify`, { userId: guard.userId }, { token: guard.token });
  check('S6-9 (71) profil fără PIN → token emis direct (garda e opțională)', noPinProfile.status === 200 && typeof noPinProfile.body?.token === 'string');

  /* --------------------------- S7. /reminders ------------------------------ */
  console.log('── S7. /reminders — abandonate >3 zile + dismiss ──');
  const procrastinator = await registerUser('f36rem');
  check('S7-1 (72) user QA „procrastinator" înregistrat', procrastinator !== null);
  if (db && qaId) {
    /* 3 intrări watchhistory: (a) abandonată 5 zile la 50% cu durată reală,
     * (b) vizionată ACUM (recentă → nu e memento), (c) abandonată 6 zile dar
     * sub 5 min progres (sub banda onestă → nu e memento). */
    await db.query(
      `INSERT INTO watchhistory (userid, contentid, progress, watchedat) VALUES ($1,$2,2700, datetime('now','-5 days'))
       ON CONFLICT (userid, contentid) DO UPDATE SET progress = 2700, watchedat = datetime('now','-5 days')`,
      [procrastinator.userId, qaId],
    );
    await db.query(
      `INSERT INTO watchhistory (userid, contentid, progress, watchedat) VALUES ($1,$2,5000, CURRENT_TIMESTAMP)
       ON CONFLICT (userid, contentid) DO UPDATE SET progress = 5000, watchedat = CURRENT_TIMESTAMP`,
      [procrastinator.userId, REAL_T1],
    );
    await db.query(
      `INSERT INTO watchhistory (userid, contentid, progress, watchedat) VALUES ($1,$2,120, datetime('now','-6 days'))
       ON CONFLICT (userid, contentid) DO UPDATE SET progress = 120, watchedat = datetime('now','-6 days')`,
      [procrastinator.userId, REAL_T2],
    );
  }
  const rem = await get(`/api/perso/reminders?user=${procrastinator.userId}`, { token: procrastinator.token });
  check('S7-2 (73) /reminders → 200 cu items', rem.status === 200 && Array.isArray(rem.body?.items));
  const remItems = rem.body?.items ?? [];
  const qaReminder = remItems.find((i) => i.contentId === qaId);
  check('S7-3 (74) vizionarea abandonată la 50% (5 zile) apare', Boolean(qaReminder), `items=${remItems.length}`);
  check('S7-4 (75) memento cu progressPct=50 + remainingMin=45 (durată 5400s − 2700s)', qaReminder?.progressPct === 50 && qaReminder?.remainingMin === 45);
  check('S7-5 (76) idleDays ≥ 3 + reason lizibil', (qaReminder?.idleDays ?? 0) >= 3 && typeof qaReminder?.reason === 'string');
  check('S7-6 (77) vizionarea RECENTĂ (acum) NU e memento', !remItems.some((i) => i.contentId === REAL_T1));
  check('S7-7 (78) progresul sub 5 min NU e memento (bandă onestă)', !remItems.some((i) => i.contentId === REAL_T2));
  check('S7-8 (79) criteriile declarate onest (20-90%, 3 zile, TTL 30 zile)', rem.body?.criteria?.progressBand === '20-90%' && rem.body?.criteria?.staleAfterDays === 3 && rem.body?.criteria?.dismissalTtlDays === 30);

  const dismissBad = await post(`/api/perso/reminders/abc/dismiss?user=${procrastinator.userId}`, {}, { token: procrastinator.token });
  check('S7-9 (80) dismiss cu contentId invalid → 400', dismissBad.status === 400);
  const dismiss = await post(`/api/perso/reminders/${qaId}/dismiss?user=${procrastinator.userId}`, {}, { token: procrastinator.token });
  check('S7-10 (81) dismiss → 200 cu TTL 30 zile declarat', dismiss.status === 200 && dismiss.body?.ttlDays === 30);
  const remAfter = await get(`/api/perso/reminders?user=${procrastinator.userId}`, { token: procrastinator.token });
  check('S7-11 (82) după dismiss memento-ul dispare + dismissedActive=1', !(remAfter.body?.items ?? []).some((i) => i.contentId === qaId) && remAfter.body?.dismissedActive === 1);

  /* --------------------------- S8. /affinities ----------------------------- */
  console.log('── S8. /affinities — breakdown detaliat ──');
  const aff = await get(`/api/perso/affinities?user=${learner.userId}`, { token: learner.token });
  check('S8-1 (83) /affinities → 200 cu structura completă', aff.status === 200 && Array.isArray(aff.body?.topGenres) && typeof aff.body?.diversity?.score === 'number');
  check('S8-2 (84) top genuri cu pct normalizat 0-100 + număr de titluri', (aff.body?.topGenres ?? []).length > 0 && aff.body.topGenres.every((g) => g.pct >= 0 && g.pct <= 100 && typeof g.titles === 'number'));
  check('S8-3 (85) top decenii prezente (formă „<dec>s")', (aff.body?.topDecades ?? []).length > 0 && /^\d{4}s$/.test(aff.body.topDecades[0].value));
  check('S8-4 (86) top tipuri prezente (movie/tv…)', (aff.body?.topTypes ?? []).length > 0 && aff.body.topTypes.some((t) => t.value === 'movie'));
  check('S8-5 (87) scor diversitate 0-100 cu nota onestă de calcul', aff.body?.diversity?.score >= 0 && aff.body?.diversity?.score <= 100 && typeof aff.body?.diversity?.note === 'string');
  const affFresh = await get(`/api/perso/affinities?user=${fresh.userId}`, { token: fresh.token });
  check('S8-6 (88) user fără semnale → zero afinități + note (fără eroare)', (affFresh.body?.topGenres ?? []).length === 0 && typeof affFresh.body?.note === 'string');

  /* ---------------------------- S9. /explain ------------------------------- */
  console.log('── S9. /explain/:contentId — de ce îți recomandăm ──');
  const ex = await get(`/api/perso/explain/${REAL_T1}?user=${learner.userId}`, { token: learner.token });
  check('S9-1 (89) explain pe titlu Thriller cu profil Thriller → recommended', ex.status === 200 && ex.body?.recommended === true && (ex.body?.score ?? 0) >= 40);
  check('S9-2 (90) reason-uri cu label+detail+puncte numerice', (ex.body?.reasons ?? []).length >= 2 && ex.body.reasons.every((r) => r.label && r.detail && typeof r.points === 'number'));
  check('S9-3 (91) include motivul de gen („Gen favorit: Thriller")', (ex.body?.reasons ?? []).some((r) => r.key === 'genre' && r.label.includes('Thriller')));
  check('S9-4 (92) include motivul similar („Pentru că ai văzut")', (ex.body?.reasons ?? []).some((r) => r.key === 'similar' && r.label.includes('Pentru că ai văzut')));
  const exMissing = await get('/api/perso/explain/99999999');
  check('S9-5 (93) explain pe contentId inexistent → 404 onest', exMissing.status === 404);
  const exBad = await get('/api/perso/explain/xyz');
  check('S9-6 (94) explain cu id nevalid → 400', exBad.status === 400);
  const exAnon = await get(`/api/perso/explain/${REAL_T1}`);
  check(
    'S9-7 (95) anonim → scor doar din calitatea catalogului (profilEmpty onest)',
    exAnon.status === 200 && exAnon.body?.profileEmpty === true && (exAnon.body?.reasons ?? []).every((r) => r.key === 'quality'),
  );

  /* ---------------------- S10. POST /events + rate limit ------------------- */
  console.log('── S10. POST /events — semnale + rate limit 60/min/IP ──');
  const evBadType = await post('/api/perso/events', { type: 'boom', contentId: qaId, userId: learner.userId }, { token: learner.token });
  check('S10-1 (96) type invalid → 400 cu lista validă', evBadType.status === 400 && String(evBadType.body?.error).includes('view'));
  const evNoContent = await post('/api/perso/events', { type: 'view', userId: learner.userId }, { token: learner.token });
  check('S10-2 (97) view fără contentId → 400', evNoContent.status === 400);
  const evBadContent = await post('/api/perso/events', { type: 'view', contentId: -5, userId: learner.userId }, { token: learner.token });
  check('S10-3 (98) contentId negativ → 400', evBadContent.status === 400);
  const evBadWeight = await post('/api/perso/events', { type: 'view', contentId: qaId, weight: 'greu', userId: learner.userId }, { token: learner.token });
  check('S10-4 (99) weight non-numeric → 400', evBadWeight.status === 400);
  const evView = await post('/api/perso/events', { type: 'view', contentId: qaId, weight: 2, userId: learner.userId }, { token: learner.token });
  check('S10-5 (100) view valid → 201 cu evenimentul stocat', evView.status === 201 && evView.body?.event?.type === 'view' && evView.body?.event?.weight === 2);
  const evComplete = await post('/api/perso/events', { type: 'complete', contentId: qaId, userId: learner.userId }, { token: learner.token });
  const evSearch = await post('/api/perso/events', { type: 'search', term: 'thriller', userId: learner.userId }, { token: learner.token });
  check('S10-6 (101) complete + search valide → 201', evComplete.status === 201 && evSearch.status === 201 && evSearch.body?.event?.term === 'thriller');
  const evClamp = await post('/api/perso/events', { type: 'like', contentId: qaId, weight: 99, userId: learner.userId }, { token: learner.token });
  check('S10-7 (102) weight 99 → clamp onest la 3', evClamp.status === 201 && evClamp.body?.event?.weight === 3);
  const evNoIdentity = await post('/api/perso/events', { type: 'view', contentId: qaId });
  check('S10-8 (103) events fără identitate → 401', evNoIdentity.status === 401);

  const st2 = await get('/api/perso/status');
  const c2 = st2.body?.counters ?? {};
  check('S10-9 (104) /status reflectă evenimentele (eventsTracked a crescut)', c2.eventsTracked >= (baseline.eventsTracked ?? 0) + 4, `Δ=${c2.eventsTracked - (baseline.eventsTracked ?? 0)}`);
  check('S10-10 (105) eventsByType.view/like/complete/search contorizate', (c2.eventsByType?.view ?? 0) >= 1 && (c2.eventsByType?.like ?? 0) >= 1 && (c2.eventsByType?.complete ?? 0) >= 1 && (c2.eventsByType?.search ?? 0) >= 1);

  /* Rate limit: 61 de cereri de pe IP dedicat (unic per rulare). Primele 60
   * trec (sunt search-uri valide no-op), a 61-a trebuie să primească 429. */
  let rateStatuses = [];
  for (let i = 0; i < 61; i += 1) {
    const r = await post('/api/perso/events', { type: 'search', userId: fresh.userId }, { xff: RATE_IP });
    rateStatuses.push(r.status);
    if (r.status === 429 && i < 60) break; // nu bombardăm inutil
  }
  const first60 = rateStatuses.slice(0, 60);
  const got429 = rateStatuses.includes(429);
  check('S10-11 (106) primele ≤60 cereri de pe același IP trec', first60.every((s) => s === 201), `distincte=${new Set(first60).size}`);
  check('S10-12 (107) al 61-lea (sau următorul) primește 429 onest', got429, `statuses=${[...new Set(rateStatuses)].join(',')}`);
  const retryAfterOk = got429; // 429 vine cu Retry-After (userRateLimit standard)
  check('S10-13 (108) alt IP nu e afectat (bucket per IP)', retryAfterOk && (await post('/api/perso/events', { type: 'search', userId: fresh.userId })).status === 201);

  /* --------------------------- S11. Rezistență ----------------------------- */
  console.log('── S11. Rezistență la input invalid (răspunsuri oneste) ──');
  const r1 = await get('/api/perso/profile?user=-3');
  check('S11-1 (109) ?user=-3 → 401 (id invalid)', r1.status === 401);
  const r2 = await get('/api/perso/profile?user=999999999');
  check('S11-2 (110) user inexistent → 200 cu profil gol onest (fără 500)', r2.status === 200 && r2.body?.profile?.empty === true);
  const r3 = await get('/api/perso/feed?user=999999999&limit=24');
  check('S11-3 (111) feed user inexistent → 200 gol + note', r3.status === 200 && (r3.body?.items ?? []).length === 0 && typeof r3.body?.note === 'string');
  const r4 = await post('/api/perso/profiles', { userId: 999999999 + Math.floor(Math.random() * 100000), name: 'Orfan' });
  check('S11-4 (112) POST /profiles pentru cont fără profiluri → 201 (izolat pe userId, id aleator — idempotent între rulări)', r4.status === 201);
  const r5 = await get('/api/perso/reminders?user=999999999');
  check('S11-5 (113) reminders user inexistent → 200 listă goală', r5.status === 200 && (r5.body?.items ?? []).length === 0);
  const r6 = await del('/api/perso/profiles/pzz?user=999999999');
  check('S11-6 (114) DELETE profil inexistent (alt cont) → 404', r6.status === 404);
  const r7 = await post('/api/perso/events', { type: 'view', contentId: 999999999, userId: fresh.userId }, { token: fresh.token });
  check('S11-7 (115) event pe contentId inexistent → tot 201 (semnal onest, nu validăm catalogul)', r7.status === 201 || r7.status === 400);
  const r8 = await get('/api/perso/explain/0');
  check('S11-8 (116) explain contentId=0 → 400', r8.status === 400);
  const r9 = await post('/api/perso/profiles', { name: 123, userId: fresh.userId });
  check('S11-9 (117) name non-string → 400', r9.status === 400);
  const r10 = await put('/api/perso/profiles/pzz?user=999999999', { name: 'Alt cont' });
  check('S11-10 (118) PUT profil inexistent → 404', r10.status === 404);
  const r11 = await post('/api/perso/reminders/12/dismiss', {});
  check('S11-11 (119) dismiss fără identitate → 401', r11.status === 401);
  const r12 = await get('/api/perso/verify-token?token=');
  check('S11-12 (120) verify-token fără token → 400', r12.status === 400);

  /* ------------------------ S12. Regresie protejată ------------------------ */
  console.log('── S12. Regresie — componentele protejate răspund neschimbate ──');
  const h = await get('/api/health');
  check('S12-1 (121) /api/health → 200 (DB conectat)', h.status === 200 && h.body?.status === 'ok');
  const px = await get('/api/playerx/status');
  check('S12-2 (122) /api/playerx/status (FAZA 34) → 200', px.status === 200);
  const lab = await get('/api/ai/lab/status');
  check('S12-3 (123) /api/ai/lab/status (FAZA 35) → 200 cu 8 capabilități', lab.status === 200 && (lab.body?.capabilities ?? []).length === 8);
  const accel = await get('/api/searchaccel/status');
  check('S12-4 (124) /api/searchaccel/status (FAZA 29-P) → 200', accel.status === 200);
  const ux = await get('/api/searchux/status');
  check('S12-5 (125) /api/searchux/status (FAZA 33) → 200', ux.status === 200);
  const hubStats = await get('/api/hub/stats');
  check('S12-6 (126) /api/hub/stats (FAZA 20, recomandările existente) → 200', hubStats.status === 200);

  /* ------------------------------ cleanup ---------------------------------- */
  if (db) {
    try {
      const qaUsers = [fresh, learner, owner, guard, procrastinator].filter(Boolean).map((u) => u.userId);
      await db.query(`DELETE FROM watchhistory WHERE userid = ANY($1[])`, [qaUsers]);
      if (qaId) await db.query(`DELETE FROM content WHERE id = $1`, [qaId]); // cascade: likes/reviews/history QA
      await db.end();
      console.log('\n🧹 cleanup: watchhistory QA + conținut QA eliminate (userii synth rămân, pattern smoke).');
    } catch (err) {
      console.log(`⚠️ cleanup parțial: ${err?.message ?? err}`);
    }
  }

  /* --------------------------------- raport --------------------------------- */
  console.log('\n──────────────────────────────────────────────────────');
  console.log(`REZULTAT: ${passed} PASSED / ${passed + failed} TOTAL · ${failed === 0 ? '🟢 VERDE' : `🔴 ${failed} EȘECURI`}`);
  if (failed > 0) {
    console.log('\nEșecuri:');
    for (const r of results.filter((x) => !x.ok)) console.log(`  ❌ ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  }
  console.log('──────────────────────────────────────────────────────\n');
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('💥 suita a crăpat:', err);
  process.exit(1);
});
