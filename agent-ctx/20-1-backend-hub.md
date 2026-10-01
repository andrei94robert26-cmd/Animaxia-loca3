# Task 20-1 — Backend: Hub-urile API complete (FAZA 20)

Agent: Z.ai Code (agent FAZA 20-1, backend) · Data: 2026-09-19 · Status: **LIVRAT, 13/13 live checks PASSED**

## Ce am construit

Un singur router `hubRouter` în **`modules/hub/hub.js`** (NOU, ~666 linii), montat în `server.js` (ADITIV, 2 hunks: import + `app.use('/api/hub', cacheMiddleware(), hubRouter)` după `/api/playerhub`, cu comentariu `/* FAZA 20 */`).

### Rute (toate GET, publice, cache HTTP 60s ca /api/discover)

| Rută | Ce face (100% SQL real Neon) |
|---|---|
| `GET /api/hub/content` | Browse faceted: `type` (slug), `genre` (containment jsonb `@>` pe array-ul real), `year` (regex-guarded `::int`), `q` (ILIKE titlu cu ESCAPE — browse, NU FTS), sort `recent\|rating\|title\|popular` (popular = LEFT JOIN COUNT(viewevents)); paginare strictă limit 1..48/page ≥1 → 400; **facete types/genres(30)/years(30 desc) pe SETUL FILTRAT**, în paralel cu pagina+total |
| `GET /api/hub/stats` | totals (content/byType/users/comments/watchlist/watchhistory/viewevents/playlists+items+subtitletracks) + engagement topWatched/topRated/mostLiked (top 5 real — mostLiked=3 pentru că doar 3 conținuturi au like-uri reale) + recency 7z + generatedAt |
| `GET /api/hub/scale` | `real` {contentItems=100, searchDocs=100, vectorEmbeddings=435 live (try/catch→0), users=180, shards=shardCount()=30, mode logical} + `view` {capacityClaim '30000000000' + notă} + `player.allowedTypes` (import din player.js NEATINS) + `search.pipelineIntegrated` **LIVE din `searchStressPipelineIntegrated()`** (exact sursa /api/search/status) |
| `GET /api/hub/years` | ani DISTINCT regex-guarded, count + ≤3 sample thumbnails (array_agg FILTER), DESC, `?limit=50` (1..100) |
| `GET /api/hub/genres` | lateral `jsonb_array_elements_text` cu guard `jsonb_typeof`, count DESC |
| `GET /api/hub/actors` | `metadata.actors` + `metadata.cast` (union; cast inexistent acum) + `coverage {contentWithActors: 2}` — 12 actori reali |
| `GET /api/hub/studios` | `metadata.studios` + `studio`/`network` (inexistente acum) + `coverage {contentWithStudios: 2}` — 3 studiouri reale; `source` (provider) deliberat neagregat |
| `GET /api/hub/feed` | 3 surse × 12 într-un apel: recent / popular(+views) / rated(+rating) |
| `GET /api/hub/recommendations` | top-rated în genul cel mai vizitat global (Animation, 136 views reale); genul are doar 7 titluri → **backfill onest** din top-ul global, raportat `fromGenre:7 / backfilled:5`; fallback top-rating global; personalizarea completă → /api/ai/* |

## Verificări metadata reală (pg direct)
- year: 93/100 (number SAU string) · rating: 82 (number) · genres: array 81/100 · **actors: 2 rânduri** (Men on a Mission, Moana 2) · **studios: 2 rânduri** (JTBC, SM C&W, Walt Disney Animation Studios) · cast/studio/network: **nicăieri** · source: provider (tmdb/jikan/demo).

## Validare live (13/13 PASSED)
1. `/content?limit=48` → len 48, total 100, totalPages 3, facete 7/23/22 ✓ · subset `type=mined` → total===len(3) ✓
2. `movie&genre=Action&sort=rating` → 5 filme, toate movie+Action, rating desc veritabil ✓ · facete pe set filtrat ✓
3. `q=dune` → „Dune: Part Two - Wikipedia" ✓ · year=2025&sort=title → 4 titluri, ordonare ASC ✓ · sort=popular #1 Big Buck Bunny ✓
4. `/stats` 200 cu toate secțiunile ✓ (totals: 100 content / 180 users / 199 viewEvents / 85 watchEntries / playlists 1+2+1)
5. `/scale` → contentItems **100**, shards **30**, allowedTypes 6, pipelineIntegrated **true**, capacityClaim 30B ✓
6. years(22)/genres(23)/actors(12)/studios(3) toate 200, sample-uri ≤3 ✓, coverage onest ✓
7. `/feed` → 3 surse × 12 ✓
8. `/recommendations` → **12 titluri distincte** (fromGenre 7 + backfilled 5) ✓
9. limit=100 → 400 · page=0 → 400 (+ limit=0/abc, sort=foo, type=MOVIE, year=abcd, years limit 0/500 — toate 400) ✓ · page=999 → 200 data goală ✓
10. Regresii: `/api/search/status` pipelineIntegrated:true + 10 stages + stress passed ✓ · `/api/health` ok/connected/100 items ✓ · `/api/playerhub/status` 19.1 intact ✓ · X-Cache MISS→HIT ✓ · 404 rută necunoscută ✓

## Netouch-uri (regulile de aur)
modules/search/* (doar import read-only `searchStressPipelineIntegrated` din stress.js), modules/sharding/* (doar `shardCount` din model.js), modules/player/player.js (doar `playerAllowedTypes`), feed 30B, db.js, cache.js, rateLimit.js, seed.js, migrările FAZA 19. Singurele fișiere modificate: `modules/hub/hub.js` (NOU) + `server.js` (2 hunks aditive). Lint frontend: cele 54 probleme existente sunt în oglinzile pre-existente animaxia-30b/animaxia-desktop — neatinse.

## Note pentru agenții următori (FAZA 21 UI)
- Răspunsurile `/api/hub/*` sunt publice + cached 60s — perfecte pentru pagini hub/actors/studios/years (#/actor/:name, #/studio/:name din roadmap).
- `q` pe /content e ILIKE pe titlu (browse); căutarea full-text rămâne /api/search/*.
- coverage-ul actors/studios e 2/100 acum — hub-urile afișează ce e REAL; minerul/AI pot îmbogăți metadata (SQL-ul acceptă deja cast/studio/network).
- Tripletul de watchere suprapuse pe :4000 produce artefacte „port in use" la reload — instanța supraviețuitoare e sănătoasă (fenomen cunoscut din 19-1).
