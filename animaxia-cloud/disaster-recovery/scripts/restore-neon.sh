#!/usr/bin/env bash
#===============================================================================
# disaster-recovery/scripts/restore-neon.sh
#
# Restore a pg_dump custom-format dump into a PostgreSQL/Neon database.
#
# GOLDEN RULE: restore into a NEW (empty) database FIRST — never over the live
# one. This script refuses to run against the DATABASEURL from .env unless you
# pass the explicit self-aware override flag.
#
# Usage:
#   bash disaster-recovery/scripts/restore-neon.sh --file <dump> --into <connection-string>
#   bash disaster-recovery/scripts/restore-neon.sh --latest --into <connection-string>
#
#   --file <path>         dump file (e.g. disaster-recovery/backups/20250101-020000.dump)
#   --latest              use the dump named in disaster-recovery/backups/latest
#   --into <url>          TARGET connection string (a NEW Neon database)
#   --force-i-know-what-im-doing
#                         required only when --into equals the .env DATABASEURL
#                         (destructive: --clean --if-exists DROPS objects first)
#
# After the restore the script runs a quick verification query set (counts on
# content / users / jobs) and prints the cutover runbook (configmap/secret
# update + rollout restart).
#
# Exit codes: 0 ok · 1 usage/safety/tool failure · 2 restore failed · 3 verify failed
#===============================================================================
set -euo pipefail

SCRIPTDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPOROOT="$(cd "$SCRIPTDIR/../.." && pwd)"
BACKUPDIR="$REPOROOT/disaster-recovery/backups"
ENVFILE="$REPOROOT/.env"

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
log() { printf '[restore-neon] %s\n' "$*"; }

usage() {
  sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 1
}

# envval — see backup-neon.sh for the rationale (the house .env has decorative
# banner lines that are NOT valid shell — never `source` it).
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

# psql helper: run ONE query, tuples-only, errors -> stderr (does not kill the
# script by itself; callers decide via rc capture).
q() { psql "$TARGET" -X -q -A -t -v ON_ERROR_STOP=1 -c "$1" 2>&1; }

#--- parse args -------------------------------------------------------------------

DUMP=""
TARGETRAW=""
LATEST=0
FORCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --file)  [ $# -ge 2 ] || die "--file needs a value"; DUMP="$2"; shift 2 ;;
    --into)  [ $# -ge 2 ] || die "--into needs a value"; TARGETRAW="$2"; shift 2 ;;
    --latest) LATEST=1; shift ;;
    --force-i-know-what-im-doing) FORCE=1; shift ;;
    -h|--help) usage ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done

[ -n "$TARGETRAW" ] || { usage; }
TARGET="$(clean_url "$TARGETRAW")"

if [ "$LATEST" -eq 1 ]; then
  [ -z "$DUMP" ] || die "pass either --file or --latest, not both"
  [ -f "$BACKUPDIR/latest" ] || die "no $BACKUPDIR/latest pointer — run backup-neon.sh first (or use --file)"
  LATESTNAME="$(tr -d '\r\n' < "$BACKUPDIR/latest")"
  DUMP="$BACKUPDIR/$LATESTNAME"
fi
[ -n "$DUMP" ] || { usage; }
[ -f "$DUMP" ] || die "dump file not found: $DUMP"
[ -s "$DUMP" ] || die "dump file is empty: $DUMP"

#--- tools ------------------------------------------------------------------------

for bin in pg_restore psql; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    cat >&2 <<EOF
ERROR: $bin not found in PATH — PostgreSQL client tools are required.
Install hint:
  Debian/Ubuntu : sudo apt-get install -y postgresql-client
  macOS (brew)  : brew install libpq && brew link --force libpq
  Docker escape : docker run --rm -v "\$PWD":/wd postgres:16-alpine $bin ...
EOF
    exit 1
  fi
done

#--- safety gate: never clobber the live database by accident ----------------------

LIVEURL="$(envval DATABASEURL)"
if [ -n "$LIVEURL" ] && [ "$FORCE" -ne 1 ]; then
  if [ "$TARGETRAW" = "$LIVEURL" ] || [ "$TARGET" = "$(clean_url "$LIVEURL")" ]; then
    cat >&2 <<EOF
******************************************************************************
* REFUSING TO RESTORE: the --into target IS the live DATABASEURL from .env.
*
* Restoring runs pg_restore --clean --if-exists, i.e. it DROPS every existing
* object in the target database before recreating it.
*
* The safe path (see PLAN.md §8):
*   1. create a NEW database in the Neon console (e.g. metadata_restore_drill)
*   2. restore into it:  --into postgresql://.../metadata_restore_drill
*   3. verify:           bash disaster-recovery/scripts/verify-restore.sh --into ...
*   4. only then cut over (secret rotation + rollout restart)
*
* If you REALLY mean to restore over the live database, re-run with:
*   --force-i-know-what-im-doing
******************************************************************************
EOF
    exit 1
  fi
fi

#--- banner ------------------------------------------------------------------------

TARGETSHOWN="$(printf '%s' "$TARGET" | sed -E 's#^[a-z]+://[^@]*@#<credentials>@#')"
log "dump     : $DUMP ($(wc -c < "$DUMP" | tr -d ' ') bytes)"
log "target   : $TARGETSHOWN"
log "pg_restore: $(pg_restore --version)"
printf '[restore-neon] starting destructive restore (--clean --if-exists) in 3s ...\n'
sleep 3

#--- restore -----------------------------------------------------------------------

# --clean --if-exists : DROP existing objects first (idempotent on empty DBs)
# --no-owner          : do not try to SET ROLE to the original dump owner
# --no-privileges     : skip GRANT/REVOKE (avoids role mismatch errors)
if ! pg_restore --clean --if-exists --no-owner --no-privileges --dbname "$TARGET" "$DUMP"; then
  printf '\n[restore-neon] pg_restore reported errors. With --clean --if-exists a first\n' >&2
  printf '[restore-neon] restore into a NON-empty database can log harmless "does not exist"\n' >&2
  printf '[restore-neon] notices — but treat ANY other error as a failed restore.\n' >&2
  printf '[restore-neon] Inspect above, then re-run or verify manually.\n' >&2
  exit 2
fi
log "pg_restore finished."

#--- quick verification query set (counts on content / users / jobs) ---------------

VERIFYFAILED=0
printf '\n[restore-neon] verification counts:\n'
for tbl in content users jobs; do
  if RES="$(q "SELECT COUNT(*) FROM $tbl")"; then
    log "  $tbl rows : $(printf '%s' "$RES" | tail -n 1)"
  else
    log "  $tbl rows : TABLE MISSING/ERROR — $(printf '%s' "$RES" | tail -n 1)"
    VERIFYFAILED=1
  fi
done

printf '\n[restore-neon] full battery (recommended):\n'
log "  bash disaster-recovery/scripts/verify-restore.sh --into '$TARGETRAW'"

#--- next steps ---------------------------------------------------------------------

cat <<EOF

[restore-neon] NEXT STEPS (cutover runbook, PLAN.md §6.3 / §8):
  1. Verify the restored DB:      bash disaster-recovery/scripts/verify-restore.sh --into '$TARGETRAW'
  2. Point the cluster at it:
       kubectl -n animaxia patch secret animaxia-secrets --type merge \\
         -p '{"stringData":{"DATABASEURL":"$TARGETRAW"}}'
       (or: bash disaster-recovery/scripts/failover-readonly.sh '$TARGETRAW')
  3. Rolling restart:             kubectl -n animaxia rollout restart deployment
  4. Watch the rollout:           kubectl -n animaxia rollout status deploy/gateway-service
  5. Smoke:                       curl -fsS http://localhost:8080/api/health
  6. Record the event in          disaster-recovery/backups/manifest.log + the DR drill log (PLAN.md §9).
EOF

if [ "$VERIFYFAILED" -ne 0 ]; then
  printf '\n[restore-neon] NOTE: verification queries reported problems — treat this restore as SUSPECT.\n' >&2
  exit 3
fi
log "done."
