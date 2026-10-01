# Animaxia Search Rate Management — FAZA 16 (ZIP aditiv `animaxia-searchrate/`)

**Search Rate-Limit + Cooldown + Anti-Spam** — stratul de control al
**ritmului** de căutare, în fața cozii FAZA 15, astfel încât **10 milioane de
utilizatori să poată căuta real, fără hardware mare, fără spike-uri
simultane, fără spam ENTER, fără supraîncărcarea Neon — păstrând căutările
100% reale.**

Compatibil 100% cu FAZA 14 + FAZA 15 (30B simulat logic, sharding logic
30×1B, feed global, player extern, Neon FTS real, coadă + priorități +
windowing). **Stratul decide DOAR cine poate căuta cât de des** — cererile
admise trec neschimbate prin coada FAZA 15, iar interogările FTS rămân
byte-identice cu FAZA 14. Fiecare respingere este un **429 explicit cu
`retryInMs`** (niciodată discard tăcut, niciodată rezultat fals).

## Ce conține arhiva

| Cale | Conținut |
|---|---|
| `monolith/modules/search/rate.js` | **Motorul FAZA 16** — gate per-utilizator: rate-limit `perUserMs` pe benzi separate advanced/autocomplete, cooldown `cooldownMs` după rezultat (sincronizat: next-allowed = max(lastAdmitted+perUserMs, lastCompleted+cooldownMs)), anti-spam (≥ `spamThreshold` sosiri în `spamWindowMs` → auto-block `spamBlockMs`), burst detector global (bucket-uri de 100ms, O(1) la orice scară, histeresis), atribuire per-shard, identități `u:{id}`/`ip:{ip}` cu sweep 5min + cap 100k, istoric 180×1s |
| `monolith/modules/search/search.js` | Integrarea: gate-ul rulează DUPĂ validarea de parametri (400-urile nu consumă slot de ritm) și ÎNAINTE de coada FAZA 15; `searchRateComplete` pornește cooldown-ul doar la rezultat real; `/status` + `rateLimit`/`burstControl` pinned; NOU `GET /rate` (consola) + `POST /rate/settings` (admin, runtime); câmp aditiv `rate { perUserMs, cooldownMs }` pe fiecare răspuns admis; `Retry-After` pe fiecare 429 |
| `monolith/modules/search/flow.js` | Motorul FAZA 15 (neschimbat — inclus pentru un prefix self-contained) |
| `monolith/modules/ops/metrics.js` | Secțiunea de emit `searchrate`: cele 4 serii pinned (`animaxia_search_rate_limit_hits`, `animaxia_search_cooldown_active`, `animaxia_search_spam_blocked`, `animaxia_search_burst_events`) + enabled/per_user_ms/cooldown_ms/admitted/completed/tracked_users/burst_* + serii by_shard sparse |
| `monolith/server.js` | Wiring: colectorul `'searchrate'` pentru `/api/metrics` |
| `monolith/tests/smoke-searchrate.mjs` | **Suita FAZA 16 — 54 checks**: contracte pinned, rate-limit (2 simultane de la un user → 200+429), cooldown (blocat + recovery), anti-spam (10 în <200ms → 1 admis + 9 explicite, auto-block, recovery), lane independence (autocomplete în timpul cooldown-ului), **burst 1000 utilizatori distincți simultan — toate 1000 răspunsuri 200 reale, 0 pierdute, windowing intact, eveniment burst înregistrat**, fast-fail, metrici, securitate settings, regresie FAZA 15 + sănătate Neon |
| `monolith/tests/burst-worker.mjs` | Helper QA: un worker = 100 căutări simultane de la 100 utilizatori distincți; suita spawn-ează 10 workeri în paralel = un burst REAL de 1000/s (un singur proces client saturează la ~260 concurent) |
| `monolith/tests/smoke-searchflow.mjs` | Suita FAZA 15 (61 checks) — adaptare FAZA 16: burst-urile 100/500 folosesc range-uri XFF disticte (cooldown-ul per-utilizator ar bloca legitim identitățile reutilizate) |
| `monolith/tests/smoke-sharding.mjs` | Suita FAZA 13/14 (47 checks) — adaptare FAZA 16: secțiunea C folosește XFF distincte per cerere |
| `frontend/src/components/animaxia/admin/admin-search-rate-tab.tsx` | Consola `#/admin/search-rate`: grafic recharts sosiri & respingeri (istoric 3 min), 8 gauge-uri live (rate-limit/cooldown/spam/burst/sosiri s/admise/utilizatori/total), config cards, strip burst control, tabel 30 sharduri, formular setări admin |
| `frontend/src/components/animaxia/views/admin-view.tsx` | Tab „Search Rate" + deep-link `#/admin/search-rate` |
| `frontend/src/components/animaxia/views/search-view.tsx` | UX-ul ritmului: buton „Caută" dezactivat în cooldown cu countdown live, mesajul „Așteaptă un moment…" (exact textul din specificație), anti-spam ENTER local (≥3 în <200ms), 429 tratate elegant — rezultatele reale anterioare rămân + auto-retry când fereastra se deschide |
| `frontend/src/lib/animaxia/{types,api}.ts` | Tipuri + client `searchRate()` + `ApiError.body` (429 structurat cu retryInMs) |
| `ops/metrics/METRICS.md` | §9 — documentația canonică a metricilor FAZA 16 |
| `ops/dashboards/search-rate.json` | Dashboard Grafana „Animaxia — Search Rate" (17 panouri) |
| `ops/dashboards/README.md` | Rând dashboard + înregistrare în `ops:validate` |
| `ops/alerts/alerts.yaml` | Grup `animaxia-searchrate-alerts`: SpamFlood (warning), BurstSustained (warning), RateDisabled (info) |
| `ops/alerts/README.md` | Matrice alertă → runbook + paragraful grupului FAZA 16 |
| `ops/runbooks/search-rate-protection.md` | Runbook operațional complet (diagnostic + remediere runtime + knob-uri) |
| `ops/synthetics/run.mjs` | Suita `searchrate` (16 checks) — `bun run ops:synthetics --only searchrate` |
| `ops/synthetics/README.md` | Rând suită + `--only` actualizat (112 checks total) |
| `.env.example` | Configurația FAZA 16 (`SEARCHRATE*`) |

## Configurație (toate runtime-adjustabile prin `POST /api/search/rate/settings`)

```bash
SEARCHRATEENABLED=true         # false = bypass (coada FAZA 15 rămâne)
SEARCHRATEPERUSERMS=500        # o căutare / utilizator / tip (100–5000)
SEARCHRATECOOLDOWNMS=1200      # cooldown după rezultat (250–10000)
SEARCHRATESPAMWINDOWMS=200     # fereastra flood (50–2000)
SEARCHRATESPAMTHRESHOLD=3      # apăsări ENTER în fereastră = flood (2–10)
SEARCHRATESPAMBLOCKMS=1000     # blocare auto după flood (100–10000)
SEARCHRATEBURSTWINDOWMS=1000   # fereastra burst (250–5000)
SEARCHRATEBURSTTHRESHOLD=1000  # sosiri / fereastră = eveniment burst (10–100000)
```

**Notă operațională:** schimbările din `.env` cer **restart complet** al
procesului — `dotenv` nu suprascrie variabilele încărcate nativ de Bun la
pornire, deci un restart `bun --watch` NU reîncarcă `.env`.

## Contractul pinned (QA + synthetics)

```jsonc
// GET /api/search/status →
"rateLimit":    { "perUserMs": 500, "enforced": true, "cooldownMs": 1200,
                  "spamProtection": { "windowMs": 200, "threshold": 3, "blockMs": 1000 }, … }
"burstControl": { "active": true, "maxBurstPerWindow": 1000, "windowMs": 1000, … }

// 429 (orice protecție) →
{ "error": "rate_limited" | "cooldown_active" | "spam_blocked",
  "code":   "SEARCH_RATE_LIMITED" | "SEARCH_COOLDOWN_ACTIVE" | "SEARCH_SPAM_BLOCKED",
  "retryInMs": 350, "message": "…" }   // + header Retry-After

// /advanced admis → câmp aditiv
"rate": { "perUserMs": 500, "cooldownMs": 1200 }
```

**Onestitate arhitecturală:** stratul FAZA 16 nu atinge interogările FTS —
cererile admise sunt byte-identice cu FAZA 14 prin coada FAZA 15; respingerile
sunt întotdeauna 429 explicite cu `retryInMs` (UI-ul afișează „Așteaptă un
moment…" și reîncearcă automat). 1000 utilizatori DISTINCTI căutând simultan
sunt toți admiși (limitele sunt per-utilizator) — burst-ul e absorbit de coada
FAZA 15 + windowing; doar flood-ul UNEI identități e blocat.
