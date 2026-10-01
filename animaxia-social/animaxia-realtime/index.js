/**
 * animaxia-realtime — FAZA 10 realtime service (port 4010).
 *
 * socket.io server, path '/' (gateway constraint: clients connect with
 * io('/?XTransformPort=4010')). Three concerns:
 *
 *   1. Watch-party rooms — host control relay (play/pause/seek/rate/source),
 *      in-memory live state for late joiners (seeded from the monolith
 *      snapshot), member presence, typing indicators.
 *   2. Party chat — relayed live AND persisted through the monolith
 *      (POST /api/social/party/:id/messages with the forwarded user JWT);
 *      degraded mode broadcasts optimistic messages when the monolith is
 *      unreachable (flag persisted:false).
 *   3. Live social activity — the monolith fire-and-forget POSTs
 *      /internal/activity (X-Internal-Token gated) → 'social:activity'
 *      broadcast to every connected socket (public feed data).
 *
 * Auth: optional at the socket layer. Verified access tokens (HS256,
 * AUTHSECRET parity — see auth.js) unlock party rooms; anonymous sockets can
 * still observe the public activity ticker.
 *
 * Ownership: this service owns NOTHING durably — Neon stays with the
 * monolith. Restart-safe by design (rooms re-seed from REST on demand).
 */

import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { config } from './env.js';
import { verifyAccessToken } from './auth.js';
import { partyDetail, partyJoin, partyMessage, monolithHealth } from './monolith.js';

const VERSION = '1.0.0';
const startedAt = Date.now();

/* --------------------------------- metrics --------------------------------- */

const counters = {
  httpRequests: new Map(), // route → count
  partyJoins: 0,
  controlEvents: 0,
  chatMessages: new Map(), // persisted(true|false) → count
  activityBroadcasts: 0,
  persistErrors: 0,
};

function httpCounted(route) {
  counters.httpRequests.set(route, (counters.httpRequests.get(route) || 0) + 1);
}

function renderMetrics() {
  const lines = [];
  const emit = (line) => lines.push(line);
  const gauge = (name, help, value) => {
    emit(`# HELP ${name} ${help}`);
    emit(`# TYPE ${name} gauge`);
    emit(`${name} ${value}`);
  };
  const counter = (name, help, value) => {
    emit(`# HELP ${name} ${help}`);
    emit(`# TYPE ${name} counter`);
    emit(`${name} ${value}`);
  };

  gauge('animaxia_realtime_sockets_connected', 'Currently connected sockets.', io?.sockets?.sockets?.size ?? 0);
  gauge('animaxia_realtime_party_rooms', 'Watch-party rooms with live state.', rooms.size);
  counter('animaxia_realtime_party_joins_total', 'Party room joins since boot.', counters.partyJoins);
  counter('animaxia_realtime_control_events_total', 'Host control events relayed since boot.', counters.controlEvents);
  for (const [persisted, value] of counters.chatMessages) {
    emit(`# HELP animaxia_realtime_chat_messages_total Party chat messages relayed (persisted flag).`);
    emit(`# TYPE animaxia_realtime_chat_messages_total counter`);
    emit(`animaxia_realtime_chat_messages_total{persisted="${persisted}"} ${value}`);
  }
  counter('animaxia_realtime_activity_broadcasts_total', 'Live activity events broadcast since boot.', counters.activityBroadcasts);
  counter('animaxia_realtime_persist_errors_total', 'Monolith persistence failures since boot.', counters.persistErrors);
  for (const [route, value] of counters.httpRequests) {
    emit(`# HELP animaxia_realtime_http_requests_total HTTP requests by route.`);
    emit(`# TYPE animaxia_realtime_http_requests_total counter`);
    emit(`animaxia_realtime_http_requests_total{route="${route}"} ${value}`);
  }
  gauge('animaxia_realtime_uptime_seconds', 'Uptime in seconds.', Math.floor((Date.now() - startedAt) / 1000));
  return `${lines.join('\n')}\n`;
}

/* --------------------------------- logging --------------------------------- */

const log = (level, msg) => {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${level}] [realtime] ${msg}`);
};

/* ------------------------------ party rooms -------------------------------- */

/**
 * rooms: Map<partyId, {
 *   partyId:number, hostId:number|null, title:string,
 *   state:{positionSec,isPaused,playbackRate,sourceIndex,updatedAt},
 *   members: Map<userid, {userid, username, avatar, sockets:Set<socketId>>
 * }>
 */
const rooms = new Map();

/** User profile cache (userid → {username, avatar, fetchedAt}). */
const profileCache = new Map();
const PROFILE_TTL_MS = 5 * 60 * 1000;

async function fetchProfile(token, userid) {
  const cached = profileCache.get(userid);
  if (cached && Date.now() - cached.fetchedAt < PROFILE_TTL_MS) return cached;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`${config.monolithUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (res.ok) {
      const json = await res.json();
      const entry = {
        userid,
        username: json?.user?.username || `user-${userid}`,
        avatar: json?.user?.avatar || null,
        fetchedAt: Date.now(),
      };
      profileCache.set(userid, entry);
      return entry;
    }
  } catch {
    /* monolith down — fall back to a stable label */
  }
  const fallback = { userid, username: `user-${userid}`, avatar: null, fetchedAt: Date.now() };
  if (!cached) profileCache.set(userid, fallback);
  return cached || fallback;
}

function membersList(room) {
  return [...room.members.values()].map((m) => ({
    userid: m.userid,
    username: m.username,
    avatar: m.avatar,
    online: m.sockets.size > 0,
  }));
}

/** Load or seed a room from the monolith party detail (fail-soft). */
async function ensureRoom(partyId) {
  const existing = rooms.get(partyId);
  if (existing) return existing;
  const detail = await partyDetail(partyId);
  if (!detail.ok || !detail.json?.party) return null;
  const party = detail.json.party;
  const room = {
    partyId,
    hostId: party.host?.id ?? null,
    title: party.title,
    state: detail.json.state || { positionSec: 0, isPaused: true, playbackRate: 1, sourceIndex: 0, updatedAt: new Date().toISOString() },
    members: new Map(),
  };
  rooms.set(partyId, room);
  return room;
}

/* ------------------------------- http server -------------------------------- */

/*
 * Socket.io MUST use path '/' (gateway constraint), but engine.io's attach()
 * intercepts EVERY request when the path is '/' (check = url.slice(0, 1) ===
 * '/'). Solution: let Server attach first, then re-order the http server's
 * 'request' listeners so our REST routes (health/metrics/internal webhook)
 * are answered BEFORE engine.io sees them. One port, both protocols —
 * standard Node listener juggling, no engine.io internals patched.
 */

const httpServer = createServer();

function handleHttp(req, res) {
  const url = (req.url || '/').split('?')[0];
  const send = (status, body, type = 'application/json') => {
    res.writeHead(status, {
      'Content-Type': type,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };

  if (req.method === 'GET' && (url === '/api' || url === '/api/info')) {
    httpCounted('info');
    return send(200, {
      service: 'animaxia-realtime',
      version: VERSION,
      status: 'ok',
      docs: 'socket.io at path / — connect with io("/?XTransformPort=4010")',
      endpoints: ['GET /api/health', 'GET /metrics', 'POST /internal/activity'],
    });
  }

  if (req.method === 'GET' && url === '/api/health') {
    httpCounted('health');
    return send(200, {
      status: 'ok',
      service: 'animaxia-realtime',
      version: VERSION,
      uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
      sockets: io?.sockets?.sockets?.size ?? 0,
      rooms: rooms.size,
      authMode: config.authSecret ? 'explicit' : 'derived',
      timestamp: new Date().toISOString(),
    });
  }

  if (req.method === 'GET' && url === '/metrics') {
    httpCounted('metrics');
    return send(200, renderMetrics(), 'text/plain; version=0.0.4; charset=utf-8');
  }

  if (req.method === 'POST' && url === '/internal/activity') {
    httpCounted('internal-activity');
    if (config.internalToken) {
      const provided = req.headers['x-internal-token'];
      if (provided !== config.internalToken) return send(401, { error: 'Invalid internal token' });
    }
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 64 * 1024) req.destroy();
    });
    req.on('end', () => {
      try {
        const event = JSON.parse(body || '{}');
        if (!event || typeof event !== 'object' || !event.type) {
          return send(400, { error: 'Activity event must include type' });
        }
        io.to('activity:public').emit('social:activity', event);
        counters.activityBroadcasts += 1;
        send(202, { ok: true, broadcast: true });
      } catch {
        send(400, { error: 'Invalid JSON' });
      }
    });
    return;
  }

  send(404, { error: 'Not found' });
}


/* ------------------------------ socket.io core ------------------------------ */

const io = new Server(httpServer, {
  /* Gateway constraint: path must stay '/' — Caddy forwards by
     XTransformPort query, never a custom path. */
  path: '/',
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000,
  maxHttpBufferSize: 64 * 1024,
});

/* Re-order listeners: REST routes win over engine.io (see note above). */
{
  const engineRequestListener = httpServer.listeners('request')[0];
  httpServer.removeAllListeners('request');
  httpServer.on('request', (req, res) => {
    const url = (req.url || '/').split('?')[0];
    const method = (req.method || 'GET').toUpperCase();
    const isRest =
      (method === 'GET' && ['/api', '/api/info', '/api/health', '/metrics'].includes(url)) ||
      (method === 'POST' && url === '/internal/activity');
    if (isRest) return handleHttp(req, res);
    if (engineRequestListener) return engineRequestListener(req, res);
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });
}

let presenceTimer = null;
function broadcastPresence() {
  if (presenceTimer) return;
  presenceTimer = setTimeout(() => {
    presenceTimer = null;
    io.emit('presence:online', { online: io.sockets.sockets.size });
  }, 500);
}

/* Handshake auth: optional token → identity; guests allowed (ticker only). */
io.use((socket, next) => {
  const token = socket.handshake.auth?.token || socket.handshake.auth?.Authorization;
  if (!token) {
    socket.data.identity = null;
    socket.data.token = null;
    return next();
  }
  const payload = verifyAccessToken(String(token).replace(/^Bearer\s+/i, ''));
  if (!payload) {
    return next(new Error('Invalid or expired access token'));
  }
  socket.data.identity = payload;
  socket.data.token = String(token).replace(/^Bearer\s+/i, '');
  return next();
});

io.on('connection', async (socket) => {
  const identity = socket.data.identity;
  socket.data.user = null;
  socket.data.partyId = null;
  socket.join('activity:public');

  if (identity) {
    socket.data.user = await fetchProfile(socket.data.token, identity.sub);
    log('INFO', `socket connected user=${identity.sub} (${socket.data.user?.username})`);
  } else {
    log('INFO', 'socket connected (guest)');
  }
  socket.emit('hello', {
    service: 'animaxia-realtime',
    version: VERSION,
    user: socket.data.user ? { id: socket.data.user.userid, username: socket.data.user.username } : null,
    online: io.sockets.sockets.size,
  });
  broadcastPresence();

  const requireAuth = () => {
    if (!identity) {
      socket.emit('party:error', { code: 'auth', message: 'Sign in to use watch parties' });
      return false;
    }
    return true;
  };

  /* ------------------------------ party:join ------------------------------- */
  socket.on('party:join', async (payload = {}) => {
    if (!requireAuth()) return;
    const partyId = Number.parseInt(payload.partyId, 10);
    if (!Number.isInteger(partyId) || partyId <= 0) {
      return socket.emit('party:error', { code: 'bad-request', message: 'partyId is required' });
    }

    const room = await ensureRoom(partyId);
    if (!room) {
      return socket.emit('party:error', { code: 'not-found', message: 'Watch party not found or ended' });
    }

    /* Idempotent membership upsert via the monolith (also validates the
       party is still active). 403/404/410 → refuse the room. */
    const joined = await partyJoin(partyId, socket.data.token);
    if (!joined.ok && joined.status !== 0) {
      return socket.emit('party:error', {
        code: joined.status === 410 ? 'ended' : `http-${joined.status}`,
        message: joined.json?.error || 'Could not join this watch party',
      });
    }
    if (!joined.ok && joined.status === 0) {
      counters.persistErrors += 1; // degraded: monolith unreachable
    }

    /* Leave any previous party room first (one party per socket). */
    if (socket.data.partyId && socket.data.partyId !== partyId) {
      leavePartyQuietly(socket);
    }

    const user = socket.data.user || { userid: identity.sub, username: `user-${identity.sub}`, avatar: null };
    let member = room.members.get(user.userid);
    if (!member) {
      member = { userid: user.userid, username: user.username, avatar: user.avatar, sockets: new Set() };
      room.members.set(user.userid, member);
    }
    member.sockets.add(socket.id);
    socket.data.partyId = partyId;
    socket.join(`party:${partyId}`);
    counters.partyJoins += 1;

    socket.emit('party:state', {
      partyId,
      title: room.title,
      hostid: room.hostId,
      state: room.state,
      members: membersList(room),
      degraded: !joined.ok,
    });
    socket.to(`party:${partyId}`).emit('party:member-joined', {
      partyId,
      user: { userid: user.userid, username: user.username, avatar: user.avatar },
    });
    log('INFO', `user=${user.userid} joined party=${partyId} (members=${room.members.size})`);
  });

  /* ------------------------------ party:leave ------------------------------ */
  socket.on('party:leave', () => {
    if (!requireAuth()) return;
    const partyId = socket.data.partyId;
    if (!partyId) return;
    const room = rooms.get(partyId);
    const user = socket.data.user;
    socket.leave(`party:${partyId}`);
    socket.data.partyId = null;
    if (room && user) {
      const member = room.members.get(user.userid);
      if (member) {
        member.sockets.delete(socket.id);
        if (member.sockets.size === 0) room.members.delete(user.userid);
      }
      socket.to(`party:${partyId}`).emit('party:member-left', {
        partyId,
        user: { userid: user.userid, username: user.username, avatar: user.avatar },
      });
    }
  });

  /* ----------------------------- party:control ----------------------------- */
  socket.on('party:control', (payload = {}) => {
    if (!requireAuth()) return;
    const partyId = Number.parseInt(payload.partyId, 10);
    const room = rooms.get(socket.data.partyId || partyId);
    if (!room) return socket.emit('party:error', { code: 'not-in-room', message: 'Join the party first' });
    if (room.hostId !== identity.sub) {
      return socket.emit('party:error', { code: 'forbidden', message: 'Only the host controls playback' });
    }
    const action = String(payload.action || '');
    if (!['play', 'pause', 'seek', 'rate', 'source'].includes(action)) {
      return socket.emit('party:error', { code: 'bad-request', message: 'Unknown control action' });
    }
    const positionSec = Number(payload.positionSec);
    room.state = {
      ...room.state,
      positionSec: Number.isFinite(positionSec) && positionSec >= 0 ? Math.min(positionSec, 86_400) : room.state.positionSec,
      isPaused: action === 'pause' ? true : action === 'play' ? false : room.state.isPaused,
      playbackRate: Number.isFinite(Number(payload.playbackRate)) && payload.playbackRate > 0 && payload.playbackRate <= 4
        ? Number(payload.playbackRate)
        : room.state.playbackRate,
      sourceIndex: Number.isInteger(payload.sourceIndex) && payload.sourceIndex >= 0 ? payload.sourceIndex : room.state.sourceIndex,
      updatedAt: new Date().toISOString(),
    };
    counters.controlEvents += 1;
    io.to(`party:${room.partyId}`).emit('party:control', {
      partyId: room.partyId,
      action,
      by: identity.sub,
      state: room.state,
    });
  });

  /* ------------------------------ party:chat ------------------------------- */
  socket.on('party:chat', async (payload = {}) => {
    if (!requireAuth()) return;
    const partyId = Number.parseInt(payload.partyId, 10);
    const room = rooms.get(socket.data.partyId || partyId);
    if (!room) return socket.emit('party:error', { code: 'not-in-room', message: 'Join the party first' });

    const body = String(payload.body || '').trim();
    if (!body || body.length > 500) {
      return socket.emit('party:error', { code: 'bad-request', message: 'Message must be 1-500 characters' });
    }

    const user = socket.data.user || { userid: identity.sub, username: `user-${identity.sub}`, avatar: null };
    const base = {
      partyId: room.partyId,
      message: {
        id: null,
        body,
        createdat: new Date().toISOString(),
        user: { id: user.userid, username: user.username, avatar: user.avatar },
      },
    };

    const saved = await partyMessage(room.partyId, socket.data.token, body);
    if (saved.ok && saved.json?.message) {
      counters.chatMessages.set('true', (counters.chatMessages.get('true') || 0) + 1);
      base.message = { ...base.message, ...saved.json.message };
      base.message.user = { id: user.userid, username: user.username, avatar: user.avatar };
      base.persisted = true;
    } else if (saved.status === 0) {
      /* Degraded: monolith unreachable — optimistic delivery, not persisted. */
      counters.chatMessages.set('false', (counters.chatMessages.get('false') || 0) + 1);
      counters.persistErrors += 1;
      base.message.id = `tmp-${Date.now()}`;
      base.persisted = false;
    } else {
      counters.persistErrors += 1;
      return socket.emit('party:error', {
        code: `http-${saved.status}`,
        message: saved.json?.error || 'Message rejected by the backend',
      });
    }
    io.to(`party:${room.partyId}`).emit('party:chat', base);
  });

  /* ------------------------------ party:typing ----------------------------- */
  socket.on('party:typing', (payload = {}) => {
    const partyId = Number.parseInt(payload.partyId, 10);
    const room = rooms.get(socket.data.partyId || partyId);
    if (!room || !socket.data.user) return;
    socket.to(`party:${room.partyId}`).emit('party:typing', {
      partyId: room.partyId,
      user: { userid: socket.data.user.userid, username: socket.data.user.username },
    });
  });

  /* ------------------------------- disconnect ------------------------------ */
  socket.on('disconnect', () => {
    const partyId = socket.data.partyId;
    const user = socket.data.user;
    if (partyId && user) {
      const room = rooms.get(partyId);
      if (room) {
        const member = room.members.get(user.userid);
        if (member) {
          member.sockets.delete(socket.id);
          if (member.sockets.size === 0) {
            room.members.delete(user.userid);
            socket.to(`party:${partyId}`).emit('party:member-left', {
              partyId,
              user: { userid: user.userid, username: user.username, avatar: user.avatar },
            });
          }
        }
      }
    }
    log('INFO', `socket disconnected ${user ? `user=${user.userid}` : '(guest)'}`);
    broadcastPresence();
  });
});

/** Remove a socket from its current party room without emitting to it. */
function leavePartyQuietly(socket) {
  const partyId = socket.data.partyId;
  if (!partyId) return;
  const room = rooms.get(partyId);
  const user = socket.data.user;
  socket.leave(`party:${partyId}`);
  socket.data.partyId = null;
  if (room && user) {
    const member = room.members.get(user.userid);
    if (member) {
      member.sockets.delete(socket.id);
      if (member.sockets.size === 0) room.members.delete(user.userid);
    }
  }
}

/* ------------------------------ room GC sweep ------------------------------- */

/* Empty rooms keep their seeded state for 30 minutes (host reconnect /
   late joiners), then drop (re-seedable from the monolith on demand). */
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [partyId, room] of rooms) {
    let hasOnline = false;
    for (const member of room.members.values()) {
      if (member.sockets.size > 0) {
        hasOnline = true;
        break;
      }
    }
    if (!hasOnline && room.state.updatedAt && Date.parse(room.state.updatedAt) < cutoff) {
      rooms.delete(partyId);
      log('INFO', `GC empty party room=${partyId}`);
    }
  }
}, 10 * 60 * 1000).unref?.();

/* ---------------------------------- boot ----------------------------------- */

httpServer.listen(config.port, () => {
  log('INFO', `animaxia-realtime v${VERSION} listening on :${config.port} (socket.io path "/")`);
  log('INFO', `monolith bridge → ${config.monolithUrl} | auth ${config.authSecret ? 'explicit AUTHSECRET' : 'derived (sha256 animaxia-auth:DATABASEURL parity)'} | internal token ${config.internalToken ? 'required' : 'open (dev)'}`);
  monolithHealth().then((h) => {
    log(h.ok ? 'INFO' : 'WARN', `upstream monolith /api/health → ${h.ok ? 'ok' : `unreachable (${h.status})`}`);
  });
});

process.on('uncaughtException', (err) => log('ERROR', `uncaught: ${err.message}`));
process.on('unhandledRejection', (err) => log('ERROR', `unhandled: ${err}`));
