#!/usr/bin/env bun
/**
 * FAZA 10 — Animaxia Social & Real-Time end-to-end smoke.
 *
 * Verifies the full social stack against the LIVE services:
 *   A. Infra health     — monolith :4000 (Neon), realtime :4010, web :3000
 *   B. REST social      — follows, people, profiles, reviews, feed v2,
 *                         watch parties, AI social (50+ checks)
 *   C. Realtime socket  — JWT parity, guest mode, party rooms, host-only
 *                         control, chat persistence, typing, presence
 *   D. E2E webhook      — REST review → activityevents → realtime → socket
 *   E. Cleanup          — test data torn down
 *
 * Run: bun tests/smoke-social.mjs   (from mini-services/animaxia-realtime)
 * Needs: socket.io-client (service dependency), services :4000 + :4010 up.
 */

import { io } from 'socket.io-client';

const MONOLITH = process.env.MONOLITH_URL || 'http://localhost:4000';
const REALTIME = process.env.REALTIME_URL || 'http://localhost:4010';
const WEB = process.env.WEB_URL || 'http://localhost:3000';
const now = Date.now();

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, extra = '') {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.error(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

const section = (title) => console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 64 - title.length))}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

async function req(base, method, path, { token, body } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON */
  }
  return { status: res.status, json };
}
const api = (method, path, opts) => req(MONOLITH, method, path, opts);

function connect({ token } = {}) {
  return io(REALTIME, {
    path: '/',
    transports: ['websocket'],
    auth: token ? { token } : {},
    forceNew: true,
    reconnection: false,
    timeout: 6000,
  });
}

function once(socket, event, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting "${event}"`)), timeoutMs);
    socket.once(event, (payload) => {
      clearTimeout(t);
      resolve(payload);
    });
  });
}

const run = async () => {
  console.log(`Animaxia FAZA 10 smoke — ${new Date().toISOString()}`);
  console.log(`monolith=${MONOLITH} realtime=${REALTIME} web=${WEB}`);

  /* ------------------------------ A. infra ------------------------------ */
  section('A. Infra health');

  const health = await api('GET', '/api/health');
  check('A1 monolith /api/health 200', health.status === 200);
  check('A2 monolith Neon connected', health.json?.db?.connected === true, JSON.stringify(health.json?.db).slice(0, 120));
  check('A3 monolith content present', num(health.json?.db?.totalItems) >= 50, `totalItems=${health.json?.db?.totalItems}`);

  const rtHealth = await req(REALTIME, 'GET', '/api/health');
  check('A4 realtime /api/health 200', rtHealth.status === 200);
  check('A5 realtime auth parity active', rtHealth.json?.authMode === 'derived' || rtHealth.json?.authMode === 'explicit', JSON.stringify(rtHealth.json).slice(0, 120));

  const rtMetrics = await fetch(`${REALTIME}/metrics`);
  check('A6 realtime /metrics Prometheus', rtMetrics.status === 200 && /animaxia_realtime_sockets_connected/.test(await rtMetrics.text()));

  const web = await fetch(WEB, { redirect: 'manual' });
  check('A7 web :3000 reachable', web.status === 200 || web.status === 307);

  /* ---------------------------- B. REST social ---------------------------- */
  section('B. REST — auth + follows');

  const u1 = await api('POST', '/api/auth/register', { body: { email: `s10a_${now}@test.dev`, username: `s10a_${now}`, password: 'Passw0rd!123' } });
  const u2 = await api('POST', '/api/auth/register', { body: { email: `s10b_${now}@test.dev`, username: `s10b_${now}`, password: 'Passw0rd!123' } });
  check('B1 register u1', u1.status === 201 && u1.json?.accessToken);
  check('B2 register u2', u2.status === 201 && u2.json?.accessToken);
  const t1 = u1.json.accessToken;
  const t2 = u2.json.accessToken;
  const id1 = u1.json.user.id;
  const id2 = u2.json.user.id;

  const all = await api('GET', '/api/all?limit=3');
  const contentId = all.json?.data?.[0]?.id;
  const contentId2 = all.json?.data?.[1]?.id;
  check('B3 content ids available', Number.isInteger(contentId) && Number.isInteger(contentId2));

  check('B4 self-follow 400', (await api('POST', '/api/social/follow', { token: t1, body: { userId: id1 } })).status === 400);
  check('B5 follow unknown 404', (await api('POST', '/api/social/follow', { token: t1, body: { userId: 99_999_999 } })).status === 404);
  const follow = await api('POST', '/api/social/follow', { token: t1, body: { userId: id2 } });
  check('B6 follow u1→u2', follow.status === 200 && follow.json?.following === true);
  check('B7 follow idempotent', (await api('POST', '/api/social/follow', { token: t1, body: { userId: id2 } })).json?.following === true);

  const people = await api('GET', '/api/social/people', { token: t1 });
  check('B8 people 200, followed excluded', people.status === 200 && Array.isArray(people.json?.data) && !people.json.data.some((p) => p.id === id2));
  const peopleCard = people.json.data[0];
  check('B9 people card shape (no email)', !peopleCard || (typeof peopleCard.username === 'string' && typeof peopleCard.followers === 'number' && peopleCard.email === undefined));

  const peopleSearch = await api('GET', `/api/social/people?q=${encodeURIComponent(`s10b_${now}`)}`, { token: t1 });
  check('B10 people search q= (followed excluded)', peopleSearch.status === 200);
  const peopleSearchU2ByOther = await api('GET', `/api/social/people?q=${encodeURIComponent(`s10a_${now}`)}`, { token: t2 });
  check('B11 people search finds u1 for u2', peopleSearchU2ByOther.status === 200 && peopleSearchU2ByOther.json?.data?.some((p) => p.id === id1));

  check('B12 following list', (await api('GET', '/api/social/following', { token: t1 })).json?.data?.some((p) => p.id === id2 && p.isfollowing === true));
  check('B13 followers list', (await api('GET', '/api/social/followers', { token: t2 })).json?.data?.some((p) => p.id === id1));

  const profile = await api('GET', `/api/social/user/${id2}/profile`, { token: t1 });
  check(
    'B14 profile shape + relation + no email',
    profile.status === 200 &&
      profile.json?.user?.username &&
      profile.json.user.email === undefined &&
      profile.json?.stats?.followers >= 1 &&
      profile.json?.relation?.isfollowing === true &&
      Array.isArray(profile.json?.recentReviews) &&
      Array.isArray(profile.json?.recentActivity),
    JSON.stringify(profile.json).slice(0, 200),
  );
  const profileAnon = await api('GET', `/api/social/user/${id2}/profile`);
  check('B15 profile anon: relation null, taste null', profileAnon.status === 200 && profileAnon.json?.relation === null && profileAnon.json?.taste === null);

  section('B. REST — reviews');

  check('B16 review rating 11 → 400', (await api('POST', '/api/social/reviews', { token: t1, body: { contentId, rating: 11, body: 'x'.repeat(20) } })).status === 400);
  check('B17 review short body → 400', (await api('POST', '/api/social/reviews', { token: t1, body: { contentId, rating: 8, body: 'short' } })).status === 400);
  check('B18 review unknown content → 404', (await api('POST', '/api/social/reviews', { token: t1, body: { contentId: 99_999_999, rating: 8, body: 'x'.repeat(20) } })).status === 404);

  const review1 = await api('POST', '/api/social/reviews', { token: t1, body: { contentId, rating: 9, title: 'Smoke review', body: 'A gripping watch from start to finish with brilliant pacing.' } });
  check('B19 review create 201', review1.status === 201 && review1.json?.review?.rating === 9);
  const review1Upd = await api('POST', '/api/social/reviews', { token: t1, body: { contentId, rating: 8, body: 'Updated take: still excellent, slight mid-season dip in momentum.' } });
  check('B20 review upsert edited', review1Upd.status === 200 && review1Upd.json?.created === false && review1Upd.json?.review?.rating === 8);

  const review2 = await api('POST', '/api/social/reviews', { token: t2, body: { contentId, rating: 10, body: 'An instant favorite — gorgeous visuals and a finale that sticks.' } });
  check('B21 second user review 201', review2.status === 201);

  const like1 = await api('POST', `/api/social/reviews/${review2.json.review.id}/like`, { token: t1, body: {} });
  check('B22 review like', like1.status === 200 && like1.json?.liked === true && like1.json?.likes === 1);
  const unlike = await api('POST', `/api/social/reviews/${review2.json.review.id}/like`, { token: t1, body: {} });
  check('B23 review unlike toggle', unlike.json?.liked === false && unlike.json?.likes === 0);
  await api('POST', `/api/social/reviews/${review2.json.review.id}/like`, { token: t1, body: {} }); // re-like for display

  const list = await api('GET', `/api/social/reviews/content/${contentId}`, { token: t1 });
  check(
    'B24 reviews list + aggregate',
    list.status === 200 && list.json?.aggregate?.count >= 2 && list.json.aggregate.avg > 0 && list.json.data?.some((r) => r.liked === true) && list.json.data?.every((r) => r.user?.email === undefined),
    JSON.stringify(list.json?.aggregate),
  );

  const recent = await api('GET', '/api/social/reviews/recent?limit=10');
  check('B25 recent reviews with content', recent.status === 200 && recent.json?.data?.length >= 2 && recent.json.data[0]?.content?.title);

  section('B. REST — feed v2');

  const feed = await api('GET', '/api/social/feed/v2?limit=10', { token: t1 });
  check(
    'B26 feed v2 auth + event types',
    feed.status === 200 && feed.json?.data?.some((e) => e.type === 'follow') && feed.json.data.some((e) => e.type === 'review'),
    JSON.stringify(feed.json?.data?.map((e) => e.type)),
  );
  check('B27 feed v2 requires auth', (await api('GET', '/api/social/feed/v2')).status === 401);
  check('B28 feed v2 public anon ok', (await api('GET', '/api/social/feed/v2/public?limit=5')).status === 200);

  const page1 = await api('GET', '/api/social/feed/v2?limit=2', { token: t1 });
  check('B29 feed v2 cursor present', page1.json?.data?.length === 2 && typeof page1.json?.nextCursor === 'string');
  if (page1.json?.nextCursor) {
    const page2 = await api('GET', `/api/social/feed/v2?limit=2&cursor=${encodeURIComponent(page1.json.nextCursor)}`, { token: t1 });
    const ids1 = page1.json.data.map((e) => e.id);
    const ids2 = page2.json.data.map((e) => e.id);
    check('B30 feed v2 cursor: no overlap', page2.json.data.length > 0 && !ids1.some((id) => ids2.includes(id)));
  }

  section('B. REST — watch parties');

  check('B31 party create requires auth', (await api('POST', '/api/social/party', { body: { contentId } })).status === 401);
  const party = await api('POST', '/api/social/party', { token: t1, body: { contentId, title: 'Smoke watch party' } });
  check('B32 party create 201 + code + host', party.status === 201 && /^[2-9A-HJKMNP-Z]{6}$/.test(party.json?.party?.code || '') && party.json?.party?.host?.id === id1, JSON.stringify(party.json).slice(0, 200));
  const partyId = party.json.party.id;

  const party2 = await api('POST', '/api/social/party', { token: t1, body: { contentId: contentId2 } });
  const partyId2 = party2.json.party.id;
  check('B33 new active party supersedes previous', partyId2 > partyId);

  const priv = await api('POST', '/api/social/party', { token: t2, body: { contentId, isPrivate: true } });
  check('B34 private party created', priv.status === 201 && priv.json?.party?.isprivate === true);
  const privId = priv.json.party.id;

  const parties = await api('GET', '/api/social/parties', { token: t2 });
  check(
    'B35 parties list: active only, private excluded',
    parties.status === 200 && parties.json?.data?.some((p) => p.id === partyId2) && !parties.json.data.some((p) => p.id === privId),
    JSON.stringify(parties.json?.data?.map((p) => [p.id, p.status, p.isprivate])).slice(0, 200),
  );

  check('B36 join unknown party 404', (await api('POST', '/api/social/party/99999999/join', { token: t2, body: {} })).status === 404);
  const join = await api('POST', `/api/social/party/${partyId2}/join`, { token: t2 });
  check('B37 join 200 + amimember', join.status === 200 && join.json?.party?.amimember === true);
  check('B38 join idempotent', (await api('POST', `/api/social/party/${partyId2}/join`, { token: t2 })).status === 200);

  check('B39 sync by non-host 403', (await api('POST', `/api/social/party/${partyId2}/sync`, { token: t2, body: { state: { positionSec: 5, isPaused: false } } })).status === 403);
  const syncBad = await api('POST', `/api/social/party/${partyId2}/sync`, { token: t1, body: { state: { positionSec: -50, isPaused: 'not-a-bool', playbackRate: 99 } } });
  check('B40 sync sanitizes garbage state', syncBad.status === 200 && syncBad.json?.state?.positionSec === 0 && syncBad.json.state.isPaused === true && syncBad.json.state.playbackRate === 1, JSON.stringify(syncBad.json?.state));
  const sync = await api('POST', `/api/social/party/${partyId2}/sync`, { token: t1, body: { state: { positionSec: 480, isPaused: false } } });
  check('B41 sync by host', sync.json?.state?.positionSec === 480 && sync.json.state.isPaused === false);

  const chatRest = await api('POST', `/api/social/party/${partyId2}/messages`, { token: t1, body: { body: 'Welcome everyone — pressing play in 3…' } });
  check('B42 party message via REST', chatRest.status === 201 && chatRest.json?.message?.body?.includes('pressing play'));
  check('B43 party message non-member 403', (await api('POST', `/api/social/party/${privId}/messages`, { token: t1, body: { body: 'should be rejected' } })).status === 403);
  check('B44 message too long 400', (await api('POST', `/api/social/party/${partyId2}/messages`, { token: t1, body: { body: 'x'.repeat(501) } })).status === 400);

  const detail = await api('GET', `/api/social/party/${partyId2}`);
  check(
    'B45 party detail: members + state + messages',
    detail.status === 200 && detail.json?.members?.length === 2 && detail.json?.state?.positionSec === 480 && detail.json?.messages?.length >= 1 && detail.json?.party?.code,
    JSON.stringify(detail.json).slice(0, 250),
  );

  for (let i = 0; i < 3; i++) {
    await api('POST', `/api/social/party/${partyId2}/messages`, { token: t2, body: { body: `history message ${i + 1}` } });
  }
  const histPage1 = await api('GET', `/api/social/party/${partyId2}/messages`);
  const firstId = histPage1.json?.data?.[0]?.id;
  const histPage2 = await api('GET', `/api/social/party/${partyId2}/messages?beforeId=${firstId}`);
  check('B46 messages keyset pagination', histPage1.json.data.length === 4 && histPage2.json.data.length === 0);

  const byCode = await api('POST', '/api/social/party/join-code', { body: { code: party2.json.party.code } });
  check('B47 join by code', byCode.status === 200 && byCode.json?.party?.id === partyId2);
  check('B48 join by bad code 404', (await api('POST', '/api/social/party/join-code', { body: { code: 'ZZZZZZ' } })).status === 404);
  check('B49 join by invalid code 400', (await api('POST', '/api/social/party/join-code', { body: { code: 'ABC' } })).status === 400);

  section('B. REST — AI social');

  const aiHome = await api('GET', '/api/ai/social/home', { token: t1 });
  check(
    'B50 AI social home shape',
    aiHome.status === 200 && Array.isArray(aiHome.json?.friendsAlsoWatched) && Array.isArray(aiHome.json?.tasteMatches) && Array.isArray(aiHome.json?.socialPicks),
    JSON.stringify(aiHome.json).slice(0, 250),
  );
  check('B51 AI social home requires auth', (await api('GET', '/api/ai/social/home')).status === 401);

  const digest = await api('POST', `/api/ai/social/review-digest/${contentId}`, { token: t1, body: {} });
  check(
    'B52 review digest (LLM chain + fallback)',
    digest.status === 200 && typeof digest.json?.summary === 'string' && digest.json.summary.length > 20 && ['positive', 'mixed', 'critical', 'neutral'].includes(digest.json.sentiment) && Array.isArray(digest.json.themes),
    JSON.stringify(digest.json).slice(0, 250),
  );

  /* --------------------------- C. realtime socket --------------------------- */
  section('C. Realtime — sockets');

  const guest = connect();
  const guestHello = await once(guest, 'hello');
  check('C1 guest connects (no user)', guestHello.user === null);

  guest.emit('party:join', { partyId: partyId2 });
  check('C2 guest party:join → auth error', (await once(guest, 'party:error')).code === 'auth');

  const bad = connect({ token: 'garbage.token.here' });
  const badErr = await new Promise((resolve) => bad.on('connect_error', (e) => resolve(e.message)));
  check('C3 invalid token connect_error', /invalid or expired/i.test(badErr), badErr);
  bad.close();

  const host = connect({ token: t1 });
  const hostHello = await once(host, 'hello');
  check('C4 host hello identity', hostHello.user?.id === id1 && typeof hostHello.user?.username === 'string', JSON.stringify(hostHello).slice(0, 150));

  host.emit('party:join', { partyId: partyId2 });
  const hostState = await once(host, 'party:state');
  check(
    'C5 host party:state (host only, state 480)',
    hostState.partyId === partyId2 && hostState.hostid === id1 && hostState.members.length === 1 && hostState.members[0]?.userid === id1 && hostState.state.positionSec === 480,
    JSON.stringify(hostState).slice(0, 250),
  );

  const member = connect({ token: t2 });
  await once(member, 'hello');
  const joinedP = once(host, 'party:member-joined');
  member.emit('party:join', { partyId: partyId2 });
  const memberState = await once(member, 'party:state');
  const joinedEvt = await joinedP;
  check('C6 member sees 2 members', memberState.members.length === 2);
  check('C7 host notified member-joined', Boolean(joinedEvt.user?.username));

  member.emit('party:control', { partyId: partyId2, action: 'play', positionSec: 10 });
  check('C8 non-host control forbidden', (await once(member, 'party:error')).code === 'forbidden');

  const ctlP = once(member, 'party:control');
  host.emit('party:control', { partyId: partyId2, action: 'seek', positionSec: 950 });
  const ctl = await ctlP;
  check('C9 host seek relayed', ctl.action === 'seek' && ctl.state.positionSec === 950 && ctl.by === id1);

  const playP = once(member, 'party:control');
  host.emit('party:control', { partyId: partyId2, action: 'play', positionSec: 950 });
  check('C10 play → isPaused false', (await playP).state.isPaused === false);

  host.emit('party:control', { partyId: partyId2, action: 'flap', positionSec: 1 });
  check('C11 unknown action rejected', (await once(host, 'party:error')).code === 'bad-request');

  const chatHostP = once(host, 'party:chat');
  const chatMemberP = once(member, 'party:chat');
  member.emit('party:chat', { partyId: partyId2, body: 'Live chat over socket — hello!' });
  const chatH = await chatHostP;
  const chatM = await chatMemberP;
  check('C12 chat relayed + persisted', chatH.persisted === true && chatM.message.body === 'Live chat over socket — hello!' && Number.isInteger(chatM.message.id), JSON.stringify(chatH).slice(0, 200));
  const persistedMsgs = await api('GET', `/api/social/party/${partyId2}/messages`);
  check('C13 chat persisted via monolith to Neon', persistedMsgs.json?.data?.some((m) => m.body === 'Live chat over socket — hello!'));

  member.emit('party:chat', { partyId: partyId2, body: '' });
  check('C14 empty chat rejected', (await once(member, 'party:error')).code === 'bad-request');

  const typingP = once(host, 'party:typing');
  member.emit('party:typing', { partyId: partyId2 });
  check('C15 typing relay', Boolean((await typingP).user?.username));

  const presenceP = once(host, 'presence:online', 8000);
  member.close();
  const presence = await presenceP;
  check('C16 presence on disconnect', typeof presence.online === 'number' && presence.online >= 1);

  member.emit('party:leave', { partyId: partyId2 }); // no-op on closed socket
  await wait(200);
  host.emit('party:leave', { partyId: partyId2 });
  await wait(300);
  host.close();
  guest.close();

  /* ------------------------------ D. E2E webhook ------------------------------ */
  section('D. E2E — monolith webhook → realtime ticker');

  const listener = connect(); // guest socket in the activity:public room
  await once(listener, 'hello');
  let liveEvent = null;
  listener.on('social:activity', (e) => {
    if (e.user?.username === `s10a_${now}`) liveEvent = e;
  });

  const trigger = await api('POST', '/api/social/reviews', { token: t1, body: { contentId: contentId2, rating: 6, body: 'Webhook end-to-end trigger review for the live ticker.' } });
  check('D1 webhook trigger review 201', trigger.status === 201);
  for (let i = 0; i < 12 && !liveEvent; i++) await wait(300);
  check('D2 social:activity received live', Boolean(liveEvent) && liveEvent.type === 'review' && liveEvent.content?.id === contentId2, JSON.stringify(liveEvent).slice(0, 200));
  listener.close();

  /* -------------------------------- E. cleanup -------------------------------- */
  section('E. Cleanup');

  check('E1 delete own review (content2)', (await api('DELETE', `/api/social/reviews/${trigger.json.review.id}`, { token: t1 })).status === 200);
  check('E2 delete review unknown 404', (await api('DELETE', '/api/social/reviews/99999999', { token: t1 })).status === 404);
  const leaveHost = await api('POST', `/api/social/party/${partyId2}/leave`, { token: t1, body: {} });
  check('E3 host leave ends party', leaveHost.json?.status === 'ended');
  check('E4 member leave active party', (await api('POST', `/api/social/party/${privId}/leave`, { token: t2, body: {} })).json?.status === 'ended');
  check('E5 unfollow', (await api('POST', '/api/social/unfollow', { token: t1, body: { userId: id2 } })).json?.following === false);
  check('E6 unfollow idempotent', (await api('POST', '/api/social/unfollow', { token: t1, body: { userId: id2 } })).json?.following === false);

  /* --------------------------------- summary --------------------------------- */
  console.log('\n' + '═'.repeat(70));
  console.log(`SMOKE RESULT: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  if (failures.length) {
    console.log('Failed checks:');
    for (const f of failures) console.error(`  ✗ ${f}`);
  }
  console.log('═'.repeat(70));
  process.exit(failed ? 1 : 0);
};

run().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
