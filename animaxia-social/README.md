# Animaxia Social & Real-Time (FAZA 10)

The social layer of the Animaxia platform: a **social graph** (follows, people
discovery, public profiles), **content reviews** (1-10 scale with likes and
aggregates), **watch parties** (live synced playback with host control, chat
and presence) and a **live activity ticker** — plus **cross-user AI
recommendations** (friends-also-watched, taste matches, AI community review
digests). FAZA 10 is strictly additive: it adds a new `modules/social/`
FAZA-10 group to the Express monolith (`:4000`, Neon PostgreSQL) and one new
service, **animaxia-realtime** (`:4010`, bun + socket.io). Phase-2 social
files (`comments.js`, `feed.js`, `platform/migrations.js`) are byte-identical
to before; all new routers are mounted additively in `server.js`.

```
  web :3000  (#/social hub — Feed / People / Reviews / Parties / AI tabs,
              watch-party rooms with synced player + chat + members)
     │
     │ REST /api/social/*, /api/ai/social/*           socket.io: io('/?XTransformPort=4010')
     │ (HTTP via gateway ?XTransformPort=4000)                        │
     ▼                                                               ▼
 ┌────────────────────────────────────┐                      ┌────────────────────────────────────┐
 │ monolith :4000 (Express + Neon)    │                      │ animaxia-realtime :4010 (bun)      │
 │  FAZA 10 — modules/social/:        │      webhook         │  watch-party rooms (in-memory      │
 │   follows · reviews · activity v2  │   POST /internal/    │   state seeded from the monolith)  │
 │   watchparty · aisocial            │   activity           │  host control relay, chat relay,   │
 │  Phase 2 (untouched):              │  (X-Internal-Token)  │  presence, typing, live ticker     │
 │   comments · feed · migrations     │─────────────────────▶│                                    │
 └──────────────┬─────────────────────┘                      └─────────────────┬──────────────────┘
                ▼     ▲                                                        │
      Neon PostgreSQL │  HTTP bridge (forwarded user JWT):                     │
      7 social tables │  party detail (room seed) · party join · chat persist  │
      source of truth │                                                        │
                      └────────────────────────────────────────────────────────┘
```

## Component inventory

### Monolith — `mini-services/animaxia-backend/modules/social/` (7 new files)

| File | Purpose |
|---|---|
| `social-migrations.js` | Idempotent DDL (CREATE TABLE/INDEX IF NOT EXISTS) for the 7 FAZA-10 tables; runs at boot after the Phase-2 platform schema, never alters/drops anything |
| `follows.js` | Social graph: people discovery (`/people`), follow/unfollow (idempotent), following/followers lists, public profiles with stats, recent activity and authenticated taste overlap |
| `reviews.js` | Content reviews 1-10: one-per-user-per-content upsert, delete (owner/admin), like toggle, aggregate (count/avg/distribution), platform-wide recents |
| `activity.js` | Social feed v2 (personal = following + own, and public = whole platform) with keyset cursor pagination; subscribes to the Phase-2 platform bus (`comment:added`) to mirror comments into `activityevents` without touching `comments.js` |
| `activity-events.js` | Shared `insertActivityEvent()` helper (one `activityevents` row + actor/content join) with a best-effort webhook POST to the realtime service; imported by the other routers, no circular deps |
| `watchparty.js` | Watch-party persistence: create (auto-ends my previous active party), list, detail (members + state + messages), join/leave (host leave ends the party), host-only sync snapshot, chat messages, join-by-code, 24h lazy expiry |
| `aisocial.js` | `/api/ai/social`: `GET /home` (friends-also-watched + taste matches + social picks — deterministic SQL, no LLM, no quota) and `POST /review-digest/:contentId` (AI community digest through the llm-core chain z-ai → openai → mock, deterministic fallback) |

**Untouched (byte-identical):** `modules/social/comments.js`,
`modules/social/feed.js` (Phase-2 contracts stay frozen:
`/content/:id/comments`, `/comments/:id/*`, `/content/:id/like|likes`,
`/feed/global`, `/feed/personal`), and `modules/platform/migrations.js`.
`server.js` mounts the new routers additively (`/api/social` gets four more
routers after the Phase-2 ones; `/api/ai/social` is a new mount) and wires
`ensureSocialSchema()` + `initSocialActivity()` at boot — a schema failure
degrades only the social routes to 503.

### Realtime service — `mini-services/animaxia-realtime/` (5 files)

| File | Purpose |
|---|---|
| `index.js` | socket.io server (path `/`), watch-party rooms (host control relay play/pause/seek/rate/source, in-memory state seeded from the monolith, member presence, typing), party chat (persisted through the monolith, optimistic degraded mode), live activity ticker, HTTP endpoints (`/api/health`, `/metrics`, `POST /internal/activity`), Prometheus counters |
| `auth.js` | Zero-dependency (node:crypto) HS256 JWT verification with **exact parity** to the monolith: `AUTHSECRET` when set, otherwise the derived secret `sha256("animaxia-auth:" + DATABASEURL)`; access tokens only, exp with 5s skew, timing-safe compare |
| `env.js` | Env fallback chain: process env → local `./.env` → `../animaxia-backend/.env` (the canonical restored source) — survives session-reset env wipes and keeps JWT parity automatic |
| `monolith.js` | Fail-soft HTTP bridge to `:4000` with the user's forwarded JWT: `partyDetail` (room seed), `partyJoin` (idempotent membership upsert), `partyMessage` (chat persistence), `monolithHealth`; 4s timeout, `{status: 0}` on unreachable |
| `package.json` | bun scripts (`dev` = `bun --hot index.js`) + `socket.io`/`socket.io-client` ^4.8.3 — the service's only dependency |

**One port, two protocols:** socket.io must use path `/` (gateway constraint —
clients connect with `io('/?XTransformPort=4010')`), but engine.io intercepts
every request when the path is `/`. `index.js` therefore re-orders the Node
http server's `request` listeners after socket.io attaches, so the REST
routes (`/api/health`, `/metrics`, `/internal/activity`) are answered before
engine.io sees them.

## REST API reference

All monolith routes are counted automatically by the FAZA-9 metrics
middleware (`requestcount / latency / errors`, route-normalized with `:id`).
"User" = `requireAuth` (Bearer access token); "public" = no token needed
(auth-aware extras when one is present).

### `follows.js` — mounted at `/api/social`

| Method | Route | Auth | Description |
|---|---|---|---|
| GET | `/api/social/people?q=&limit=` | user | People discovery: users I don't follow yet, ranked by followers/reviews |
| POST | `/api/social/follow` `{userId}` | user (30/min) | Idempotent follow; self-follow → 400; writes a `follow` activity event |
| POST | `/api/social/unfollow` `{userId}` | user (30/min) | Idempotent unfollow |
| GET | `/api/social/following` | user | Users I follow (userCard shape, no email) |
| GET | `/api/social/followers` | user | My followers |
| GET | `/api/social/user/:id/profile` | public | Public profile: user (no email), stats, recent reviews, recent activity, relation + taste overlap (shared genres) when authenticated |

### `reviews.js` — mounted at `/api/social`

| Method | Route | Auth | Description |
|---|---|---|---|
| GET | `/api/social/reviews/content/:id` | public | Reviews for one content (top 50 by likes) + `aggregate {count, avg, distribution 1..10}`; auth-aware `liked` |
| POST | `/api/social/reviews` `{contentId, rating, title?, body}` | user (10/min) | Upsert my review (one per user per content); rating 1-10, body 10-4000 chars; 201 created / 200 edited |
| DELETE | `/api/social/reviews/:id` | user | Delete a review (owner or admin) |
| POST | `/api/social/reviews/:id/like` | user (60/min) | Toggle my like → `{ok, likes, liked}` |
| GET | `/api/social/reviews/recent?limit=` | public | Platform-wide recent reviews (with content info) |

### `activity.js` — mounted at `/api/social`

| Method | Route | Auth | Description |
|---|---|---|---|
| GET | `/api/social/feed/v2?limit=&cursor=` | user | Social feed: activity from people I follow + my own (`comment`, `review`, `follow`, `party:create`, `party:join`, `party:ended`), keyset cursor |
| GET | `/api/social/feed/v2/public?limit=&cursor=` | public | Whole-platform activity feed (logged-out friendly) |

### `watchparty.js` — mounted at `/api/social`

| Method | Route | Auth | Description |
|---|---|---|---|
| POST | `/api/social/party` `{contentId, title?, isPrivate?}` | user (10/min) | Create a party (I become host; my previous active hosted party is auto-ended); returns a 6-char join code |
| GET | `/api/social/parties?limit=&includeEnded=` | public | Active public parties (auth-aware `amimember`); lazily expires parties untouched for 24h |
| GET | `/api/social/party/:id` | public | Party detail: metadata, members, host state snapshot, last 50 messages |
| POST | `/api/social/party/:id/join` | user (30/min) | Idempotent membership upsert (ended party → 410) |
| POST | `/api/social/party/:id/leave` | user | Leave; **host leaving ends the party** (`party:ended` activity) |
| POST | `/api/social/party/:id/sync` `{state}` | user | Host-only playback snapshot `{positionSec, isPaused, playbackRate, sourceIndex, updatedAt}` (non-host → 403) |
| GET | `/api/social/party/:id/messages?beforeId=` | public | Chat history (keyset, 50/page) |
| POST | `/api/social/party/:id/messages` `{body}` | user (60/min) | Post a chat message (members only, 1-500 chars) |
| POST | `/api/social/party/join-code` `{code}` | public | Look up an active party by its 6-char code (alphabet without 0/O/1/I/L) |

### `aisocial.js` — mounted at `/api/ai/social`

| Method | Route | Auth | Description |
|---|---|---|---|
| GET | `/api/ai/social/home` | user | `{friendsAlsoWatched, tasteMatches, socialPicks}` — cross-user recommendations from follows' watch history / watchlist / reviews, genre-Jaccard taste matching, community-loved picks; deterministic SQL, no LLM, no quota |
| POST | `/api/ai/social/review-digest/:contentId` | user | AI community digest `{summary, sentiment, themes, reviewCount, provider, degraded}`; AI-quota gated; llm-core chain z-ai → openai → mock with a deterministic fallback (< 2 reviews or LLM failure → computed summary, `degraded: true`) |

### Realtime service HTTP endpoints — `:4010`

| Method | Route | Auth | Description |
|---|---|---|---|
| GET | `/api` (or `/api/info`) | none | Service descriptor + endpoint list |
| GET | `/api/health` | none | `{status, service, version, uptimeSec, sockets, rooms, authMode: explicit\|derived, timestamp}` |
| GET | `/metrics` | none | Prometheus text (`animaxia_realtime_*` family — see Metrics) |
| POST | `/internal/activity` | `X-Internal-Token` (`REALTIMETOKEN`) | Webhook from the monolith: broadcast one activity event as `social:activity` to all sockets; missing/wrong token → 401 `{error: "Invalid internal token"}`; missing `type` / bad JSON → 400; success → 202 `{ok, broadcast}` |

## Socket events reference

Handshake: `io('/?XTransformPort=4010', { auth: { token } })` — token
optional (guests may connect and observe the public ticker; party rooms
require a verified access token; an invalid/expired token fails the
handshake). Same-origin deployments use
`io('http://localhost:4010', { path: '/' })`.

**Client → server:**

| Event | Payload | Notes |
|---|---|---|
| `party:join` | `{partyId}` | Seeds/loads the room (from the monolith party detail), upserts membership via the monolith REST join (forwarded JWT); 403/404/410 → `party:error`. One party per socket: a new join silently leaves the previous room. |
| `party:leave` | — | Leave the current party room (broadcasts `party:member-left` when the last socket of a user goes) |
| `party:control` | `{partyId?, action, positionSec?, playbackRate?, sourceIndex?}` | **Host only**; `action` = `play \| pause \| seek \| rate \| source`; updates the in-memory state and relays to the room |
| `party:chat` | `{partyId?, body}` | 1-500 chars; persisted through the monolith (`persisted: true`); monolith unreachable → optimistic delivery `persisted: false` with a `tmp-*` id |
| `party:typing` | `{partyId?}` | Typing indicator to the room (auth'd users only) |

**Server → client:**

| Event | Payload | Notes |
|---|---|---|
| `hello` | `{service, version, user\|null, online}` | On connect |
| `presence:online` | `{online}` | Global connected-socket count (debounced 500 ms) |
| `social:activity` | `{id, type, createdat, user, content, preview, metadata}` | Live activity ticker — one activity event per webhook |
| `party:state` | `{partyId, title, hostid, state, members, degraded}` | `party:join` ack — the snapshot a late joiner syncs to; `degraded: true` when the monolith was unreachable at join |
| `party:member-joined` | `{partyId, user}` | To the room |
| `party:member-left` | `{partyId, user}` | To the room |
| `party:control` | `{partyId, action, by, state}` | Relayed host control (to everyone in the room, including the host) |
| `party:chat` | `{partyId, message, persisted}` | Relayed chat message |
| `party:typing` | `{partyId, user}` | To the room (not the sender) |
| `party:error` | `{code, message}` | Codes: `auth`, `bad-request`, `not-found`, `ended`, `not-in-room`, `forbidden`, `http-*` |

Room lifecycle: empty rooms keep their seeded state for 30 minutes (host
reconnect / late joiners), then a GC sweep drops them — they re-seed from the
monolith on demand (`GET /api/social/party/:id`), so a realtime restart never
loses parties.

## Database tables (Neon, via `social-migrations.js`)

House style: lowercase columns **without underscores** (e.g. `createdat`,
`contentid`), `TIMESTAMPTZ` defaults, FKs to `users(id)` / `content(id)` with
`ON DELETE CASCADE`, everything `IF NOT EXISTS` (idempotent at every boot).

| Table | Columns (summary) | Notes |
|---|---|---|
| `follows` | `id, followerid, followeeid, createdat` | `UNIQUE (followerid, followeeid)`; indexed both directions |
| `reviews` | `id, userid, contentid, rating (1-10), title, body, createdat, updatedat` | `UNIQUE (userid, contentid)` — the upsert key |
| `reviewlikes` | `userid, reviewid, createdat` | `PRIMARY KEY (userid, reviewid)` — toggle-safe |
| `activityevents` | `id, actorid, type, contentid?, targetuserid?, metadata (jsonb), createdat` | feed v2 source; types: comment, review, follow, party:create, party:join, party:ended |
| `watchparties` | `id, code (unique), hostid, contentid, title, isprivate, status, state (jsonb), createdat, updatedat` | `status` = active \| ended; `state` = host playback snapshot |
| `watchpartymembers` | `partyid, userid, role (host\|member), joinedat` | `PRIMARY KEY (partyid, userid)` |
| `partymessages` | `id, partyid, userid, body, createdat` | chat history (500 chars max per message) |

## Metrics

Realtime service — `GET http://localhost:4010/metrics` (Prometheus text):

| Metric | Type | Labels | Help text |
|---|---|---|---|
| `animaxia_realtime_sockets_connected` | gauge | — | Currently connected sockets. |
| `animaxia_realtime_party_rooms` | gauge | — | Watch-party rooms with live state. |
| `animaxia_realtime_party_joins_total` | counter | — | Party room joins since boot. |
| `animaxia_realtime_control_events_total` | counter | — | Host control events relayed since boot. |
| `animaxia_realtime_chat_messages_total` | counter | `persisted` | Party chat messages relayed (persisted flag). |
| `animaxia_realtime_activity_broadcasts_total` | counter | — | Live activity events broadcast since boot. |
| `animaxia_realtime_persist_errors_total` | counter | — | Monolith persistence failures since boot. |
| `animaxia_realtime_http_requests_total` | counter | `route` | HTTP requests by route (`info`, `health`, `metrics`, `internal-activity`). |
| `animaxia_realtime_uptime_seconds` | gauge | — | Uptime in seconds. |

Monolith — the FAZA-9 metrics middleware (`GET /api/metrics`) automatically
counts every new `/api/social/*` and `/api/ai/social/*` route in
`animaxia_http_requests_total` / `animaxia_http_request_latency_ms` /
`animaxia_http_server_errors_total` (route labels normalized: numeric ids →
`:id`, ≤ 4 segments — e.g. `/api/social/party/:id`,
`/api/ai/social/review-digest`). See `animaxia-ops/metrics/METRICS.md` for
the canonical contract and the suggested scrape job.

## Configuration

| Variable | Where | Default | Meaning |
|---|---|---|---|
| `REALTIMEURL` | monolith `.env` | `http://127.0.0.1:4010` | Where `activity-events.js` POSTs the `/internal/activity` webhook |
| `REALTIMETOKEN` | **both** `.env` files (must match) | — (unset = webhook ungated, dev only) | Shared secret for the `X-Internal-Token` webhook header |
| `PORT` | realtime `.env` | `4010` | Realtime service listen port |
| `MONOLITHURL` | realtime `.env` | `http://127.0.0.1:4000` | Where the realtime bridge sends party detail/join/messages |

Both spellings are accepted (`REALTIMEURL`/`REALTIME_URL`, etc. — house style
keeps the historical no-underscore names).

**JWT secret parity** (`auth.js`): the realtime service verifies monolith
access tokens with the same secret the monolith signs them with —
`AUTHSECRET` when set, otherwise the deterministic derived secret
`sha256("animaxia-auth:" + DATABASEURL)` (current state: `AUTHSECRET` is
absent, both services derive the same secret from the shared `DATABASEURL`).
No secret is ever copied between services.

**Env fallback chain** (`env.js`): real process env → local `./.env` →
`../animaxia-backend/.env` (the canonical ZIP-restored source). A session
reset that wipes envs leaves the service correctly configured as long as the
monolith `.env` was restored — parity and tokens survive automatically.

## Running locally

```bash
# 1. Monolith (Neon, social schema applied at boot)
cd mini-services/animaxia-backend && bun run dev          # :4000

# 2. Realtime service (bun --hot, single dependency: socket.io)
cd mini-services/animaxia-realtime && bun run dev         # :4010

# 3. Detached restart pattern (survives the shell — NEVER plain &, which gets reaped)
cd mini-services/animaxia-realtime && (setsid bun run dev > log 2>&1 < /dev/null &)
```

Socket client connect pattern (gateway constraint: path stays `'/'`):

```js
const socket = io('/?XTransformPort=4010', { transports: ['websocket', 'polling'] });
// or direct: io('http://localhost:4010', { path: '/' })
```

## QA summary

- **REST contract — 31/31** (throwaway suite
  `mini-services/animaxia-backend/tests-faza10-quick.mjs`): register ×2,
  follow idempotent, self-follow 400, people/following/followers, profile
  shape (no email leak), review upsert + like + aggregate + recent, feed v2
  personal/public, party create/join/sync-403/sync/messages/by-code/
  host-leave-ends, AI social home, review digest with real z-ai output.
- **Realtime — 18/18** (throwaway suite
  `mini-services/animaxia-realtime/test-quick.mjs`): guest mode, invalid
  token rejected, party join/state/member events, host-only control, chat
  persisted to Neon via the monolith, typing, webhook token gating (401),
  presence, metrics counters. (The last check asserts absolute counter
  values — a clean 18/18 requires a freshly booted service; on a long-running
  instance it may report stale numbers while the functional checks pass. See
  `animaxia-ops/runbooks/social-realtime-degraded.md`.)
- **E2E webhook chain** (`mini-services/animaxia-realtime/hook-e2e.mjs`):
  POST a review via REST → `activityevents` row → monolith webhook →
  connected socket receives `social:activity`.
- The full end-to-end smoke lives at `tests/smoke-social.mjs` in this
  package (see Directory layout).

## Directory layout (ZIP staging)

This directory is the ZIP prefix `animaxia-social/` (added additively to
`public/animaxia-cloud.zip`; nothing pre-existing is rewritten):

```
animaxia-social/
├── README.md              ← this file
├── animaxia-realtime/     ← the realtime service copy (index.js, auth.js,
│                             env.js, monolith.js, package.json — bun install && bun run dev)
├── monolith-modules/      ← the 7 FAZA-10 social module files, drop-in for
│                             mini-services/animaxia-backend/modules/social/
└── tests/
    └── smoke-social.mjs   ← end-to-end social + realtime smoke
```

## Reliability notes (degraded modes)

- **Realtime service down** → the platform loses nothing durable: the REST
  feed (`/api/social/feed/v2`) stays the source of truth and the social hub
  falls back to polling; the monolith webhook is fire-and-forget and
  silently swallows failures (1.5 s abort) — nothing blocks on `:4010`.
- **Monolith down (from the realtime service)** → rooms keep working in
  relay mode: party joins mark the room `degraded`, chat broadcasts
  optimistically with `persisted: false` and `tmp-*` ids, and
  `animaxia_realtime_persist_errors_total` counts the failures.
- **Realtime restart** → party rooms are in-memory only and re-seed
  themselves from the monolith snapshots (`GET /api/social/party/:id` +
  host sync state) on the next join; empty rooms are GC'd after 30 minutes.
- **24h lazy expiry** → parties untouched for 24 h are marked `ended` on the
  next `GET /api/social/parties`; host leaving ends a party immediately
  (only one active hosted party per user).
- **One party per socket** → joining a new party silently leaves the
  previous one; member presence tracks per-user socket sets (multiple tabs =
  one member, online until the last socket drops).
- **Guest sockets** → allowed but ticker-only: every party event requires a
  verified access token (`party:error {code: "auth"}`).
- **Web frontend** (`#/social` hub with Feed/People/Reviews/Parties/AI tabs,
  watch-party rooms with a synced player, chat, members and host controls,
  plus a reviews section on content pages) — built in parallel (Task 10-5)
  and intentionally not specified here.
