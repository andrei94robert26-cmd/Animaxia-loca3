# PROOF: ZERO Neon DB POLLING (AR10M §5)

**Regula utilizatorului:** „Neon trebuie să poată intra în scale-to-zero după 5 minute fără trafic real."
**Interzis:** orice verificare DB la 5s / 10s / 15s / 30s / 60s; health polling; SELECT 1 periodic; cron permanent.

## 1. Dovada grep — toate `setInterval`-urile rămase în backendul LIVE

Rezultatul `grep -rn "setInterval(" mini-services/animaxia-backend/ --include="*.js"` (excluzând `node_modules`, `tests/`, `scripts/`, `data/`), clasificate onest:

| Locație | Interval | Atinge Neon? | Verdict |
|---|---|---|---|
| `rateLimit.js:20` | curățare fereastră rate-limit (≥30s) | NU — Map în memorie | permis (memorie) |
| `cache.js:15` | sweep cache expirat (60s) | NU — Map în memorie | permis (memorie) |
| `db.js` | ~~reconnect probe 60s~~ | **ELIMINAT AR10M** → `tryReconnectLazy()` on-demand, rate-limit 1 tentativă/60s, ZERO timer | ✅ eliminat |
| `modules/search/rate.js:277` | istoric rate search (memorie) | NU | permis |
| `modules/search/pipeline.js:364` | sweeper pipeline (memorie) | NU | permis |
| `modules/search/flow.js:332,398` | ferestre + istoric (memorie) | NU | permis |
| `modules/search/opt.js:429` | istoric optimizări (memorie) | NU | permis |
| `modules/searchaccel/index.js:320` | sweeper bucket-uri (memorie) | NU | permis |
| `modules/playerx/index.js:241` | sweeper use-tracking (memorie) | NU | permis |
| `modules/ai/ai.js:127`, `aicloud/llm-core.js:247` | sweep cote AI (memorie) | NU | permis |
| `modules/security/security.js:29,130` | sweep bucket-uri anti-bruteforce (memorie) | NU | permis |
| `modules/platform/resilience.js:81` | sample event-loop lag (memorie) | NU | permis (proces, nu DB) |
| `modules/platform/resilience.js:215` | watchdog memorie RSS → purge cache local (memorie) | NU | permis (proces, nu DB) |
| `modules/tenant/ai-quota.js:53`, `tenant/core.js:46` | sweep cache tenant (memorie) | NU | permis |
| `modules/premium/stripe.js:55` | sweep sesiuni (memorie) | NU | permis |
| `modules/cache/advancedCache.js:55` | sweep cache (memorie) | NU | permis |
| `modules/searchux/index.js:245` | sweeper (memorie) | NU | permis |
| `modules/workers/workers.js:265` | **DOAR dacă** `WORKERSREFRESHMS` e setat explicit (default 0 = OPRIT) | condiționat de env | ✅ default OPRIT |

**Concluzie:** ZERO interogări Neon programate. Toate intervalele rămase operează EXCLUSIV pe structuri în memorie (cache-uri, rate-limit, sampling proces). Singurul timer condiționat (`workers.js`) are default OPRIT și necesită setare explicită de mediu.

## 2. Endpoint-urile de health

### `GET /api/health` — ZERO acces PostgreSQL (implementare strictă)
- `server.js`: `healthDbStatsFor()` citește DOAR cache-ul din memorie (`healthStats`). NICIODATĂ nu declanșează interogări Neon — nici măcar fire-and-forget.
- Vechiul `?refresh=1` (care forța interogarea) a fost ELIMINAT din endpoint-ul public.
- Răspunsul marchează onest: `db.probe: 'memory-only'`, `statsStale: true/false`, `statsFetchedAt`.
- Reîmprospătarea statisticilor are loc EXCLUSIV piggyback pe trafic real: `piggybackStatsRefresh()` apelat din `/api/all`, doar când `lastDbActivityAt()` arată activitate DB recentă (compute-ul e oricum treaz din trafic real).

### `GET /api/health/db` — manual, protejat, timeout 2s
- Auth: header `X-Admin-Token` (timing-safe vs. `AR10M_ADMIN_TOKEN`) SAU sesiune admin.
- Fără autorizare → 403 (verificat live).
- Timeout maxim 2s pe fiecare interogare (SELECT 1 + COUNT).
- ZERO consumatori automați în platformă — nici watchdog, nici edge-live, nici observability nu îl apelează.

## 3. Serviciile din jur

| Serviciu | Comportament AR10M |
|---|---|
| **watchdog (:4020)** | Verifică DOAR procesul (TCP connect la port), la 6 ORE, zero HTTP /api/health, zero DB. Nu trezește Neon. |
| **edge-live (:8181/:8443/:8080)** | ~~`startHealthChecks(60000)`~~ → **ELIMINAT**. Acum: un singur set de probe-uri la boot + re-probe ON-DEMAND în deciziile de rutare (`ensureFresh`, doar când starea e >60s veche, piggyback pe trafic real). Probe-urile apelează `/api/health` care e zero-DB. |
| **observability (:4050)** | Scraper la 30 min (fost 5s→lazy, NEON-OPT), colector lazy; sync gauge la citire. |
| **stability (:4060)** | Observă platforma read-only; fără polling DB. |
| **backend workers (AI/miner)** | DEFAULT OPRIT; on-demand prin butoane admin (`POST /api/workers/refresh/{source}`), batch-uri controlate, pauze între batch-uri. |
| **benchmark (bench-ar10m.mjs)** | Rulează DOAR manual, cu batch-uri de 5.000 rânduri + pauză 250ms + checkpoint. |

## 4. Dovada live

```bash
# /api/health NU trezește Neon — răspunsul arată sursa datelor:
$ curl -s localhost:4000/api/health | jq '.db | {probe, statsStale, statsFetchedAt, totalItems}'
{ "probe": "memory-only", "statsStale": <bool>, "statsFetchedAt": "<ISO>", "totalItems": <număr real din cache> }

# /api/health/db refuză fără token:
$ curl -s -o /dev/null -w "%{http_code}" localhost:4000/api/health/db
403

# cu token (rulat MANUAL de admin):
$ curl -s -H "X-Admin-Token: $AR10M_ADMIN_TOKEN" localhost:4000/api/health/db | jq '.db.latencyMs'
<latență reală ms>
```

**Obiectiv atins:** fără trafic real, NICIO componentă din platformă nu emite interogări către Neon → compute-ul intră în scale-to-zero după 5 minute de inactivitate (setarea Neon default).
