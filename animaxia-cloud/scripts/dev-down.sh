#!/usr/bin/env bash
#===============================================================================
# scripts/dev-down.sh — stop everything started by dev-up.sh (bun run dev:down).
#
# What it does:
#   1. reads "<name> <pid> <port>" lines from .dev-pids
#   2. sends each PID SIGTERM (services shut down gracefully: SIGTERM/SIGINT
#      handlers close the pg pool), waits up to 5s, then SIGKILLs stragglers
#   3. removes .dev-pids and prints what stopped
#   4. fallback for orphaned sessions (crashed .dev-pids, manual boots):
#        pkill -f 'animaxia-cloud/services'
#      — interactive confirmation required (or pass --yes)
#
# Usage:
#   bash scripts/dev-down.sh          # graceful, then fallback offer
#   bash scripts/dev-down.sh --yes    # no prompts (safe for scripts/CI)
#===============================================================================
set -euo pipefail

SCRIPTDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPOROOT="$(cd "$SCRIPTDIR/.." && pwd)"
PIDFILE="$REPOROOT/.dev-pids"

log() { printf '[dev-down] %s\n' "$*"; }

ASSUMEYES=0
case "${1:-}" in
  --yes|-y) ASSUMEYES=1 ;;
  "") : ;;
  *) printf 'usage: dev-down.sh [--yes]\n' >&2; exit 1 ;;
esac

#--- graceful stop via .dev-pids ------------------------------------------------------

NAMES=()
PIDS=()
MISSING=()
if [ -f "$PIDFILE" ]; then
  while IFS=' ' read -r name pid port; do
    [ -n "$name" ] || continue
    if kill -0 "$pid" 2>/dev/null; then
      NAMES+=("$name")
      PIDS+=("$pid")
    else
      MISSING+=("$name($pid)")
    fi
  done < "$PIDFILE"

  if [ "${#PIDS[@]}" -gt 0 ]; then
    log "SIGTERM -> ${#PIDS[@]} process(es): ${NAMES[*]}"
    kill -TERM "${PIDS[@]}" 2>/dev/null || true

    # wait up to 5s (10 x 0.5s) for graceful exits
    for _ in $(seq 1 10); do
      ALIVE=0
      for pid in "${PIDS[@]}"; do
        if kill -0 "$pid" 2>/dev/null; then ALIVE=$((ALIVE + 1)); fi
      done
      if [ "$ALIVE" -eq 0 ]; then break; fi
      sleep 0.5
    done

    # SIGKILL the stragglers
    for i in "${!PIDS[@]}"; do
      if kill -0 "${PIDS[$i]}" 2>/dev/null; then
        log "SIGKILL -> ${NAMES[$i]} (${PIDS[$i]}) — did not exit within 5s"
        kill -KILL "${PIDS[$i]}" 2>/dev/null || true
      fi
    done
  fi

  rm -f "$PIDFILE"
  if [ "${#NAMES[@]}" -gt 0 ]; then
    log "stopped: ${NAMES[*]}"
  fi
  if [ "${#MISSING[@]}" -gt 0 ]; then
    log "already gone (stale pidfile entries): ${MISSING[*]}"
  fi
else
  log "no .dev-pids file — nothing tracked by dev-up was found."
fi

#--- fallback: catch orphans the pidfile does not know about --------------------------

# dev-up boots with the ABSOLUTE path (…/animaxia-cloud/services/<name>/server.js),
# so this pattern matches exactly the dev sessions of this repo checkout — and
# nothing else on the machine.
PATTERN='animaxia-cloud/services'
if pgrep -f "$PATTERN" >/dev/null 2>&1; then
  log "found processes matching '$PATTERN' that were NOT in .dev-pids:"
  pgrep -af "$PATTERN" | sed 's/^/  /'
  if [ "$ASSUMEYES" -eq 1 ]; then
    log "killing them (--yes) ..."
    pkill -TERM -f "$PATTERN" 2>/dev/null || true
    sleep 2
    pkill -KILL -f "$PATTERN" 2>/dev/null || true
    log "orphaned dev processes cleaned."
  else
    printf '[dev-down] Kill them too? [y/N] '
    read -r ANSWER
    case "$ANSWER" in
      y|Y|yes|YES)
        pkill -TERM -f "$PATTERN" 2>/dev/null || true
        sleep 2
        pkill -KILL -f "$PATTERN" 2>/dev/null || true
        log "orphaned dev processes cleaned."
        ;;
      *) log "leaving them running (they were not tracked by this session)." ;;
    esac
  fi
else
  log "no orphaned dev processes found (pgrep -f '$PATTERN': no matches)."
fi

if [ "${#NAMES[@]}" -eq 0 ]; then
  log "nothing was stopped from .dev-pids (was dev-up running?)."
fi
log "done."
