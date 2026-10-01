# RAPORT COMPLET DE AUDIT — ANIMAXIA REAL 10M (AR10M)

**Data:** 2026-09-27 · **Proiect:** transformarea platformei Animaxia din arhitectura simulată „30B" într-o arhitectură reală, măsurabilă și scalabilă gradual.
**Reguli respectate:** nu s-au șters module funcționale fără analiză; designul existent a rămas intact (cu excepțiile necesare); backup creat înainte de modificări; NU se pretinde că infrastructura gratuită garantează 10M utilizatori simultan.

---

## 1. CAPACITATEA — DECLARATĂ SEPARAT ȘI ONEST (regula critică)

| Nivel | Valoare | Sursa |
|---|---|---|
| **Capacitate proiectată** | 10.000.000 titluri | Arhitectura reală: schemă minimală + 15 sharduri Neon (hash determinist) — `capacity.designed` în `/api/ar10m/stats` |
| **Capacitate testată** | 10.000 → 100.000 → 1.000.000 rânduri (benchmark progresiv) | `tests/bench-ar10m.mjs`, rânduri sintetice marcate `synthetic=true` în `ar10m.bench_catalog` — NICIODATĂ în catalogul public |
| **Capacitate demonstrată prin benchmark** | Vezi §8 (10K/100K/1M: latență p50/p95/p99, QPS, B/rând, proiecție 10M) | Măsurători reale `pg_total_relation_size` / `pg_indexes_size` / `pg_database_size` / `pg_column_size` |

**Declarație onestă:** infrastructura gratuită Neon NU garantează 10 milioane de utilizatori simultan. Un singur proces Node + un pool de conexiuni la un singur proiect Neon susține astăzi cel mult câteva mii de utilizatori activi simultan (vezi `/api/scale/report` — verdicturile rămân oneste). Numărul de proiecte Neon necesare pentru 10M se determină DIN MĂSURĂTORI (§8), nu se presupune.

---

## 2. ÎNAINTE / DUPĂ — arhitectura

### ÎNAINTE (simulat)
- „Platforma susține 30.000.000.000 de conținuturi" — catalog VIRTUAL determinist (30 sharduri × 1 miliard ID-logici, zero stocare), badge „30B", feed global virtual, contoare false, salturi O(1) „demonstrate" pe un spațiu de adresare simulat.
- `searchdocs` FTS (48 MB) + `vectorembeddings` (22 MB) + `aisemantic` (10 MB) pe Neon — exact balastul interzis.
- `SHARDCOUNT=30` logic × `SHARD_SPAN_IDS=1B` = „spațiu logic 30B" expus în API-uri.
- `/api/health` cu statistici DB; probe health la 5-60s; reconnect DB pe interval 60s.

### DUPĂ (real)
- **Catalog real minimal** în schema `ar10m`: `content` (id, title, normalized_title, year, source_id, shard_id, created_at, updated_at) + `content_sources` (source_type, source_url, embed_code, source_hash **UNIQUE**, created_at). ZERO postere/thumbnails/video/embeddings/descrieri/actori/genuri/categorii în Neon.
- **15 sharduri** (ANIMAXIA_DB_01..15, DOAR din env): shard_id = fnv1a(normalized_title + ':' + year) % 15 — stabil pentru totdeauna; pool-uri LAZY (create la prima interogare, închise când inactive), circuit breaker (3 eșecuri/60s → open 30s → half-open), timeout per shard, retry controlat, fallback pe primar, distribuție echilibrată măsurată, raport spațiu real per proiect.
- **Motor de căutare real** (title + year EXCLUSIV): normalized_title + indexuri `text_pattern_ops`; prefix search indexabil (LIKE 'prefix%'), **interzis** LIKE '%text%'; keyset pagination; max 3-5 sharduri simultane; max 20 rezultate inițiale; deduplicare; continuă dacă un shard nu răspunde; cache pozitiv (120s) + **cache negativ** (60s); FARA reindexare la inserare; fuzionează onest catalogul real AR10M + legacy TMDB (title/year only).
- **UI real**: badge „30B" dispărut complet; „Arhitectură reală pregătită gradual pentru până la 10.000.000 de conținuturi"; „Catalog real, distribuit și extensibil gradual până la 10 milioane de titluri."; contoare EXCLUSIV din DB (16 titluri reale, 17 surse, 102 utilizatori, 29.192 legacy, sharduri online 1/15, spațiu 139,9 MB).
- **ZERO polling Neon** (vezi `PROOF-NO-POLLING.md`).
- **Buget Neon** cu praguri 70/85/95/100% + mod economic (doar căutare+auth; fără AI/miner/reindex/analytics/polling).
- **Thumbnails pe tabletă**: WebP 320×180, directoare pe hash (/ab/cd/id.webp), endpoint `/thumb/:id` cu ETag/Cache-Control/Last-Modified/protecție path-traversal/placeholder/limită dimensiune.

---

## 3. SISTEMUL SIMULAT 30B — tot ce a fost eliminat

**Frontend** (grep-proof ZERO rezultate pentru `30B|30 miliarde|30000000000|30.000.000.000`):
- Șters `views/global-30b-view.tsx` (feed virtual 30B); rescris `scale-report-view.tsx` → „Arhitectura Reală"; `stability-lab-view.tsx` — suita „Browser virtual 30B" ștearsă integral, suite „Catalog virtual 30B"/„Mixt" eliminate, testele REALE (Căutare FTS + Ingest) păstrate.
- Eliminate din `api.ts`: virtualCatalog, globalFeed, scaleReport/scaleMetrics, hub.scale, buildVirtualCursor; din `types.ts`: VirtualCatalogItem/Response, GlobalFeed*, HubScale*, ScaleReport*; PLATFORM_CAPACITY ('30.000.000.000') din `menu.ts`.
- Home: „Platforma susține 30.000.000.000..." → textul real mandatat; stats-view: cardul „Date reale vs. 30.000.000.000 logic" eliminat.

**Backend:**
- `platform/stress.js` (654→248 linii): eliminate `GET /feed/global` (feed virtual 30B), `GET /scale/virtual` (catalog virtual), suita `virtual30b`, generatoarele PRNG/template-uri, `ADDRESS_SPACE=30000000000`. Păstrate: `/stability` (real) + `/stress/run` cu suite reale search/ingest/mixed.
- `hub/hub.js`: `LOGICAL_ADDRESS_SPACE=30000000000` + raportul „real vs logical 30B" + secțiunea „logical" din recomandări — ELIMINATE; `/scale` raportează acum doar numere reale + capacity {designed/tested/benchmarked}.
- `sharding/model.js`: `SHARD_SPAN_IDS` + `logicalAddressSpace()` (30B) eliminate; SHARDCOUNT default '30'→'15'; rutarea RANGE legacy păstrată pentru compatibilitate (toate ID-urile reale <1B).
- `platform/scale.js`: TARGETS.contents 30B→10M (proiectată), verdicturile/gaps/concluzia rescrise onest AR10M.
- `.env` + `.env-deploy.mjs`: `SHARDCOUNT=30` → `15`.
- Observability: 3 synthetics `scale30b-*` repunctate onest pe `/api/ar10m/stats`.

---

## 4. LISTA EXACTĂ A FIȘIERELOR

### Create (backend — modulul AR10M, 2.988 linii)
| Fișier | Linii | Rol |
|---|---|---|
| `modules/ar10m/normalize.js` | 89 | normalizeTitle, fnv1a32, computeShardId (15), normalizeYear |
| `modules/ar10m/allowlist.js` | 190 | DOMAIN_ALLOWLIST, detectSourceType, sanitizeEmbedCode (zero JS arbitrar), sourceHash sha256 |
| `modules/ar10m/schema.js` | 100 | AR10M_DDL idempotent + ensureAr10mSchema |
| `modules/ar10m/shard-router.js` | 589 | 15 sloturi env-only, pool-uri lazy, circuit breaker, timeout/retry/fallback, status + metrici manuale, închidere pool-uri inactive |
| `modules/ar10m/search-gateway.js` | 401 | căutare reală title/year, keyset, max 3-5 sharduri, dedup, cache±negativ, p50/p95/p99 |
| `modules/ar10m/budget.js` | 214 | buget Neon (CU-hours 'indisponibil' onest), praguri 70/85/95/100, mod economic |
| `modules/ar10m/thumbs.js` | 268 | /thumb/:id (ETag/304/immutable/traversal-safe/placeholder 320×180 WebP), importThumbnail on-demand |
| `modules/ar10m/routes.js` | 453 | /stats /shards /search /suggest /budget /thumb/import /admin/* /bench/status + rate-limit 429 cu Retry-After |
| `tests/bench-ar10m.mjs` | ~420 | benchmark progresiv 10K/100K/1M, batchuri 5.000 + pauze + checkpoint, măsurători pg_* reale |
| `scripts/ar10m-rebalance.mjs` | 280 | mutarea shard-elor către DB-uri dedicate, batchuri + checkpoint |
| `scripts/ar10m-setup.mjs` | ~200 | migrare idempotentă (schema + backfill legacy + seed real) |

### Create (docs/config)
`docs/ar10m/AUDIT-REPORT.md` · `SCHEMA.sql` · `ROLLBACK.md` · `TERMUX.md` · `PROOF-NO-POLLING.md` · `mini-services/animaxia-backend/.env.example` (fără secrete, 15 sloturi shard).

### Modificate — backend (live)
`server.js` (montare /api/ar10m + /thumb/:id; /api/health ZERO-DB strict; /api/health/db admin manual 2s; piggybackStatsRefresh din /api/all) · `db.js` (reconnect LAZY on-demand — fost interval 60s; 7 hook-uri tryReconnectLazy) · `modules/platform/scale.js` · `modules/platform/stress.js` · `modules/platform/resilience.js` (etichete) · `modules/hub/hub.js` · `modules/sharding/model.js` · `modules/sharding/routes.js` (antet) · `modules/aisuite/common.js` (etichete) · `index.js` (etichete) · `.env` + `.env-deploy.mjs` (SHARDCOUNT 15) · `mini-services/edge-live/upstreams.ts` + `index.ts` (probe on-demand — fost interval 60s) · `mini-services/animaxia-observability/modules/synthetics.ts` (3 synthetics repunctate).

### Modificate — frontend (20 fișiere)
`src/app/page.tsx` · `src/lib/animaxia/api.ts` · `src/lib/animaxia/types.ts` · `src/lib/animaxia/menu.ts` · `src/components/animaxia/home-panels.tsx` · `navbar.tsx` · `command-palette.tsx` · `views/home-view.tsx` · `views/stats-view.tsx` · `views/scale-report-view.tsx` (rescris, 374→530) · `views/stability-lab-view.tsx` · `views/search-view.tsx` · `views/admin/admin-observability-tab.tsx` · `admin/admin-shards-tab.tsx` (rescris, 462→330) · `admin/admin-search-full-tab.tsx` · `admin/admin-search-flow-tab.tsx` · `admin/admin-search-rate-tab.tsx` · `admin/admin-search-opt-tab.tsx` · `admin/admin-playerhub-tab.tsx` · `admin/admin-analytics-tab.tsx` + `public/announcements.json`.

### Șterse
`src/components/animaxia/views/global-30b-view.tsx` (view virtual 30B, neimportat).

### Teste actualizare (chirurgical)
`tests/smoke-hubs.mjs` · `tests/smoke-observability.mjs` · `tests/stability-faza24.mjs` · `tests/infra-faza22.mjs` · `tests/unit/sharding-model.test.js`.

---

## 5. BAZA DE DATE — ÎNAINTE/DUPĂ

| | Înainte | După |
|---|---|---|
| Tabele public | 48 (content 30 MB cu metadata JSONB, searchdocs 48 MB, vectorembeddings 22 MB, aisemantic 10 MB...) | 48 INTACTE (regula: nu șterge date reale) + coloană aditivă `normalized_title` pe public.content + 2 indexuri prefix |
| Schema `ar10m` | — | `content` (16 titluri REALE cu surse), `content_sources` (17 surse unice, source_hash UNIQUE), `bench_catalog` (sintetic marcat) + 7 indexuri |
| Catalog real redatabil | 0 (metadate TMDB fără surse video) | **16 titluri / 17 surse** (Blender open movies + streamuri HLS de test — surse cu drepturi libere) |
| Distribuție shard-uri (hash real) | — | S0=2 S2=1 S3=2 S5=1 S6=1 S8=1 S12=4 S13=2 S14=2 (9/15 sharduri populate fizic pe DB_01) |
| Dimensiune DB | 129,6 MB | 139,9 MB (+schema ar10m +coloană legacy) |

**Ce NU se mai scrie în Neon:** postere, thumbnails, fișiere video, date simulate, embeddings AI noi, descrieri/actori/genuri/categorie noi, HTML duplicat, surse duplicate (UNIQUE source_hash). Tabelele legacy rămân read-navigabil pentru UI-ul existent (plan de retragere graduală — evict `searchdocs`/`vectorembeddings`/`aisemantic` după migrarea completă a UI-ului pe AR10M).

---

## 6. SECURITATE SURSE (AR10M §2)
- Allowlist domenii: youtube.com, youtu.be, youtube-nocookie.com, rumble.com, cdn.jsdelivr.net, commondatastorage.googleapis.com, test-videos.co.uk, test-streams.mux.dev, devstreaming-cdn.apple.com, storage.googleapis.com, vjs.zencdn.net, download/peach.blender.org, media.w3.org + `EXTRA_ALLOWED_DOMAINS` (env).
- Tipuri acceptate: direct_url, youtube, rumble, iframe, embed, hls (CHECK constraint în DB + validare în cod).
- `sanitizeEmbedCode`: DOAR un singur tag `<iframe src="https://allowlisted...">`, zero `<script>`, zero atribute on*, max 2.000 char — zero JavaScript arbitrar executat din DB.
- Connection string-urile: DOAR din env (ANIMAXIA_DB_01..15); niciodată în repo/frontend/loguri/răspunsuri API (hoști mascați `ep-****`).

## 7. RATE LIMITING & SCALARE (AR10M §8)
- `/api/ar10m/search` 30 req/min/IP, `/suggest` 60/min, `/thumb/import` 10/min — răspuns **429 + Retry-After**.
- Global: rateLimitMiddleware existent + load shedding FAZA 17 (503 + Retry-After la lag/memorie) + backpressure; paginare keyset peste tot.
- Indexuri unice pe email/username există în schema users (verificate — migrările FAZA anterioare).

## 8. BENCHMARK REAL (date sintetice marcate, în afara catalogului public)

Rulat progresiv 2026-09-27 (sandbox → Neon eu-central-1, RTT rețea ~180 ms inclus în latențe):

| Metrică | 10.000 rânduri | 100.000 rânduri | 1.100.000 rânduri |
|---|---|---|---|
| p50 prefix search | 181 ms | 183 ms | 374 ms |
| p95 / p99 | 205 / 1.260 ms | 314 / 1.267 ms | 488 / 1.545 ms |
| Queries/sec (4 workeri) | 19,5 | 18,9 | 10,4 |
| Căutare exactă p50 (index seek) | 180 ms | 179 ms | **173 ms** (scalabil — constant) |
| Căutare + filtru an p50 | 180 ms | 182 ms | 200 ms |
| Erori | 0 | 0 | 0 |
| Spațiu/rând (pg_total_relation_size real) | 387 B | 189 B | 176,7 B |
| Proiecție 10M (măsurată, nu presupusă) | 3,6 GB | 1,76 GB | **1,65 GB** (convergent) |

**Concluzii măsurate:** căutarea exactă rămâne constantă la 1,1M rânduri (index seek — scala O(log n)); prefix search degradare grațioasă (p50 181→374 ms de la 10K la 1,1M, din care ~180 ms este RTT rețea); indexurile = ~47% din spațiu (87 MB din 185 MB la 1,1M); 10M rânduri ≈ 1,65 GB + surse. La 512 MB/proiect gratuit → ~2,8M rânduri/proiect → **15 proiecte acoperă teoretic 42M rânduri din perspectiva spațiului**; limita REALĂ rămâne CU-hours (măsurată, nu presupusă). 10M NU se importă până când 1M nu e stabil — **1,1M tocmai a demonstrat stabilitate (0 erori)**.

**Igienă post-benchmark:** cele 1.100.000 rânduri sintetice au fost ȘTERSE (`--cleanup`, 1,4s) — rezultatele rămân în `data/ar10m-bench-state.json` + acest raport; `ar10m.content` real a rămas 16 titluri / 17 surse (contori neschimbați — dovada că datele sintetice NU contaminează catalogul public).

## 9. ROLLBACK
Vezi `ROLLBACK.md` (backup cod + schema aditivă + export CSV înainte de orice operație distructivă).

## 10. DECLARAȚII ONESTE FINALE
- Contoarele din UI sunt EXCLUSIV valori reale din DB (16/17/102/29.192/1 shard online — așa este azi).
- „10 milioane disponibile" NU se afișează nicăieri — doar „proiectată gradual până la 10 milioane".
- CU-hours Neon sunt raportate „indisponibil" până când există o sursă reală de măsurare (env manual sau API Neon cu cheie).
- Testele smoke existente au fost actualizare chirurgical; 2 eșecuri pre-existente (dependente de date, straturi neatinse) sunt documentate în worklog.
