#!/usr/bin/env bash
#===============================================================================
# scripts/dev-up.sh — boot ALL Animaxia Cloud services locally (bun run dev).
#
# What it does:
#   1. verifies the repo-root .env exists (services need DATABASEURL etc.)
#   2. verifies each service folder (services/<name>) has package.json + server.js
#      — services not yet scaffolded are SKIPPED with a warning (Phase-3 mid-build
#      friendliness); when all 10 exist, all 10 boot
#   3. runs `bun install` at the repo root when node_modules is missing
#   4. boots every service in the background:
#        bun <repo>/services/<name>/server.js >> logs/<name>.log 2>&1 &
#      writing "<name> <pid> <port>" lines to .dev-pids (see dev-down.sh)
#   5. waits up to 30s per service for GET /health to answer on its port
#      (ports honor the .env overrides: GATEWAYPORT, AUTHPORT, CONTENTPORT, …)
#   6. prints a status table + warns about port conflicts
#
# Usage:
#   bash scripts/dev-up.sh            (or: bun run dev / npm run dev)
#
# Stop everything:  bash scripts/dev-down.sh   (or bun run dev:down)
# Tail one service: tail -f logs/gateway-service.log
#===============================================================================
set -euo pipefail

SCRIPTDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPOROOT="$(cd "$SCRIPTDIR/.." && pwd)"
ENVFILE="$REPOROOT/.env"
PIDFILE="$REPOROOT/.dev-pids"
LOGDIR="$REPOROOT/logs"

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
log() { printf '[dev-up] %s\n' "$*"; }

# envval KEY [DEFAULT] — read ONE value from the house .env WITHOUT sourcing it
# (the .env contains decorative banner lines that are not valid shell — sourcing
# would explode; grepping a single KEY= line is safe: no eval, no side effects).
envval() {
  local key="$1" default="${2:-}" line
  [ -f "$ENVFILE" ] || { printf '%s' "$default"; return 0; }
  line="$(sed -n -E "s/^[[:space:]]*${key}[[:space:]]*=[[:space:]]*//p" "$ENVFILE" | tail -n 1 || true)"
  line="${line%$'\r'}"
  printf '%s' "${line:-$default}"
}

#--- service registry (name : port env : default port — BLUEPRINT §2) ---------------

SERVICES=(
  "gateway-service:GATEWAYPORT:8080"
  "auth-service:AUTHPORT:4001"
  "content-service:CONTENTPORT:4002"
  "ai-service:AIPORT:4003"
  "analytics-service:ANALYTICSPORT:4004"
  "search-service:SEARCHPORT:4005"
  "premium-service:PREMIUMPORT:4006"
  "social-service:SOCIALPORT:4007"
  "mobile-service:MOBILEPORT:4008"
  "queue-service:QUEUEPORT:4009"
)

#--- pre-flight -----------------------------------------------------------------------

command -v bun >/dev/null 2>&1 || die "bun not found — install it: https://bun.sh (curl -fsSL https://bun.sh/install | bash)"
[ -f "$ENVFILE" ] || die "no .env found at $ENVFILE — run: cp .env.example .env  (then fill DATABASEURL, AUTHSECRET, TMDBAPIKEY, ...)"
[ -n "$(envval DATABASEURL)" ] || log "WARNING: DATABASEURL is not set in .env — DB-bound services will boot degraded."

# Which services exist? (mid-build: some folders may still be missing)
EXISTING=()
MISSING=()
for entry in "${SERVICES[@]}"; do
  name="${entry%%:*}"
  if [ -f "$REPOROOT/services/$name/package.json" ] && [ -f "$REPOROOT/services/$name/server.js" ]; then
    EXISTING+=("$entry")
  else
    MISSING+=("$name")
  fi
done

if [ "${#EXISTING[@]}" -eq 0 ]; then
  die "no services found under services/ (need package.json + server.js per folder). Nothing to boot."
fi
if [ "${#MISSING[@]}" -gt 0 ]; then
  log "WARNING: skipping ${#MISSING[@]} not-yet-scaffolded service(s): ${MISSING[*]}"
  log "         (all 10 will boot once services/ is complete — BLUEPRINT §2)"
fi

# Dependencies: bun install once at the root (workspaces hoist @animaxia/*).
if [ ! -d "$REPOROOT/node_modules" ]; then
  log "node_modules missing — running bun install ..."
  (cd "$REPOROOT" && bun install)
else
  log "node_modules present — skipping bun install"
fi

mkdir -p "$LOGDIR"

# Stale pid file from a crashed session? Warn (dev-down will clean it).
if [ -f "$PIDFILE" ]; then
  log "NOTE: $PIDFILE already exists — a previous dev session may still be running."
  log "      Run 'bun run dev:down' first if you want a clean slate."
fi

#--- port conflict pre-check -----------------------------------------------------------

# bash built-in /dev/tcp probe: is anything already listening on this port?
port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null && { exec 3>&- 3<&-; return 0; } || return 1; }

log "checking ports for conflicts ..."
CONFLICTS=0
for entry in "${EXISTING[@]}"; do
  IFS=':' read -r name portenv defport <<< "$entry"
  port="$(envval "$portenv" "$defport")"
  if port_busy "$port"; then
    log "WARNING: port $port ($name) is already in use — the service will be SKIPPED."
    log "         (something is listening; maybe a previous dev session: bun run dev:down)"
    CONFLICTS=$((CONFLICTS + 1))
  fi
done

#--- boot ------------------------------------------------------------------------------

# cwd MUST be the repo root: services load the repo .env via `dotenv/config`
# (which reads process.cwd()/.env) and resolve @animaxia/* workspaces from there.
cd "$REPOROOT"

log "booting ${#EXISTING[@]} service(s) ..."
: > "$PIDFILE"
BOOTED=()
SKIPPED_BUSY=()
for entry in "${EXISTING[@]}"; do
  IFS=':' read -r name portenv defport <<< "$entry"
  port="$(envval "$portenv" "$defport")"
  if port_busy "$port"; then
    SKIPPED_BUSY+=("$name:$port")
    continue
  fi
  # Absolute script path on purpose: the process command line then contains
  # "animaxia-cloud/services/...", which dev-down.sh's pkill fallback matches.
  # No subshell here — $! must be bun's own PID so dev-down kills the right thing.
  bun "$REPOROOT/services/$name/server.js" >> "$LOGDIR/$name.log" 2>&1 &
  pid=$!
  printf '%s %s %s\n' "$name" "$pid" "$port" >> "$PIDFILE"
  BOOTED+=("$name")
done

log "booted PIDs written to .dev-pids ($(printf '%s ' "${BOOTED[@]}"))"

#--- wait for /health -------------------------------------------------------------------

wait_healthy() { # wait_healthy PORT -> 0 when /health answered 200 within 30s
  local port="$1" i
  for i in $(seq 1 60); do
    if curl -fsS -m 2 "http://localhost:$port/health" >/dev/null 2>&1; then return 0; fi
    sleep 0.5
  done
  return 1
}

log "waiting for /health endpoints (up to 30s each) ..."
GREEN='' RED='' YELLOW='' BOLD='' RESET=''
if [ -t 1 ] && [ -z "${NOCOLOR:-}" ]; then
  GREEN=$'\033[32m'; RED=$'\033[31m'; YELLOW=$'\033[33m'; BOLD=$'\033[1m'; RESET=$'\033[0m'
fi

printf '\n%s%-22s %-8s %-7s %s%s\n' "$BOLD" "SERVICE" "PID" "PORT" "STATUS" "$RESET"
FAILED=0
while IFS=' ' read -r name pid port; do
  [ -n "$name" ] || continue
  if wait_healthy "$port"; then
    printf '%-22s %-8s %-7s %sOK%s   http://localhost:%s/health\n' "$name" "$pid" "$port" "$GREEN" "$RESET" "$port"
  elif kill -0 "$pid" 2>/dev/null; then
    printf '%-22s %-8s %-7s %sFAIL%s  (running but /health not answering — check logs/%s.log)\n' "$name" "$pid" "$port" "$RED" "$RESET" "$name"
    FAILED=$((FAILED + 1))
  else
    printf '%-22s %-8s %-7s %sDEAD%s  (process exited — check logs/%s.log)\n' "$name" "$pid" "$port" "$RED" "$RESET" "$name"
    FAILED=$((FAILED + 1))
  fi
done < "$PIDFILE"

for busy in "${SKIPPED_BUSY[@]:-}"; do
  [ -n "$busy" ] || continue
  printf '%-22s %-8s %-7s %sSKIP%s  (port busy — see warning above)\n' "${busy%%:*}" "-" "${busy##*:}" "$YELLOW" "$RESET"
done

#--- summary ------------------------------------------------------------------------------

GWPORT="$(envval GATEWAYPORT 8080)"
printf '\n'
log "gateway       : http://localhost:$GWPORT  (aggregated health: /api/health)"
log "logs          : $LOGDIR/<name>.log   (tail -f logs/gateway-service.log)"
log "stop          : bun run dev:down"
if [ "$FAILED" -gt 0 ]; then
  log "$FAILED service(s) failed to become healthy — inspect the logs above."
  exit 1
fi
log "all ${#BOOTED[@]} booted service(s) healthy."
