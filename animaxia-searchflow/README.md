# Animaxia Search Flow Control — FAZA 15 (ZIP aditiv `animaxia-searchflow/`)

**Search Queue + Priority + Windowing** — stratul de admission între rutele de
căutare (`/api/search/advanced`, `/api/search/autocomplete`) și Neon, astfel
încât **10 milioane de utilizatori să poată căuta real, fără hardware mare,
fără ca Neon să fie supraîncărcat și fără ca platforma să cadă — păstrând
căutările 100% reale.**

Compatibil 100% cu FAZA 14 (30B simulat logic, sharding logic 30×1B, feed
global, player extern, Neon FTS real). **Interogările FTS rămân byte-identice**
— coada controlează DOAR fluxul cererilor, niciodată semanticile rezultatelor
(dovedit de testul de echivalență semantică din suita de smoke).

## Ce conține arhiva

| Cale | Conținut |
|---|---|
| `monolith/modules/search/flow.js` | **Motorul FAZA 15** — coadă shard-aware cu 3 benzi de prioritate (high = admin/ops/QA, normal = logați, low = anonimi) + anti-starvation aging (low→normal 2s, normal→high 5s), windowed dispatch (max `batchSize` execuții la fiecare `intervalMs`, bound `maxConcurrent`), fairness per-shard, request-budget deadline (504 curat ÎNAINTE de 504-ul FAZA 17), overflow explicit 503 (niciodată discard tăcut) |
| `monolith/modules/search/search.js` | Integrarea: execuția cluster/legacy (byte-identică FAZA 14) mutată în closure-uri `run()` trecute prin coadă; offset-cap hoisted (validare rapidă, fără admitere); `/status` + `flowControl`/`windowing`; NOU `GET /flow` (consola) + `POST /flow/settings` (admin, runtime); câmp aditiv `flow { priority, shardid, queuedMs }` pe fiecare răspuns |
| `monolith/modules/ops/metrics.js` | Secțiunea de emit `searchflow`: 19 familii `animaxia_search_*` (queue_length, inflight, window_interval, dropped_requests, timedout_requests, processed_total, wait p50/p95, processing_rate, queue_high_water/capacity, max_concurrent, serii by_priority + by_shard sparse) |
| `monolith/modules/platform/resilience.js` | Fix bug latent FAZA 17: garda late-`res.json` după timeout (coliziunea „Cannot set headers" descoperită de coada FAZA 15) |
| `monolith/server.js` | Wiring: colectorul `'searchflow'` pentru `/api/metrics` |
| `monolith/tests/smoke-searchflow.mjs` | **Suita FAZA 15 — 61 checks**: contracte pinned, priorități, burst-uri 10/100/500 simultane (utilizatori distincți, toate reale, 0 pierdute), ordering priorități, atribuire per-shard, echivalență semantică vs FAZA 14, fast-fail, metrici, securitate settings, sănătate Neon |
| `frontend/src/components/animaxia/admin/admin-search-flow-tab.tsx` | Consola `#/admin/search-flow`: grafic recharts coadă+execuții (istoric 3 min), 7 gauge-uri live (Respinte/Expirate cu „0 țintă"), config cards, priorități, tabel 30 sharduri, formular setări admin |
| `frontend/src/components/animaxia/views/admin-view.tsx` | Tab „Search Flow" + deep-link `#/admin/search-flow` |
| `frontend/src/lib/animaxia/{types,api}.ts` | Tipuri + client `searchFlow()` |
| `ops/metrics/METRICS.md` | §8 — documentația canonică a metricilor FAZA 15 |
| `ops/dashboards/search-flow.json` | Dashboard Grafana „Animaxia — Search Flow" (17 panouri) |
| `ops/alerts/alerts.yaml` | Grup `animaxia-searchflow-alerts`: DroppedRequests (critical), QueueSaturation (warning), InflightSaturated (warning) |
| `ops/runbooks/search-flow-saturation.md` | Runbook operațional complet (diagnostic + remediere runtime + bypass) |
| `ops/synthetics/run.mjs` | Suita `searchflow` (12 checks) — `bun run ops:synthetics --only searchflow` |
| `.env.example` | Configurația FAZA 15 (`SEARCHFLOW*` + nota `PGPOOLMAX`) |

## Configurație (toate runtime-adjustabile prin `POST /api/search/flow/settings`)

```bash
SEARCHFLOWENABLED=true          # false = bypass complet (comportament FAZA 14)
SEARCHFLOWMAXCONCURRENT=250     # execuții simultane (specificat 200–300)
SEARCHFLOWWINDOWMS=80           # interval fereastră (specificat 50–100 ms)
SEARCHFLOWBATCHSIZE=80          # intrări per fereastră (specificat 50–100)
SEARCHFLOWQUEUECAP=10000        # capacitate coadă (overflow → 503 explicit)
SEARCHFLOWMAXWAITMS=30000       # wait maxim (depășit → 504 explicit)
SEARCHFLOWLOWPROMOTEMS=2000     # aging low → normal
SEARCHFLOWNORMALPROMOTEMS=5000  # aging normal → high
PGPOOLMAX=40                    # plafonul fizic de conexiuni (10 → 40 în FAZA 15)
```

**Notă operațională:** schimbările din `.env` cer **restart complet** al
procesului — `dotenv` nu suprascrie variabilele încărcate nativ de Bun la
pornire, deci un restart `bun --watch` NU reîncarcă `.env`.

## Regulile Animaxia (păstrate 100%)

- 30B conținuturi = **spațiu logic simulat** (fără stocare fizică); metadata
  reală rămâne 100% reală în Neon (`content`, `searchdocs`, `vectorembeddings`,
  `miner_sources`, `miner_manifests`);
- linkuri / embed / iframe / JS = **reale**; player = **redare reală externă**;
- sharding = **logic 30×1 miliard** (`computeShardIdFromContentId`,
  `X-Animaxia-Shard`);
- **maxConcurrent** = limită de concurență la nivel de scheduler — pool-ul pg
  (`PGPOOLMAX`) rămâne plafonul fizic de conexiuni dedesubt;
- căutarea rămâne **FTS 100% real** — coada doar programează admission-ul.

## QA (livrat verde)

- `bun tests/smoke-searchflow.mjs` — **61/61** (burst 500: toate răspunsuri
  reale, 0 pierdute, 0 dropped, 0 timedOut, inflight ≤ maxConcurrent,
  echivalență semantică cu FAZA 14);
- `bun tests/smoke-sharding.mjs` — **47/47** (regresie FAZA 13/14);
- `bun run ops:synthetics` — **96 passed / 0 failed / 0 soft-warned**
  (include suita `searchflow` nouă);
- edge: typecheck 0 + smoke 196/0 + e2e 35/0 + tenant 61/0 (regresie);
- `tsc --noEmit` 0 erori în `src/`; eslint 0 probleme pe fișierele atinse;
- `ops:validate` 5/5 dashboards; browser: `#/admin/search-flow`,
  `#/search?q=dune`, flow admin save/restore — 0 erori de consolă.
