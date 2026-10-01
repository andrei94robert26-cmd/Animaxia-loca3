#!/usr/bin/env bash
#===============================================================================
# disaster-recovery/scripts/cold-archive.sh
#
# Move local backups older than AGEDAYS (default 30) to cold storage on
# Cloudflare R2, verify the archive, and delete the verified local copies.
#
# The move is performed as a VERIFIED pipeline — copy -> rclone check -> delete —
# so every archived dump is size-verified on the remote BEFORE the local copy is
# removed (same end state as `rclone move`, minus the blind-delete risk).
#
# Usage:
#   bash disaster-recovery/scripts/cold-archive.sh [--dry-run]
#
# Options:
#   --dry-run   show what would be archived (rclone --dry-run, nothing deleted)
#
# Environment (process env wins over the repo .env):
#   AGEDAYS   local dumps older than this many days are archived (default 30)
#   R2COLD    rclone remote:path for the cold archive
#             (default: r2:animaxia-media/backups/cold)
#
# ---------------------------------------------------------------------------
# RCLONE + CLOUDFLARE R2 CONFIG (one-time setup):
#
#   1. Install rclone:      https://rclone.org/install/
#      (macOS: brew install rclone · Debian/Ubuntu:
#       curl https://rclone.org/install.sh | sudo bash)
#   2. Create an R2 API token in the Cloudflare dashboard:
#      R2 -> Manage R2 API Tokens -> Create API Token
#      (Object Read & Write, scope to the animaxia-media bucket)
#   3. Configure the remote:
#        rclone config
#        n) new remote
#        name> r2
#        type> s3
#        provider> Cloudflare
#        env_auth> false
#        access_key_id>  <token Access Key ID>
#        secret_access_key> <token Secret Access Key>
#        endpoint> https://<ACCOUNT_ID>.r2.cloudflarestorage.com
#   4. Test:  rclone lsd r2:animaxia-media
#
# Retention policy (PLAN.md §7): cold objects transition to Glacier-class
# storage after 90 days via an R2 lifecycle rule; monthly dumps are kept for
# 1 year. The lifecycle rule is configured on the bucket (dashboard/terraform),
# not by this script.
#
# NOTE on interaction with BACKUPKEEP (backup-neon.sh): the default local keep
# is 14 dumps (~14 days), so nothing local ever reaches AGEDAYS=30. This script
# is for the BACKUP HOST setup where you set BACKUPKEEP higher (e.g. 45) and let
# this script tier the aging locals into cold storage. Nightly dumps are
# additionally offloaded to the HOT R2 tier by backup-neon.sh (R2REMOTE) — that
# path is the primary offsite copy; this one is the local-housekeeping tier.
#===============================================================================
set -euo pipefail

SCRIPTDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPOROOT="$(cd "$SCRIPTDIR/../.." && pwd)"
BACKUPDIR="$REPOROOT/disaster-recovery/backups"
ENVFILE="$REPOROOT/.env"

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
log() { printf '[cold-archive] %s\n' "$*"; }

envval() {
  local key="$1" default="${2:-}" line
  [ -f "$ENVFILE" ] || { printf '%s' "$default"; return 0; }
  line="$(sed -n -E "s/^[[:space:]]*${key}[[:space:]]*=[[:space:]]*//p" "$ENVFILE" | tail -n 1 || true)"
  line="${line%$'\r'}"
  line="${line%\"}"; line="${line#\"}"
  line="${line%\'}"; line="${line#\'}"
  printf '%s' "${line:-$default}"
}

#--- args + config -------------------------------------------------------------------

DRYRUN=0
[ "${1:-}" = "--dry-run" ] && DRYRUN=1
[ $# -le 1 ] || die "usage: cold-archive.sh [--dry-run]"

AGEDAYS="${AGEDAYS:-$(envval AGEDAYS 30)}"
case "$AGEDAYS" in (*[!0-9]*|'') die "AGEDAYS must be a positive integer, got '$AGEDAYS'.";; esac
R2COLD="${R2COLD:-$(envval R2COLD r2:animaxia-media/backups/cold)}"

command -v rclone >/dev/null 2>&1 || die "rclone not found — see the RCLONE + R2 CONFIG section in this file's header."
command -v find >/dev/null 2>&1 || die "find not found (nonstandard PATH?)."
log "rclone $(rclone version | head -n 1)"

if [ ! -d "$BACKUPDIR" ]; then
  log "no backups directory yet ($BACKUPDIR) — nothing to archive."
  exit 0
fi

#--- select dumps older than AGEDAYS ---------------------------------------------------

# -maxdepth 1: only the flat dump dir, never subdirectories.
# File names are our own YYYYMMDD-HHMMSS.dump stamps (no spaces/strange chars).
# (basename per hit keeps this portable across GNU/BSD find — no -printf.)
FILELIST="$(mktemp)"
trap 'rm -f "$FILELIST"' EXIT
find "$BACKUPDIR" -maxdepth 1 -type f -name '*.dump' -mtime +"$AGEDAYS" -exec basename {} \; 2>/dev/null | sort > "$FILELIST" || true

COUNT="$(wc -l < "$FILELIST" | tr -d ' ')"
if [ "$COUNT" -eq 0 ]; then
  log "no local dumps older than $AGEDAYS days — nothing to archive."
  log "cold archive listing:"
  rclone lsl "$R2COLD" 2>/dev/null || log "(remote cold archive empty or unreachable)"
  exit 0
fi

log "dumps older than $AGEDAYS days to archive: $COUNT"
sed 's/^/  /' "$FILELIST"

if [ "$DRYRUN" -eq 1 ]; then
  log "DRY RUN — would copy them to $R2COLD, verify, then delete the local copies."
  rclone copy "$BACKUPDIR" "$R2COLD" --files-from "$FILELIST" --size-only --dry-run
  exit 0
fi

#--- verified move: copy -> check -> delete --------------------------------------------

log "1/3 copying to $R2COLD ..."
rclone copy "$BACKUPDIR" "$R2COLD" --files-from "$FILELIST" --size-only

log "2/3 verifying with rclone check (size-only: multipart R2 etags are not plain md5) ..."
# --size-only   : robust for R2 (etag != md5 for multipart uploads)
# --files-from  : compare ONLY the files we just uploaded
if ! rclone check "$BACKUPDIR" "$R2COLD" --files-from "$FILELIST" --size-only; then
  die "rclone check FAILED — remote copies do not match. Local files were NOT deleted."
fi
log "verification OK."

log "3/3 deleting verified local copies ..."
while IFS= read -r f; do
  [ -n "$f" ] || continue
  rm -f -- "$BACKUPDIR/$f"
  printf '%s\t%s\tarchived to %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$f" "$R2COLD" >> "$BACKUPDIR/manifest.log"
done < "$FILELIST"

#--- archive listing --------------------------------------------------------------------

log "cold archive contents ($R2COLD):"
rclone lsl "$R2COLD" || die "could not list $R2COLD"

TOTAL="$(rclone lsl "$R2COLD" 2>/dev/null | wc -l | tr -d ' ')"
log "archived $COUNT dump(s); cold archive now holds ${TOTAL} object(s)."
log "done."
