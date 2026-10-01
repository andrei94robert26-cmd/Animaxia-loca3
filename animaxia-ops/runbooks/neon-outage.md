# Runbook — Neon PostgreSQL outage / backend degraded to local fallback

**Service:** monolith backend `mini-services/animaxia-backend/` (Express + Neon PostgreSQL) on **:4000**.
**Most common cause in this environment:** a sandbox/session reset deletes
`mini-services/animaxia-backend/.env`, so the backend reboots without `DATABASEURL` (and without
`TMDBAPIKEY`, which fails together). Rarer cause: Neon itself is unreachable or the credentials
were rotated/revoked. The backend never crashes — it silently degrades to the local-fallback
JSON store (3 seed items).
**Incident history:** 2026-09-17, 2026-09-18 (×2). Procedure validated end-to-end on 2026-09-18.

## Symptoms

Homepage (`http://localhost:3000`) shows the two signature error/degradation cards:

- `tmdb responded 401 Unauthorized ... api_key=` → `TMDBAPIKEY` missing (env-wipe signature)
- `SQL layer unavailable — PostgreSQL driver inactive (local fallback store in use)` → `DATABASEURL` missing/rejected
- Catalog collapses to the 3 seed items: stats strip shows **3 Total titles**, hero falls back to Big Buck Bunny.

Health probe — the `db` section flips from Neon to local fallback:

```bash
curl -s http://localhost:4000/api/health
```

degraded signature:

```json
"db": { "driver": "local-fallback", "connected": false, "totalItems": 3 }
```

healthy reference:

```json
"db": { "driver": "postgres", "connected": true, "totalItems": 79 }
```

Metrics (FAZA 9 Prometheus endpoint):

```bash
curl -s http://localhost:4000/api/metrics | grep animaxia_db
# animaxia_db_connected 0        <- degraded (healthy: animaxia_db_connected 1)
```

## Impact

**Still works** (the platform degrades, it does not die):

- Backend :4000 and web app :3000 stay up — the local-fallback JSON driver is automatic.
- Reads/writes on the 3 local seed items (local fallback store).
- Jikan-sourced anime rows (no API key needed). TMDB rows are only lost when the cause is an
  env wipe (missing `TMDBAPIKEY`); a pure Neon outage keeps TMDB working.

**Broken:**

- Everything backed by Neon tables: the full catalog (≈79 items → 3), user/session data, analytics.
- AI quota persistence (quota counters live in the DB) — quotas reset while degraded.
- TMDB live "Trending now" rows when the trigger is the env wipe (401, empty api_key).

## Diagnosis

```bash
# 1. Health — confirm the degraded db signature
curl -s http://localhost:4000/api/health | grep -o '"driver":"[^"]*"\|"connected":[a-z]*\|"totalItems":[0-9]*'
# "driver":"local-fallback" "connected":false "totalItems":3

# 2. Metrics
curl -s http://localhost:4000/api/metrics | grep animaxia_db
# animaxia_db_connected 0

# 3. Backend boot log — healthy boots print the Neon line, degraded boots don't
rg -n "\[DB\] Connected to PostgreSQL|local fallback|\[aicloud\] vector backend" mini-services/animaxia-backend/log
# healthy: [DB] Connected to PostgreSQL (Neon) — schema ready
#          [aicloud] vector backend: pgvector (configured: auto, embeds: local-hash-256)
# degraded: no "[DB] Connected" line, a local-fallback notice instead,
#           and the vector backend resolves to mock (no Neon → no pgvector)

# 4. Is the .env gone? (healthy copy = 305 lines, 149+ vars)
ls -la mini-services/animaxia-backend/.env && wc -l mini-services/animaxia-backend/.env
# missing after a wipe → Recovery below. Present but still degraded → Neon-side issue,
# see "Prevention & history".

# 5. List backend processes + their working directory (needed before ANY kill)
for p in $(pgrep -f "bun --watch server.js"); do readlink /proc/$p/cwd; done
# ONLY pids whose cwd is mini-services/animaxia-backend are backend processes.
# NEVER kill anything else — the :3000 Next.js dev server must survive.
```

Note: do not confuse the two `.env` files — the repo-root `.env` is intentionally at platform
default (the Next.js app needs no provider keys; all data flows through :4000). Only
`mini-services/animaxia-backend/.env` matters here. Also beware: resets have left up to 4 stray
backend pids (2× `bun run dev` + 2× `bun --watch server.js`), only one of them holding :4000.

## Recovery

### Option A — one-command recovery (preferred): `restore-env.sh`

```bash
cd mini-services/animaxia-backend && ./restore-env.sh
```

What it does (idempotent, safe by design):

1. Restores `.env` from the authoritative ZIP copy if missing
   (`unzip -o public/animaxia-cloud.zip ".env" -d .` — the `.env` lives at the **zip root**).
2. Kills **only** processes whose cwd is the backend directory (it checks `/proc/$pid/cwd` for
   each `bun --watch server.js` / `bun run dev` pid) — the :3000 web server is never touched.
3. Relaunches the backend detached: `(setsid bun run dev > log 2>&1 < /dev/null &)`.
4. Polls `/api/health` for up to 40 s waiting for `"connected":true`, then prints
   driver / connected / totalItems. Exit 0 on success; exit 1 + "check ./log" on timeout.

Expected output:

```text
[restore] .env missing — extracting from public/animaxia-cloud.zip
[restore] stopping backend pid 12345
[restore] relaunching backend (detached)
[restore] waiting for boot.... OK
"driver":"postgres"
"connected":true
"totalItems":79
[restore] done — Neon reconnected.
```

### Option B — manual recovery (same steps by hand)

```bash
# 1. Restore the .env (149+ vars, 305 lines) from the ZIP — run from the repo root
cd /home/z/my-project
unzip -o public/animaxia-cloud.zip ".env" -d mini-services/animaxia-backend/

# 2. Identify the degraded backend pids and verify EACH cwd before killing
for p in $(pgrep -f "bun --watch server.js"); do readlink /proc/$p/cwd; done
# kill ONLY the pids whose cwd is mini-services/animaxia-backend (there may be several strays)
kill <backend-pid> [<backend-pid-2> ...]

# 3. Relaunch detached (setsid = survives the current shell/session)
cd mini-services/animaxia-backend
(setsid bun run dev > log 2>&1 < /dev/null &)

# 4. Watch the boot
tail -f log
# expect: [DB] Connected to PostgreSQL (Neon) — schema ready
```

Why each step matters:

- **cwd check before kill** — protects the :3000 Next.js dev server and any other bun processes.
- **`setsid ... < /dev/null &`** — the backend keeps running after the shell exits.
- **exact unzip pattern** — the ZIP stores `.env` at the zip root; `-d` extracts it into the backend dir.

## Verification

```bash
# 1. Health — Neon back, full catalog
curl -s http://localhost:4000/api/health | grep -o '"driver":"[^"]*"\|"connected":[a-z]*\|"totalItems":[0-9]*'
# "driver":"postgres" "connected":true "totalItems":79

# 2. Metrics
curl -s http://localhost:4000/api/metrics | grep animaxia_db_connected
# animaxia_db_connected 1

# 3. Synthetics — 29 checks, exits non-zero on any hard failure
cd /home/z/my-project/animaxia-ops && bun run ops:synthetics

# 4. DB write path — register a throwaway user
curl -s -X POST http://localhost:4000/api/auth/register -H "content-type: application/json" \
  -d '{"email":"test-9b@animaxia","username":"test9b","password":"Pass!1234"}'
# 201 + accessToken

# 5. Browser (http://localhost:3000): stats strip back to 79 Total titles / 29 Movies /
#    26 TV shows / 20 Anime (parity with /api/health), zero error cards, TMDB "Trending now"
#    and Jikan "Popular anime" rows render.
```

## Prevention & history

- **Three wipe incidents so far, all the same failure mode** (session reset deletes
  `mini-services/animaxia-backend/.env` → degraded reboot):
  - 2026-09-17 — first occurrence, manual recovery.
  - 2026-09-18 (×2) — recovered via the documented unzip/kill/setsid procedure, then
    `restore-env.sh` was created and tested end-to-end (Neon reconnect observed in ~10 s).
- The 2026-09-18 reset **also deleted `animaxia-edge/tests/local-harness.ts`** — if edge tests
  suddenly can't run after a reset, restore it the same way:

```bash
cd /home/z/my-project && unzip -o public/animaxia-cloud.zip "animaxia-edge/tests/local-harness.ts" -d .
```

- **`public/animaxia-cloud.zip` is the source of truth** — the backend `.env` lives at the zip
  root. ZIP updates must stay additive (never rewrite existing prefixes).
- **If Neon itself is down** (`.env` intact, `DATABASEURL` present): the platform keeps running
  on local fallback **by design** — no emergency restart needed. Check the Neon console for
  outages / suspended compute. If the credentials were rotated or revoked, update `DATABASEURL`
  in `mini-services/animaxia-backend/.env`, restart with the safe kill + setsid pattern
  (Option B steps 2-3), and refresh the ZIP copy so the next `restore-env.sh` doesn't resurrect
  the dead credentials:

```bash
cd mini-services/animaxia-backend && zip -u ../../public/animaxia-cloud.zip .env
```

## Rollback

N/A — this is a recovery-only procedure (nothing is config-changed that needs undoing).

Data-safety note: writes that landed in the local fallback store are **not lost**. A 60 s
reconnect probe migrates local rows back into PostgreSQL via idempotent upserts — observed live
as `[DB] Migrated 23/23 local rows into PostgreSQL` after one incident — after which the local
file is archived as `content.json.migrated`.
