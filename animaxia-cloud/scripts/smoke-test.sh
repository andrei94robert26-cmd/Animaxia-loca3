#!/usr/bin/env bash
#===============================================================================
# scripts/smoke-test.sh — end-to-end smoke test of the running platform
# (bun run smoke). Assumes dev-up.sh (or docker compose / k8s port-forward)
# already brought the services up on their default ports.
#
# Checks:
#   1. gateway GET /api/health        -> 200 + "status" field (aggregated fan-out)
#   2. every service GET /health      -> 200 + "status" field (direct ports)
#   3. gateway GET /api/all?page=1&limit=1 -> 200 + JSON with data/total
#   4. GET /metrics on 2 services     -> animaxia_http_requests_total present
#      (gateway + auth-service by default; override with METRICSHOSTS="a:b")
#   5. queue GET /api/queue/stats     -> 200 + JSON with status/pending counts
#
# Phase-3 mid-build behavior: services whose services/<name>/ folder does not
# exist yet are marked SKIP (yellow, not a failure) — mirroring
# scripts/verify-syntax.mjs. Once all 10 folders exist, every service is a hard
# test. A service whose folder EXISTS but is down/ill counts as FAIL.
#
# Exit code: 0 = all PASS (SKIPs allowed) · 1 = any FAIL.
#===============================================================================
set -euo pipefail

SCRIPTDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPOROOT="$(cd "$SCRIPTDIR/.." && pwd)"
ENVFILE="$REPOROOT/.env"

log() { printf '[smoke] %s\n' "$*"; }

envval() {
  local key="$1" default="${2:-}" line
  [ -f "$ENVFILE" ] || { printf '%s' "$default"; return 0; }
  line="$(sed -n -E "s/^[[:space:]]*${key}[[:space:]]*=[[:space:]]*//p" "$ENVFILE" | tail -n 1 || true)"
  line="${line%$'\r'}"
  printf '%s' "${line:-$default}"
}

#--- colors ----------------------------------------------------------------------------

GREEN='' RED='' YELLOW='' BOLD='' RESET=''
if [ -t 1 ] && [ -z "${NOCOLOR:-}" ]; then
  GREEN=$'\033[32m'; RED=$'\033[31m'; YELLOW=$'\033[33m'; BOLD=$'\033[1m'; RESET=$'\033[0m'
fi
PASSC() { printf '%sPASS%s' "$GREEN" "$RESET"; }
FAILC() { printf '%sFAIL%s' "$RED" "$RESET"; }
SKIPC() { printf '%sSKIP%s' "$YELLOW" "$RESET"; }

#--- registry (BLUEPRINT §2) --------------------------------------------------------

GATEWAYPORT="$(envval GATEWAYPORT 8080)"
GATEWAY="http://localhost:$GATEWAYPORT"

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

# Metrics endpoints to probe: gateway + auth-service unless overridden
# (METRICSHOSTS format: "name:port name:port")
METRICSHOSTS="${METRICSHOSTS:-gateway-service:$GATEWAYPORT auth-service:$(envval AUTHPORT 4001)}"

PASS=0; FAIL=0; SKIP=0
RESULTROWS=()

record() { # record NAME STATUS DETAIL
  RESULTROWS+=("$1|$2|$3")
  case "$2" in
    PASS) PASS=$((PASS + 1)) ;;
    FAIL) FAIL=$((FAIL + 1)) ;;
    SKIP) SKIP=$((SKIP + 1)) ;;
  esac
}

svcport() { # svcport "name:PORTENV:default"
  local entry="$1"
  local name="${entry%%:*}"; local rest="${entry#*:}"
  local portenv="${rest%%:*}"; local defport="${rest##*:}"
  envval "$portenv" "$defport"
}

#--- 1. gateway aggregated health -----------------------------------------------------

log "1/5 gateway aggregated health: GET $GATEWAY/api/health"
BODY="$(curl -fsS -m 10 "$GATEWAY/api/health" 2>&1)" \
  && case "$BODY" in *status*) record "gateway /api/health" PASS "200 + status field";; \
       *) record "gateway /api/health" FAIL "200 but no status field: $(printf '%s' "$BODY" | head -c 120)";; esac \
  || record "gateway /api/health" FAIL "request failed: $(printf '%s' "$BODY" | head -c 120)"

#--- 2. per-service direct /health ----------------------------------------------------

log "2/5 direct /health per service"
for entry in "${SERVICES[@]}"; do
  name="${entry%%:*}"
  port="$(svcport "$entry")"
  if [ ! -f "$REPOROOT/services/$name/server.js" ]; then
    record "$name /health (:$port)" SKIP "service folder not scaffolded yet"
    continue
  fi
  BODY="$(curl -fsS -m 5 "http://localhost:$port/health" 2>&1)" \
    && case "$BODY" in *status*) record "$name /health (:$port)" PASS "200 + status field";; \
         *) record "$name /health (:$port)" FAIL "200 but no status field";; esac \
    || record "$name /health (:$port)" FAIL "not reachable on :$port"
done

#--- 3. content list through the gateway ------------------------------------------------

log "3/5 content through the gateway: GET $GATEWAY/api/all?page=1&limit=1"
BODY="$(curl -fsS -m 10 "$GATEWAY/api/all?page=1&limit=1" 2>&1)" \
  && case "$BODY" in
       *total*|*data*) record "gateway /api/all" PASS "200 + data/total payload";;
       *) record "gateway /api/all" FAIL "200 but unexpected payload: $(printf '%s' "$BODY" | head -c 120)";;
     esac \
  || record "gateway /api/all" FAIL "request failed: $(printf '%s' "$BODY" | head -c 120)"

#--- 4. /metrics on two services ----------------------------------------------------------

log "4/5 Prometheus /metrics on: $METRICSHOSTS"
for host in $METRICSHOSTS; do
  name="${host%%:*}"
  port="${host##*:}"
  if [ ! -f "$REPOROOT/services/$name/server.js" ]; then
    record "$name /metrics (:$port)" SKIP "service folder not scaffolded yet"
    continue
  fi
  BODY="$(curl -fsS -m 5 "http://localhost:$port/metrics" 2>&1)" \
    && case "$BODY" in
         *animaxia_http_requests_total*) record "$name /metrics (:$port)" PASS "animaxia_http_requests_total present";;
         *) record "$name /metrics (:$port)" FAIL "metrics body missing animaxia_http_requests_total";;
       esac \
    || record "$name /metrics (:$port)" FAIL "not reachable on :$port"
done

#--- 5. queue stats via the gateway --------------------------------------------------------

log "5/5 queue stats: GET $GATEWAY/api/queue/stats"
BODY="$(curl -fsS -m 10 "$GATEWAY/api/queue/stats" 2>&1)" \
  && case "$BODY" in
       *byStatus*|*byType*|*deadLetters*) record "gateway /api/queue/stats" PASS "200 + queue stats payload";;
       *) record "gateway /api/queue/stats" FAIL "200 but unexpected payload: $(printf '%s' "$BODY" | head -c 120)";;
     esac \
  || record "gateway /api/queue/stats" FAIL "request failed (queue-service up? gateway route mounted?): $(printf '%s' "$BODY" | head -c 120)"

#--- report ----------------------------------------------------------------------------------

printf '\n%s%-34s %-6s %s%s\n' "$BOLD" "CHECK" "RESULT" "DETAIL" "$RESET"
for row in "${RESULTROWS[@]}"; do
  IFS='|' read -r name status detail <<< "$row"
  case "$status" in
    PASS) STATUSCOL="$(PASSC)" ;;
    FAIL) STATUSCOL="$(FAILC)" ;;
    *)    STATUSCOL="$(SKIPC)" ;;
  esac
  printf '%-34s %-6s %s\n' "$name" "$STATUSCOL" "$detail"
done

printf '\n'
if [ "$FAIL" -gt 0 ]; then
  printf '%sSMOKE: FAIL%s  (%d passed, %s%d failed%s, %d skipped)\n' "$RED" "$RESET" "$PASS" "$RED" "$FAIL" "$RESET" "$SKIP"
  printf 'Check per-service logs: logs/<name>.log  · gateway view: %s/api/gateway/stats\n' "$GATEWAY"
  exit 1
fi
if [ "$SKIP" -gt 0 ]; then
  printf '%sSMOKE: PASS (with skips)%s  (%d passed, 0 failed, %d skipped — services not scaffolded yet)\n' "$YELLOW" "$RESET" "$PASS" "$SKIP"
else
  printf '%sSMOKE: PASS%s  (%d passed, 0 failed, 0 skipped)\n' "$GREEN" "$RESET" "$PASS"
fi
exit 0
