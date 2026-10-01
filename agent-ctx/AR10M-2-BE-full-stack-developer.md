# AR10M-2-BE — full-stack-developer — Backend core for ANIMAXIA REAL 10M

Task ID: AR10M-2-BE · Agent: full-stack-developer · Date: 2026-09-27

## Ce am construit

Nucleul REAL al arhitecturii AR10M în backend-ul existent (Bun + Express + pg, port 4000):
10 fișiere NOI, zero fișiere existente modificate, zero apeluri DB executate de mine
(baza de date e live — am scris DOAR cod; schema `ar10m` o creează orchestratorul).

## Fișiere create (toate sub /home/z/my-project/mini-services/animaxia-backend/)

| Fișier | Linii | Rol |
|---|---|---|
| modules/ar10m/normalize.js | 89 | Adevăr unic: normalizeTitle (NFKD + diacritice + punctuație), fnv1a32, computeShardId (stabil pe veci), normalizeYear, AR10M_SHARD_COUNT (env, clamp 1..15) |
| modules/ar10m/allowlist.js | 186 | Validare surse: DOMAIN_ALLOWLIST + EXTRA_ALLOWED_DOMAINS, detectSourceType (youtube/embed/rumble/hls/direct_url/iframe), sanitizeEmbedCode (DOAR iframe https allowlist, zero JS), sourceHash sha256 |
| modules/ar10m/schema.js | 100 | AR10M_DDL (array de statement-uri idempotente: schema ar10m + content + content_sources + bench_catalog + 6 indexuri) + ensureAr10mSchema(queryFn) → {ok, applied, errors}, nu aruncă niciodată fatal |
| modules/ar10m/shard-router.js | 589 | Router-ul REAL de shard-uri: 15 sloturi ANIMAXIA_DB_01..15, primary=ANIMAXIA_DB_01‖DATABASEURL, pool-uri LENEȘE (max 3, create la primul query, niciodată la boot), idle close 120s prin setTimeout unref'd one-shot, circuit breaker (3 eșecuri/60s → open 30s → half-open), timeout/query (5s default) + cancel real pg, 1 retry controlat doar pe timeout/conexiune, SHARD_UNAVAILABLE cu {shardId, slot}, fallback transparent pe primary doar pentru scrieri bootstrap (opts.allowPrimaryFallback), shardStatus/shardStatus raport cu host mascat (ep-****.neon.tech), refreshShardMetrics manual, distributionSnapshot (cache 60s, invalidat la write), poolGauges/activeShardCount pentru budget |
| modules/ar10m/search-gateway.js | 401 | Motorul de căutare REAL: normalizare → fan-out fizic deduplicat (azi 15 logice → 1 fizic = 1 query), batching MAX_PARALLEL 3..5 cu early-stop la >=limit, keyset cursor base64url({t,i}) cu (normalized_title,id)>($1,$2), LIKE prefix% (fără leading wildcard), merge legacy public.content (graceful skip 60s dacă lipsește coloana), dedupe titlu+an (ar10m preferat), sortare exact-match-first, cache pozitiv 120s/negativ 60s/500 chei LRU-ish, failedShards raportate fără crash, autocomplete 2s, p50/p95/p99 rolling 100, ZERO reindex |
| modules/ar10m/budget.js | 214 | Buget Neon free HONEST: contoare in-memory (search queries/min rolling 60s, cache hit rate, pools active), storageBytes doar când măsurat real (512MB limită reală), cuHours/transferBytes 'indisponibil' fără env manual, level normal/warning/economic/critical/max din max(pct disponibili), economicMode auto >=85 + manual admin, economicGate(['ai','miner','reindex','analytics','admin-heavy']) → 503, zero polling, zero crash |
| modules/ar10m/thumbs.js | 268 | Pipeline thumbnail on-demand: thumbPath cu validare strictă [A-Za-z0-9_-]{1,64} (anti-traversal), schemă {dir}/{h0:2}/{h2:4}/{id}.webp, GET /thumb/:id cu ETag sha1+cache, 304, immutable 1y pt real / placeholder WebP 320x180 REAL embedat base64 (176 bytes, generat cu ffmpeg) cu cache scurt + X-Thumbnail: placeholder, ?strict=1 → 404, >500KB → 403; importThumbnail: youtube i.ytimg.com/hqdefault, direct_url → ffmpeg frame la 3s, conversie webp 320x180 q75 aspect-preserving+pad, salvare atomică .tmp→rename, 'ffmpeg-indisponibil' honest când lipsește binary, rumble skipat onest (fără API public) |
| modules/ar10m/routes.js | 453 | Router Express montat de orchestrator la /api/ar10m: /stats (contoare reale, cache 30s, capacity {designed:10M, tested/benchmarked din bench state}), /shards, /search (30 req/min/IP), /suggest (60/min, 503 în economic), /budget (30s), /thumb/import (10/min), /admin/refresh-metrics, /admin/economic, /admin/bench {rows∈10k/100k/1M} cu insert sintetic batch-uri 5000 + pauză 250ms + checkpoint data/ar10m-bench-state.json, /admin/bench/resume, /bench/status, /healthz zero-DB. Rate limit in-memory cu Retry-After. Admin token timing-safe (sha256+timingSafeEqual), 503 'admin-token-not-configured' când lipsește |
| tests/bench-ar10m.mjs | 408 | Benchmark REAL manual: --rows 10k/100k/1M, insert sintetic în ar10m.bench_catalog (batch 5000 + pauze 250ms, checkpoint/resume, --cleanup), măsurători 200 interogări prefix cu 4 workeri (p50/p95/p99, qps, erori), căutare exactă 1-rând, an-filtrat, spațiu real pg_total_relation_size/pg_indexes_size/pg_database_size/pg_column_size, tabel stdout + stare în data/ar10m-bench-state.json |
| scripts/ar10m-rebalance.mjs | 280 | Rebalans manual: mută shard_id=s pe DB-ul dedicat ANIMAXIA_DB_(s+1) — ensure schemă pe țintă, copiază content_sources referite (id explicit, ON CONFLICT DO NOTHING), copiază content, VERIFICĂ count batch, șterge din primary (guard shard_id), checkpoint per batch (data/ar10m-rebalance-state.json), pauze 200ms, setval secvență; status honest + exit 0 când nu există DB-uri dedicate |

## Decizii cheie

1. **Pool-uri leneșe cu adevărat**: getEntry() nu creează pool; getPool() doar la primul query;
   closeIdlePools(120s) programat one-shot unref'd după fiecare query — zero setInterval în
   toate fișierele (verificat cu grep).
2. **Timeout real pg**: query în formă callback cu query.cancel() + discard forțat la +5s
   (client eliberat exact o dată — pool-ul nu curge niciodată).
3. **LIKE $1||'%'**: parametrizat, funcționează pe index text_pattern_ops prin custom plans
   (node-pg planifică cu valorile reale la fiecare execuție) — fără inline SQL.
4. **Legacy search**: `substring(metadata->>'year' from '^[0-9]{4}')` — robust la date murdare,
   comparare text; coloana normalized_title presupusă adăugată de orchestrator, skip 60s la 42702.
5. **Placeholder thumb scurt-cache (300s) nu immutable** — abatere intenționată de la spec
   (cache 1y pe placeholder ar bloca lazy-fill-ul tabletei pe un an).
6. **/stats piggyback**: interogarea de count include pg_database_size() și actualizează
   primaryStorageBytes — budgetul vede storage REAL fără trafic suplimentar.
7. **Bench măsoară pe ar10m.bench_catalog** (aceeași formă de coloană+index ca ar10m.content)
   pentru că rândurile sintetice nu intră NICIODATĂ în catalogul real (regula spec).
8. **SSL**: pg.Pool/Client cu `ssl: PGSSL==='true' ? {rejectUnauthorized:false} : undefined`
   — stilul casei din db.js (PGSSL=true în .env).
9. **Fără secrets**: hosturi mascate ep-****, erori mascate (postgres://***, password ***),
   timing-safe admin token.

## Suprafața de export (routes.js)

```js
export default router;            // montat de orchestrator: app.use('/api/ar10m', router)
export { registerThumbRoute };    // apelat de orchestrator: registerThumbRoute(app) → GET /thumb/:id
```

## Contract API respectat EXACT (comunicat FE)

- GET /api/ar10m/stats → { ok, real: { titles, sources, users, legacyTitles, playableTitles,
  shardsConfigured, shardsOnline, dbSizeBytes, lastSyncAt, economicMode, budgetLevel },
  capacity: { designed: 10000000, tested, benchmarked }, message, asOf }
- GET /api/ar10m/shards → { ok, shards: [...], distribution: [{ shardId, rows, pct }] }
- GET /api/ar10m/search?q&year&limit&cursor → { ok, q, year, results: [{ id, title, year,
  sourceType, sourceUrl, embedCode, shardId, thumbnailId, catalog }], nextCursor, cached,
  negative, elapsedMs, shards: { queried, failed } }
- GET /api/ar10m/suggest?q → { ok, suggestions: [{ id, title, year }] }
- GET /api/ar10m/budget → shape budget + search: { cache, latency }
- GET /api/ar10m/bench/status → { ok, running, state }
- GET /thumb/:id → WebP binar (placeholder dacă lipsește)

## Verificări rulate (zero apeluri DB)

- `bun build --target=bun` pe toate cele 10 fișiere: OK 10/10.
- Import runtime routes.js fără env special: OK (nimic nu crapă, pool-urile nu se deschid).
- Teste funcționale pure: normalizeTitle (diacritice românești/punctuație), fnv1a32 (vectori
  cunoscuți 2166136261 / 3826002220), computeShardId determinist, normalizeYear limite
  1888..2100, detectSourceType 12 cazuri, sanitizeEmbedCode 10 cazuri (script/onclick/
  javascript:/non-iframe/http/disallowed/too-long rejectate), thumbPath anti-traversal,
  importThumbnail respingeri oneste, gateway negative-cache, ETag/304/strict/placeholder
  pe /thumb/:id, rate-limit 429 cu Retry-After, admin 503 fără token configurat —
  toate trecute.

## Pentru orchestrator (montare)

```js
import ar10mRouter, { registerThumbRoute } from './modules/ar10m/routes.js';
import { ensureAr10mSchema } from './modules/ar10m/schema.js';
import { primaryQuery } from './modules/ar10m/shard-router.js';
app.use('/api/ar10m', ar10mRouter);
registerThumbRoute(app);
// DDL idempotent: await ensureAr10mSchema(primaryQuery) — creează schema ar10m + toate tabelele.
```

Zero editări pe server.js / fișiere existente — montarea rămâne la orchestrator.
