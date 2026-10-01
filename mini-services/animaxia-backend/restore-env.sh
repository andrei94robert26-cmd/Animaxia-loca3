#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Animaxia backend — env recovery (run after a sandbox/session reset)
#
# Recurring failure mode (seen 2026-09-17 and again 2026-09-18; worklog):
#   a session reset deletes mini-services/animaxia-backend/.env, then the
#   backend restarts degraded -> homepage shows:
#     - "tmdb responded 401 Unauthorized ... api_key="   (TMDBAPIKEY missing)
#     - "SQL layer unavailable — PostgreSQL driver inactive"
#       (DATABASEURL missing -> local fallback store, 3 seed items)
#
# Fix (idempotent). TS3 secret-hygiene note: the PUBLIC ZIPs no longer carry
# .env (regenerated without secrets on 2026-09-20), so the restore order is:
#   (1) .env already present in the service dir        -> skip extraction
#   (2) /home/z/my-project/secrets/animaxia.env        -> cp (persistent backup)
#   (3) legacy fallback: public/animaxia-cloud.zip ".env" (will find nothing
#       in the regenerated archive — kept only for pre-TS3 copies on disk)
# After a successful boot the backup is refreshed in the other direction too
# (cp .env secrets/animaxia.env — auto-heal, so manual fixes propagate).
#
# The script stops only THIS service's processes (never the Next.js dev
# server on :3000), relaunches detached, then prints the health probe.
#
# Usage:  cd mini-services/animaxia-backend && ./restore-env.sh
#         (also spawned automatically by animaxia-watchdog when :4000 reports
#          db.driver=local-fallback + DATABASEURL in db.lastError — TS3)
# ---------------------------------------------------------------------------
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(cd ../.. && pwd)"
SECRETS_DIR="$ROOT/secrets"
SECRETS_BACKUP="$SECRETS_DIR/animaxia.env"
PORT="${BACKEND_PORT:-4000}"

if [ -f .env ]; then
  echo "[restore] .env already present ($(wc -l < .env) lines)"
else
  if [ -f "$SECRETS_BACKUP" ]; then
    echo "[restore] .env missing — restoring from secrets/animaxia.env (persistent backup)"
    cp "$SECRETS_BACKUP" .env
  else
    echo "[restore] .env missing and secrets/animaxia.env absent — trying legacy zip extraction"
    unzip -o "$ROOT/public/animaxia-cloud.zip" ".env" -d . 2>/dev/null || true
  fi
fi

if [ ! -f .env ]; then
  echo "[restore] NO .env source available (secrets/animaxia.env missing and zip has no .env)."
  echo "[restore] Place the env file at $SECRETS_BACKUP or mini-services/animaxia-backend/.env and retry."
  exit 1
fi

# Stop only processes whose cwd is THIS directory (protects :3000 dev server)
for pid in $(pgrep -f "bun --watch server.js" 2>/dev/null || true) \
           $(pgrep -xf "bun run dev" 2>/dev/null || true); do
  if [ "$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)" = "$(pwd)" ]; then
    echo "[restore] stopping backend pid $pid"
    kill "$pid" 2>/dev/null || true
  fi
done
sleep 2

echo "[restore] relaunching backend (detached)"
(setsid bun run dev > log 2>&1 < /dev/null &)

echo -n "[restore] waiting for boot"
for i in $(seq 1 20); do
  sleep 2; echo -n "."
  if curl -s --max-time 5 "http://localhost:$PORT/api/health" | rg -q '"connected":true'; then
    echo " OK"
    curl -s --max-time 10 "http://localhost:$PORT/api/health" \
      | rg -o '"driver":"[^"]+"|"connected":(true|false)|"totalItems":\d+' || true
    # TS3 auto-heal: refresh the persistent backup after a healthy boot, so a
    # manually repaired .env (or a pre-TS3 archive restore) propagates forward.
    if [ -f .env ]; then
      mkdir -p "$SECRETS_DIR"
      cp .env "$SECRETS_BACKUP"
      chmod 600 "$SECRETS_BACKUP" 2>/dev/null || true
      echo "[restore] secrets/animaxia.env backup refreshed (auto-heal)."
    fi
    echo "[restore] done — Neon reconnected."
    exit 0
  fi
done
echo " TIMEOUT — check ./log and retry, or verify Neon credentials."
exit 1
