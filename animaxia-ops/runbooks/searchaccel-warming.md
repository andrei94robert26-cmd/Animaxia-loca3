# Runbook — Strat accelerare căutare (FAZA 29-P / PLAN 100X)

**Componente:** `mini-services/animaxia-backend/modules/searchaccel/index.js` (modul NOU, aditiv)
**Rută:** `/api/searchaccel/{lookup,status,popular,prefetch}` pe backend :4000
**Zero atingeri ale motorului protejat** — pipeline-ul FAZA 18 este doar consumat prin loopback.

## Ce face
1. **Keepalive pool Neon** — ping `SELECT 1` la 20s prin db.js ⇒ conexiunile rămân calde
   (rece ≈ 1,3s vs cald ≈ 190ms/query) ⇒ execuțiile FTS reale rămân la ~2×RTT.
2. **Cache LRU accel** — 10 min / 500 chei în fața pipeline-ului pentru interogări
   repetate; hit = sub-ms (badge „Accel · instant" în UI).
3. **Warming top interogări** — top-6 populare (count ≥ 2) re-executate prin loopback
   la 30s (`refresh: true` = bypass cache accel) ⇒ intrările pipeline strat-9 (TTL 45s)
   rămân proaspete ⇒ hit-uri reale strat 9 ⇒ alerta `cache-miss-high` rămâne inactivă.
4. **Prefetch predictiv** — hover/săgeți pe sugestiile din navbar și search-view
   încălzesc semnătura EXACTĂ ce va fi cerută la click (`sort=score, limit=24, page=1`).

## Diagnosticare rapidă
```bash
# stare completă (keepalive, cache, warming, prefetch, popular)
curl -s http://127.0.0.1:4000/api/searchaccel/status | jq

# top interogări urmărite
curl -s http://127.0.0.1:4000/api/searchaccel/popular?limit=10 | jq

# test hit/miss (a doua chemare trebuie accel=hit, took≈0)
curl -s "http://127.0.0.1:4000/api/searchaccel/lookup?q=naruto&limit=3" | jq .accel
```

## Semnale & acțiuni
| Simptom | Cauză probabilă | Acțiune |
|---|---|---|
| `keepalive.errors > 0` crescând | Neon inaccesibil/rețea | Verifică `/api/health` db.connected; vezi runbook `neon-down.md` |
| `cache.hitRate` scade sub 20% | Trafic multivariate (multe q unice) | Normal pentru catalog nou; warmingul acoperă top-ul |
| `warming.errors` crescând | 429/503 de la pipeline (legitim) | Nimic — bugetul de rate al pipeline-ului e protejat; scade `SEARCHACCEL_WARM_TOP` |
| `prefetch.rejected` > 0 | Client trimite >30 prefetch/min | Client-side dedup; rată normală de protecție |
| Lookup 504 | Executorul protejat > 8s | Vezi runbook `fts-latency.md` |

## Config env (toate cu default sigur)
`SEARCHACCEL_TTL_MS` (600000) · `SEARCHACCEL_MAX_KEYS` (500) · `SEARCHACCEL_PING_MS` (20000)
`SEARCHACCEL_WARM_MS` (30000 — sub TTL strat-9 45s, obligatoriu) · `SEARCHACCEL_WARM_TOP` (6)
`SEARCHACCEL_FRESH_MS` (25000) · `SEARCHACCEL_PREFETCH_PER_MIN` (30)

## Limită onestă cunoscută
Alerta `fts-latency-high` (p95 execuții reale > 500ms) rămâne activă onest: executorul
protejat face 2 round-trip-uri secvențiale la Neon peste WAN (~570-980ms). Rezolvarea
la nivel DB (query unic / read-replica / regiune Neon mai apropiată) cere **aprobarea
explicită a utilizatorului** (poarta ⚠️ din PLAN-100X) — NU se face din runbook.
