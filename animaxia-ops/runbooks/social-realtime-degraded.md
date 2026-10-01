# Runbook — Social & Real-Time degraded (animaxia-realtime :4010 down / webhook mismatch)

**Service:** realtime service `mini-services/animaxia-realtime/` (bun + socket.io) on **:4010**,
plus its integration with the monolith backend (`mini-services/animaxia-backend/`, **:4000**,
Neon PostgreSQL) — the social feed v2 REST routes and the `/internal/activity` webhook.
**Most common cause in this environment:** the realtime process was killed (session/invocation
tree-kill — the same failure mode that repeatedly took down :3000/:4000) and never relaunched,
or `REALTIMETOKEN` diverged between the two `.env` files so the monolith's webhook is rejected
401. Rarer cause: the monolith itself is unreachable from the realtime service (degraded chat
persistence). **No data is ever lost** — Neon stays the source of truth, the REST feed keeps
working; only the *live* layer (ticker, party sync, live chat) degrades.
**Incident history:** none yet (FAZA 10, documented 2026-09-18; all diagnosis commands verified
live against a healthy instance).

## Symptoms

- The live activity ticker on `#/social` stops updating, but the feed still loads —
  `curl http://localhost:4000/api/social/feed/v2/public` still returns 200 with data.
- Watch-party chat messages show "not saved / offline mode" notes (`persisted: false`
  optimistic messages), or chat/members/playback sync freeze entirely.
- The party members list is stale and the presence counter is stuck (or resets to 0).
- Browser console shows socket connection errors (`xhr poll error`, `transport error`,
  `connect_error`) — the client cannot reach `/?XTransformPort=4010`.
- Monolith metrics keep counting `/api/social/*` normally — the REST side is healthy.

## Impact

**Still works** (the platform degrades, it does not die):

- Every social REST route on :4000 — follows, profiles, reviews, feed v2 (polling), parties,
  AI social home/review digest. The web `#/social` hub falls back to REST polling.
- All data: reviews, follows, party membership, chat history and host sync snapshots are
  persisted in Neon by the monolith. Nothing is lost while :4010 is down.
- The monolith itself — its webhook to :4010 is fire-and-forget with a 1.5 s abort and
  swallows all failures silently (by design).

**Broken:**

- Live activity ticker (no `social:activity` broadcasts).
- Watch-party live sync: host control relay, presence, typing.
- Live chat relay (history is still written to Neon if the monolith is up — the REST UI
  still shows it on reload; only the realtime echo is gone).

## Diagnosis

```bash
# 1. Realtime health — the primary probe (expect status ok + sockets/rooms gauges)
curl -s http://localhost:4010/api/health
# healthy: {"status":"ok","service":"animaxia-realtime","version":"1.0.0",
#           "uptimeSec":406,"sockets":0,"rooms":1,"authMode":"derived", ...}
# connection refused / timeout → the service is DOWN → Recovery step 1.

# 2. Metrics — counters prove the live path works
curl -s http://localhost:4010/metrics
# watch: animaxia_realtime_sockets_connected, animaxia_realtime_party_rooms,
#        animaxia_realtime_activity_broadcasts_total (must grow as people act),
#        animaxia_realtime_persist_errors_total (must stay 0 — non-zero means the
#        realtime service cannot reach the monolith).

# 3. Is the port listening at all?
ss -ltnp | grep 4010
# LISTEN ... *:4010 ... users:(("bun",pid=...)) — missing → service down.

# 4. Monolith log — the webhook is SILENT on failure by design, so the monolith log
#    only proves the bus is wired, never that :4010 received anything:
rg -n "social|realtime" mini-services/animaxia-backend/log
# expect the boot lines:
#   [social] Schema verified — 16/16 statements OK (...)
#   [social] activity bus wired (comment:added → activityevents + realtime webhook)
# → for webhook failures, read the REALTIME log instead:

# 5. Realtime log — connections, joins, boot banner
tail -20 mini-services/animaxia-realtime/log
# healthy boot lines:
#   [realtime] animaxia-realtime v1.0.0 listening on :4010 (socket.io path "/")
#   [realtime] monolith bridge → http://127.0.0.1:4000 | auth derived (...) | internal token required

# 6. REALTIMETOKEN parity — both .env files must carry the SAME token
#    (mismatch = every webhook is rejected 401 "Invalid internal token"; the monolith
#    swallows it, so the signature is: activity events accumulate in the REST feed but
#    animaxia_realtime_activity_broadcasts_total stays flat while
#    animaxia_realtime_http_requests_total{route="internal-activity"} keeps counting):
diff <(grep -o '^REALTIMETOKEN=.*' mini-services/animaxia-backend/.env) \
     <(grep -o '^REALTIMETOKEN=.*' mini-services/animaxia-realtime/.env) \
  && echo "tokens MATCH" || echo "tokens MISMATCH → Recovery step 2"

# 7. Monolith reachable from the realtime service? (animaxia_realtime_persist_errors_total > 0)
curl -s http://localhost:4000/api/health | grep -o '"connected":[a-z]*'
# "connected":true → the bridge problem is MONOLITHURL in mini-services/animaxia-realtime/.env
```

## Recovery

### Step 1 — restart the realtime service (down / misbehaving)

```bash
cd mini-services/animaxia-realtime
(setsid bun run dev > log 2>&1 < /dev/null &)
```

- **Always the detached setsid pattern** — a plain `... &` process is reaped when the
  invoking shell/session ends (the documented cause of past :3000/:4000 outages).
- Single dependency (`socket.io`); if it was wiped:
  `cd mini-services/animaxia-realtime && bun install` first.
- Rooms rebuild on demand: each is re-seeded from the monolith party snapshot on the next
  `party:join` — a restart loses nothing durable.

### Step 2 — REALTIMETOKEN mismatch (webhook 401s)

```bash
# 1. Copy the token from one file into the other (they must be identical):
grep '^REALTIMETOKEN=' mini-services/animaxia-backend/.env
#   → paste the same line into mini-services/animaxia-realtime/.env (or vice versa)

# 2. Restart BOTH services — each reads the token only at boot:
cd mini-services/animaxia-realtime && (setsid bun run dev > log 2>&1 < /dev/null &)
# monolith: safe kill (cwd check!) + setsid relaunch, or one command:
cd mini-services/animaxia-backend && ./restore-env.sh   # also restores .env if wiped
```

Note: the monolith reads `REALTIMEURL`/`REALTIMETOKEN` from its env at module load —
env edits never take effect without a restart. Do not kill the monolith by pid without
the cwd check (`for p in $(pgrep -f "bun --watch server.js"); do readlink /proc/$p/cwd; done`)
— see [neon-outage.md](neon-outage.md) for the full safe-restart procedure.

### Step 3 — monolith unreachable from the realtime service

`animaxia_realtime_persist_errors_total` climbing while :4000 answers locally means
`MONOLITHURL` in `mini-services/animaxia-realtime/.env` is wrong. Set it to
`http://127.0.0.1:4000`, restart the realtime service (Step 1). If the monolith itself
is degraded (Neon local-fallback), fix that first via [neon-outage.md](neon-outage.md) —
chat persistence self-heals once :4000 is back; rooms keep relaying in the meantime.

## Verification

```bash
# 1. Health + boot banner
curl -s http://localhost:4010/api/health        # "status":"ok", sockets/rooms > 0 when used
tail -3 mini-services/animaxia-realtime/log     # "listening on :4010"

# 2. Full E2E webhook chain — register → review → socket receives social:activity
#    (prints "webhook delivered: review by ..." and exits 0 on success):
cd mini-services/animaxia-realtime && bun hook-e2e.mjs

# 3. Full realtime contract (auth parity, guest mode, party join/state/member events,
#    host-only control, chat persisted to Neon, typing, webhook 401 gating, presence).
#    On a long-running instance the final "metrics counters" check asserts absolute
#    counter values and may report stale numbers — the 17 functional checks are what
#    matter; restart the service first for a clean 18/18:
cd mini-services/animaxia-realtime && bun test-quick.mjs

# 4. Counters move while you watch (run hook-e2e.mjs again, then):
curl -s http://localhost:4010/metrics | grep -E "activity_broadcasts|persist_errors"

# 5. Web #/social (http://localhost:3000): live ticker receives new events,
#    party room chat works in two sessions, host play/pause syncs the member player.
```

## Prevention & history

- **Keep `REALTIMETOKEN` in BOTH `.env` files** — `mini-services/animaxia-backend/.env`
  (`REALTIMEURL`, `REALTIMETOKEN`, appended at the end) and
  `mini-services/animaxia-realtime/.env` (`PORT`, `MONOLITHURL`, `REALTIMETOKEN` — same
  value). The ZIP (`public/animaxia-cloud.zip`, prefix `animaxia-social/`) carries both —
  restore from there after any session reset, the same golden rule as the monolith `.env`.
- **JWT parity needs no maintenance**: with `AUTHSECRET` absent (current state) both
  services derive the identical secret `sha256("animaxia-auth:" + DATABASEURL)`; the
  realtime `env.js` fallback chain (process env → local `.env` → the monolith's `.env`)
  keeps parity even after env wipes.
- **Health endpoint is synthetics-ready**: `GET :4010/api/health` is a natural synthetic
  check (see the FAZA-10 candidate list in `../synthetics/README.md` — not yet wired).
- **Restart-safe by design**: rooms are in-memory but re-seed from the monolith; the
  webhook is best-effort; chat persistence retries on every message. Restarting
  `:4010` during traffic is safe.

## Rollback

N/A — recovery-only procedure (nothing is config-changed that needs undoing; the token
fix in Step 2 only re-synchronizes the two `.env` files to the value the ZIP already
carries).
