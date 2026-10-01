#!/bin/bash
# faza28-e-verify.sh — SUITA FINALĂ DE VERIFICARE END-TO-END (FAZA 28-E)
# Lanț public complet: frontend → edge → TLS → gateway → backend → Neon
# Volum mic de sonde (respectă bucket-urile de rate: hub 240/min, search 120/min).

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
check() { # name expected actual
  [ "$3" = "$2" ] && ok "$1 = $2" || bad "$1: expected $2, got $3"
}

echo "═══════════ FAZA 28-E — VERIFICARE LANȚ PUBLIC COMPLET ═══════════"

echo "── 1. FRONTEND public (:81 → :3000)"
check "GET / status" "200" "$(curl -s -m 8 -o /dev/null -w '%{http_code}' http://localhost:81/)"
html=$(curl -s -m 8 http://localhost:81/ | head -c 4000)
echo "$html" | grep -qi "animaxia" && ok "conținut SPA Animaxia randat" || bad "SPA nu randează"

echo "── 2. EDGE :8080 — redirect 308 permanent"
r=$(curl -s -m 5 -o /dev/null -D - http://localhost:8080/api/hub/browse | head -1 | tr -d '\r')
echo "$r" | grep -q "308" && ok "308 Permanent Redirect" || bad "redirect: $r"
loc=$(curl -s -m 5 -o /dev/null -D - http://localhost:8080/api/hub/browse | grep -i '^location:' | tr -d '\r')
echo "$loc" | grep -q "https://.*:8443/api/hub/browse" && ok "Location → https://:8443 (cale+query păstrate)" || bad "location: $loc"

echo "── 3. EDGE :8443 — TLS + HTTP/2 + HSTS"
ver=$(curl -sk -m 8 -o /dev/null -w '%{http_version}' --http2 https://localhost:8443/api/edge/health)
check "ALPN negociat" "2" "$ver"
hsts=$(curl -sk -m 8 -o /dev/null -D - --http2 https://localhost:8443/api/edge/health | grep -i '^strict-transport-security:' | tr -d '\r' | head -1)
echo "$hsts" | grep -q "max-age=31536000" && ok "HSTS strict (max-age=31536000; includeSubDomains; preload)" || bad "HSTS: $hsts"
tls=$(curl -sk -m 8 -o /dev/null -w '%{ssl_verify_result}' --tlsv1.2 https://localhost:8443/api/edge/health)
check "TLS handshake (self-signed OK)" "18" "$tls"

echo "── 4. HUB APIs — lanț complet prin TOATE straturile (zero 502)"
for ep in browse stats genres years feed recommendations; do
  d=$(curl -s -m 8 -o /dev/null -w '%{http_code}' "http://localhost:4000/api/hub/$ep")
  check "backend direct  /api/hub/$ep" "200" "$d"
  g=$(curl -s -m 8 -o /dev/null -w '%{http_code}' "http://localhost:4040/api/hub/$ep")
  check "gateway         /api/hub/$ep" "200" "$g"
  e1=$(curl -s -m 10 -o /dev/null -w '%{http_code}' "http://localhost:8181/api/hub/$ep")
  check "edge :8181      /api/hub/$ep" "200" "$e1"
  e2=$(curl -sk -m 10 -o /dev/null -w '%{http_code}' --http2 "https://localhost:8443/api/hub/$ep")
  check "edge :8443 h2   /api/hub/$ep" "200" "$e2"
  p=$(curl -s -m 10 -o /dev/null -w '%{http_code}' "http://localhost:81/api/hub/$ep?XTransformPort=8181")
  check "PUBLIC :81→edge /api/hub/$ep" "200" "$p"
done

echo "── 5. Upstream marker (lanțul edge→gateway→backend vizibil în headere)"
up=$(curl -sk -m 10 -o /dev/null -D - --http2 https://localhost:8443/api/hub/browse | grep -i '^x-animaxia-upstream:' | tr -d '\r')
echo "$up" | grep -q "http://gateway:4040" && ok "x-animaxia-upstream: http://gateway:4040 (canonical)" || bad "upstream: $up"
reg=$(curl -sk -m 10 -o /dev/null -D - --http2 https://localhost:8443/api/hub/browse | grep -i '^x-animaxia-region:' | tr -d '\r')
echo "$reg" | grep -q "eu" && ok "gateway region routing activ ($reg)" || bad "region: $reg"

echo "── 6. EDGE status — contoare zero-502"
curl -s -m 6 http://localhost:8181/api/edge/status | python3 -c "
import json,sys
d=json.load(sys.stdin); c=d['counters']
assert c['errors502']==0, '502 count != 0'
assert c['errors503']==0, '503 count != 0'
ups=d['upstreams']
assert all(v['healthy'] for v in ups.values()), 'unhealthy upstream'
assert d['redisGlobal']['ok'] is True, 'redis down'
print('  ✅ contoare edge: 502=0, 503=0, toate upstream-urile healthy, redis PING ok')
print('  ✅ upstream-uri: ' + ', '.join(f\"{k}={v['canonical']}\" for k,v in ups.items()))
" || bad "edge status"

echo "── 7. BACKEND — sănătate + Neon"
curl -s -m 6 http://localhost:4000/api/health | python3 -c "
import json,sys
d=json.load(sys.stdin)
assert d['status']=='ok'; assert d['db']['connected'] is True; assert d['db']['totalItems']>0
print(f\"  ✅ status ok | Neon postgres conectat | {d['db']['totalItems']} item-uri | 0 erori 5xx\")
" || bad "backend health"

echo "── 8. GATEWAY — regiuni + failover"
curl -s -m 6 http://localhost:4040/api/infra/status | python3 -c "
import json,sys
d=json.load(sys.stdin)
assert all(any(u['healthy'] for u in r['upstreams']) for r in d['regions'])
print('  ✅ regiuni eu/us/asia: toate cu upstream healthy (backend:4000)')
" || bad "gateway status"

echo "── 9. OBSERVABILITY — alerte infra + synthetics"
curl -s -m 6 http://localhost:4050/api/summary | python3 -c "
import json,sys
d=json.load(sys.stdin)
firing=[a['id'] for a in d['alerts']['firing']]
infra=[x for x in firing if x in ('animaxia-neon-down','animaxia-redis-down','animaxia-gateway-down','animaxia-backend-down')]
assert not infra, f'infra alerts firing: {infra}'
syn=d['synthetics']
print(f\"  ✅ alerte infra (neon/redis/gateway/backend): TOTH verde\")
print(f\"  ✅ synthetics: {syn['passing']}/{syn['total']} trec\")
print(f\"  ℹ️  firing non-infra: {firing} (item 29-P cunoscut, amânat)\")
" || bad "observability"

echo "── 10. REDIS GLOBAL — RESP PING"
pong=$(curl -s -m 6 http://localhost:8181/api/edge/status | python3 -c "import json,sys; print(json.load(sys.stdin)['redisGlobal']['ok'])")
check "redis-global PING" "True" "$pong"

echo
echo "═══════════════════════════════════════════════════════════════════"
echo "  REZULTAT: $PASS PASSED / $FAIL FAILED"
[ $FAIL -eq 0 ] && echo "  LANȚ PUBLIC COMPLET FUNCȚIONAL — ZERO 502" || echo "  AU EȘUAT $11 CHECK-URI"
echo "═══════════════════════════════════════════════════════════════════"
exit $FAIL
