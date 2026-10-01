#!/usr/bin/env bash
#===============================================================================
# disaster-recovery/scripts/failover-readonly.sh
#
# Switch the running Animaxia cluster to the Neon READ REPLICA (read-only
# degraded mode, RTO <= 10 min) by patching the DATABASEURL in the k8s secret
# and rolling every deployment.
#
# Usage:
#   bash disaster-recovery/scripts/failover-readonly.sh <replica-connection-string>
#   READREPLICAURL=... bash disaster-recovery/scripts/failover-readonly.sh
#   bash disaster-recovery/scripts/failover-readonly.sh <url> --dry-run
#
# Options:
#   <url>        replica connection string (overrides READREPLICAURL env/.env)
#   --dry-run    print the exact commands instead of executing them
#   --yes        skip the interactive kubectl-context confirmation
#
# Environment:
#   READREPLICAURL  replica connection string (checked after the positional arg,
#                   then the repo .env)
#   NAMESPACE       k8s namespace (default: animaxia)
#   SECRETNAME      secret holding DATABASEURL (default: animaxia-secrets)
#
# Pre-checks performed:
#   - kubectl present, current context printed (and confirmed interactively)
#   - target secret exists in the namespace
#   - URL looks like a postgres:// connection string
#
# Docker-compose (non-k8s) fallback — no kubectl involved:
#   1. edit DATABASEURL in the repo-root .env (point it at the replica)
#   2. docker compose -f deploy/docker/docker-compose.yml up -d --force-recreate
#      (or: docker compose ... restart  — env_file is only read on recreate)
#   3. verify: curl -fsS http://localhost:8080/api/health
#   Roll back by restoring the original DATABASEURL line and recreating again.
#===============================================================================
set -euo pipefail

SCRIPTDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPOROOT="$(cd "$SCRIPTDIR/../.." && pwd)"
ENVFILE="$REPOROOT/.env"

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
log() { printf '[failover-readonly] %s\n' "$*"; }

envval() {
  local key="$1" default="${2:-}" line
  [ -f "$ENVFILE" ] || { printf '%s' "$default"; return 0; }
  line="$(sed -n -E "s/^[[:space:]]*${key}[[:space:]]*=[[:space:]]*//p" "$ENVFILE" | tail -n 1 || true)"
  line="${line%$'\r'}"
  line="${line%\"}"; line="${line#\"}"
  line="${line%\'}"; line="${line#\'}"
  printf '%s' "${line:-$default}"
}

#--- args ---------------------------------------------------------------------------

REPLICA=""
DRYRUN=0
ASSUMEYES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRYRUN=1; shift ;;
    --yes|-y)  ASSUMEYES=1; shift ;;
    -h|--help) sed -n '2,35p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*)        die "unknown option: $1" ;;
    *)         [ -z "$REPLICA" ] || die "unexpected extra argument: $1"; REPLICA="$1"; shift ;;
  esac
done

NAMESPACE="${NAMESPACE:-animaxia}"
SECRETNAME="${SECRETNAME:-animaxia-secrets}"

[ -n "$REPLICA" ] || REPLICA="${READREPLICAURL:-$(envval READREPLICAURL)}"
[ -n "$REPLICA" ] || die "no replica URL given. Pass it as an argument, or set READREPLICAURL (env or .env)."

case "$REPLICA" in
  postgres://*|postgresql://*) : ;;
  *) die "READREPLICAURL does not look like a postgres connection string: $REPLICA" ;;
esac

# JSON-escape the URL for the secret patch payload (quotes + backslashes only —
# connection strings never legitimately contain either, but be safe anyway).
jsonesc() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  printf '%s' "$s"
}
REPLICAJSON="$(jsonesc "$REPLICA")"
PATCH="{\"stringData\":{\"DATABASEURL\":\"$REPLICAJSON\"}}"

#--- pre-checks ---------------------------------------------------------------------

if ! command -v kubectl >/dev/null 2>&1; then
  die "kubectl not found in PATH. Non-k8s (docker compose) fallback is documented in this file's header."
fi

CONTEXT="$(kubectl config current-context 2>/dev/null || echo "<unknown>")"
log "kubectl context: $CONTEXT"
log "namespace      : $NAMESPACE"
log "target secret  : $SECRETNAME"

if ! kubectl -n "$NAMESPACE" get secret "$SECRETNAME" >/dev/null 2>&1; then
  die "secret $NAMESPACE/$SECRETNAME not found — wrong namespace/cluster? (set NAMESPACE=... to override)"
fi

if [ "$DRYRUN" -ne 1 ] && [ "$ASSUMEYES" -ne 1 ]; then
  printf '\n[failover-readonly] About to point ALL deployments in %s at:\n' "$NAMESPACE"
  printf '[failover-readonly]   %s\n' "$(printf '%s' "$REPLICA" | sed -E 's#^[a-z]+://[^@]*@#<credentials>@#')"
  printf '[failover-readonly] Read-only degraded mode starts after the rollout restart.\n'
  printf '[failover-readonly] Continue? [y/N] '
  read -r ANSWER
  case "$ANSWER" in
    y|Y|yes|YES) : ;;
    *) log "aborted (no changes made)."; exit 0 ;;
  esac
fi

#--- act ----------------------------------------------------------------------------

if [ "$DRYRUN" -eq 1 ]; then
  log "DRY RUN — the following would be executed:"
  printf '  kubectl -n %s patch secret %s --type merge -p %s\n' "$NAMESPACE" "$SECRETNAME" "$PATCH"
  printf '  kubectl -n %s rollout restart deployment\n' "$NAMESPACE"
  printf '  kubectl -n %s rollout status deploy/gateway-service --timeout=180s\n' "$NAMESPACE"
  exit 0
fi

log "patching secret $NAMESPACE/$SECRETNAME (DATABASEURL -> replica) ..."
kubectl -n "$NAMESPACE" patch secret "$SECRETNAME" --type merge -p "$PATCH"

log "rolling out restart of every deployment in $NAMESPACE ..."
kubectl -n "$NAMESPACE" rollout restart deployment

log "waiting for the gateway rollout (Ctrl-C to skip; the rest keeps rolling) ..."
kubectl -n "$NAMESPACE" rollout status deploy/gateway-service --timeout=180s || \
  printf '[failover-readonly] WARNING: gateway rollout not clean within 180s — check: kubectl -n %s get pods\n' "$NAMESPACE" >&2

#--- post-checks --------------------------------------------------------------------

log "gateway health via port-forward (run in another shell if this hangs):"
printf '  kubectl -n %s port-forward deploy/gateway-service 8080:8080\n' "$NAMESPACE"
printf '  curl -fsS http://localhost:8080/api/health\n'
printf '\n[failover-readonly] READ-ONLY DEGRADED MODE is live once pods report 1/1.\n'
printf '[failover-readonly] Expect write endpoints (auth login, social posts, premium checkout, queue enqueues)\n'
printf '[failover-readonly] to fail or return errors — reads (content, search, analytics dashboards) keep working.\n'
printf '[failover-readonly] Roll BACK to the primary by re-running with the original DATABASEURL,\n'
printf '[failover-readonly] or follow PLAN.md §6.2 (return-to-primary) when the primary is healthy again.\n'
