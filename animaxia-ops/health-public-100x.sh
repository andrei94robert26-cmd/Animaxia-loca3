#!/usr/bin/env bash
# health-public-100x.sh — FAZA 31 (PLAN 100X): suita zilnică de sănătate publică.
#
# Rulează întregul lanț de validare în ordine (oprire la primul eșec cu --strict):
#   1. faza28-e-verify.sh      — lanț public complet, zero 502 (40 checks)
#   2. smoke-hubs.mjs          — hub APIs FAZA 20 (35 checks)
#   3. smoke-faza21.mjs        — istoric/playlists/stats FAZA 21 (43 checks)
#   4. smoke-searchaccel.mjs   — strat accelerare FAZA 29-P (11 checks)
#   5. SLO FAZA 30             — tracker activ + buget neconsumat
#   6. Alerte infra FAZA 23    — fără CRITICAL/WARNING active pe infra
#
# Jurnal: /home/z/faza28-runtime/logs/health-public-100x.log
# Ieșire: 0 = totul verde · 1 = cel puțin o suită a picat
set -u

ROOT="/home/z/my-project"
BACKEND="$ROOT/mini-services/animaxia-backend"
LOG_DIR="/home/z/faza28-runtime/logs"
LOG_FILE="$LOG_DIR/health-public-100x-$(date -u +%Y%m%d).log"
STRICT="${1:-}"
mkdir -p "$LOG_DIR"

pass=0; fail=0
section() { echo -e "\n===== $1 =====" | tee -a "$LOG_FILE"; }
run_suite() {
  local name="$1"; shift
  section "$name"
  if "$@" >> "$LOG_FILE" 2>&1; then
    echo "✅ $name — PASSED" | tee -a "$LOG_FILE"; pass=$((pass+1))
  else
    echo "❌ $name — FAILED (detalii: $LOG_FILE)" | tee -a "$LOG_FILE"; fail=$((fail+1))
    [ "$STRICT" = "--strict" ] && { echo "STOP (strict mode)" | tee -a "$LOG_FILE"; exit 1; }
  fi
}

echo "health-public-100x · pornire $(date -u +%FT%TZ)" | tee "$LOG_FILE"

# 1-4: suitele de regresie
run_suite "1/6 lanț public FAZA 28-E (40 checks)" bash "$ROOT/animaxia-ops/faza28-e-verify.sh"
run_suite "2/6 hub APIs FAZA 20 (35 checks)" bun "$BACKEND/tests/smoke-hubs.mjs"
run_suite "3/6 istoric/playlists FAZA 21 (43 checks)" bun "$BACKEND/tests/smoke-faza21.mjs"
run_suite "4/6 accelerare FAZA 29-P (11 checks)" bun "$BACKEND/tests/smoke-searchaccel.mjs"

# 5: tracker SLO FAZA 30 activ și buget sănătos
section "5/6 SLO FAZA 30"
if curl -s -m 10 -o /tmp/slo-check.json "http://127.0.0.1:81/slo-status.json" && \
   python3 -c "
import json, sys
d = json.load(open('/tmp/slo-check.json'))
assert d['errorBudget']['status'] in ('ok', 'warming', 'at-risk'), f\"buget SLO: {d['errorBudget']['status']}\"
assert d['samples']['window'] > 0, 'tracker fără probe'
print('SLO ok:', d['availability'], 'buget folosit:', d['errorBudget']['used'])
" >> "$LOG_FILE" 2>&1; then
  echo "✅ 5/6 SLO FAZA 30 — PASSED" | tee -a "$LOG_FILE"; pass=$((pass+1))
else
  echo "❌ 5/6 SLO FAZA 30 — FAILED" | tee -a "$LOG_FILE"; fail=$((fail+1))
fi

# 6: alerte infra — fără CRITICALE/WARNING active (cele două alerte „cunoscute" oneste
#    legate de latența brută FTS sunt raportate informativ, nu ca eșec — vezi runbook)
section "6/6 Alerte infra FAZA 23"
if curl -s -m 10 "http://127.0.0.1:4050/api/alerts" | python3 -c "
import json, sys
d = json.load(sys.stdin)
firing = [r for r in d.get('rules', []) if r.get('state') == 'firing']
critical = [r for r in firing if r.get('severity') == 'critical']
if critical:
    print('CRITICAL ACTIVE:', [r['id'] for r in critical]); sys.exit(1)
known = {'animaxia-fts-latency-high'}  # onest, documentat în runbook (poarta ⚠️)
newly = [r['id'] for r in firing if r['id'] not in known]
if newly:
    print('WARNING NOI ACTIVE:', newly); sys.exit(1)
print('infra verzi; cunoscute-oneste:', [r['id'] for r in firing])
" >> "$LOG_FILE" 2>&1; then
  echo "✅ 6/6 Alerte infra — PASSED" | tee -a "$LOG_FILE"; pass=$((pass+1))
else
  echo "❌ 6/6 Alerte infra — FAILED" | tee -a "$LOG_FILE"; fail=$((fail+1))
fi

echo -e "\nREZULTAT health-public-100x: $pass PASSED / $fail FAILED · $(date -u +%FT%TZ)" | tee -a "$LOG_FILE"
[ "$fail" -gt 0 ] && exit 1
exit 0
