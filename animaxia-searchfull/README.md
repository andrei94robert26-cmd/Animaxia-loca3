# Animaxia — FAZA 18: Full Integration + Stress Test (oglinda de livrare)

Aceasta este oglinda aditivă a livrării FAZA 18 pe `animaxia-cloud.zip`.
Fișierele de aici sunt copii byte-identice ale surselor live din repository.

## Ce conține FAZA 18

**Integrarea completă a pipeline-ului de căutare + stress test 10.000+ căutări simultane:**

- `monolith/modules/search/stress.js` — motorul FAZA 18: 11.000 cereri
  simultane (cele 6 secțiuni pinned din specificație: 1.000 identice + 1.000
  diferite + 5.000 mixte + 2.000 spam ENTER + 1.000 cooldown + 1.000
  rate-limit) prin pipeline-ul REAL integrat (searchRateGate →
  searchFlowExecute → searchOptExecute → searchCluster.queryFTS), cu 22 de
  asserții pinned, projecția 10M utilizatori (model onest + eșantion real de
  500 concurenți) și persistența verdictului.
- `monolith/modules/search/flow.js` — aditiv: buget per-cerere (`budgetMs`)
  pentru lan-ul de stress; traficul normal păstrează deadline-ul implicit.
- `monolith/modules/search/search.js` — initSearchStress DI + /status
  (pipelineIntegrated + pipelineStages + stressTest) + GET/POST /stress.
- `monolith/modules/ops/metrics.js` + `monolith/server.js` — collectorul
  'searchstress' (15 serii animaxia_search_stress_* / pipeline_*).
- `monolith/tests/smoke-searchfull.mjs` — suita QA (43 checks) + workerul de
  burst refolosit.
- `frontend/...` — consola `#/admin/search-full` (verdict live, secțiunile
  pinned, 22 asserții cu dovezi, proiecția 10M, 4 grafice, buton admin).
- `ops/...` — METRICS.md §11, dashboard Grafana (18 panouri), 2 alerte,
  runbook, suita synthetics searchfull (13 checks).

## Contractul pinned

`GET /api/search/status` → `{ pipelineIntegrated: true, pipelineStages: [...10],
stressTest: { concurrent: 10000, passed: true, ... } }`

Verdictul de referință: 11.000/11.000 cereri răspunse (7.050 rezultate 100%
reale + 3.950 blocări oneste 429), exact 1 interogare Neon reală pentru
secțiunea „identice”, 1.000 execuții reale distincte pentru „diferite”,
0 erori, 0 dropped, 0 timedOut, coada high-water 8.050/10.000, reducere
totală 5,31×, eșantion 10M: 500 concurenți → 40 execuții (12,5×).
