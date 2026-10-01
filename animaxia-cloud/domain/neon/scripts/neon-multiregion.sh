#!/usr/bin/env bash
# =============================================================================
# animaxia-neon-multiregion.sh — Neon read-replica provisioning (FAZA 22)
# =============================================================================
# HONESTY: Neon does NOT offer native cross-region replication. This script
# provisions the part Neon DOES support natively — a read-only branch + a
# read_only endpoint in the PRIMARY region — and prints the plan for the
# us/asia logical-replication targets (separate regional PostgreSQL
# instances fed by Neon logical replication; see ../README.md).
#
# SAFETY MODEL:
#   • Default mode is --dry-run: it prints every curl command it WOULD run
#     and exits 0 WITHOUT touching the network (works with no NEON_API_KEY).
#   • --apply is required to execute anything for real; it additionally
#     requires NEON_API_KEY and NEON_PROJECT_ID to be set.
#
# Usage:
#   bash scripts/neon-multiregion.sh --dry-run          # plan only (no network)
#   NEON_API_KEY=… NEON_PROJECT_ID=… \
#     bash scripts/neon-multiregion.sh --apply          # create for real
#
# Actions when applied:
#   1. list endpoints       GET  /v2/projects/<id>/endpoints
#   2. create read branch   POST /v2/projects/<id>/branches
#      { branch: { name: "read-replica-eu", parent_id: "main" } }
#   3. create read endpoint POST /v2/projects/<id>/endpoints
#      { endpoint: { branch_id: <new branch>, type: "read_only" } }
# =============================================================================
set -euo pipefail

# --- configuration ------------------------------------------------------------

API_BASE="https://api.neon.tech/v2"
BRANCH_NAME="read-replica-eu"
BRANCH_PARENT="main"
ENDPOINT_TYPE="read_only"

MODE="dry-run"
for arg in "$@"; do
  case "$arg" in
    --dry-run) MODE="dry-run" ;;
    --apply)   MODE="apply" ;;
    *) echo "unknown flag: $arg (supported: --dry-run | --apply)" >&2; exit 2 ;;
  esac
done

# --- helpers ------------------------------------------------------------------

# run METHOD URL [JSON_BODY] — executes the call in --apply mode; in dry-run
# mode prints the exact curl command it WOULD run. The Authorization header is
# never expanded into the printed plan (dry-run needs no NEON_API_KEY at all).
run() {
  local method="$1"
  local url="$2"
  local data="${3:-}"
  if [[ "$MODE" == "apply" ]]; then
    if [[ -n "$data" ]]; then
      curl -sS -X "$method" "$url" \
        -H "Authorization: Bearer ${NEON_API_KEY}" \
        -H "Content-Type: application/json" \
        -d "$data"
    else
      curl -sS -X "$method" "$url" \
        -H "Authorization: Bearer ${NEON_API_KEY}" \
        -H "Content-Type: application/json"
    fi
  else
    printf '  curl -sS -X %s %s \\\n' "$method" "$url"
    printf '    -H "Authorization: Bearer $NEON_API_KEY" \\\n'
    printf '    -H "Content-Type: application/json"'
    if [[ -n "$data" ]]; then
      printf ' \\\n    -d %s' "'$data'"
    fi
    printf '\n'
  fi
}

# --- preflight ----------------------------------------------------------------

if [[ "$MODE" == "apply" ]]; then
  if [[ -z "${NEON_API_KEY:-}" ]]; then
    echo "ERROR: --apply requires NEON_API_KEY in the environment." >&2
    echo "       Get one from the Neon console (Account → API keys)." >&2
    exit 1
  fi
  if [[ -z "${NEON_PROJECT_ID:-}" ]]; then
    echo "ERROR: --apply requires NEON_PROJECT_ID in the environment." >&2
    echo "       Find it in the Neon console (Project → Settings)." >&2
    exit 1
  fi
fi

# Dry-run works with no credentials at all — the placeholders below are only
# substituted for display; nothing is sent anywhere in dry-run mode.
PROJECT_ID="${NEON_PROJECT_ID:-<NEON_PROJECT_ID>}"

# --- plan ---------------------------------------------------------------------

echo "════════════════════════════════════════════════════════════════════════"
echo " Animaxia — Neon multi-region read scaling (mode: ${MODE})"
echo "════════════════════════════════════════════════════════════════════════"
echo
echo " HONEST SCOPE: Neon has NO native cross-region replication."
echo " This run provisions the eu read replica (branch + read_only endpoint)"
echo " in the PRIMARY region and documents the us/asia path: separate regional"
echo " PostgreSQL instances fed by Neon LOGICAL REPLICATION (pgoutput), wired"
echo " to the app through DATABASE_READ_REPLICA_URLS (read-router.config.json)."
echo
echo " Project:      ${PROJECT_ID}"
echo " Read branch:  ${BRANCH_NAME} (parent: ${BRANCH_PARENT})"
echo " Endpoint:     type=${ENDPOINT_TYPE}"
echo

echo "── 1. list current endpoints ────────────────────────────────────────────"
CURL_GET_URL="${API_BASE}/projects/${PROJECT_ID}/endpoints"
run GET "${CURL_GET_URL}"
echo

echo "── 2. create the read-replica branch ───────────────────────────────────"
BRANCH_BODY='{"branch":{"name":"'"${BRANCH_NAME}"'","parent_id":"'"${BRANCH_PARENT}"'"}}'
run POST "${API_BASE}/projects/${PROJECT_ID}/branches" "${BRANCH_BODY}"
echo "   → saves the new branch id as READ_BRANCH_ID (next step uses it)"
echo

echo "── 3. create the read_only endpoint on that branch ─────────────────────"
ENDPOINT_BODY='{"endpoint":{"branch_id":"<READ_BRANCH_ID>","type":"'"${ENDPOINT_TYPE}"'"}}'
run POST "${API_BASE}/projects/${PROJECT_ID}/endpoints" "${ENDPOINT_BODY}"
echo "   → the endpoint host joins DATABASE_READ_REPLICA_URLS (eu entry)"
echo

echo "── 4. us / asia (NOT executed — logical replication targets) ───────────"
echo "   These are SEPARATE regional PostgreSQL instances, fed from Neon via"
echo "   logical replication. One-time setup (documented, cross-provider):"
echo "     -- on the Neon primary:"
echo "        CREATE PUBLICATION animaxia_read_pub FOR ALL TABLES;"
echo "     -- on each regional target (us / asia):"
echo "        CREATE SUBSCRIPTION animaxia_<region>_sub"
echo "          CONNECTION 'host=<neon-primary> dbname=neondb sslmode=require'"
echo "          PUBLICATION animaxia_read_pub WITH (copy_data = true);"
echo "   pgoutput (built into Postgres 10+) is the protocol; wal2json is only"
echo "   needed if JSON change events are preferred."
echo

if [[ "$MODE" == "dry-run" ]]; then
  echo "DRY-RUN complete: nothing was sent, no API key was required."
  echo "Apply for real with: NEON_API_KEY=… NEON_PROJECT_ID=… $0 --apply"
else
  echo "APPLY mode selected — the curl calls above were executed."
fi
