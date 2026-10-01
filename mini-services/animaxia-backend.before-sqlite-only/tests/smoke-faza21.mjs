#!/usr/bin/env bun
/**
 * tests/smoke-faza21.mjs — FAZA 21 smoke suite: EXACT 43 checks.
 *
 * Live end-to-end checks against the Animaxia monolith (:4000) covering the
 * whole FAZA-21 surface (100% real Neon data, zero mocks):
 *   A. Playlists (18)   — create/validate/list/items/dedup/renumber/patch/
 *                          play-order/delete + owner-only 404s + anon 401
 *   B. Subtitles (13)   — admin upsert + dedup-upsert, public listing, public
 *                          {id}.vtt serving (text/vtt), invalid-VTT 400s,
 *                          non-admin 403 / anon 401, admin list, delete
 *   C. Mystats (5)      — history/views enrichment + /api/users/me/stats
 *                          contract + anon 401 + profile /me not shadowed
 *   D. Playerhub (4)    — admin /status + /history, non-admin 403, anon 401
 *   E. Regression (3)   — /api/health, /api/hub/stats (FAZA 20),
 *                          /api/search/status pipelineIntegrated (FAZA 18)
 *
 * Admin strategy (honest, no shortcuts): register a fresh user, promote it to
 * role='admin' via the real Neon DB (pg client + DATABASEURL from .env —
 * bootstrap-first-user does not apply, the DB already has users), re-login.
 * Protection is ALSO proven with 403/401 on the admin routes.
 *
 * Zero new dependencies (bun-native fetch + the backend's own pg).
 * Exits non-zero on any failure.
 *
 * Usage:  bun tests/smoke-faza21.mjs
 * Env:    API_ORIGIN  default http://localhost:4000
 */

import { readFileSync } from 'node:fs';
import pg from 'pg';

const API_ORIGIN = process.env.API_ORIGIN || 'http://localhost:4000';
const NONCE = Date.now();

let passed = 0;
let failed = 0;
const failures = [];

function record(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function call(method, path, { token, body } = {}) {
  const res = await fetch(`${API_ORIGIN}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* keep null — raw-body checks use text */
  }
  return { res, text, json };
}

const get = (path, token) => call('GET', path, { token });
const post = (path, body, token) => call('POST', path, { body, token });

/** DATABASEURL from env or the backend .env (no dotenv dependency needed). */
function loadDatabaseUrl() {
  if (process.env.DATABASEURL) return process.env.DATABASEURL;
  try {
    const raw = readFileSync(new URL('../.env', import.meta.url), 'utf8');
    const m = raw.match(/^DATABASEURL=(.+)$/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  } catch {
    /* fall through */
  }
  return null;
}

/* ---------------------------------- setup ----------------------------------- */

console.log('── Setup: 3 fresh users + real admin promotion + real content ids ──');

const userA = { email: `faza21-a-${NONCE}@animaxia.local`, username: `fz21a${NONCE % 100000}`, password: 'faza21-pass-A' };
const userB = { email: `faza21-b-${NONCE}@animaxia.local`, username: `fz21b${NONCE % 100000}`, password: 'faza21-pass-B' };
const userAdm = { email: `faza21-adm-${NONCE}@animaxia.local`, username: `fz21m${NONCE % 100000}`, password: 'faza21-pass-M' };

const regA = await post('/api/auth/register', userA);
const regB = await post('/api/auth/register', userB);
const regAdm = await post('/api/auth/register', userAdm);
if (regA.res.status !== 201 || regB.res.status !== 201 || regAdm.res.status !== 201) {
  console.error(`SETUP FAILED: register A=${regA.res.status} B=${regB.res.status} ADM=${regAdm.res.status}`);
  process.exit(1);
}
const tokenA = regA.json.accessToken;
const tokenB = regB.json.accessToken;
let tokenAdm = regAdm.json.accessToken;

// Real admin promotion through the real database (pg + DATABASEURL), plus
// cleanup of THIS suite's own leftover subtitle tracks (matched by their
// distinctive test bodies — never touches anyone else's data).
const databaseUrl = loadDatabaseUrl();
let promoted = false;
if (databaseUrl) {
  try {
    const client = new pg.Client({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } });
    await client.connect();
    const r = await client.query(`UPDATE users SET role = 'admin' WHERE email = $1 RETURNING id, role`, [userAdm.email]);
    const cleaned = await client.query(
      `DELETE FROM subtitles WHERE vtt LIKE '%FAZA 21%' OR vtt LIKE '%Welcome to Animaxia%'
       RETURNING id`,
    );
    await client.end();
    promoted = r.rowCount === 1 && r.rows[0].role === 'admin';
    if (cleaned.rowCount > 0) console.log(`  cleaned ${cleaned.rowCount} leftover FAZA-21 test subtitle track(s)`);
  } catch (err) {
    console.error(`  admin promotion via pg failed: ${err.message}`);
  }
}
if (promoted) {
  const loginAdm = await post('/api/auth/login', { email: userAdm.email, password: userAdm.password });
  if (loginAdm.res.status === 200) tokenAdm = loginAdm.json.accessToken;
}
console.log(`  users: A=${regA.json.user.id} B=${regB.json.user.id} ADM=${regAdm.json.user.id} (promoted=${promoted})`);

// Real content picks: #1 rich (thumbnail+rating+year+genres) for items/history,
// #2 any other with a thumbnail — for the renumbering flow.
const all = await get('/api/all?limit=100');
if (all.res.status !== 200 || !Array.isArray(all.json?.data) || all.json.data.length < 2) {
  console.error('SETUP FAILED: /api/all did not return content');
  process.exit(1);
}
const items = all.json.data;
const rich = items.find((c) => c.thumbnail && c.metadata?.rating != null && c.metadata?.year != null && Array.isArray(c.metadata?.genres) && c.metadata.genres.length > 0);
const pick1 = rich || items.find((c) => c.thumbnail) || items[0];
const pick2 = items.find((c) => c.id !== pick1.id && c.thumbnail) || items.find((c) => c.id !== pick1.id);
console.log(`  content: pick1=#${pick1.id} (${pick1.title}) pick2=#${pick2.id} (${pick2.title})`);

/* ------------------------------- A. playlists -------------------------------- */

console.log('── A. Playlists (18) ──');

const created = await post('/api/playlists', { title: 'Maraton FAZA 21', description: 'playlist de test' }, tokenA);
record(
  'A1 (1) POST /api/playlists → 201 { ok, playlist.id }',
  created.res.status === 201 && created.json?.ok === true && Number.isInteger(created.json?.playlist?.id),
  `status=${created.res.status}`,
);
const plId = created.json?.playlist?.id;

const noTitle = await post('/api/playlists', { description: 'fara titlu' }, tokenA);
record('A2 (2) POST /api/playlists fără title → 400', noTitle.res.status === 400, `status=${noTitle.res.status}`);

const list0 = await get('/api/playlists', tokenA);
record(
  'A3 (3) GET /api/playlists → lista cu itemCount 0, firstTitle null',
  list0.res.status === 200 && Array.isArray(list0.json?.data)
    && list0.json.data.some((p) => p.id === plId && p.itemCount === 0 && p.firstTitle === null && p.firstThumbnail === null),
  `status=${list0.res.status}`,
);

const add1 = await post(`/api/playlists/${plId}/items`, { contentId: pick1.id }, tokenA);
record(
  'A4 (4) POST /:id/items pick1 → 201 added:true position 1',
  add1.res.status === 201 && add1.json?.ok === true && add1.json?.added === true && add1.json?.item?.position === 1,
  `status=${add1.res.status} added=${add1.json?.added}`,
);

const add1again = await post(`/api/playlists/${plId}/items`, { contentId: pick1.id }, tokenA);
record(
  'A5 (5) POST /:id/items pick1 din nou → 200 added:false (dedup ON CONFLICT)',
  add1again.res.status === 200 && add1again.json?.ok === true && add1again.json?.added === false,
  `status=${add1again.res.status} added=${add1again.json?.added}`,
);

const add2 = await post(`/api/playlists/${plId}/items`, { contentId: pick2.id }, tokenA);
record(
  'A6 (6) POST /:id/items pick2 → 201 added:true position 2',
  add2.res.status === 201 && add2.json?.added === true && add2.json?.item?.position === 2,
  `status=${add2.res.status} position=${add2.json?.item?.position}`,
);

const detail = await get(`/api/playlists/${plId}`, tokenA);
const dItem = detail.json?.items?.find((i) => i.contentId === pick1.id);
record(
  'A7 (7) GET /:id → items 2, pick1 cu title/thumbnail/type/rating/year reale',
  detail.res.status === 200 && detail.json?.items?.length === 2
    && dItem?.title === pick1.title && dItem?.thumbnail === pick1.thumbnail && dItem?.type === pick1.type
    && dItem?.rating != null && dItem?.year != null && dItem?.position === 1,
  `items=${detail.json?.items?.length} rating=${dItem?.rating} year=${dItem?.year}`,
);

const list1 = await get('/api/playlists', tokenA);
const plRow = list1.json?.data?.find((p) => p.id === plId);
record(
  'A8 (8) GET /api/playlists → itemCount 2, firstThumbnail/firstTitle = pick1',
  list1.res.status === 200 && plRow?.itemCount === 2 && plRow?.firstTitle === pick1.title && plRow?.firstThumbnail === pick1.thumbnail,
  `itemCount=${plRow?.itemCount} firstTitle=${plRow?.firstTitle}`,
);

const patched = await call('PATCH', `/api/playlists/${plId}`, { token: tokenA, body: { title: 'Maraton FAZA 21 — redenumit' } });
record(
  'A9 (9) PATCH /:id rename → 200, title nou, updatedat ≥ createdat',
  patched.res.status === 200 && patched.json?.playlist?.title === 'Maraton FAZA 21 — redenumit'
    && new Date(patched.json?.playlist?.updatedat) >= new Date(patched.json?.playlist?.createdat),
  `status=${patched.res.status} title=${patched.json?.playlist?.title}`,
);

const play0 = await get(`/api/playlists/${plId}/play`, tokenA);
record(
  'A10 (10) GET /:id/play → 200, items 2, startPos 0',
  play0.res.status === 200 && play0.json?.items?.length === 2 && play0.json?.startPos === 0 && play0.json?.playlist?.id === plId,
  `status=${play0.res.status} startPos=${play0.json?.startPos}`,
);

const playClamp = await get(`/api/playlists/${plId}/play?pos=99`, tokenA);
record(
  'A11 (11) GET /:id/play?pos=99 → startPos clampat la 1 (len-1)',
  playClamp.res.status === 200 && playClamp.json?.startPos === 1,
  `startPos=${playClamp.json?.startPos}`,
);

const rm1 = await call('DELETE', `/api/playlists/${plId}/items/${pick1.id}`, { token: tokenA });
record(
  'A12 (12) DELETE /:id/items/:contentId pick1 → removed:true',
  rm1.res.status === 200 && rm1.json?.ok === true && rm1.json?.removed === true,
  `status=${rm1.res.status} removed=${rm1.json?.removed}`,
);

const detail2 = await get(`/api/playlists/${plId}`, tokenA);
const remItem = detail2.json?.items?.[0];
record(
  'A13 (13) GET /:id după remove → 1 item, pick2 renumerotat la position 1',
  detail2.res.status === 200 && detail2.json?.items?.length === 1 && remItem?.contentId === pick2.id && remItem?.position === 1,
  `items=${detail2.json?.items?.length} position=${remItem?.position}`,
);

const bogusContent = await post(`/api/playlists/${plId}/items`, { contentId: 999999999 }, tokenA);
record('A14 (14) POST /:id/items content inexistent → 404', bogusContent.res.status === 404, `status=${bogusContent.res.status}`);

const foreignGet = await get(`/api/playlists/${plId}`, tokenB);
record(
  'A15 (15) non-owner GET /:id → 404 (fără leak de existență)',
  foreignGet.res.status === 404,
  `status=${foreignGet.res.status}`,
);

const foreignAdd = await post(`/api/playlists/${plId}/items`, { contentId: pick1.id }, tokenB);
record('A16 (16) non-owner POST /:id/items → 404', foreignAdd.res.status === 404, `status=${foreignAdd.res.status}`);

const anonList = await get('/api/playlists');
record('A17 (17) anonim GET /api/playlists → 401', anonList.res.status === 401, `status=${anonList.res.status}`);

const delPl = await call('DELETE', `/api/playlists/${plId}`, { token: tokenA });
const afterDel = await get(`/api/playlists/${plId}`, tokenA);
record(
  'A18 (18) DELETE /:id → ok deleted, apoi GET /:id → 404',
  delPl.res.status === 200 && delPl.json?.ok === true && delPl.json?.deleted === plId && afterDel.res.status === 404,
  `status=${delPl.res.status} afterDel=${afterDel.res.status}`,
);

/* ------------------------------ B. subtitles --------------------------------- */

console.log('── B. Subtitrări WebVTT (13) ──');

const VTT_RO = `WEBVTT

1
00:00:01.000 --> 00:00:04.000
Bun venit la Animaxia!

2
00:00:05.000 --> 00:00:08.000
Subtitrare de test FAZA 21.
`;
const VTT_EN = `WEBVTT

1
00:00:01.000 --> 00:00:03.000
Welcome to Animaxia! (FAZA 21 test)
`;

const sub1 = await post('/api/player/subtitles', { contentId: pick1.id, lang: 'ro', vtt: VTT_RO }, tokenAdm);
record(
  'B1 (19) POST /api/player/subtitles (admin, VTT valid 2 cue-uri) → 200 created:true',
  sub1.res.status === 200 && sub1.json?.ok === true && sub1.json?.created === true && Number.isInteger(sub1.json?.subtitle?.id),
  `status=${sub1.res.status} created=${sub1.json?.created}`,
);
const subId1 = sub1.json?.subtitle?.id;

const sub1again = await post('/api/player/subtitles', { contentId: pick1.id, lang: 'ro', vtt: VTT_RO }, tokenAdm);
record(
  'B2 (20) POST identic din nou → created:false, același id (upsert ON CONFLICT)',
  sub1again.res.status === 200 && sub1again.json?.created === false && sub1again.json?.subtitle?.id === subId1,
  `created=${sub1again.json?.created} id=${sub1again.json?.subtitle?.id} vs ${subId1}`,
);

const sub2 = await post('/api/player/subtitles', { contentId: pick1.id, lang: 'en', vtt: VTT_EN }, tokenAdm);
record(
  'B3 (21) POST a doua pistă (lang en) → created:true',
  sub2.res.status === 200 && sub2.json?.created === true && sub2.json?.subtitle?.id !== subId1,
  `status=${sub2.res.status} created=${sub2.json?.created}`,
);

const listing = await get(`/api/player/subtitles/content/${pick1.id}/subtitles`);
const srcOk = listing.json?.data?.every?.((t) => typeof t.src === 'string' && t.src.startsWith('/api/player/subtitles/') && t.src.endsWith('.vtt'));
record(
  'B4 (22) GET /content/:id/subtitles PUBLIC (anonim) → 200, 2 piste cu src {id}.vtt',
  listing.res.status === 200 && listing.json?.data?.length === 2 && srcOk
    && listing.json.data.some((t) => t.lang === 'ro' && t.label === 'Română') && listing.json.data.some((t) => t.lang === 'en'),
  `status=${listing.res.status} n=${listing.json?.data?.length}`,
);

const vttFile = await call('GET', `/api/player/subtitles/${subId1}.vtt`);
record(
  'B5 (23) GET /{id}.vtt PUBLIC → 200, Content-Type text/vtt, corpul începe cu WEBVTT',
  vttFile.res.status === 200 && String(vttFile.res.headers.get('content-type') || '').startsWith('text/vtt')
    && vttFile.text.startsWith('WEBVTT') && vttFile.text.includes('-->') && vttFile.text.includes('Bun venit'),
  `status=${vttFile.res.status} ct=${vttFile.res.headers.get('content-type')}`,
);

const vttMissing = await get('/api/player/subtitles/99999999.vtt');
record('B6 (24) GET /99999999.vtt (inexistent) → 404', vttMissing.res.status === 404, `status=${vttMissing.res.status}`);

const badMagic = await post('/api/player/subtitles', { contentId: pick1.id, vtt: '00:00:01.000 --> 00:00:02.000\nnot a vtt file at all' }, tokenAdm);
record(
  'B7 (25) POST VTT fără magic WEBVTT → 400 cu motiv',
  badMagic.res.status === 400 && /WEBVTT/i.test(String(badMagic.json?.error || '')),
  `status=${badMagic.res.status} error=${badMagic.json?.error}`,
);

const badCues = await post('/api/player/subtitles', { contentId: pick1.id, vtt: 'WEBVTT\n\nnicio intrare cue aici' }, tokenAdm);
record(
  'B8 (26) POST VTT fără cue-uri (lipsă -->) → 400',
  badCues.res.status === 400 && /cue/i.test(String(badCues.json?.error || '')),
  `status=${badCues.res.status} error=${badCues.json?.error}`,
);

const nonAdminPost = await post('/api/player/subtitles', { contentId: pick1.id, vtt: VTT_RO }, tokenB);
record('B9 (27) POST ca non-admin → 403', nonAdminPost.res.status === 403, `status=${nonAdminPost.res.status}`);

const anonPost = await post('/api/player/subtitles', { contentId: pick1.id, vtt: VTT_RO });
record('B10 (28) POST anonim → 401', anonPost.res.status === 401, `status=${anonPost.res.status}`);

const adminList = await get('/api/player/subtitles/list', tokenAdm);
const roRow = adminList.json?.data?.find?.((t) => t.id === subId1);
record(
  'B11 (29) GET /list (admin) → 200, rânduri cu contentTitle + cues reale',
  adminList.res.status === 200 && Array.isArray(adminList.json?.data) && adminList.json.data.length >= 2
    && roRow?.contentTitle === pick1.title && roRow?.cues === 2 && roRow?.lang === 'ro',
  `status=${adminList.res.status} n=${adminList.json?.data?.length} cues=${roRow?.cues}`,
);

const delSub = await call('DELETE', `/api/player/subtitles/${subId1}`, { token: tokenAdm });
record(
  'B12 (30) DELETE /:id (admin) → ok deleted',
  delSub.res.status === 200 && delSub.json?.ok === true && delSub.json?.deleted === subId1,
  `status=${delSub.res.status}`,
);

const vttAfterDel = await get(`/api/player/subtitles/${subId1}.vtt`);
const listingAfterDel = await get(`/api/player/subtitles/content/${pick1.id}/subtitles`);
record(
  'B13 (31) după DELETE: {id}.vtt → 404, listarea publică → 1 pistă (en rămasă)',
  vttAfterDel.res.status === 404 && listingAfterDel.res.status === 200 && listingAfterDel.json?.data?.length === 1 && listingAfterDel.json?.data?.[0]?.lang === 'en',
  `vtt=${vttAfterDel.res.status} n=${listingAfterDel.json?.data?.length}`,
);

/* -------------------------------- C. mystats --------------------------------- */

console.log('── C. Stats personale (5) ──');

const hist = await post('/api/users/me/history', { contentId: pick1.id, progress: 600 }, tokenA);
record(
  'C1 (32) POST /api/users/me/history {contentId, progress:600} → ok (enrichment real)',
  hist.res.status === 200 && hist.json?.ok === true,
  `status=${hist.res.status}`,
);

const view = await post('/api/analytics/views', { contentId: pick1.id, event: 'view' }, tokenA);
record(
  'C2 (33) POST /api/analytics/views {event:view} → ok (viewevents atribuit)',
  view.res.status === 200 && view.json?.ok === true,
  `status=${view.res.status}`,
);

const stats = await get('/api/users/me/stats', tokenA);
const s = stats.json;
record(
  'C3 (34) GET /api/users/me/stats → contract complet: historyCount≥1, totalMinutes≥10, engagement/streak, watchlistCount, viewsCount≥1, topGenres, aiUsage',
  stats.res.status === 200 && s?.ok === true
    && s.watch?.historyCount >= 1 && s.watch?.totalMinutes >= 10 && Number.isFinite(s.watch?.avgProgress)
    && s.engagement?.activeDays >= 1 && s.engagement?.streakDays >= 1 && s.engagement?.lastActive != null
    && Number.isInteger(s.watchlistCount) && s.viewsCount >= 1
    && Array.isArray(s.topGenres) && s.topGenres.length >= 1
    && (s.aiUsage === null || Number.isInteger(s.aiUsage?.calls)),
  `status=${stats.res.status} history=${s?.watch?.historyCount} min=${s?.watch?.totalMinutes} streak=${s?.engagement?.streakDays} genres=${s?.topGenres?.length}`,
);

const anonStats = await get('/api/users/me/stats');
record('C4 (35) anonim GET /api/users/me/stats → 401', anonStats.res.status === 401, `status=${anonStats.res.status}`);

const meProfile = await get('/api/users/me', tokenA);
record(
  'C5 (36) GET /api/users/me (profile FAZA-2) → 200 user (mystats NU umbrește profileRouter)',
  meProfile.res.status === 200 && meProfile.json?.user?.id === regA.json.user.id,
  `status=${meProfile.res.status}`,
);

/* ------------------------------ D. playerhub --------------------------------- */

console.log('── D. Playerhub admin (4) ──');

const status = await get('/api/admin/playerhub/status', tokenAdm);
const st = status.json;
record(
  'D1 (37) GET /api/admin/playerhub/status (admin) → 200 cu playback/topWatched/subtitles/sources/uptimeSec',
  status.res.status === 200 && st?.ok === true
    && Number.isInteger(st.playback?.total) && st.playback.total >= 1 && Number.isInteger(st.playback?.last24h) && st.playback?.byKind != null
    && Array.isArray(st.topWatched) && st.topWatched.length >= 1 && st.topWatched[0]?.title != null
    && Number.isInteger(st.subtitles?.total) && st.subtitles.total >= 1 && Array.isArray(st.subtitles?.perContent)
    && Array.isArray(st.sources?.allowedTypes) && st.sources.allowedTypes.length >= 1
    && st.sources?.byMode != null && Number.isInteger(st.sources?.contentWithSources)
    && Number.isInteger(st.usersWatching) && Number.isInteger(st.uptimeSec) && st.generatedAt != null,
  `status=${status.res.status} playback=${st?.playback?.total} topWatched=${st?.topWatched?.length} subs=${st?.subtitles?.total} allowed=${st?.sources?.allowedTypes?.join(',')}`,
);

const history = await get('/api/admin/playerhub/history', tokenAdm);
record(
  'D2 (38) GET /api/admin/playerhub/history (admin) → 200 array (istoric personal)',
  history.res.status === 200 && Array.isArray(history.json?.data),
  `status=${history.res.status} n=${history.json?.data?.length}`,
);

const nonAdminHub = await get('/api/admin/playerhub/status', tokenB);
record('D3 (39) GET /api/admin/playerhub/status ca non-admin → 403', nonAdminHub.res.status === 403, `status=${nonAdminHub.res.status}`);

const anonHub = await get('/api/admin/playerhub/status');
record('D4 (40) GET /api/admin/playerhub/status anonim → 401', anonHub.res.status === 401, `status=${anonHub.res.status}`);

/* ------------------------------- E. regression ------------------------------- */

console.log('── E. Regresie FAZA 18/20 + health (3) ──');

const health = await get('/api/health');
record(
  'E1 (41) GET /api/health → 200 status ok (monolit sănătos)',
  health.res.status === 200 && health.json?.status === 'ok' && health.json?.db?.connected === true,
  `status=${health.res.status}`,
);

const hubStats = await get('/api/hub/stats');
record(
  'E2 (42) GET /api/hub/stats → 200 ok (FAZA 20 neatinsă)',
  hubStats.res.status === 200 && hubStats.json?.ok === true && Number.isInteger(hubStats.json?.totalItems),
  `status=${hubStats.res.status} totalItems=${hubStats.json?.totalItems}`,
);

const searchStatus = await get('/api/search/status');
record(
  'E3 (43) GET /api/search/status → pipelineIntegrated true (FAZA 18 neatinsă)',
  searchStatus.res.status === 200 && searchStatus.json?.pipelineIntegrated === true,
  `status=${searchStatus.res.status} pipelineIntegrated=${searchStatus.json?.pipelineIntegrated}`,
);

/* ---------------------------------- verdict ---------------------------------- */

console.log('────────────────────────────────');
console.log(`FAZA 21 smoke: ${passed} passed, ${failed} failed (din 43)`);
if (failed > 0) {
  console.log('Eșecuri:');
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log('TOATE CELE 43 CHECK-URI AU TRECUT ✓');
