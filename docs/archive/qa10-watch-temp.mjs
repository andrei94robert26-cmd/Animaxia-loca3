import { io } from 'socket.io-client';

const TOKEN = process.argv[2];
const PARTY_ID = Number(process.argv[3]);

const socket = io('http://localhost:4010/', {
  path: '/',
  transports: ['websocket', 'polling'],
  auth: TOKEN ? { token: TOKEN } : {},
});

socket.on('connect', () => {
  console.log('[watch] connected', socket.id, '- joining room', PARTY_ID);
  socket.emit('party:join', { partyId: PARTY_ID });
});
socket.on('party:state', (d) => console.log('[watch] party:state members:', JSON.stringify(d.members)));
socket.on('party:member-joined', (d) => console.log('[watch] member-joined:', JSON.stringify(d)));
socket.on('party:member-left', (d) => console.log('[watch] member-left:', JSON.stringify(d)));
socket.on('party:chat', (d) => console.log('[watch] chat:', d.message?.body?.slice(0, 40), 'persisted=', d.persisted));
socket.on('party:typing', (d) => console.log('[watch] typing from:', d.user?.username));
socket.on('connect_error', (e) => console.log('[watch] connect_error:', e.message));
socket.on('disconnect', (r) => console.log('[watch] disconnect:', r));

setTimeout(() => { console.log('[watch] done'); process.exit(0); }, 20000);
