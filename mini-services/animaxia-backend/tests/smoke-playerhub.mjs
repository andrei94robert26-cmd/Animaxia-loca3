#!/usr/bin/env bun
/**
 * animaxia-backend/tests/smoke-playerhub.mjs — FAZA 19 (Player Hub) live
 * smoke suite (Task 19-4a, backend QA).
 *
 * End-to-end checks against the Animaxia monolith (:4000) covering the whole
 * FAZA 19 Player Hub surface (modules/player/hub.js, mounted at
 * /api/playerhub — 18 routes, real Neon data):
 *   A. Contracte publice — GET /status (hub "playerhub" + version "19.1" +
 *      the 6 features + totals), public subtitle listing, GET /stats
 *      (totals + topContinueWatching ≤ 5), 401 anonymous on every user route
 *   B. Playlists CRUD   — create (201 + validation 400s), list with
 *      itemsCount, item add + dedupe + content 404, detail with ordered
 *      positions, reorder (valid + wrong-set 400), PATCH, owner isolation
 *      (second user → 404), DELETE, the 20-per-user cap (21st → 409) and a
 *      full API cleanup of every QA playlist
 *   C. Progress / resume — POST /progress (saved:true) → GET /progress/:id
 *      (137 + watchedat) → THE UNIFIED HISTORY PROOF: /api/users/me/history
 *      serves the very same row → /continue-watching shape (progress,
 *      watchedat, sourcesCount, hasResume, content) → validation (-5 → 400,
 *      999999 → 404 GET+POST) → DELETE reset → 0 → anonymous 401
 *   D. Subtitles        — admin attach (201, track.id) → public listing →
 *      raw VTT serving (200 + Content-Type text/vtt + WEBVTT payload) →
 *      non-admin 403 → vtt/lang validation 400 → admin detach 200 +
 *      re-detach 404 (cleanup)
 *   E. Regresii         — the FAZA 15–18 search pipeline intact on
 *      /api/search/status (pipelineIntegrated + the exact 10 stages +
 *      stressTest.concurrent 10000), /api/health (ok + db.connected), the
 *      external player resolver route GET /api/content/2/player (allowedTypes)
 *
 * Zero dependencies (bun-native fetch; `pg` only for the QA admin promotion,
 * exactly like tests/smoke-searchfull.mjs). Exits non-zero on any failure.
 *
 * Rotating X-Forwarded-For identities (10.79.x.y, unique per request) keep
 * the GLOBAL rate limiter (120 req / 60s per client IP) out of the way —
 * the whole suite stays far below the per-IP budget.
 *
 * Usage:  bun tests/smoke-playerhub.mjs       (from the monolith)
 * Env:    API_ORIGIN  default http://localhost:4000
 *         DATABASEURL (monolith .env — for the QA admin promotion)
 */

const API_ORIGIN = process.env.API_ORIGIN || 'http://localhost:4000';

let passed = 0;
let failed = 0;
const failures = [];

function record(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/* Rotating simulated client IP (10.79.x.y) for EVERY request the suite
 * makes — the GLOBAL rate limiter (120 req / 60s per client IP) would
 * otherwise exhaust the shared 127.0.0.1 budget when QA suites run
 * back-to-back. Each call gets its own identity. */
let callSeq = 0;
function qaXff() {
  callSeq += 1;
  return `10.79.${Math.floor(callSeq / 250) % 250}.${(callSeq % 250) + 1}`;
}

async function request(method, path, { body, headers = {}, timeoutMs = 30000 } = {}) {
  return fetch(`${API_ORIGIN}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      'X-Forwarded-For': qaXff(),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

async function getJson(path, headers = {}, timeoutMs = 30000) {
  const res = await request('GET', path, { headers, timeoutMs });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

async function postJson(path, body, headers = {}, timeoutMs = 30000) {
  const res = await request('POST', path, { body, headers, timeoutMs });
  let parsed = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed };
}

async function patchJson(path, body, headers = {}, timeoutMs = 30000) {
  const res = await request('PATCH', path, { body, headers, timeoutMs });
  let parsed = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed };
}

async function deleteJson(path, headers = {}, timeoutMs = 30000) {
  const res = await request('DELETE', path, { headers, timeoutMs });
  let parsed = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed };
}

/** Raw GET returning the unparsed body (for the VTT payload + headers). */
async function getText(path, headers = {}, timeoutMs = 30000) {
  const res = await request('GET', path, { headers, timeoutMs });
  const text = await res.text().catch(() => '');
  return { status: res.status, contentType: res.headers.get('content-type') || '', text };
}

/* ------------------------------------------------------------------ sections -- */

/** A. The public Player Hub contracts (no authentication). */
async function sectionA() {
  console.log('\nA. Contracte publice pe /api/playerhub (fără auth)');
  const st = await getJson('/api/playerhub/status');
  record('GET /api/playerhub/status → 200', st.status === 200, `status=${st.status}`);
  record(
    'hub="playerhub" + version="19.1" pinned',
    st.body?.hub === 'playerhub' && st.body?.version === '19.1',
    `hub=${st.body?.hub} version=${st.body?.version}`,
  );
  const FEATURES = ['playlists', 'progress', 'resume', 'continue-watching', 'subtitles', 'stats'];
  const feats = Array.isArray(st.body?.features) ? st.body.features : [];
  const missingF = FEATURES.filter((f) => !feats.includes(f));
  record(
    'features conține toate cele 6 capabilități FAZA 19',
    missingF.length === 0,
    missingF.length ? `lipsesc: ${missingF.join(', ')}` : FEATURES.join(', '),
  );
  const totals = st.body?.totals;
  record(
    'totals: obiect cu cele 3 chei (playlists/playlistItems/subtitleTracks)',
    Boolean(totals && typeof totals === 'object') &&
      ['playlists', 'playlistItems', 'subtitleTracks'].every((k) => Number.isFinite(totals[k])),
    `totals=${JSON.stringify(totals)}`,
  );

  const subs = await getJson('/api/playerhub/subtitles/2');
  record(
    'GET /subtitles/2 (contentId real) → 200 cu { data: array }',
    subs.status === 200 && Array.isArray(subs.body?.data),
    `status=${subs.status} data=${Array.isArray(subs.body?.data) ? subs.body.data.length : 'not-array'}`,
  );

  const stats = await getJson('/api/playerhub/stats');
  record(
    'GET /api/playerhub/stats → 200, totals obiect + topContinueWatching array ≤ 5',
    stats.status === 200 &&
      Boolean(stats.body?.totals && typeof stats.body.totals === 'object') &&
      Array.isArray(stats.body?.topContinueWatching) &&
      stats.body.topContinueWatching.length <= 5,
    `status=${stats.status} top=${Array.isArray(stats.body?.topContinueWatching) ? stats.body.topContinueWatching.length : 'not-array'}`,
  );

  const a1 = await getJson('/api/playerhub/playlists');
  record('fără auth: GET /playlists → 401', a1.status === 401, `status=${a1.status}`);
  const a2 = await getJson('/api/playerhub/continue-watching');
  record('fără auth: GET /continue-watching → 401', a2.status === 401, `status=${a2.status}`);
  const a3 = await postJson('/api/playerhub/progress', { contentId: 2, seconds: 10 });
  record('fără auth: POST /progress → 401', a3.status === 401, `status=${a3.status}`);
  const a4 = await postJson('/api/playerhub/subtitles/2', { label: 'QA', lang: 'ro', vtt: 'WEBVTT' });
  record('fără auth: POST /subtitles/2 → 401', a4.status === 401, `status=${a4.status}`);
}

/** Register a throwaway QA user (same pattern as smoke-searchfull.mjs).
 *  Returns the Bearer token or null. */
async function registerUser(prefix) {
  try {
    const stamp = `${Date.CURRENT_TIMESTAMP.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
    const email = `${prefix}-${stamp}@synth.animaxia`;
    const reg = await fetch(`${API_ORIGIN}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Forwarded-For': qaXff() },
      body: JSON.stringify({ email, username: `${prefix}${stamp}`, password: 'F19User!2026' }),
      signal: AbortSignal.timeout(15000),
    });
    const regBody = await reg.json().catch(() => null);
    return regBody?.accessToken ? regBody.accessToken : null;
  } catch {
    return null;
  }
}

/** Register a throwaway QA user and promote it to admin directly in Neon
 *  (DATABASEURL from the monolith .env — bun auto-loads it). Returns the
 *  Bearer token or null when promotion is unavailable. */
async function promoteAndLoginAdmin(prefix) {
  try {
    const stamp = `${Date.CURRENT_TIMESTAMP.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
    const email = `${prefix}-admin-${stamp}@synth.animaxia`;
    const reg = await fetch(`${API_ORIGIN}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Forwarded-For': '10.79.200.10' },
      body: JSON.stringify({ email, username: `${prefix}admin${stamp}`, password: 'F19Admin!2026' }),
      signal: AbortSignal.timeout(15000),
    });
    const regBody = await reg.json().catch(() => null);
    if (!regBody?.accessToken) return null;
    const dbUrl = process.env.DATABASEURL;
    if (!dbUrl) return null;
    const pg = (await import('pg')).default;
    const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
    await client.connect();
    await client.query('UPDATE users SET role = $1 WHERE email = $2', ['admin', email]);
    await client.end();
    const login = await fetch(`${API_ORIGIN}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Forwarded-For': '10.79.200.11' },
      body: JSON.stringify({ email, password: 'F19Admin!2026' }),
      signal: AbortSignal.timeout(15000),
    });
    const loginBody = await login.json().catch(() => null);
    return loginBody?.accessToken ?? regBody.accessToken;
  } catch {
    return null;
  }
}

/** B. Playlists — the full owner CRUD lifecycle + isolation + the 20 cap. */
async function sectionB() {
  console.log('\nB. Playlists — CRUD complet, reorder, izolare proprietar, limita 20');
  const tokenB = await registerUser('f19qa');
  if (!tokenB) {
    record(' utilizator QA (playlists) înregistrat', false, 'register a eșuat — verifică /api/auth/register');
    return;
  }
  const auth = { authorization: `Bearer ${tokenB}` };

  const created = await postJson('/api/playerhub/playlists', { title: 'QA FAZA 19 Playlist' }, auth);
  const pid = created.body?.playlist?.id;
  record(
    'POST /playlists {title:"QA FAZA 19 Playlist"} → 201/200 cu playlist.id',
    (created.status === 201 || created.status === 200) && Number.isInteger(pid),
    `status=${created.status} id=${pid}`,
  );
  if (!Number.isInteger(pid)) return;

  const badShort = await postJson('/api/playerhub/playlists', { title: 'X' }, auth);
  record('POST /playlists title de 1 caracter → 400', badShort.status === 400, `status=${badShort.status}`);
  const badMissing = await postJson('/api/playerhub/playlists', {}, auth);
  record('POST /playlists fără title → 400', badMissing.status === 400, `status=${badMissing.status}`);

  const list0 = await getJson('/api/playerhub/playlists', auth);
  const mine0 = (list0.body?.data || []).find((p) => p.id === pid);
  record(
    'GET /playlists conține playlistul cu itemsCount=0',
    list0.status === 200 && Boolean(mine0) && mine0.itemsCount === 0,
    `itemsCount=${mine0?.itemsCount}`,
  );

  const add1 = await postJson(`/api/playerhub/playlists/${pid}/items`, { contentId: 2 }, auth);
  record(
    'POST /playlists/:id/items {contentId:2} → added:true',
    (add1.status === 201 || add1.status === 200) && add1.body?.added === true,
    `status=${add1.status} added=${add1.body?.added}`,
  );

  const addMissing = await postJson(`/api/playerhub/playlists/${pid}/items`, { contentId: 999999 }, auth);
  record('POST items {contentId:999999} → 404', addMissing.status === 404, `status=${addMissing.status}`);

  const dup = await postJson(`/api/playerhub/playlists/${pid}/items`, { contentId: 2 }, auth);
  record(
    're-POST items {contentId:2} → 200 duplicate:true added:false',
    dup.status === 200 && dup.body?.duplicate === true && dup.body?.added === false,
    `status=${dup.status} duplicate=${dup.body?.duplicate} added=${dup.body?.added}`,
  );

  const det1 = await getJson(`/api/playerhub/playlists/${pid}`, auth);
  const items1 = det1.body?.items || [];
  record(
    'GET /playlists/:id → 1 item, position 0, content.id=2',
    det1.status === 200 && items1.length === 1 && items1[0]?.position === 0 && items1[0]?.content?.id === 2,
    `items=${items1.length} pos0=${items1[0]?.position} cid=${items1[0]?.content?.id}`,
  );

  const add2 = await postJson(`/api/playerhub/playlists/${pid}/items`, { contentId: 1 }, auth);
  record(
    'POST items {contentId:1} → al doilea item pe position 1',
    add2.body?.added === true && add2.body?.item?.position === 1,
    `added=${add2.body?.added} position=${add2.body?.item?.position}`,
  );

  const reord = await postJson(`/api/playerhub/playlists/${pid}/reorder`, { contentIds: [1, 2] }, auth);
  record(
    'POST /playlists/:id/reorder {contentIds:[1,2]} → ok',
    reord.status === 200 && reord.body?.ok === true && reord.body?.count === 2,
    `status=${reord.status} count=${reord.body?.count}`,
  );

  const det2 = await getJson(`/api/playerhub/playlists/${pid}`, auth);
  const items2 = det2.body?.items || [];
  record(
    'după reorder: ordinea [1,2] cu pozițiile 0,1',
    items2.length === 2 &&
      items2[0]?.content?.id === 1 && items2[0]?.position === 0 &&
      items2[1]?.content?.id === 2 && items2[1]?.position === 1,
    `order=${items2.map((i) => `${i?.content?.id}@${i?.position}`).join(',')}`,
  );

  const badReord = await postJson(`/api/playerhub/playlists/${pid}/reorder`, { contentIds: [1, 999] }, auth);
  record('reorder cu set greșit [1,999] → 400', badReord.status === 400, `status=${badReord.status}`);

  const patched = await patchJson(`/api/playerhub/playlists/${pid}`, { title: 'QA FAZA 19 Redenumit' }, auth);
  record(
    'PATCH /playlists/:id {title:"QA FAZA 19 Redenumit"} → 200',
    patched.status === 200 && patched.body?.playlist?.title === 'QA FAZA 19 Redenumit',
    `status=${patched.status} title=${patched.body?.playlist?.title}`,
  );

  const list1 = await getJson('/api/playerhub/playlists', auth);
  const mine1 = (list1.body?.data || []).find((p) => p.id === pid);
  record('GET /playlists reflectă titlul redenumit', mine1?.title === 'QA FAZA 19 Redenumit', `title=${mine1?.title}`);

  const tokenB2 = await registerUser('f19iso');
  if (!tokenB2) {
    record('izolare: al doilea user pe playlistul primului → 404', false, 'register al celui de-al doilea user a eșuat');
  } else {
    const foreign = await getJson(`/api/playerhub/playlists/${pid}`, { authorization: `Bearer ${tokenB2}` });
    record(
      'izolare: al doilea user pe playlistul primului → 404 (fără leak de ownership)',
      foreign.status === 404,
      `status=${foreign.status}`,
    );
  }

  const del = await deleteJson(`/api/playerhub/playlists/${pid}`, auth);
  record('DELETE /playlists/:id → 200', del.status === 200 && del.body?.deleted === true, `status=${del.status}`);
  const list2 = await getJson('/api/playerhub/playlists', auth);
  record(
    'GET /playlists nu mai conține playlistul șters',
    !(list2.body?.data || []).some((p) => p.id === pid),
    `stillPresent=${(list2.body?.data || []).some((p) => p.id === pid)}`,
  );

  /* Limita 20/user: 20 creații (al 21-lea → 409), apoi cleanup prin API. */
  const limitIds = [];
  for (let i = 1; i <= 20; i += 1) {
    const r = await postJson('/api/playerhub/playlists', { title: `QA FAZA 19 Limită #${String(i).padStart(2, '0')}` }, auth);
    if ((r.status === 201 || r.status === 200) && Number.isInteger(r.body?.playlist?.id)) {
      limitIds.push(r.body.playlist.id);
    }
  }
  record('limita: 20 playlists create cu succes', limitIds.length === 20, `created=${limitIds.length}/20`);
  const extra = await postJson('/api/playerhub/playlists', { title: 'QA FAZA 19 Limită #21' }, auth);
  record('al 21-lea playlist → 409 (limită 20/user)', extra.status === 409, `status=${extra.status}`);

  let cleaned = 0;
  for (const id of limitIds) {
    const r = await deleteJson(`/api/playerhub/playlists/${id}`, auth);
    if (r.status === 200) cleaned += 1;
  }
  record('cleanup: toate cele 20 playlists QA șterse prin API', cleaned === limitIds.length, `deleted=${cleaned}/${limitIds.length}`);
  const listFinal = await getJson('/api/playerhub/playlists', auth);
  const remaining = (listFinal.body?.data || []).length;
  record('cleanup verificat: listarea userului QA e goală', remaining === 0, `remaining=${remaining}`);
}

/** C. Progress / resume — the unified watchhistory proof. */
async function sectionC() {
  console.log('\nC. Progress / resume / istoric unificat');
  const tokenC = await registerUser('f19prg');
  if (!tokenC) {
    record(' utilizator QA (progress) înregistrat', false, 'register a eșuat — verifică /api/auth/register');
    return;
  }
  const auth = { authorization: `Bearer ${tokenC}` };

  const save = await postJson('/api/playerhub/progress', { contentId: 2, seconds: 137 }, auth);
  record(
    'POST /progress {contentId:2, seconds:137} → 200 saved:true',
    save.status === 200 && save.body?.saved === true,
    `status=${save.status} saved=${save.body?.saved}`,
  );

  const read = await getJson('/api/playerhub/progress/2', auth);
  record(
    'GET /progress/2 → progress=137 + watchedat non-null',
    read.status === 200 && read.body?.progress === 137 && Boolean(read.body?.watchedat),
    `progress=${read.body?.progress} watchedat=${read.body?.watchedat}`,
  );

  const hist = await getJson('/api/users/me/history', auth);
  const entry = (hist.body?.data || []).find((e) => e?.content?.id === 2);
  record(
    'DOVADA istoricului unificat: /api/users/me/history conține contentId 2 cu progress 137',
    hist.status === 200 && Boolean(entry) && entry.progress === 137,
    `status=${hist.status} progress=${entry?.progress}`,
  );

  const cw = await getJson('/api/playerhub/continue-watching', auth);
  const first = (cw.body?.data || [])[0];
  record(
    'GET /continue-watching → prima intrare (content 2) cu progress + câmpurile așteptate',
    cw.status === 200 &&
      Boolean(first) &&
      first.content?.id === 2 &&
      first.progress === 137 &&
      Boolean(first.watchedat) &&
      Number.isFinite(first.sourcesCount) &&
      typeof first.hasResume === 'boolean',
    `first=${first ? `${first.content?.id}@${first.progress} resume=${first.hasResume}` : 'lipsă'}`,
  );

  const neg = await postJson('/api/playerhub/progress', { contentId: 2, seconds: -5 }, auth);
  record('POST /progress seconds:-5 → 400', neg.status === 400, `status=${neg.status}`);
  const missGet = await getJson('/api/playerhub/progress/999999', auth);
  record('GET /progress/999999 → 404', missGet.status === 404, `status=${missGet.status}`);
  const missPost = await postJson('/api/playerhub/progress', { contentId: 999999, seconds: 10 }, auth);
  record('POST /progress {contentId:999999} → 404', missPost.status === 404, `status=${missPost.status}`);

  const del = await deleteJson('/api/playerhub/progress/2', auth);
  record('DELETE /progress/2 → 200', del.status === 200 && del.body?.ok === true, `status=${del.status}`);
  const after = await getJson('/api/playerhub/progress/2', auth);
  record(
    'GET /progress/2 după reset → progress=0',
    after.status === 200 && after.body?.progress === 0,
    `progress=${after.body?.progress}`,
  );

  const anon = await getJson('/api/playerhub/progress/2');
  record('fără auth: GET /progress/2 → 401', anon.status === 401, `status=${anon.status}`);
}

/** D. Subtitles — admin attach, public VTT serving, validation, detach. */
const QA_VTT = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nSalut QA';

async function sectionD() {
  console.log('\nD. Subtitles — attach admin, servire VTT publică, validări, detach');
  const adminToken = await promoteAndLoginAdmin('f19');
  if (!adminToken) {
    record('admin QA promovat + logat', false, ' fără DATABASEURL pentru promovarea QA — rulează din monolith cu .env încărcat');
    return;
  }
  const adminAuth = { authorization: `Bearer ${adminToken}` };

  const attach = await postJson('/api/playerhub/subtitles/2', { label: 'QA RO', lang: 'ro', vtt: QA_VTT }, adminAuth);
  const trackId = attach.body?.track?.id;
  record(
    'POST /subtitles/2 {label:"QA RO", lang:"ro"} ca ADMIN → 201/200 cu track.id',
    (attach.status === 201 || attach.status === 200) && Number.isInteger(trackId),
    `status=${attach.status} trackId=${trackId}`,
  );
  if (!Number.isInteger(trackId)) return;

  const list = await getJson('/api/playerhub/subtitles/2');
  record(
    'GET /subtitles/2 (public) conține trackul QA',
    list.status === 200 && (list.body?.data || []).some((t) => t.id === trackId && t.label === 'QA RO' && t.lang === 'ro'),
    `tracks=${(list.body?.data || []).length}`,
  );

  const raw = await getText(`/api/playerhub/subtitles/2/${trackId}`);
  record(
    'GET /subtitles/2/:trackId → 200, Content-Type text/vtt, corp cu WEBVTT + "Salut QA"',
    raw.status === 200 && raw.contentType.includes('text/vtt') && raw.text.includes('WEBVTT') && raw.text.includes('Salut QA'),
    `status=${raw.status} ct=${raw.contentType} WEBVTT=${raw.text.includes('WEBVTT')}`,
  );

  const tokenNonAdmin = await registerUser('f19sub');
  if (!tokenNonAdmin) {
    record('POST /subtitles/2 non-admin → 403', false, 'register non-admin a eșuat');
  } else {
    const forbidden = await postJson(
      '/api/playerhub/subtitles/2',
      { label: 'X', lang: 'ro', vtt: QA_VTT },
      { authorization: `Bearer ${tokenNonAdmin}` },
    );
    record('POST /subtitles/2 non-admin → 403', forbidden.status === 403, `status=${forbidden.status}`);
  }

  const badVtt = await postJson(
    '/api/playerhub/subtitles/2',
    { label: 'QA BAD', lang: 'ro', vtt: '00:00:01.000 --> 00:00:02.000\nfără header WEBVTT' },
    adminAuth,
  );
  record('vtt fără header WEBVTT → 400', badVtt.status === 400, `status=${badVtt.status}`);
  const badLang = await postJson('/api/playerhub/subtitles/2', { label: 'QA LANG', lang: 'x1!', vtt: QA_VTT }, adminAuth);
  record('lang invalid "x1!" → 400', badLang.status === 400, `status=${badLang.status}`);

  const detach = await deleteJson(`/api/playerhub/subtitles/2/${trackId}`, adminAuth);
  record(
    'DELETE /subtitles/2/:trackId ca admin → 200 (cleanup)',
    detach.status === 200 && detach.body?.deleted === true,
    `status=${detach.status}`,
  );
  const reDelete = await deleteJson(`/api/playerhub/subtitles/2/${trackId}`, adminAuth);
  record('re-DELETE același track → 404', reDelete.status === 404, `status=${reDelete.status}`);
}

/** E. Platform regressions — the golden rules must hold after FAZA 19. */
async function sectionE() {
  console.log('\nE. Regresii de platformă — pipeline FAZA 15–18 + health + player extern');
  const search = await getJson('/api/search/status');
  record(
    'regresie: /api/search/status pipelineIntegrated:true + pipelineStages exact 10 (FAZA 15–18 INTACT)',
    search.status === 200 &&
      search.body?.pipelineIntegrated === true &&
      Array.isArray(search.body?.pipelineStages) &&
      search.body.pipelineStages.length === 10,
    `status=${search.status} integrated=${search.body?.pipelineIntegrated} stages=${search.body?.pipelineStages?.length}`,
  );
  record(
    'regresie: stressTest.concurrent === 10000 (contractul FAZA 18 pinned)',
    search.body?.stressTest?.concurrent === 10000,
    `concurrent=${search.body?.stressTest?.concurrent}`,
  );

  const health = await getJson('/api/health');
  record(
    'regresie: /api/health status ok + db.connected:true',
    health.status === 200 && health.body?.status === 'ok' && health.body?.db?.connected === true,
    `status=${health.status} db=${health.body?.db?.connected}`,
  );

  /* The existing external player resolver route (verified with grep in
   * server.js): GET /api/content/:id/player — /api/player/:id is NOT a route. */
  const player = await getJson('/api/content/2/player');
  record(
    'regresie: ruta player externă /api/content/2/player → 200 cu allowedTypes',
    player.status === 200 && Array.isArray(player.body?.allowedTypes) && player.body.allowedTypes.length > 0,
    `status=${player.status} allowedTypes=${JSON.stringify(player.body?.allowedTypes)?.slice(0, 80)}`,
  );
}

/* ------------------------------------------------------------------ main -- */

async function main() {
  console.log(`FAZA 19 — Player Hub smoke (against ${API_ORIGIN})`);

  await sectionA();
  await sectionB();
  await sectionC();
  await sectionD();
  await sectionE();

  console.log(`\n────────────────────────────────────────`);
  console.log(`PLAYERHUB SMOKE: ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log('failures:');
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('smoke-playerhub crashed:', err);
  process.exit(1);
});
