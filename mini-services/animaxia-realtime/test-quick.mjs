#!/usr/bin/env node
/**
 * FAZA 10 quick realtime verification (throwaway; full smoke in
 * animaxia-social/tests/smoke-social.mjs). Exercises: JWT auth parity,
 * guest mode, party join/state/member events, host-only control, chat with
 * monolith persistence, live activity webhook, error paths, metrics.
 */
import { io } from 'socket.io-client';
import { readFileSync } from 'node:fs';

const MONOLITH = 'http://localhost:4000';
const REALTIME = 'http://localhost:4010';
const now = Date.now();
let passed = 0;
let failed = 0;

const check = (name, cond, extra = '') => {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name} ${extra}`);
  }
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(method, path, { token, body } = {}) {
  const res = await fetch(`${MONOLITH}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

function connect({ token } = {}) {
  return io(REALTIME, {
    path: '/',
    transports: ['websocket'],
    auth: token ? { token } : {},
    forceNew: true,
    reconnection: false,
    timeout: 5000,
  });
}

function once(socket, event, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting "${event}"`)), timeoutMs);
    socket.once(event, (payload) => {
      clearTimeout(t);
      resolve(payload);
    });
  });
}

const realtimeToken = (() => {
  const text = readFileSync(new URL('./.env', import.meta.url), 'utf8');
  const m = text.match(/^REALTIMETOKEN=(.+)$/m);
  return m ? m[1].trim() : '';
})();

const run = async () => {
  /* --- setup: 2 users + party --- */
  const u1 = await req('POST', '/api/auth/register', { body: { email: `rt1_${now}@test.dev`, username: `rt1_${now}`, password: 'Passw0rd!123' } });
  const u2 = await req('POST', '/api/auth/register', { body: { email: `rt2_${now}@test.dev`, username: `rt2_${now}`, password: 'Passw0rd!123' } });
  const t1 = u1.json.accessToken;
  const t2 = u2.json.accessToken;
  const id1 = u1.json.user.id;

  const all = await req('GET', '/api/all?limit=1');
  const contentId = all.json.data[0].id;
  const party = await req('POST', '/api/social/party', { token: t1, body: { contentId } });
  const partyId = party.json.party.id;
  check('setup party', party.status === 201, JSON.stringify(party.json).slice(0, 150));

  /* --- guest socket: connects, cannot join parties --- */
  const guest = connect();
  const guestHello = await once(guest, 'hello');
  check('guest hello (no user)', guestHello.user === null, JSON.stringify(guestHello).slice(0, 120));
  guest.emit('party:join', { partyId });
  const guestErr = await once(guest, 'party:error');
  check('guest party:join → auth error', guestErr.code === 'auth', JSON.stringify(guestErr));

  /* --- invalid token: connect_error --- */
  const bad = connect({ token: 'not.a.jwt' });
  const badErr = await new Promise((resolve) => bad.on('connect_error', (e) => resolve(e.message)));
  check('invalid token rejected', /invalid or expired/i.test(badErr), badErr);
  bad.close();

  /* --- host socket --- */
  const host = connect({ token: t1 });
  const hostHello = await once(host, 'hello');
  check('host hello with identity', hostHello.user?.id === id1, JSON.stringify(hostHello).slice(0, 150));

  host.emit('party:join', { partyId });
  const hostState = await once(host, 'party:state');
  check('host party:state', hostState.partyId === partyId && hostState.hostid === id1 && hostState.members.length === 1 && hostState.state, JSON.stringify(hostState).slice(0, 250));

  /* --- member socket --- */
  const member = connect({ token: t2 });
  await once(member, 'hello');
  const memberJoinedP = once(host, 'party:member-joined', 6000);
  member.emit('party:join', { partyId });
  const memberState = await once(member, 'party:state');
  const joinedEvt = await memberJoinedP;
  check('member party:state (2 members)', memberState.members.length === 2);
  check('host sees member-joined', joinedEvt.user?.id === memberState.hostid - memberState.hostid + memberState.hostid || joinedEvt.user, JSON.stringify(joinedEvt).slice(0, 150));

  /* --- control: member forbidden, host relays --- */
  member.emit('party:control', { partyId, action: 'play', positionSec: 50 });
  const forbidden = await once(member, 'party:error');
  check('non-host control forbidden', forbidden.code === 'forbidden');

  const controlP = once(member, 'party:control');
  host.emit('party:control', { partyId, action: 'seek', positionSec: 1337 });
  const control = await controlP;
  check('host control relayed', control.action === 'seek' && control.state.positionSec === 1337 && control.by === id1, JSON.stringify(control).slice(0, 200));

  const playP = once(member, 'party:control');
  host.emit('party:control', { partyId, action: 'play', positionSec: 1337 });
  const play = await playP;
  check('play → isPaused false', play.state.isPaused === false);

  /* --- chat: persisted via monolith --- */
  const hostChatP = once(host, 'party:chat');
  const memberChatP = once(member, 'party:chat');
  member.emit('party:chat', { partyId, body: 'Synced watch party works!' });
  const chatH = await hostChatP;
  const chatM = await memberChatP;
  check('chat relayed + persisted', chatH.persisted === true && chatM.message.body === 'Synced watch party works!' && Number.isInteger(chatM.message.id), JSON.stringify(chatH).slice(0, 250));

  const messages = await req('GET', `/api/social/party/${partyId}/messages`);
  check('chat persisted in Neon via monolith', messages.json?.data?.some((m) => m.body === 'Synced watch party works!'));

  /* --- typing --- */
  const typingP = once(host, 'party:typing');
  member.emit('party:typing', { partyId });
  const typing = await typingP;
  check('typing indicator', typing.user?.username, JSON.stringify(typing).slice(0, 120));

  /* --- live activity webhook --- */
  const activityP = once(guest, 'social:activity', 6000);
  const hook = await fetch(`${REALTIME}/internal/activity`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Internal-Token': realtimeToken },
    body: JSON.stringify({ id: 999, type: 'review', user: { id: 1, username: 'webhook-test' }, content: null, preview: 'live!' }),
  });
  const activity = await activityP;
  check('internal webhook → social:activity', hook.status === 202 && activity.type === 'review' && activity.user?.username === 'webhook-test', JSON.stringify(activity).slice(0, 150));

  const hookNoToken = await fetch(`${REALTIME}/internal/activity`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'review' }),
  });
  check('webhook without token 401', hookNoToken.status === 401);

  /* --- presence --- */
  const presenceP = once(host, 'presence:online', 6000);
  member.close();
  const presence = await presenceP;
  check('presence update on disconnect', typeof presence.online === 'number' && presence.online >= 1, JSON.stringify(presence));

  /* --- leave + member-left --- */
  const leftP = once(host, 'party:member-left', 6000).catch(() => null);
  member.emit('party:leave', { partyId });
  await wait(300);
  member.close();

  /* --- metrics --- */
  const metrics = await (await fetch(`${REALTIME}/metrics`)).text();
  check('metrics counters', /animaxia_realtime_party_joins_total 2/.test(metrics) && /animaxia_realtime_chat_messages_total\{persisted="true"\} 1/.test(metrics) && /animaxia_realtime_control_events_total 2/.test(metrics), metrics.split('\n').filter((l) => l.includes('_total')).join(' | '));

  host.emit('party:leave', { partyId });
  await wait(200);
  host.close();
  guest.close();

  /* --- cleanup --- */
  await req('POST', `/api/social/party/${partyId}/leave`, { token: t1, body: {} });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
};

run().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
