# Task 20-2 — QA backend: smoke-hubs.mjs (Hub-urile API FAZA 20)

Agent: Z.ai Code (agent FAZA 20-2 — QA backend Hub-uri API)
Data: 2026-09-19

## Context
- Citez worklog 20-1 (modules/hub/hub.js, 9 rute publice pe /api/hub, cache 60s) și 19-4a (pattern-ul suitei smoke-playerhub.mjs: record ✓/✗, XFF rotativ, exit non-zero).
- Predecesori relevanți: 19-4a (suite QA Player Hub), 20-1 (implementarea hub-urilor).

## Livrabil
`mini-services/animaxia-backend/tests/smoke-hubs.mjs` — ~490 linii, 35 checks în 6 secțiuni (A–F), zero dependențe (fetch nativ bun), IP-uri rotative X-Forwarded-For 10.80.x.y unice per request (limitatorul global 120/60s/IP neatins — ~30 request-uri în total, fiecare cu IP propriu).

## Structura check-urilor (35 = 10+5+6+7+4+3)
- **A. /api/hub/content (10)**: shape complet {data,page,limit,total,totalPages,facets{types,genres,years}}; data.length ≤ limit && total ≥ len; facets.types conține movie count>0 + genres/years {value,count}; type=movie&limit=48 → toate movie + len === min(48,total) + totalPages === ceil(total/48); genre="Drama" (top facet) → toate rândurile au genul în metadata.genres; q=dune → hit ILIKE ("Dune: Part Two - Wikipedia"); sort=rating → primele 3 rating non-null desc (8.7 ≥ 8.6 ≥ 8.6); limit=100/page=0/sort=invalid → toate 400; page=999 → 200 data goală; cache: primul apel X-Cache MISS → al doilea HIT (backend-ul EXPUNE X-Cache în cache.js — check REAL, nu skip; cheie de cache proaspătă garantată prin param `qa=<ts>` ignorat de handler dar inclus în req.originalUrl).
- **B. /api/hub/stats (5)**: totals content=100 ≥ 100 + users=180 > 0 + byType object; engagement topWatched ≤5 cu id+title + topRated + mostLiked; recency contentAddedLast7d=100/activeUsersLast7d=6 ≥ 0; playlists=1 ≥ 1 + playlistItems=2 ≥ 2 (playlistul real FAZA 19); generatedAt ISO valid (Date.parse).
- **C. /api/hub/scale (6)**: real.contentItems === stats.totals.content — CONSISTENȚĂ INTERNĂ verificată robust: ambele endpoint-uri re-fetch-uite back-to-back cu chei de cache proaspete (`?qa=<ts>` ignorat de handler) astfel încât cele două agregări SQL sunt calculate la ~100ms distanță, nu una proaspătă vs una stale din cache-ul de 60s; shards=30 + shardMode 'logical'; searchDocs=100 > 0; allowedTypes conține mp4+youtube; pipelineIntegrated=true; capacityClaim '30000000000' + notă non-gol.
- **D. Facete (7)**: /years {year,count,sample≤3} strict desc + non-gol; /genres count desc; /actors array scurt onest + coverage; /studios array; limite: /years?limit=1 → exact 1, /genres?limit=0 → 400, /years?limit=500 → 400; cross-check count gen (Drama=27) din /genres === total din /content?genre=Drama (Δ0, toleranță documentată ±2 pentru cache/timing între cele 2 query-uri); ≥1 actor cu count ≥ 1 (12 actori reali).
- **E. /feed + /recommendations (4)**: 3 surse cu id+label+data 1..12 cu id; id-urile exact recent,popular,rated; recomandări exact 12 cu id (strategy most-watched-genre, fromGenre 7 + backfilled 5 — split onest raportat); toate cele 12 id-uri distincte (Set size 12).
- **F. Regresii (3)**: /api/search/status pipelineIntegrated:true + pipelineStages 10 (FAZA 15–18 INTACT); /api/health ok + db.connected:true; /api/playerhub/status hub playerhub + version 19.1 (FAZA 19 INTACT).

## Decizii QA (documentate în header-ul suitei)
1. **Cache check REAL**: cache.js expune X-Cache: HIT/MISS → check-ul e veritic complet (MISS apoi HIT), nu skip condiționat. Cheie proaspătă prin param `qa` ignorat.
2. **C1 anti-flaky**: comparația stats-vs-scale folosește ambele fetch-uri proaspete în paralel cu cache-busting — elimină fereastra de staleness de 60s fără a slăbi check-ul (egalitate strictă).
3. **D6 toleranță ±2**: documentată în comentariu — cele două agregări sunt query-uri separate; un writer de fundal între ele ar deplasa o parte cu numărul de rânduri adăugate; în practică Δ=0.
4. Rating check: filtrez explicit null/undefined/'' înainte de Number() (Number(null)===0 ar falsifica desc).

## Rezultate
- Run 1: **35 passed, 0 failed, EXIT=0** (prima iterație completă — verde din prima).
- Run 2 (stabilitate): **35 passed, 0 failed, EXIT=0**.
- Log backend: zero erori noi din /api/hub (ultimele [ERROR] sunt artefactele cunoscute de port-race ale tripletului de watchere suprapuse, 14:54–14:56, documentate în 19-1/20-1).
- Backend NEmodificat, zero date scrise (doar GET-uri publice + 400-uri de validare), zero cleanup necesar.

## Concluzie
Hub-urile FAZA 20 (modules/hub/hub.js, 9 rute) sunt verzi end-to-end: contracte, validări, cache, consistență internă stats↔scale, cross-check facete↔browse, feed/recomandări și regresiile FAZA 15–19 — toate intacte. Zero bug-uri găsite.
