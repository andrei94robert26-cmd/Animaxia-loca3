#!/usr/bin/env bun
/**
 * smoke-ailab.mjs — FAZA 35 (PLAN 100X · WS5): AI Lab — cele 8 capabilități
 * AI noi (modules/ainew, montat la /api/ai/lab).
 *
 * Verifică END-TO-END, direct contra backend-ului (:4000, ca smoke-playerx),
 * contractul înghețat al AI Lab (FAZA-35-b/c construiesc pe EXACT aceste forme):
 *   S1  /status — 8 capabilități, chei în ordine, totals + toggle settings
 *       roundtrip (mood off → 503 disabled → mood on) + 400 la key/enabled
 *   S2  companion — context pe titlu REAL (descoperit prin autocomplete),
 *       chat happy path (provider onest ∈ z-ai|heuristic), validări 400,
 *       >8 mesaje → trunchiate la ultimele 8 (usedMessages=8)
 *   S3  recap — 401 anonim; user fresh fără istoric → {ok, recap:null, note};
 *       după POST /api/playerhub/progress (FAZA 19 protejat, doar consumat)
 *       → recap ok + watched cu progres
 *   S4  mood — moods 6 intrări deterministe; generate relaxat limit=8 →
 *       carduri reale; mood invalid → 400; limit invalid → 400
 *   S5  shield — spoiler RO evident → spoiler:true confidence>0.5 + matched;
 *       text curat → false; mode block → ascuns/vizibil; >50 texte → 400;
 *       body >2000 → 400; mode invalid → 400
 *   S6  dubbing — missing shape; anon 401 / non-admin 403; flux ADMIN complet
 *       pe conținut QA propriu (generate → draft → corecturi → publish prin
 *       FAZA 21 protejat → track RO „Română (AI)" vizibil) + curățare
 *   S7  curation — why/:realContentId → note + 5 semnale {key,label,value,
 *       weight} + provider onest
 *   S8  voice — status (whitelist 7 voci, maxChars 1024); tts/asr validări
 *       400 (text>1024, voce invalidă, viteză invalidă, base64 invalid);
 *       happy paths oneste: status ∈ [200,503] — NICIODATĂ text fals
 *   S9  editor — generate „thrillere coreene lungi" → interpreted+playlist+
 *       items; <3 caractere → 400; save anonim → 401; user → save → lists
 *       roundtrip (uuid)
 *   S10 REGRESIE PROTEJATĂ (read-only): /api/health, /api/search/autocomplete
 *       (FAZA 18), /api/hub/stats (FAZA 20), /api/ai/suite/status (FAZA 32,
 *       18 motoare), /api/searchaccel/status (FAZA 29-P), /api/searchux/
 *       status (FAZA 33), /api/playerx/status (FAZA 34), /api/player/
 *       subtitles/content/:id/subtitles (FAZA 21)
 *
 * Provider-agnostism onest: z-ai poate fi temporar 429/timeout — fiecare
 * capabilitate are fallback determinist etichetat 'heuristic' (voice: 503
 * onest, fără transcript fals). Testele acceptă provider ∈ {z-ai, heuristic}
 * și, pentru voce, status ∈ [200, 503].
 *
 * Determinism (rulabil de mai multe ori la rând):
 *   • useri de test FRESH per rulare (nonce în email/username — ca faza21);
 *   • conținutul QA din S6 e creat și ȘTERS la final (preventiv și la final);
 *   • admin-ul S6 e promovat prin DB real (pattern smoke-faza21, pg + .env);
 *   • playlist-urile editorului rămân în data/ainew/playlists/<userid>.json
 *     sub chei de useri de unică folosință (inerte, documentat onest);
 *   • fiecare rulare folosește X-Forwarded-For unic (TEST-NET-2) → bucket de
 *     rate-limit izolat de traficul de pe 127.0.0.1.
 *
 * Usage:  bun tests/smoke-ailab.mjs
 * Env:    API_ORIGIN  default http://127.0.0.1:4000
 */

import { readFileSync } from 'node:fs';
import pg from 'pg';

const BASE = process.env.API_ORIGIN || 'http://127.0.0.1:4000';
const NONCE = Date.now();
const XFF = `198.51.100.${100 + (NONCE % 100)}`; // TEST-NET-2 — izolare rate-limit

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

const EXPECTED_CAPS = ['companion', 'recap', 'mood', 'shield', 'dubbing', 'curation', 'voice', 'editor'];
const VOICES = ['tongtong', 'chuichui', 'xiaochen', 'jam', 'kazi', 'douji', 'luodo'];

/* ---------------------------------- setup ----------------------------------- */

console.log(`── Setup: useri fresh (nonce) + admin real + conținut real (BASE=${BASE}, XFF=${XFF}) ──`);

async function registerUser(label) {
  const email = `faza35-${label}-${NONCE}@animaxia.local`;
  const username = `fz35${label}${NONCE % 100000}`;
  const { status, body } = await post('/api/auth/register', { email, username, password: `faza35-pass-${label}` });
  if (status !== 201 || !body?.accessToken) {
    console.error(`SETUP FAILED: register ${label} → ${status} ${JSON.stringify(body).slice(0, 120)}`);
    process.exit(1);
  }
  return { id: body.user.id, username, email, token: body.accessToken };
}

const userA = await registerUser('a'); // recap + editor + conținut QA
const userAdm = await registerUser('adm'); // dubbing admin (promovat prin DB real)

/* Admin promotion prin DB real (pattern smoke-faza21 — bootstrap-first-user
 * nu se aplică, DB-ul are useri). Protecția e dovedită și cu 403/401. */
function loadDatabaseUrl() {
  if (process.env.DATABASEURL) return process.env.DATABASEURL;
  try {
    const raw = readFileSync('/home/z/my-project/mini-services/animaxia-backend/.env', 'utf8');
    const m = raw.match(/^DATABASEURL=(.+)$/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  } catch {
    /* fall through */
  }
  return null;
}

let adminToken = userAdm.token;
let promoted = false;
const dbUrl = loadDatabaseUrl();
if (dbUrl) {
  try {
    const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
    await client.connect();
    const r = await client.query(`UPDATE users SET role = 'admin' WHERE email = $1 RETURNING id, role`, [userAdm.email]);
    await client.end();
    promoted = r.rowCount === 1 && r.rows[0].role === 'admin';
  } catch (err) {
    console.error(`  admin promotion via pg failed: ${err.message}`);
  }
}
if (promoted) {
  const login = await post('/api/auth/login', { email: userAdm.email, password: 'faza35-pass-adm' }, null, { timeoutMs: 15000 });
  if (login.status === 200 && login.body?.accessToken) adminToken = login.body.accessToken;
}
console.log(`  useri: A=${userA.id} ADM=${userAdm.id} (promoted=${promoted})`);

/* Conținut REAL: întâi prin autocomplete (FAZA 18, ca în specificație), cu
 * fallback onest la /api/all dacă pipeline-ul e lent/degradat. Excludem
 * conținutul de test/QA (titluri de forma „AI Lab Smoke"/„Dubbing QA") și
 * cerem metadate bogate, ca fallback-ul să nu aleagă un titlu de test. */
const isQaContent = (c) => /AI Lab Smoke|Dubbing QA|FAZA \d+ (smoke|QA)|ailab/i.test(String(c?.title ?? ''));
let realContent = null;
try {
  const ac = await get('/api/search/autocomplete?q=dragon', null, { timeoutMs: 60000 });
  if (ac.status === 200 && Array.isArray(ac.body?.suggestions) && ac.body.suggestions.length > 0) {
    realContent = ac.body.suggestions[0];
  }
} catch {
  /* fallback below */
}
if (!realContent) {
  const all = await get('/api/all?limit=100');
  const rich = (all.body?.data ?? []).find(
    (c) => !isQaContent(c) && c.metadata?.rating != null && c.metadata?.year != null &&
      Array.isArray(c.metadata?.genres) && c.metadata.genres.length > 0,
  );
  realContent = rich ?? (all.body?.data ?? []).find((c) => !isQaContent(c)) ?? null;
}
if (!realContent) {
  console.error('SETUP FAILED: niciun conținut real găsit (autocomplete + /api/all)');
  process.exit(1);
}
const richId = realContent.id;
console.log(`  conținut real: #${richId} „${realContent.title}"`);

/* TV cu runtime real pentru recap (progressPct calculabil). */
const tvAll = await get('/api/all?limit=100&type=tv');
const tvWithRuntime = (tvAll.body?.data ?? []).find((c) => Number(c?.metadata?.runtime) >= 25);
const recapContentId = tvWithRuntime?.id ?? richId;
console.log(`  conținut recap: #${recapContentId}${tvWithRuntime ? ` (runtime ${tvWithRuntime.metadata.runtime}min)` : ' (fără runtime — progressPct null onest)'}`);

/* ═══════════════════════ S1 · status + settings ═══════════════════════ */
console.log('\n════════ S1 · /api/ai/lab/status + settings roundtrip ════════');
{
  const { status, body } = await get('/api/ai/lab/status');
  ok('S1.1 status 200 + suite AI LAB', status === 200 && body?.suite === 'AI LAB', `got ${status}`);
  ok('S1.2 faza FAZA 35 (PLAN 100X · WS5)', /FAZA 35/.test(String(body?.faza)) && /WS5/.test(String(body?.faza)));
  const caps = body?.capabilities ?? [];
  ok(
    'S1.3 exact 8 capabilități, chei în ordinea contractului',
    Array.isArray(caps) && caps.length === 8 && caps.every((c, i) => c.key === EXPECTED_CAPS[i]),
    JSON.stringify(caps.map((c) => c.key)),
  );
  ok(
    'S1.4 fiecare cap are name/emoji/description/enabled/stats',
    caps.every((c) => typeof c.name === 'string' && typeof c.emoji === 'string' && typeof c.description === 'string' &&
      typeof c.enabled === 'boolean' && c.stats && typeof c.stats.runs === 'number' && 'lastProvider' in c.stats),
  );
  ok(
    'S1.5 totals oneste (total 8, enabled+disabled=8)',
    body?.totals?.total === 8 && body.totals.enabled + body.totals.disabled === 8,
    JSON.stringify(body?.totals),
  );
  ok('S1.6 generatedAt ISO valid', !Number.isNaN(Date.parse(body?.generatedAt ?? '')));

  /* settings: validare + toggle roundtrip pe mood. */
  const badKey = await post('/api/ai/lab/settings', { key: 'bogus', enabled: true }, null, { timeoutMs: 15000 });
  ok('S1.7 settings key invalid → 400', badKey.status === 400, `got ${badKey.status}`);
  const badEnabled = await post('/api/ai/lab/settings', { key: 'mood', enabled: 'yes' }, null, { timeoutMs: 15000 });
  ok('S1.8 settings enabled non-boolean → 400', badEnabled.status === 400, `got ${badEnabled.status}`);

  const off = await post('/api/ai/lab/settings', { key: 'mood', enabled: false });
  ok('S1.9 toggle mood OFF → ok', off.status === 200 && off.body?.ok === true && off.body?.enabled === false, JSON.stringify(off.body));
  const blocked = await get('/api/ai/lab/mood/generate?mood=relaxat');
  ok(
    'S1.10 cap oprită → 503 { error, disabled: true }',
    blocked.status === 503 && blocked.body?.disabled === true && /disabled/.test(String(blocked.body?.error)),
    `got ${blocked.status} ${JSON.stringify(blocked.body).slice(0, 100)}`,
  );
  const backOn = await post('/api/ai/lab/settings', { key: 'mood', enabled: true });
  ok('S1.11 toggle mood ON la loc → ok', backOn.status === 200 && backOn.body?.enabled === true);
  const reopened = await get('/api/ai/lab/mood/generate?mood=relaxat&limit=1');
  ok('S1.12 cap reactivată imediat (fără restart)', reopened.status === 200 && reopened.body?.ok === true, `got ${reopened.status}`);
}

/* ═══════════════════════ S2 · companion ═══════════════════════ */
console.log('\n════════ S2 · companion — context RAG + chat pe titlu real ════════');
{
  const ctx = await get(`/api/ai/lab/companion/context/${richId}`);
  ok('S2.1 context 200 + ok', ctx.status === 200 && ctx.body?.ok === true, `got ${ctx.status}`);
  const c = ctx.body?.context ?? {};
  ok(
    'S2.2 context cu contentId/title/type/year/synopsis/genres/reviews',
    c.contentId === richId && typeof c.title === 'string' && 'type' in c && 'year' in c &&
      'synopsis' in c && Array.isArray(c.genres) && Array.isArray(c.reviews),
    JSON.stringify(Object.keys(c)),
  );
  ok('S2.3 context provider onest', ctx.body?.provider === 'sql');

  const missing = await get('/api/ai/lab/companion/context/999999');
  ok('S2.4 conținut inexistent → 404', missing.status === 404, `got ${missing.status}`);
  const badId = await get('/api/ai/lab/companion/context/abc');
  ok('S2.5 id invalid → 400', badId.status === 400, `got ${badId.status}`);

  const noContent = await post('/api/ai/lab/companion/chat', { messages: [{ role: 'user', content: 'Salut' }] });
  ok('S2.6 chat fără contentId → 400', noContent.status === 400, `got ${noContent.status}`);
  const noMessages = await post('/api/ai/lab/companion/chat', { contentId: richId });
  ok('S2.7 chat fără messages → 400', noMessages.status === 400, `got ${noMessages.status}`);
  const badRole = await post('/api/ai/lab/companion/chat', { contentId: richId, messages: [{ role: 'system', content: 'hack' }] });
  ok('S2.8 rol invalid (system) → 400', badRole.status === 400, `got ${badRole.status}`);

  const chat = await post('/api/ai/lab/companion/chat', {
    contentId: richId,
    messages: [{ role: 'user', content: 'Despre ce e?' }],
  }, null, { timeoutMs: 45000 });
  ok(
    'S2.9 chat happy path — răspuns non-gol + provider onest',
    chat.status === 200 && typeof chat.body?.answer === 'string' && chat.body.answer.trim().length > 0 &&
      ['z-ai', 'heuristic'].includes(chat.body?.provider),
    `${chat.status} provider=${chat.body?.provider}`,
  );
  ok('S2.10 chat folosește contextul (title + usedMessages)', chat.body?.title === realContent.title && chat.body?.usedMessages === 1);

  /* Contract: >8 mesaje → păstrăm ULTIMELE 8 (usedMessages=8, nu 400). */
  const many = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: `mesaj ${i}` }));
  many.push({ role: 'user', content: 'Deci, despre ce e?' });
  const trimmed = await post('/api/ai/lab/companion/chat', { contentId: richId, messages: many }, null, { timeoutMs: 45000 });
  ok(
    'S2.11 >8 mesaje → trunchiere la ultimele 8 (usedMessages=8)',
    trimmed.status === 200 && trimmed.body?.usedMessages === 8,
    `got ${trimmed.status} usedMessages=${trimmed.body?.usedMessages}`,
  );

  const chatMissing = await post('/api/ai/lab/companion/chat', { contentId: 999999, messages: [{ role: 'user', content: 'Salut' }] });
  ok('S2.12 chat pe conținut inexistent → 404', chatMissing.status === 404, `got ${chatMissing.status}`);
}

/* ═══════════════════════ S3 · recap ═══════════════════════ */
console.log('\n════════ S3 · recap — istoric real prin FAZA 19 (doar consumat) ════════');
{
  const anon = await get(`/api/ai/lab/recap/${recapContentId}`);
  ok('S3.1 anonim → 401 «Autentificare necesară pentru recap»', anon.status === 401 && anon.body?.error === 'Autentificare necesară pentru recap', `got ${anon.status}`);

  const empty = await get(`/api/ai/lab/recap/${recapContentId}`, userA.token);
  ok(
    'S3.2 user fresh fără istoric → { ok, recap: null, note }',
    empty.status === 200 && empty.body?.ok === true && empty.body?.recap === null && typeof empty.body?.note === 'string',
    JSON.stringify(empty.body ?? {}).slice(0, 120),
  );

  /* Simulare istoric prin serviciul PROTEJAT FAZA 19 (POST /api/playerhub/
   * progress { contentId, seconds, duration? } — contract verificat în hub.js). */
  const progress = await post('/api/playerhub/progress', { contentId: recapContentId, seconds: 300, duration: 1800 }, userA.token);
  ok('S3.3 POST /api/playerhub/progress (FAZA 19) → saved', progress.status === 200 && progress.body?.saved === true, `got ${progress.status}`);

  const recap = await get(`/api/ai/lab/recap/${recapContentId}`, userA.token, { timeoutMs: 45000 });
  ok(
    'S3.4 recap după progres → ok + recap non-gol + provider onest',
    recap.status === 200 && recap.body?.ok === true && typeof recap.body?.recap === 'string' && recap.body.recap.trim().length > 0 &&
      ['z-ai', 'heuristic'].includes(recap.body?.provider),
    `${recap.status} provider=${recap.body?.provider}`,
  );
  const watched = recap.body?.watched ?? [];
  ok(
    'S3.5 watched conține titlul vizionat cu progres real',
    Array.isArray(watched) && watched.some(
      (w) => w.contentId === recapContentId && w.progressSec === 300 &&
        (w.progressPct === null || (typeof w.progressPct === 'number' && w.progressPct >= 0 && w.progressPct <= 100)),
    ),
    JSON.stringify(watched).slice(0, 140),
  );

  const badId = await get('/api/ai/lab/recap/abc', userA.token);
  ok('S3.6 id invalid → 400', badId.status === 400, `got ${badId.status}`);
}

/* ═══════════════════════ S4 · mood ═══════════════════════ */
console.log('\n════════ S4 · mood — playlisturi deterministe ════════');
{
  const moods = await get('/api/ai/lab/mood/moods');
  const list = moods.body?.moods ?? [];
  ok('S4.1 moods 200 + ok', moods.status === 200 && moods.body?.ok === true, `got ${moods.status}`);
  ok(
    'S4.2 exact 6 dispoziții deterministe, în ordine',
    list.length === 6 && ['relaxat', 'captivant', 'nostalgic', 'energic', 'misterios', 'romantic'].every((k, i) => list[i]?.key === k),
    JSON.stringify(list.map((m) => m.key)),
  );
  ok('S4.3 fiecare mood are emoji/genres/description', list.every((m) => typeof m.emoji === 'string' && Array.isArray(m.genres) && m.genres.length > 0 && typeof m.description === 'string'));

  const gen = await get('/api/ai/lab/mood/generate?mood=relaxat&limit=8&seed=smoke35', null, { timeoutMs: 45000 });
  ok('S4.4 generate relaxat → ok + provider onest', gen.status === 200 && gen.body?.ok === true && ['z-ai', 'heuristic'].includes(gen.body?.provider), `${gen.status} ${gen.body?.provider}`);
  const items = gen.body?.items ?? [];
  ok('S4.5 items non-gol (bibliotecă reală)', items.length > 0, `items=${items.length}`);
  ok(
    'S4.6 carduri complete (id/title/type/year/rating/genres/posterPath)',
    items.every((i) => Number.isInteger(i.id) && typeof i.title === 'string' && i.type != null && Array.isArray(i.genres) && 'year' in i && 'rating' in i && 'posterPath' in i),
    JSON.stringify(items[0] ?? {}).slice(0, 120),
  );
  ok('S4.7 limit respectat (≤8)', items.length <= 8, `items=${items.length}`);
  ok('S4.8 narrative prezent (o propoziție)', typeof gen.body?.narrative === 'string' && gen.body.narrative.length > 0);

  const badMood = await get('/api/ai/lab/mood/generate?mood=furious');
  ok('S4.9 mood invalid → 400 cu lista validă', badMood.status === 400 && /relaxat/.test(String(badMood.body?.error)), `got ${badMood.status}`);
  const noMood = await get('/api/ai/lab/mood/generate');
  ok('S4.10 mood lipsă → 400', noMood.status === 400, `got ${noMood.status}`);
  const badLimit = await get('/api/ai/lab/mood/generate?mood=relaxat&limit=0');
  ok('S4.11 limit=0 → 400', badLimit.status === 400, `got ${badLimit.status}`);
}

/* ═══════════════════════ S5 · shield ═══════════════════════ */
console.log('\n════════ S5 · shield — detecție spoilere (determinist) ════════');
{
  const res = await post('/api/ai/lab/shield/filter', {
    contentId: richId,
    texts: [
      { id: 1, body: 'Ce film superb, mi-a plăcut mult, recomand!' },
      { id: 2, body: 'Nu pot crede că personajul principal moare la final' },
      { id: 3, body: 'The villain is revealed to be his father — massive twist' },
    ],
  }, null, { timeoutMs: 45000 });
  ok('S5.1 filter 200 + ok', res.status === 200 && res.body?.ok === true, `got ${res.status}`);
  const results = res.body?.results ?? [];
  ok('S5.2 rezultate în ordinea cerută (3)', results.length === 3 && results.every((r, i) => r.id === [1, 2, 3][i]), `len=${results.length}`);
  const clean = results.find((r) => r.id === 1);
  const spoilerRo = results.find((r) => r.id === 2);
  const spoilerEn = results.find((r) => r.id === 3);
  ok('S5.3 text curat → spoiler:false, confidence 0', clean && clean.spoiler === false && clean.confidence === 0 && clean.matched.length === 0, JSON.stringify(clean));
  ok(
    'S5.4 spoiler RO evident → spoiler:true + confidence>0.5 + matched',
    spoilerRo && spoilerRo.spoiler === true && spoilerRo.confidence > 0.5 && spoilerRo.matched.includes('moare'),
    JSON.stringify(spoilerRo),
  );
  ok('S5.5 spoiler EN → spoiler:true (villain/twist/revealed)', spoilerEn && spoilerEn.spoiler === true && spoilerEn.confidence > 0, JSON.stringify(spoilerEn));
  ok('S5.6 mode tag → action etichetat', results.every((r) => r.action === 'etichetat'));
  ok('S5.7 stats oneste (total/spoilers)', res.body?.stats?.total === 3 && res.body?.stats?.spoilers === 2, JSON.stringify(res.body?.stats));

  const block = await post('/api/ai/lab/shield/filter', {
    mode: 'block',
    texts: [
      { id: 'a', body: 'personajul principal moare la final' },
      { id: 'b', body: 'Super serial, abia aștepț următorul episod!' },
    ],
  }, null, { timeoutMs: 45000 });
  const bRes = block.body?.results ?? [];
  ok(
    'S5.8 mode block → ascuns/vizibil',
    block.status === 200 && bRes.find((r) => r.id === 'a')?.action === 'ascuns' && bRes.find((r) => r.id === 'b')?.action === 'vizibil',
    JSON.stringify(bRes.map((r) => [r.id, r.action])),
  );

  const tooMany = await post('/api/ai/lab/shield/filter', { texts: Array.from({ length: 51 }, (_, i) => ({ id: i, body: 'text' })) });
  ok('S5.9 >50 texte → 400', tooMany.status === 400, `got ${tooMany.status}`);
  const tooLong = await post('/api/ai/lab/shield/filter', { texts: [{ id: 1, body: 'x'.repeat(2001) }] });
  ok('S5.10 body >2000 caractere → 400', tooLong.status === 400, `got ${tooLong.status}`);
  const badMode = await post('/api/ai/lab/shield/filter', { mode: 'censor', texts: [{ id: 1, body: 'ok' }] });
  ok('S5.11 mode invalid → 400', badMode.status === 400, `got ${badMode.status}`);
  const noTexts = await post('/api/ai/lab/shield/filter', {});
  ok('S5.12 texts lipsă → 400', noTexts.status === 400, `got ${noTexts.status}`);
}

/* ═══════════════════════ S6 · dubbing (admin) ═══════════════════════ */
console.log('\n════════ S6 · dubbing — flux admin complet (FAZA 21 doar consumată) ════════');
{
  const missingShape = await get('/api/ai/lab/dubbing/missing?limit=10');
  ok(
    'S6.1 missing 200 + items cu forma {contentId,title,type,year,hasEn,enSubtitleId}',
    missingShape.status === 200 && Array.isArray(missingShape.body?.items) &&
      missingShape.body.items.every((i) => Number.isInteger(i.contentId) && typeof i.title === 'string' && i.hasEn === true && Number.isInteger(i.enSubtitleId)),
    `got ${missingShape.status} items=${missingShape.body?.items?.length}`,
  );
  const badLimit = await get('/api/ai/lab/dubbing/missing?limit=0');
  ok('S6.2 limit=0 → 400', badLimit.status === 400, `got ${badLimit.status}`);

  /* Conținut QA propriu: creat de userA (POST /api/content necesită auth),
   * subtitrarea EN pusă de admin — flux complet, curățat la final. */
  const extId = `f35-ailab-${NONCE}`;
  const created = await post('/api/content', {
    externalid: extId,
    type: 'tv',
    title: `AI Lab Smoke ${NONCE}`,
    metadata: { genres: ['Drama'], year: '2026', overview: 'QA content pentru AI Lab FAZA 35' },
  }, userA.token);
  ok('S6.3 conținut QA creat (200 + record.id)', created.status === 200 && Number.isInteger(created.body?.record?.id), `got ${created.status}`);
  const qaId = created.body?.record?.id;

  const enVtt = [
    'WEBVTT',
    '',
    '1',
    '00:00:01.000 --> 00:00:04.000',
    'Welcome to the AI Lab dubbing smoke test.',
    '',
    '2',
    '00:00:05.000 --> 00:00:08.500',
    'This is the second line of the English track.',
  ].join('\n');
  const sub = await post('/api/player/subtitles', { contentId: qaId, lang: 'en', label: 'English', vtt: enVtt }, adminToken);
  ok('S6.4 subtitrare EN creată de admin (FAZA 21)', sub.status === 200 && Number.isInteger(sub.body?.subtitle?.id), `got ${sub.status}`);

  /* Conținut QA FĂRĂ nicio subtitrare — pentru 404-ul onest de la S6.10. */
  const createdNoSub = await post('/api/content', {
    externalid: `${extId}-nosub`,
    type: 'tv',
    title: `AI Lab Smoke ${NONCE} nosub`,
    metadata: { genres: ['Drama'], overview: 'QA fără subtitrare' },
  }, userA.token);
  const noSubQaId = createdNoSub.body?.record?.id;

  const missingNow = await get('/api/ai/lab/dubbing/missing?limit=100');
  ok('S6.5 QA apare în missing (EN fără RO)', (missingNow.body?.items ?? []).some((i) => i.contentId === qaId), 'qa not in missing');

  const anonGen = await post('/api/ai/lab/dubbing/generate', { contentId: qaId });
  ok('S6.6 generate anonim → 401', anonGen.status === 401, `got ${anonGen.status}`);
  const userGen = await post('/api/ai/lab/dubbing/generate', { contentId: qaId }, userA.token, { timeoutMs: 45000 });
  ok('S6.7 generate non-admin → 403', userGen.status === 403, `got ${userGen.status}`);

  const gen = await post('/api/ai/lab/dubbing/generate', { contentId: qaId }, adminToken, { timeoutMs: 45000 });
  ok(
    'S6.8 admin generate → ciornă cu cues + provider onest',
    gen.status === 200 && gen.body?.ok === true && gen.body?.cues === 2 &&
      ['z-ai', 'mixed', 'untranslated'].includes(gen.body?.provider),
    `${gen.status} provider=${gen.body?.provider}`,
  );
  ok('S6.9 generate traduce sau păstrează originalul onest (translated+untranslated=2)', (gen.body?.translated ?? 0) + (gen.body?.untranslated ?? 0) === 2, JSON.stringify(gen.body ?? {}).slice(0, 140));

  const noEn = await post('/api/ai/lab/dubbing/generate', { contentId: noSubQaId }, adminToken, { timeoutMs: 45000 });
  ok('S6.10 generate fără subtitrare EN → 404 onest', noEn.status === 404, `got ${noEn.status}`);
  const delNoSub = await del(`/api/content/${noSubQaId}`, adminToken);
  ok('S6.10b curățare conținut fără subtitrare', delNoSub.status === 200, `got ${delNoSub.status}`);

  const draft = await get(`/api/ai/lab/dubbing/draft/${qaId}`, adminToken);
  const draftCues = draft.body?.draft?.cues ?? [];
  ok(
    'S6.11 draft admin → cues {start,end,text,source} sortate',
    draft.status === 200 && draftCues.length === 2 && draftCues.every((c) => typeof c.start === 'number' && typeof c.end === 'number' && c.end > c.start && typeof c.text === 'string' && typeof c.source === 'string'),
    `${draft.status} cues=${draftCues.length}`,
  );
  const draftAnon = await get(`/api/ai/lab/dubbing/draft/${qaId}`);
  ok('S6.12 draft anonim → 401', draftAnon.status === 401, `got ${draftAnon.status}`);
  const draftUser = await get(`/api/ai/lab/dubbing/draft/${qaId}`, userA.token);
  ok('S6.13 draft non-admin → 403', draftUser.status === 403, `got ${draftUser.status}`);

  const corrected = draftCues.map((c, i) => ({ ...c, text: i === 0 ? 'Bun venit la testul de dublare AI Lab.' : c.text }));
  const putRes = await put(`/api/ai/lab/dubbing/draft/${qaId}`, { cues: corrected }, adminToken);
  ok('S6.14 corecturi admin → corrected:true + salvate', putRes.status === 200 && putRes.body?.corrected === true && putRes.body?.saved === true, JSON.stringify(putRes.body ?? {}).slice(0, 120));
  const badCues = await put(`/api/ai/lab/dubbing/draft/${qaId}`, { cues: [{ start: 5, end: 1, text: 'invers' }] }, adminToken);
  ok('S6.15 cue cu end≤start → 400', badCues.status === 400, `got ${badCues.status}`);
  const emptyText = await put(`/api/ai/lab/dubbing/draft/${qaId}`, { cues: [{ start: 1, end: 2, text: '' }] }, adminToken);
  ok('S6.16 cue cu text gol → 400', emptyText.status === 400, `got ${emptyText.status}`);

  const pub = await post(`/api/ai/lab/dubbing/publish/${qaId}`, {}, adminToken, { timeoutMs: 45000 });
  ok(
    'S6.17 publish prin FAZA 21 → { ok, published, subtitleId }',
    pub.status === 200 && pub.body?.ok === true && pub.body?.published === true && Number.isInteger(pub.body?.subtitleId) && pub.body?.label === 'Română (AI)',
    `${pub.status} ${JSON.stringify(pub.body ?? {}).slice(0, 140)}`,
  );

  const tracks = await get(`/api/player/subtitles/content/${qaId}/subtitles`);
  const roTrack = (tracks.body?.data ?? []).find((t) => t.lang === 'ro');
  ok('S6.18 track RO „Română (AI)" vizibil public', tracks.status === 200 && roTrack?.label === 'Română (AI)', JSON.stringify(tracks.body?.data));

  const pubNonAdmin = await post(`/api/ai/lab/dubbing/publish/${qaId}`, {}, userA.token);
  ok('S6.19 publish non-admin → 403', pubNonAdmin.status === 403, `got ${pubNonAdmin.status}`);

  /* Curățare: ștergem conținutul QA (DELETE admin — cascadează subtitrările). */
  const cleanup = await del(`/api/content/${qaId}`, adminToken);
  ok('S6.20 curățare: conținut QA șters (cascade subtitrări)', cleanup.status === 200, `got ${cleanup.status}`);
}

/* ═══════════════════════ S7 · curation ═══════════════════════ */
console.log('\n════════ S7 · curation — „De ce îți recomandăm" ════════');
{
  const why = await get(`/api/ai/lab/curation/why/${richId}`, null, { timeoutMs: 45000 });
  ok('S7.1 why 200 + ok', why.status === 200 && why.body?.ok === true, `got ${why.status}`);
  ok('S7.2 note non-gol + provider onest', typeof why.body?.note === 'string' && why.body.note.length > 0 && ['z-ai', 'heuristic'].includes(why.body?.provider), why.body?.provider);
  const signals = why.body?.signals ?? [];
  ok(
    'S7.3 exact 5 semnale {key,label,value,weight} cu ponderi 0..1',
    signals.length === 5 && signals.every((s) => typeof s.key === 'string' && typeof s.label === 'string' && s.value >= 0 && s.value <= 1 && s.weight > 0 && s.weight <= 1),
    JSON.stringify(signals.map((s) => s.key)),
  );
  ok('S7.4 semnalele așteptate (rating/popularity/genreMatch/recency/franchise)',
    ['rating', 'popularity', 'genreMatch', 'recency', 'franchise'].every((k, i) => signals[i]?.key === k), JSON.stringify(signals.map((s) => s.key)));
  ok('S7.5 title = titlul real', why.body?.title === realContent.title);
  const missing = await get('/api/ai/lab/curation/why/999999');
  ok('S7.6 conținut inexistent → 404', missing.status === 404, `got ${missing.status}`);
}

/* ═══════════════════════ S8 · voice ═══════════════════════ */
console.log('\n════════ S8 · voice — ASR/TTS onest (niciodată fals) ════════');
{
  const st = await get('/api/ai/lab/voice/status');
  ok('S8.1 status 200 + ok', st.status === 200 && st.body?.ok === true, `got ${st.status}`);
  ok('S8.2 asr ready', st.body?.asr?.ready === true && st.body.asr.maxDecodedBytes === 12 * 1024 * 1024);
  ok(
    'S8.3 tts whitelist exact 7 voci + maxChars 1024 + speed [0.5, 2]',
    JSON.stringify(st.body?.tts?.voices) === JSON.stringify(VOICES) && st.body?.tts?.maxChars === 1024 &&
      st.body?.tts?.speed?.[0] === 0.5 && st.body?.tts?.speed?.[1] === 2,
    JSON.stringify(st.body?.tts),
  );

  const tooLong = await post('/api/ai/lab/voice/tts', { text: 'x'.repeat(1025) });
  ok('S8.4 tts text >1024 → 400', tooLong.status === 400 && /1024/.test(String(tooLong.body?.error)), `got ${tooLong.status}`);
  const badVoice = await post('/api/ai/lab/voice/tts', { text: 'salut', voice: 'robot' });
  ok('S8.5 tts voce invalidă → 400', badVoice.status === 400, `got ${badVoice.status}`);
  const badSpeed = await post('/api/ai/lab/voice/tts', { text: 'salut', speed: 5 });
  ok('S8.6 tts viteză invalidă → 400', badSpeed.status === 400, `got ${badSpeed.status}`);

  /* Happy path onest: z-ai poate fi indisponibil → 503; NICIODATĂ audio fals. */
  const tts = await post('/api/ai/lab/voice/tts', { text: 'Bun venit pe Animaxia.', voice: 'tongtong', speed: 1.0 }, null, { timeoutMs: 45000 });
  ok('S8.7 tts happy → 200 sau 503 onest', [200, 503].includes(tts.status), `got ${tts.status}`);
  if (tts.status === 200) {
    ok(
      'S8.8 tts 200 → audioBase64 wav + bytes + provider z-ai',
      typeof tts.body?.audioBase64 === 'string' && tts.body.audioBase64.length > 0 && tts.body.format === 'wav' &&
        Number.isInteger(tts.body?.bytes) && tts.body.bytes > 0 && tts.body.provider === 'z-ai',
      `bytes=${tts.body?.bytes}`,
    );
  } else {
    ok('S8.8 tts 503 → mesaj onest (fără audio fals)', tts.body?.error === 'Serviciul vocal este momentan indisponibil', JSON.stringify(tts.body));
  }

  const badB64 = await post('/api/ai/lab/voice/asr', { audioBase64: '!!!nu-e-base64!!!' });
  ok('S8.9 asr base64 invalid → 400', badB64.status === 400, `got ${badB64.status}`);
  const noAudio = await post('/api/ai/lab/voice/asr', {});
  ok('S8.10 asr fără audioBase64 → 400', noAudio.status === 400, `got ${noAudio.status}`);

  /* WAV minim real (44 bytes header RIFF + 4 bytes date) — dacă z-ai e
   * disponibil, transcript real; altfel 503 onest. Niciodată text fals. */
  const tinyWav = Buffer.from(
    'UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAAQABAAgAZGF0YQAAAAA=',
    'base64',
  ).toString('base64');
  const asr = await post('/api/ai/lab/voice/asr', { audioBase64: tinyWav }, null, { timeoutMs: 45000 });
  ok('S8.11 asr happy → 200 sau 503 onest', [200, 503].includes(asr.status), `got ${asr.status}`);
  if (asr.status === 200) {
    ok('S8.12 asr 200 → text string + provider z-ai', typeof asr.body?.text === 'string' && asr.body.provider === 'z-ai', JSON.stringify(asr.body ?? {}).slice(0, 100));
  } else {
    ok('S8.12 asr 503 → mesaj onest (fără transcript fals)', asr.body?.error === 'Serviciul vocal este momentan indisponibil', JSON.stringify(asr.body));
  }
}

/* ═══════════════════════ S9 · editor ═══════════════════════ */
console.log('\n════════ S9 · editor — descriere liberă → playlist real ════════');
{
  const gen = await post('/api/ai/lab/editor/generate', { description: 'thrillere coreene lungi' }, null, { timeoutMs: 45000 });
  ok('S9.1 generate 200 + ok + provider onest', gen.status === 200 && gen.body?.ok === true && ['z-ai', 'heuristic'].includes(gen.body?.provider), `${gen.status} ${gen.body?.provider}`);
  const interp = gen.body?.interpreted ?? {};
  ok(
    'S9.2 interpreted {title, genres[], types[], keywords[], mood, maxItems, provider}',
    'title' in interp && Array.isArray(interp.genres) && Array.isArray(interp.types) && Array.isArray(interp.keywords) && 'mood' in interp && 'maxItems' in interp && 'provider' in interp,
    JSON.stringify(interp),
  );
  ok('S9.3 interpretarea prinde „thriller" (gen sau keyword)', interp.genres.includes('Thriller') || interp.keywords.some((k) => /thriller/i.test(k)), JSON.stringify(interp));
  ok('S9.4 playlist {title, description, itemCount}', typeof gen.body?.playlist?.title === 'string' && gen.body.playlist.title.length > 0 && gen.body.playlist.itemCount === (gen.body?.items ?? []).length);
  ok(
    'S9.5 items = carduri reale din catalog',
    Array.isArray(gen.body?.items) && gen.body.items.every((i) => Number.isInteger(i.id) && typeof i.title === 'string'),
    `items=${(gen.body?.items ?? []).length}`,
  );

  const tooShort = await post('/api/ai/lab/editor/generate', { description: 'ab' });
  ok('S9.6 descriere <3 caractere → 400', tooShort.status === 400, `got ${tooShort.status}`);
  const tooLongDesc = await post('/api/ai/lab/editor/generate', { description: 'x'.repeat(401) });
  ok('S9.7 descriere >400 caractere → 400', tooLongDesc.status === 400, `got ${tooLongDesc.status}`);

  const anonSave = await post('/api/ai/lab/editor/save', { playlist: { title: 'X' }, itemIds: [1] });
  ok('S9.8 save anonim → 401', anonSave.status === 401, `got ${anonSave.status}`);
  const anonLists = await get('/api/ai/lab/editor/lists');
  ok('S9.9 lists anonim → 401', anonLists.status === 401, `got ${anonLists.status}`);

  const itemIds = (gen.body?.items ?? []).slice(0, 3).map((i) => i.id);
  const save = await post('/api/ai/lab/editor/save', {
    playlist: { title: 'Thrillere de seară', description: 'thrillere coreene lungi' },
    itemIds: itemIds.length > 0 ? itemIds : [richId],
  }, userA.token);
  const saved = save.body?.playlist ?? {};
  ok(
    'S9.10 save → playlist cu uuid + createdAt + itemIds deduplicate',
    save.status === 200 && save.body?.ok === true && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(saved.id ?? '') &&
      Array.isArray(saved.itemIds) && !Number.isNaN(Date.parse(saved.createdAt ?? '')),
    JSON.stringify(save.body ?? {}).slice(0, 160),
  );
  const lists = await get('/api/ai/lab/editor/lists', userA.token);
  ok(
    'S9.11 lists roundtrip — playlistul salvat e acolo',
    lists.status === 200 && lists.body?.ok === true && (lists.body?.playlists ?? []).some((p) => p.id === saved.id),
    `total=${lists.body?.total}`,
  );
  const badSave = await post('/api/ai/lab/editor/save', { playlist: { description: 'fără titlu' }, itemIds: [1] }, userA.token);
  ok('S9.12 save fără title → 400', badSave.status === 400, `got ${badSave.status}`);
}

/* ═══════════════════════ S10 · REGRESIE PROTEJATĂ ═══════════════════════ */
console.log('\n════════ S10 · REGRESIE PROTEJATĂ (18/19/20/21/29-P/32/33/34) ════════');
{
  const health = await get('/api/health', null, { timeoutMs: 30000 });
  ok(
    'S10.1 /api/health 200 + totalItems ≥ 18925 (zero pierdere de date)',
    health.status === 200 && health.body?.db?.totalItems >= 18925,
    `totalItems=${health.body?.db?.totalItems}`,
  );

  /* FAZA 18 autocomplete: degradare PRE-EXISTENTĂ documentată (curatorScan/
   * Neon, FAZA 33/34) — retry onest, 3 încercări înainte de verdict. */
  let ac = null;
  /* S6 mută conținut QA (POST/DELETE /api/content — necesar fluxului dubbing),
   * ceea ce declanșează resync-ul complet PROTEJAT FAZA 18 (18.925 rânduri,
   * 757 upsert-uri secvențiale ≈ 40-75s pe Neon). Căutările așteaptă
   * ensureSynced() în fereastra asta → 504 onest de la resilience timeout.
   * Comportament REAL al platformei, nu o regresie: reîncercăm până iese
   * fereastra (max ~4 min, mult peste cel mai lung resync observat). */
  for (let attempt = 1; attempt <= 8 && (ac === null || ac.status !== 200); attempt += 1) {
    ac = await get('/api/search/autocomplete?q=dragon', null, { timeoutMs: 60000 });
    if (ac.status === 200) break;
    await new Promise((r) => setTimeout(r, 15000));
  }
  ok('S10.2 FAZA 18 autocomplete neatins (200 + suggestions)', ac.status === 200 && Array.isArray(ac.body?.suggestions), `got ${ac.status} după până la 8 încercări (fereastra de resync post-mutări S6)`);

  const hub = await get('/api/hub/stats', null, { timeoutMs: 30000 });
  ok('S10.3 FAZA 20 hub neatins (200)', hub.status === 200, `got ${hub.status}`);

  const suite = await get('/api/ai/suite/status', null, { timeoutMs: 30000 });
  ok(
    'S10.4 FAZA 32 AI suite neatinsă (18 motoare)',
    suite.status === 200 && Object.keys(suite.body?.engines ?? {}).length === 18,
    `engines=${Object.keys(suite.body?.engines ?? {}).length}`,
  );

  const accel = await get('/api/searchaccel/status', null, { timeoutMs: 30000 });
  ok('S10.5 FAZA 29-P accel neatins (service=searchaccel)', accel.status === 200 && accel.body?.service === 'searchaccel', `got ${accel.status}`);

  const searchux = await get('/api/searchux/status', null, { timeoutMs: 30000 });
  ok('S10.6 FAZA 33 searchux neatins (service=searchux)', searchux.status === 200 && searchux.body?.service === 'searchux', `got ${searchux.status}`);

  const playerx = await get('/api/playerx/status', null, { timeoutMs: 30000 });
  ok('S10.7 FAZA 34 playerx neatins (service=playerx)', playerx.status === 200 && playerx.body?.service === 'playerx', `got ${playerx.status}`);

  const tracks = await get(`/api/player/subtitles/content/${richId}/subtitles`, null, { timeoutMs: 30000 });
  ok(
    'S10.8 FAZA 21 subtitrări neatinse (200 + data[])',
    tracks.status === 200 && tracks.body?.ok === true && Array.isArray(tracks.body?.data),
    `got ${tracks.status}`,
  );
}

/* ---------------------------------- verdict ---------------------------------- */

console.log('\n══════════════════════════════════════════════');
console.log(`REZULTAT: ${passed} PASSED · ${failed} FAILED`);
if (failed > 0) {
  console.log('\nEșecuri:');
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log('✅ FAZA 35 AI Lab — TOATE verificările verzi. Contractul înghețat respectat; suite-urile protejate (FAZA 18/19/20/21/29-P/32/33/34) neatrinse.');
