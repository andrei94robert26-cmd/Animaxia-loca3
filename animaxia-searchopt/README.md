# Animaxia Search Optimization Layer — FAZA 17 (ZIP aditiv `animaxia-searchopt/`)

**Search Batching + Search Cache + Deduplication** — stratul de **optimizare
masivă** a căutării, între dispatcher-ul de ferestre FAZA 15 și Neon FTS,
astfel încât **10 milioane de utilizatori să poată căuta real, fără hardware
mare, fără supraîncărcarea Neon, fără spike-uri — păstrând căutările 100%
reale, cu 100×–1000× mai puține interogări Neon.**

Compatibil 100% cu FAZA 14 + FAZA 15 + FAZA 16 (30B simulat logic, sharding
logic 30×1B, feed global, player extern, Neon FTS real, coadă + priorități +
windowing, rate-limit + cooldown + anti-spam). **Stratul decide DOAR dacă
Neon mai vede o interogare**: cererile identice sosite concomitent partajează
**o singură execuție reală** (batch), repetările în fereastra TTL sunt
servite din micro-cache, iar rezultatul livrat este **exact obiectul produs
de execuția reală** — nimic fabricat, nimic mai vechi de TTL (1–5 s).

**QA dovedit**: 100 / 1000 / 5000 cereri identice simultane → **1 singură
interogare reală Neon fiecare** (reducere 5000×), toate răspunsuri 200 cu
date reale, 0 pierderi, coada FAZA 15 intactă, platforma stabilă (3,2 s pentru
5000).

## Ce conține arhiva

| Cale | Conținut |
|---|---|
| `monolith/modules/search/opt.js` | **Motorul FAZA 17** — executor `searchOptExecute` cu decizie deterministă (batch in-flight → attach / cache valid → serve / altfel batch nou + FTS real + cache la succes): `batchMap[queryHash]` (fan-out, shard-uri participante, settle garantat de budget-ul de 8s), `searchCache[queryHash]` (TTL pinned 1000–5000 ms, sweep 1s, flush la `content:changed`), cap-uri protective (`cacheMax`, `batchMax` → bypass onest), hash sha256-16 pe cheia canonică a tuturor parametrilor semantici, atribuire per-shard (30 rânduri), istoric 180×1s, loguri bounded-rate (BATCH CREATED/COMPLETED/FAILED per execuție reală, CACHE MISS per execuție, CACHE HIT eșantionat + sumar 1s — un burst de 5000 nu blochează event loop-ul) |
| `monolith/modules/search/search.js` | Integrarea: căile cluster + legacy + autocomplete trec prin `searchOptExecute` ÎNAINTE de coada FAZA 15 (după dispatch-ul ferestrei); `/status` + blocurile pinned `batching`/`cache`/`dedup`/`pipeline` (array-ul exact de 10 etape); NOU `GET /opt` (consola) + `POST /opt/settings` (admin, runtime, clamp 1000–5000); câmp aditiv `opt { source, queryHash, cached, batched }` pe fiecare răspuns (provenance: `neon`/`batch`/`cache`/`bypass`); bypass-ul păstrează single-flight-ul FAZA 17-a byte-identic |
| `monolith/modules/search/{flow,rate}.js` | Motoarele FAZA 15 + FAZA 16 (neschimbate — incluse pentru un prefix self-contained) |
| `monolith/modules/ops/metrics.js` | Secțiunea de emit `searchopt`: cele 4 serii pinned (`animaxia_search_batch_hits`, `animaxia_search_cache_hits`, `animaxia_search_cache_misses`, `animaxia_search_dedup_count`) + opt_enabled/cache_ttl_ms/entries/hit_ratio/evictions/active_batches/batches_created/completed/batch_max_fanout/fts_queries_total/fts_errors_total/served/bypassed + serii by_shard sparse |
| `monolith/server.js` | Wiring: colectorul `'searchopt'` pentru `/api/metrics` |
| `monolith/tests/smoke-searchopt.mjs` | **Suita FAZA 17 — 53 checks**: contracte pinned (batching/cache/dedup/pipeline exact), provenance aditiv, **100 identice → 1 interogare Neon (fts Δ1, dedup Δ99)**, **1000 identice → 1 (reducere 1000×)**, **5000 identice → 1 (reducere 5000×, wall 3,2 s, knob-uri runtime tunate + RESTAURATE)**, ciclul cache (hit în TTL cu payload EXACT + miss onest după expirare), no false dedup (30 cereri distincte → 30 execuții), autocomplete (30 probe identice → 1 reală), shard-awareness (X-Animaxia-Shard 7 → 1 execuție + atribuiri pe shard), metrici Prometheus + JSON, securitate settings (401/403) + clamp + master switch (`enabled=false` → `bypass` onest cu rezultate reale), regresii FAZA 15/16 + sănătate Neon |
| `monolith/tests/opt-burst-worker.mjs` | Helper QA: cereri identice (același q) de la utilizatori distincți (XFF unic per cerere), chunk-uri de 100 concurent (sandbox 2 nuclee — 50 de procese spawn-ate simultan înfometează CPU-ul; 10 × 500 chunk-ed = 5000 fără furtună de conexiuni) |
| `monolith/tests/{smoke-searchrate,smoke-searchflow,smoke-sharding}.mjs` | Suitele FAZA 16/15/13-14 (regresii verzi după FAZA 17) |
| `frontend/src/components/animaxia/admin/admin-search-opt-tab.tsx` | Consola `#/admin/search-opt`: banner „1.000 utilizatori, 1 interogare Neon", 8 gauge-uri live (batch-uri active/batch hits/cache hits/misses/interogări Neon/reducere ×/dedup/intrări cache), **graficul „Cereri vs Interogări Neon"** (dovada vizuală a reducerii), pipeline vizual 10 etape, config cards, tabel batch-uri în curs, tabel 30 sharduri cu reducerea per shard, formular setări admin (switch + TTL + cap-uri) |
| `frontend/src/components/animaxia/views/admin-view.tsx` | Tab „Search Opt" + deep-link `#/admin/search-opt` |
| `frontend/src/lib/animaxia/{types,api}.ts` | Tipuri SearchOpt* + client `searchOpt()` |
| `ops/metrics/METRICS.md` | §10 — documentația canonică a metricilor FAZA 17 |
| `ops/dashboards/search-opt.json` | Dashboard Grafana „Animaxia — Search Optimization" (15 panouri) |
| `ops/dashboards/README.md` | Rând dashboard + înregistrare în `ops:validate` (7/7) |
| `ops/alerts/alerts.yaml` | Grup `animaxia-searchopt-alerts`: CacheRatioLow (warning — adesea NU incident), OptDisabled (info) |
| `ops/alerts/README.md` | Paragraful grupului FAZA 17 |
| `ops/runbooks/search-optimization.md` | Runbook operațional complet (diagnostic + remediere runtime + knob-uri) |
| `ops/synthetics/run.mjs` | Suita `searchopt` (14 checks) — `bun run ops:synthetics --only searchopt` |
| `ops/synthetics/README.md` | Rând suită + `--only` actualizat (126 checks total) |
| `.env.example` | Configurația FAZA 17 (`SEARCHOPT*`) |

## Configurație (toate runtime-adjustabile prin `POST /api/search/opt/settings`)

```bash
SEARCHOPTENABLED=true      # false = bypass onest (source 'bypass', FAZA 16 behavior)
SEARCHOPTCACHETTLMS=3000   # TTL-ul cache-ului (1000–5000 — plaja pinned)
SEARCHOPTCACHEMAX=5000     # intrări max (evict LRU-ish peste limită)
SEARCHOPTBATCHMAX=10000    # batch-uri DISTINCTE simultane (protectie memorie)
```

## Pipeline-ul pinned (expus în `/api/search/status` → `pipeline`)

```
antiSpam → rateLimit → cooldown → queue → priority → windowing
        → dedup → batching → cache → fts
```

## Contracte pinned

| Endpoint / câmp | Contract |
|---|---|
| `GET /api/search/status` → `batching` | `{ enabled: true, activeBatches: N }` |
| `GET /api/search/status` → `cache` | `{ ttlMs: 3000, hits: X, misses: Y }` |
| `GET /api/search/status` → `dedup` | `{ active: true, deduplicatedRequests: N }` |
| `GET /api/search/status` → `pipeline` | array-ul exact de 10 etape (mai sus) |
| `GET /api/search/opt` | consola completă (config + contoare + batch-uri active + istoric + perShard 30) |
| fiecare răspuns /advanced + /autocomplete | `opt: { source, queryHash, cached, batched }` (aditiv) |
| `POST /api/search/opt/settings` | admin-only (401 anonim, 403 non-admin), clamp server-side |

## Rulare QA

```bash
cd mini-services/animaxia-backend
bun tests/smoke-searchopt.mjs    # 53 checks (100/1000/5000 → 1 interogare Neon)
bun tests/smoke-searchrate.mjs   # 58 (regresie FAZA 16)
bun tests/smoke-searchflow.mjs   # 61 (regresie FAZA 15)
bun tests/smoke-sharding.mjs     # 47 (regresie FAZA 13/14)

cd ../../animaxia-ops
bun run ops:synthetics           # 126 passed / 0 failed (11 searchopt)
bun run ops:validate             # 7/7 dashboards JSON valide
```
