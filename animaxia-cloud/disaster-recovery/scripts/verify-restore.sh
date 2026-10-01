#!/usr/bin/env bash
#===============================================================================
# disaster-recovery/scripts/verify-restore.sh
#
# Read-only verification battery for a (restored) Animaxia database.
# Safe to run against ANY database — every query is a SELECT; nothing is
# written. Use it after restore-neon.sh, before any cutover, and during DR
# drills (PLAN.md §8–9).
#
# Usage:
#   bash disaster-recovery/scripts/verify-restore.sh                  # checks .env DATABASEURL
#   bash disaster-recovery/scripts/verify-restore.sh --into <url>     # checks a specific target
#
# Checks:
#   1. core tables exist + row counts : content, users, jobs   (FAIL if missing)
#   2. queue stats                    : jobs grouped by status (pending/running/
#                                        done/failed/dead)      (FAIL if broken)
#   3. content freshness              : age of the newest content row (hours)
#   4. secondary tables (best effort) : comments, viewevents, subscriptions,
#                                        auditlogs, aichats        (WARN if missing)
#
# Output: PASS/FAIL table on stdout + a stamped log under
#   disaster-recovery/backups/verify-YYYYMMDD-HHMMSS.log
#
# Exit code: 0 = ALL PASS (warnings allowed) · 1 = any FAIL (or tooling missing)
#===============================================================================
set -euo pipefail

SCRIPTDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPOROOT="$(cd "$SCRIPTDIR/../.." && pwd)"
BACKUPDIR="$REPOROOT/disaster-recovery/backups"
ENVFILE="$REPOROOT/.env"

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
log() { printf '[verify-restore] %s\n' "$*"; }

envval() {
  local key="$1" default="${2:-}" line
  [ -f "$ENVFILE" ] || { printf '%s' "$default"; return 0; }
  line="$(sed -n -E "s/^[[:space:]]*${key}[[:space:]]*=[[:space:]]*//p" "$ENVFILE" | tail -n 1 || true)"
  line="${line%$'\r'}"
  line="${line%\"}"; line="${line#\"}"
  line="${line%\'}"; line="${line#\'}"
  printf '%s' "${line:-$default}"
}

clean_url() {
  printf '%s' "$1" | sed -E \
    -e 's/([?&])options=[^&]*channel_binding[^&]*&/\1/g' \
    -e 's/[?&]options=[^&]*channel_binding[^&]*$//' \
    -e 's/([?&])channel_binding=[^&]*&/\1/g' \
    -e 's/[?&]channel_binding=[^&]*$//' \
    -e 's/\?$//'
}

#--- args ----------------------------------------------------------------------------

TARGETRAW="${DATABASEURL:-$(envval DATABASEURL)}"
while [ $# -gt 0 ]; do
  case "$1" in
    --into) [ $# -ge 2 ] || die "--into needs a value"; TARGETRAW="$2"; shift 2 ;;
    -h|--help) sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[ -n "$TARGETRAW" ] || die "no DATABASEURL (env or .env) and no --into target given."
TARGET="$(clean_url "$TARGETRAW")"

command -v psql >/dev/null 2>&1 || die "psql not found — install PostgreSQL client tools (see backup-neon.sh header)."

mkdir -p "$BACKUPDIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
LOGFILE="$BACKUPDIR/verify-$STAMP.log"

# query SQL -> prints the last non-empty result line (or 'ERR' on failure).
# `set +e` around psql because a failed query must become a FAIL row, not kill
# the script (set -e is active globally).
q() {
  local out rc
  set +e
  out="$(psql "$TARGET" -X -q -A -t -v ON_ERROR_STOP=1 -c "$1" 2>&1)"
  rc=$?
  set -e
  if [ "$rc" -ne 0 ]; then printf 'ERR'; return 0; fi
  printf '%s' "$(printf '%s' "$out" | sed '/^[[:space:]]*$/d' | tail -n 1)"
}

PASS=0; FAIL=0; WARN=0
row() { # row NAME RESULT EXPECTED-STATUS
  printf '  %-34s %-8s %s\n' "$1" "$2" "$3" | tee -a "$LOGFILE"
}

printf '[verify-restore] target: %s\n' "$(printf '%s' "$TARGET" | sed -E 's#^[a-z]+://[^@]*@#<credentials>@#')" | tee -a "$LOGFILE"
printf '[verify-restore] log   : %s\n\n' "$LOGFILE" | tee -a "$LOGFILE"

#--- 1. core tables -------------------------------------------------------------------

printf 'Core tables (FAIL if missing):\n' | tee -a "$LOGFILE"
for tbl in content users jobs; do
  RES="$(q "SELECT COUNT(*) FROM $tbl")"
  if [ "$RES" = "ERR" ]; then
    row "table $tbl" "FAIL" "missing or not queryable"
    FAIL=$((FAIL + 1))
  elif [ "$RES" = "0" ]; then
    row "table $tbl ($RES rows)" "WARN" "exists but empty (fresh seed?)"
    WARN=$((WARN + 1))
  else
    row "table $tbl ($RES rows)" "PASS" ""
    PASS=$((PASS + 1))
  fi
done

#--- 2. queue stats --------------------------------------------------------------------

printf '\nQueue stats (jobs by status):\n' | tee -a "$LOGFILE"
RES="$(q "SELECT COALESCE(string_agg(status || ':' || c, ', '), 'no rows') FROM (SELECT status, COUNT(*)::text AS c FROM jobs GROUP BY status ORDER BY status) s")"
if [ "$RES" = "ERR" ]; then
  row "jobs by status" "FAIL" "jobs table not queryable"
  FAIL=$((FAIL + 1))
else
  row "jobs by status" "PASS" "$RES"
  PASS=$((PASS + 1))
fi

#--- 3. content freshness ----------------------------------------------------------------

printf '\nContent freshness:\n' | tee -a "$LOGFILE"
RES="$(q "SELECT COALESCE(ROUND(EXTRACT(EPOCH FROM (NOW() - MAX(createdat))) / 3600)::int, -1) FROM content")"
if [ "$RES" = "ERR" ]; then
  row "newest content age" "FAIL" "could not compute"
  FAIL=$((FAIL + 1))
elif [ "$RES" = "-1" ]; then
  row "newest content age" "WARN" "no content rows at all"
  WARN=$((WARN + 1))
elif [ "$RES" -gt 720 ]; then
  row "newest content age" "WARN" "$RES hours (>30 days) — stale restore?"
  WARN=$((WARN + 1))
else
  row "newest content age" "PASS" "$RES hours since newest content row"
  PASS=$((PASS + 1))
fi

#--- 4. secondary tables (best effort) ------------------------------------------------------

printf '\nSecondary tables (WARN if missing — a valid dump has them, but their\nabsence does not by itself invalidate the restore):\n' | tee -a "$LOGFILE"
for tbl in comments viewevents subscriptions auditlogs aichats; do
  RES="$(q "SELECT COUNT(*) FROM $tbl")"
  if [ "$RES" = "ERR" ]; then
    row "table $tbl" "WARN" "missing"
    WARN=$((WARN + 1))
  else
    row "table $tbl ($RES rows)" "PASS" ""
    PASS=$((PASS + 1))
  fi
done

#--- summary ----------------------------------------------------------------------------------

printf '\n' | tee -a "$LOGFILE"
printf 'SUMMARY: %d passed, %d failed, %d warnings\n' "$PASS" "$FAIL" "$WARN" | tee -a "$LOGFILE"
if [ "$FAIL" -gt 0 ]; then
  printf 'RESULT : FAIL — the restore is INCOMPLETE/BROKEN. Do not cut over.\n' | tee -a "$LOGFILE"
  printf '         Re-run restore-neon.sh with a different dump or check PLAN.md §8.\n' | tee -a "$LOGFILE"
  exit 1
fi
if [ "$WARN" -gt 0 ]; then
  printf 'RESULT : PASS (with warnings) — review the WARN rows above before cutover.\n' | tee -a "$LOGFILE"
else
  printf 'RESULT : PASS — database verified. Safe to proceed with cutover (PLAN.md §8.4).\n' | tee -a "$LOGFILE"
fi
exit 0
