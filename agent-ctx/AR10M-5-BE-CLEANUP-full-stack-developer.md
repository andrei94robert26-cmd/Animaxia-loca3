# AR10M-5-BE-CLEANUP — full-stack-developer

Task: eliminarea completă a simulării „30B" din backend-ul LIVE Animaxia (mini-services/animaxia-backend, port 4000), păstrând 100% funcționalitatea reală. Context anterior: AR10M-2-BE (nucleul modules/ar10m — DONE, LIVE), AR10M-3-FE (frontend curățat — DONE).

## Fișiere editate — backend

| Fișier | Schimbare |
|---|---|
| `modules/platform/stress.js` | Rescris 654→248 l. ELIMINAT: ruta `GET /feed/global` (feed global 30B), ruta `GET /scale/virtual` (catalog virtual 30B), suita `virtual30b`, constantele `ADDRESS_SPACE`/`FEED_ADDRESS_SPACE`/`FEED_LOGICAL_SHARDS`, generatorul virtual (TITLE_*, GENRES, OVERVIEW_TEMPLATES, fnv1a local, mulberry32, generateVirtualItem), b64urlEncode/Decode, `INT4_MAX`, `globalFeedRealStats`, `realItemOf`, importuri moarte (`SHARD_SPAN_IDS`, `logicalAddressSpace`, `computeShardIdFromContentId`, `parseJsonb`, `query`). PĂSTRAT: `GET /stability` (contract identic), `POST /stress/run` — suite REALE 'search'\|'ingest'\|'mixed' (mixed = search+ingest), rate-limit 2/min, lock 409, caps 1-30s × 1-32 workers, param `concurrency` + `q`. 'virtual30b' → 400 onest. |
| `modules/hub/hub.js` | `GET /scale` rescris: `real {totalItems, countsByType, sources (registry+providers), users, viewevents, dbSizeBytes (pg_database_size live)}` + `capacity {designed: 10_000_000, tested, benchmarked}` (tested/benchmarked din `data/ar10m-bench-state.json` phase 'done' → rowsDone/rowsTarget, altfel null — aceeași sursă onestă ca /api/ar10m/stats) + `shards {shardcount, mode, map}`. ELIMINAT: `logical{...}` (addressSpace, engine, rangePerShard, idsAddressable), `realVsLogical{logicalSpace, ratio}`, `LOGICAL_ADDRESS_SPACE=30000000000`, `SHARD_RANGE`. `GET /recommendations`: secțiunea „logical" (sample catalog virtual 30B via fetch localhost /api/platform/scale/virtual) ștearsă — rămân ONLY real picks (trending 7d + top-rated fill). Eliminate: `virtualCatalogSample`, `VIRTUAL_CALL_TIMEOUT_MS`, `RECOMMENDATIONS_LOGICAL_LIMIT`. Frontend nu consuma hub.scale/hub.recommendations (verificat — folosește doar hub.stats + hub.feed). |
| `modules/sharding/model.js` | ELIMINAT exporturile `SHARD_SPAN_IDS` (1B/shard) + `logicalAddressSpace()` (30B simulat) — zero apelanți rămași după curățarea stress.js (db.js importă doar computeShardIdFromContentId/shardMap/shardBranchName — neatinse, exporturi stabile). Default `SHARDCOUNT` '30'→'15' (fallback NaN→15). Regula RANGE legacy (`floor(id/1B) % SHARDCOUNT`) PĂSTRATĂ pt. compat — toate id-urile reale < 1B → shard 0. Header rescris AR10M (15 shards; catalogul real = hash(normalized_title+year) în modules/ar10m). |
| `modules/sharding/routes.js` | Doar header comment: notă AR10M (registrul canonic = /api/ar10m/shards; fostele afirmații 30B eliminate). Răspunsurile conțineau deja doar date reale — zero schimbări funcționale. |
| `modules/sharding/migrations.js` | Citit complet — nu conținea nicio afirmație 30B / volum simulat (doar regula RANGE reală + DDL idempotent). NEATINS. |
| `modules/platform/resilience.js` | `'/api/platform/scale/virtual'` scos din `SHED_ALLOWLIST` + comentariu de eliminare. |
| `modules/platform/scale.js` | Eticheta „suite search/ingest/virtual30b/mixed" → „search/ingest/mixed (search+ingest)" + notă AR10M. |
| `modules/aisuite/common.js` | „...Neon FTS, 30B, player" → „...Neon FTS, player; AR10M: fostul 30B simulat a fost eliminat". |
| `index.js` | Idem — listă module protejate fără 30B. |
| `server.js` | 2 comentarii (import block FAZA 17-a + mount /api/platform) — 30B → notă de eliminare. Endpoint-urile de health NEATINSE (regulă). |
| `.env` | `SHARDCOUNT=30` → `15` (runtime live aliniat AR10M; 30×1B era construcția 30B). |
| `.env-deploy.mjs` | Fallback `SHARDCOUNT` '30' → '15' (consistență artefact deploy). |

## Fișiere test actualizate (chirurgical, zero ștergeri de fișiere)

| Fișier | Schimbare |
|---|---|
| `tests/smoke-hubs.mjs` | A3 (scale: real+capacity), A9 + I4 (recommendations real-only), G1 (`real.totalItems`), G2 (`capacity.designed === 10000000`), header G. |
| `tests/smoke-observability.mjs` | S6-2/S6-6 (categorie '30b'→'ar10m', ținte `/api/ar10m/stats`), S8-4 (→ ar10m stats capacity.designed 10M), REQUIRED_CATEGORIES, header S8. |
| `tests/stability-faza24.mjs` | S9-4 (→ ar10m stats), S9-5 (count hardcodat „4 noduri" → „toate nodurile healthy"; era staling pre-existing — live avea 30), header S9. |
| `tests/infra-faza22.mjs` | S9-3 (→ ar10m stats capacity.designed), header S9. |
| `tests/unit/sharding-model.test.js` | `process.env.SHARDCOUNT='4'` pin înainte de teste (eticheta „SHARDCOUNT=4" exista; aserțiunile wrap-around depindeau de env ambient → 1 test FAILUIA deja cu .env=30; acum 9/9 determinist). |

## Deviație necesară în afara backend-ului

`mini-services/animaxia-observability` (LIVE :4050, `bun --hot`): cele 3 synthetics `scale30b-eu/us/asia` (categorie '30b') țintea endpoint-ul eliminat cu aserțiunea `addressSpace === 30000000000` → repointate la REALUL `/api/ar10m/stats` (ids `ar10m-stats-eu/us/asia`, categorie 'ar10m', aserțiune `capacity.designed === 10000000`); `hub-scale-asia` redenumit onest; `README.md` rând tabel actualizat. Fără repoint: 3 check-uri roșii live + referințe 30000000000 live + smoke-observability S6-8 S9 roșii. Totalul rămâne 46 check-uri / 16 categorii; verificat live prin :4050/api/synthetics și prin GW :4040 (capacity.designed=10000000 OK).

## Verificări (toate trecute)

1. `bun build --target=bun` OK pe toate fișierele editate (11 backend + 5 teste + observability synthetics.ts via bun --hot live).
2. Backend hot-reload sănătos — `/api/health` 200 (JSON ok). 3 boot-uri curate în `backend-ar10m.log` (watch-reload la editări), ZERO crash-loop; o singură eroare DB tranzitorie (Neon „terminating connection" — lazy-reconnect a gestionat-o).
3. `/api/platform/stability` 200 · `POST /api/platform/stress/run {suite:'search'}` 200 (4 req reale, 0 erori, extra.search) · `{suite:'mixed'}` 200 (extra: {search, ingest}) · `{'virtual30b'}` → 400 onest · `/api/ar10m/stats` 200 (neatins).
4. Endpoint-uri eliminate: `/api/platform/scale/virtual` → 404, `/api/platform/feed/global` → 404 (cel REAL `/api/social/feed/global` → 200 — modul social neatins, coincidență de nume).
5. `/api/hub/scale` → real.totalItems=29.192, real.dbSizeBytes=140.476.416, real.sources.registry.total=19, capacity {designed:10000000, tested:null, benchmarked:null}, shards.shardcount=15, fără cheile logical/realVsLogical. `/api/hub/recommendations` → 12 reale (trending/top-rated), fără logical. `/api/shards` → model.shardcount=15, 15 pool-uri, searchCluster 15 noduri healthy.
6. 16 endpoint-uri cheie toate 200 (health, stability, search/status, scale/report+metrics, hub x5, shards x2, ar10m x3, social feed, metrics).
7. **GREP PROOF FINAL** — `grep -rn "30B\|30000000000\|30_000_000_000\|virtual30b" modules/ server.js index.js seed.js scripts/ tests/` = 34 hit-uri raw, TOATE comentarii/etichete oneste „fost 30B simulat — eliminat": modules/sharding/routes.js:10, model.js:12/20/63, platform/stress.js:5/6/7/146, resilience.js:44, scale.js:10/37/329, hub/hub.js:5/32/49/382(honesty)/637, aisuite/common.js:5, server.js:102/103/351, index.js:15, tests/smoke-hubs.mjs:14/130/296/361, smoke-observability.mjs:11/641/802, stability-faza24.mjs:10/1126/1132, infra-faza22.mjs:375, unit/sharding-model.test.js:9. ZERO cod funcțional 30B. (`grep -v "ar10m\|eliminat\|fost 30B\|30B SIMULATĂ"` lasă 10 linii — toate continuări de comentarii de eliminare, verificate manual fiecare.)
8. ZERO setInterval/cron/polling nou (Map in-memory fără timere).
9. Suite rulate: unit 38/38 PASS · smoke-hubs 34/35 (A9/G1/G2/I4 verzi; eșecul C2 = sort title lexicographic — PRE-EXISTENT data-driven: titluri '#...'/'$...' sortate de collation PG ≠ comparație JS; cod /browse neatins) · smoke-observability 70/76 (eșecuri rămase PRE-EXISTENTE în straturi neatinse: player-eu/us/asia — content 1907 fără metadata.player.sources (drift date); ai-hub-eu/us — timeout prin gateway; S2-7/S2-10/S3-11 — collector OTel; toate check-urile AR10M PASS).

## Nicio atingere (reguli respectate)

modules/ar10m/* (DONE, LIVE — verificat 200 pe stats/shards/budget), db.js, server.js health endpoints, modules/workers/*, edge-live, modules/social/feed.js (feed-ul global REAL de activitate — altă rută), toate tabelele/DB (zero psql).
