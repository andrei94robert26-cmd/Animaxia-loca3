#!/usr/bin/env bash
#===============================================================================
# disaster-recovery/scripts/backup-neon.sh
#
# Nightly logical backup of the Neon Postgres database (DATABASEURL from the
# repo-root .env) into a portable PostgreSQL custom-format dump.
#
# Usage:
#   bash disaster-recovery/scripts/backup-neon.sh
#
# Configuration (process env wins over the repo .env; both optional except
# DATABASEURL):
#   DATABASEURL  required — Neon connection string. Pooled (-pooler) URLs are
#                fine; libpq params that upset pg_dump (channel_binding, and
#                options=... channel_binding) are stripped safely, see the sed
#                note in clean_url() below.
#   BACKUPKEEP   optional — how many dumps to keep locally (default 14).
#   R2REMOTE     optional — rclone remote to offload every dump to, e.g.
#                r2:animaxia-media/backups. Offload runs only when rclone is
#                installed; otherwise a warning is printed (the local dump is
#                still kept and the script still exits 0).
#
# Output:
#   disaster-recovery/backups/YYYYMMDD-HHMMSS.dump   pg_dump --format=custom
#   disaster-recovery/backups/latest                 pointer file (dump name)
#   disaster-recovery/backups/manifest.log           one line per dump
#
# Cron example (02:00 nightly — the log lives next to the dumps):
#   0 2 * * * cd /opt/animaxia-cloud && bash disaster-recovery/scripts/backup-neon.sh \
#             >> disaster-recovery/backups/cron.log 2>&1
#===============================================================================
set -euo pipefail

SCRIPTDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPOROOT="$(cd "$SCRIPTDIR/../.." && pwd)"
BACKUPDIR="$REPOROOT/disaster-recovery/backups"
ENVFILE="$REPOROOT/.env"

#--- helpers -------------------------------------------------------------------

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
log() { printf '[backup-neon] %s\n' "$*"; }

# envval KEY [DEFAULT] — extract ONE value from the house .env WITHOUT sourcing
# it. The .env contains decorative banner lines ("======", prose) that are NOT
# valid shell, so `source .env` would explode; grepping a single KEY= line is
# safe (no eval, no arbitrary code execution). Strips CR and surrounding quotes.
envval() {
  local key="$1" default="${2:-}" line
  [ -f "$ENVFILE" ] || { printf '%s' "$default"; return 0; }
  line="$(sed -n -E "s/^[[:space:]]*${key}[[:space:]]*=[[:space:]]*//p" "$ENVFILE" | tail -n 1 || true)"
  line="${line%$'\r'}"
  line="${line%\"}"; line="${line#\"}"
  line="${line%\'}"; line="${line#\'}"
  printf '%s' "${line:-$default}"
}

# clean_url URL — make a Neon connection string safe for pg_dump/pg_restore.
#
# sed note: Neon pooled strings sometimes carry `channel_binding=require` (or
# an options= param embedding it URL-encoded). Some client builds reject the
# parameter outright. We surgically remove ONLY channel_binding-ish params and
# leave everything else (sslmode, connect_timeout, ...) untouched:
#   ...?sslmode=require&channel_binding=require   -> ...?sslmode=require
#   ...?channel_binding=require&sslmode=require   -> ...?sslmode=require
#   ...?options=--channel_binding%3Drequire&x=1   -> ...?x=1
clean_url() {
  printf '%s' "$1" | sed -E \
    -e 's/([?&])options=[^&]*channel_binding[^&]*&/\1/g' \
    -e 's/[?&]options=[^&]*channel_binding[^&]*$//' \
    -e 's/([?&])channel_binding=[^&]*&/\1/g' \
    -e 's/[?&]channel_binding=[^&]*$//' \
    -e 's/\?$//'
}

#--- configuration --------------------------------------------------------------

if [ ! -f "$ENVFILE" ]; then
  die "no .env found at $ENVFILE — copy .env.example to .env and set DATABASEURL first."
fi

DATABASEURL="${DATABASEURL:-$(envval DATABASEURL)}"
[ -n "$DATABASEURL" ] || die "DATABASEURL is not set (neither in the environment nor in .env)."

BACKUPKEEP="${BACKUPKEEP:-$(envval BACKUPKEEP 14)}"
case "$BACKUPKEEP" in (*[!0-9]*|'') die "BACKUPKEEP must be a positive integer, got '$BACKUPKEEP'.";; esac
[ "$BACKUPKEEP" -ge 1 ] || die "BACKUPKEEP must be >= 1."

R2REMOTE="${R2REMOTE:-$(envval R2REMOTE)}"

#--- pre-flight ------------------------------------------------------------------

if ! command -v pg_dump >/dev/null 2>&1; then
  cat >&2 <<'EOF'
ERROR: pg_dump not found in PATH — the PostgreSQL client tools are required.

Install hint:
  Debian/Ubuntu : sudo apt-get install -y postgresql-client
  Alpine        : apk add postgresql-client   (or postgresql16-client)
  macOS (brew)  : brew install libpq && brew link --force libpq
  Fedora/RHEL   : sudo dnf install -y postgresql
  Docker escape : docker run --rm -v "$PWD":/wd postgres:16-alpine \
                    pg_dump ... (run from the dump directory)
EOF
  exit 1
fi

log "pg_dump version: $(pg_dump --version)"

CONNECTION="$(clean_url "$DATABASEURL")"
# Never log credentials: print only the host part.
log "target host: $(printf '%s' "$CONNECTION" | sed -E 's#^[a-z]+://[^@]*@#<credentials>@#')"

#--- dump ------------------------------------------------------------------------

mkdir -p "$BACKUPDIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$BACKUPDIR/$STAMP.dump"

log "running pg_dump -> $(basename "$OUT") ..."
SECONDS=0
# --format=custom     : compressed, pg_restore-able, selective restore capable
# --no-owner          : dump omits ownership (restores cleanly into any role)
# --no-privileges     : dump omits GRANT/REVOKE (avoids role mismatch errors)
if ! pg_dump --format=custom --no-owner --no-privileges --file "$OUT" "$CONNECTION"; then
  rm -f "$OUT"
  die "pg_dump failed (see output above). Connection string issues? See clean_url() notes."
fi
ELAPSED="$SECONDS"

[ -s "$OUT" ] || { rm -f "$OUT"; die "pg_dump produced an empty file — refusing to record it as a backup."; }
SIZE="$(wc -c < "$OUT" | tr -d ' ')"
SHA256="-"
if command -v sha256sum >/dev/null 2>&1; then
  SHA256="$(sha256sum "$OUT" | awk '{print $1}')"
fi

#--- optional R2 offload (before the manifest so the log records the truth) -----

R2STATE="-"
if [ -n "$R2REMOTE" ]; then
  if command -v rclone >/dev/null 2>&1; then
    log "offloading to $R2REMOTE ..."
    if rclone copyto "$OUT" "$R2REMOTE/$STAMP.dump"; then
      R2STATE="ok"
      log "offload complete: $R2REMOTE/$STAMP.dump"
    else
      # The local dump is fine — but an offbox copy is the whole point of R2,
      # so fail loudly so cron/monitoring picks it up.
      die "rclone copyto failed — local dump kept at $OUT, but NO offsite copy exists."
    fi
  else
    printf '[backup-neon] WARNING: R2REMOTE is set but rclone is not installed — dump kept locally only.\n' >&2
    printf '[backup-neon]          Install rclone: https://rclone.org/install/ (see cold-archive.sh header for R2 config).\n' >&2
    R2STATE="rclone-missing"
  fi
fi

#--- pointers + manifest ----------------------------------------------------------

printf '%s\n' "$STAMP.dump" > "$BACKUPDIR/latest"
printf '%s\t%s\t%s bytes\t%s\t%s\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$STAMP.dump" "$SIZE" "$SHA256" "$R2STATE" \
  >> "$BACKUPDIR/manifest.log"

#--- prune local copies ------------------------------------------------------------

# Dump names are our own YYYYMMDD-HHMMSS.dump stamps, so a name sort IS a time
# sort — no need to stat every file.
shopt -s nullglob
mapfile -t ALLDUMPS < <(printf '%s\n' "$BACKUPDIR"/*.dump | sort -r)
PRUNED=0
if [ "${#ALLDUMPS[@]}" -gt "$BACKUPKEEP" ]; then
  for f in "${ALLDUMPS[@]:$BACKUPKEEP}"; do
    rm -f -- "$f"
    PRUNED=$((PRUNED + 1))
  done
fi
KEEPNOW=$(( ${#ALLDUMPS[@]} - PRUNED ))

#--- summary ------------------------------------------------------------------------

printf '\n'
log "SUMMARY ------------------------------------------------------------------"
log "dump      : $STAMP.dump ($SIZE bytes)"
log "sha256    : $SHA256"
log "duration  : ${ELAPSED}s"
log "local     : $BACKUPDIR ($KEEPNOW kept, $PRUNED pruned, BACKUPKEEP=$BACKUPKEEP)"
log "pointer   : $(cat "$BACKUPDIR/latest")"
if [ -n "$R2REMOTE" ]; then log "offsite   : $R2REMOTE [$R2STATE]"; fi
log "restore   : bash disaster-recovery/scripts/restore-neon.sh --latest --into '<NEW-NEON-URL>'"
log "verify    : bash disaster-recovery/scripts/verify-restore.sh --into '<NEW-NEON-URL>'"
log "---------------------------------------------------------------------------"
