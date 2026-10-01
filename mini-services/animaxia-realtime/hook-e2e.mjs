import { io } from 'socket.io-client';
const MONOLITH = 'http://localhost:4000';
const now = Date.now();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(method, path, { token, body } = {}) {
  const res = await fetch(`${MONOLITH}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

const sock = io('http://localhost:4010', { path: '/', transports: ['websocket'], forceNew: true, reconnection: false });
let got = null;
sock.on('social:activity', (e) => { got = e; });
await new Promise((r) => sock.on('connect', r));

const u = await req('POST', '/api/auth/register', { body: { email: `hook_${now}@test.dev`, username: `hook_${now}`, password: 'Passw0rd!123' } });
const all = await req('GET', '/api/all?limit=1');
const contentId = all.json.data[0].id;
const review = await req('POST', '/api/social/reviews', { token: u.json.accessToken, body: { contentId, rating: 7, body: 'Webhook end-to-end verification review body.' } });
console.log('review status:', review.status);
for (let i = 0; i < 10 && !got; i++) await wait(300);
console.log('webhook delivered:', got ? `${got.type} by ${got.user?.username} preview="${got.preview?.slice(0, 40)}"` : 'NOT RECEIVED');
sock.close();
process.exit(got ? 0 : 1);
