#!/usr/bin/env bash
# slo-100x.sh — FAZA 30 (PLAN 100X): SLO tracker real 99.9% availability + soak continuu.
#
# Rulează la infinit (soak FAZA 30): sondează lanțul public la fiecare interval,
# calculează disponibilitatea rolling 24h pe fereastră glisantă de probe și
# bugetul de eroare SLO 99.9% (permite max 1.44 min indisponibilitate/24h),
# scrie stare persistentă în public/slo-status.json (consumabil de status-view)
# + jurnal în /home/z/faza28-runtime/logs/slo-100x.log.
#
# 100% aditiv: doar sondează endpoint-urile publice existente; nu modifică
# nicio componentă protejată. Se oprește cu kill $(cat slo-100x.pid).
set -u

INTERVAL_SEC="${SLO_INTERVAL_SEC:-30}"           # o sondă la 30s = 2880 probe/24h
WINDOW_SEC="${SLO_WINDOW_SEC:-86400}"            # fereastră rolling 24h
SLO_TARGET="${SLO_SLO_TARGET:-0.999}"            # 99.9%
STATE_FILE="${SLO_STATE_FILE:-/home/z/my-project/public/slo-status.json}"
HISTORY_FILE="/home/z/faza28-runtime/logs/slo-history.jsonl"
LOG_FILE="/home/z/faza28-runtime/logs/slo-100x.log"
PID_FILE="/home/z/faza28-runtime/slo-100x.pid"
BASE="${SLO_BASE_URL:-http://127.0.0.1:81}"

mkdir -p "$(dirname "$LOG_FILE")" "$(dirname "$STATE_FILE")"
echo $$ > "$PID_FILE"
log() { echo "[$(date -u +%FT%TZ)] $*" >> "$LOG_FILE"; }

log "SLO 100X tracker pornit (FAZA 30) · interval=${INTERVAL_SEC}s fereastră=${WINDOW_SEC}s SLO=${SLO_TARGET}"

# Probe: lanțul public complet (frontend + API hub prin gateway). O sondă =
# ambele cereri; succes doar dacă ambele întorc 200.
probe() {
  local fe api fe_code api_code
  fe_code=$(curl -s -o /dev/null -m 10 -w '%{http_code}' "$BASE/" 2>/dev/null || echo 000)
  api_code=$(curl -s -o /dev/null -m 10 -w '%{http_code}' "$BASE/api/hub/stats?XTransformPort=4040" 2>/dev/null || echo 000)
  if [ "$fe_code" = "200" ] && [ "$api_code" = "200" ]; then
    return 0
  fi
  echo "probe FAIL fe=$fe_code api=$api_code" >&2
  return 1
}

while true; do
  ts=$(date +%s)
  if probe; then
    echo "{\"ts\":$ts,\"ok\":1}" >> "$HISTORY_FILE"
  else
    echo "{\"ts\":$ts,\"ok\":0}" >> "$HISTORY_FILE"
    log "sondă EȘUATĂ la $ts"
  fi

  # Agregare fereastră glisantă (awk — fără dependențe)
  cutoff=$((ts - WINDOW_SEC))
  read -r total failed <<< "$(awk -v c="$cutoff" '$1 >= c' < "$HISTORY_FILE" 2>/dev/null | head -0; true)"
  total=$(wc -l < "$HISTORY_FILE" 2>/dev/null || echo 0)
  # recalculează doar liniile din fereastră
  inwin=$(awk -F'"ts":' '{print $2}' "$HISTORY_FILE" 2>/dev/null | awk -F',' -v c="$cutoff" '$1+0 >= c' | wc -l)
  failwin=$(awk -F'"ts":' '{print $2}' "$HISTORY_FILE" 2>/dev/null | awk -F'[,}]' -v c="$cutoff" '$1+0 >= c && /"ok":0/' | wc -l)

  if [ "$inwin" -gt 0 ]; then
    avail=$(awk -v t="$inwin" -v f="$failwin" 'BEGIN { printf "%.5f", (t-f)/t }')
    err_budget_used=$(awk -v t="$inwin" -v f="$failwin" -v s="$SLO_TARGET" 'BEGIN { e=(f/t); b=(1-s); if (b <= 0) print "0"; else { u=e/b; if (u>1) u=1; printf "%.4f", u } }')
    status="ok"; [ "$(awk -v u="$err_budget_used" 'BEGIN {print (u >= 1.0) ? 1 : 0}')" = "1" ] && status="breached"
    [ "$status" = "ok" ] && [ "$(awk -v u="$err_budget_used" 'BEGIN {print (u >= 0.75) ? 1 : 0}')" = "1" ] && status="at-risk"
  else
    avail="1.00000"; err_budget_used="0.0000"; status="warming"
  fi

  cat > "$STATE_FILE.tmp" <<EOF
{
  "phase": "FAZA 30 (PLAN 100X)",
  "slo": { "target": $SLO_TARGET, "windowSec": $WINDOW_SEC, "intervalSec": $INTERVAL_SEC },
  "availability": $avail,
  "errorBudget": { "used": $err_budget_used, "status": "$status" },
  "samples": { "window": $inwin, "failed": $failwin, "total": $total },
  "soakStartedAt": "$(date -u +%FT%TZ)",
  "updatedAt": "$(date -u +%FT%TZ)"
}
EOF
  mv "$STATE_FILE.tmp" "$STATE_FILE"

  # igienă: taie istoricul la 48h (2× fereastra)
  cutoff48=$((ts - 2 * WINDOW_SEC))
  awk -F'"ts":' -v c="$cutoff48" '{ if ($2+0 >= c || NR <= 0) print }' "$HISTORY_FILE" > "$HISTORY_FILE.tmp" 2>/dev/null && mv "$HISTORY_FILE.tmp" "$HISTORY_FILE"

  sleep "$INTERVAL_SEC"
done
