# FAZA 16 — Task 16-b (backend): Modul AI Hub — 6 AI-uri NOI, toate reale, cu on/off în Neon

Ești Task ID **16-b** în proiectul Animaxia. CITEȘTE ÎNTÂI /home/z/my-project/worklog.md — obligatoriu secțiunile: 0, 6, 7 (fundament platformă: platform/sql.js, events.js, users/auth.js cu requireAuth/requireAdmin, security/security.js cu userRateLimit/auditLog), 15-a (modules/ai/home.js — motorul AI Home existent, ca să NU dublezi funcționalitățile) și 16-a (tocmai adăugată: tabele noi searchdocs/contentsources/aisettings/aienrichment/aitrailercache/thumbnailcache/marathons, motor de căutare Neon FTS, registru dedup /api/ingest, raport scală /api/scale). LA FINAL adaugi secțiunea ta în worklog (append; începe cu o linie `---`; template: Task ID / Agent / Task / Work Log / Stage Summary).

## Context
- Backend Express monolith la /home/z/my-project/mini-services/animaxia-backend (port 4000, `bun --watch` hot-reload; verifică `curl -s localhost:4000/api/health` — driver postgres).
- z-ai-web-dev-sdk e instalat în mini-service și funcțional (vezi modules/ai/ai.js pentru pattern-ul de utilizare: import ZAI from 'z-ai-web-dev-sdk', try/catch cu fallback heuristic, timeout). Folosește ACELAȘI pattern.
- Neon PostgreSQL activ. Extensia `vector` (pgvector) e DEJA instalată pe baza de date. Tabela `vectorembeddings` există deja (din FAZA aicloud — verifică coloanele cu information_schema înainte să o folosești; dacă schema nu se potrivește, creează tabela ta `aisemantic`).
- AI-urile EXISTENTE (nu le reproduce, doar referențiază în /status): ai/home.js are infinite feed, taxonomie auto, narțiune, analiză externă, extractor metadata, trailere, 4 toggle-uri (infiniteScroll, aiCursor, autoTrailers, autoTaxonomy) stocate în tabela `aisettings` (key 'home'); ai/ai.js are recommendations, summarize, describe, chat.
- Stil casă: ES modules, wrap async, logger din utils/logger.js, coloane DB lowercase-fără-underscore, migrații idempotente în modules/platform/migrations.js, best-effort nu aruncă niciodată.

## Sarcina: modul NOU modules/ai/hub.js — "AI Hub" cu 6 AI-uri noi

Fiecare AI: logică REALĂ (SQL pe Neon + fetch-uri externe reale + LLM z-ai cu fallback heuristic), toggle on/off persistent în Neon (tabela `aisettings`, key `hub:{aishopkey}` cu value {enabled: bool}), endpoint-uri sub mount-ul `/api/ai/hub`. Când un AI e oprit, endpoint-urile lui principale returnează 503 {error: 'AI <name> is disabled', disabled: true} — iar UI-ul va afișa switch-ul. `/status` și `/settings` funcționează mereu.

### Mount + ordine în server.js
`app.use('/api/ai/hub', hubRouter)` ÎNAINTE de mount-ul existent `/api/ai` (ca pattern-ul /api/ai/home deja existent — verifică ordinea exactă din server.js). NU atinge alte mount-uri.

### Endpoint-uri comune
- **GET /api/ai/hub/status** → { ais: [ {key, name, emoji, description, enabled, provider ('z-ai'/'heuristic'/'sql'), lastRunAt?, stats: {...} } ] } — cele 6 AI-uri noi + o secțiune `existing` cu listarea AI-urilor existente (home engine + ai.js) doar ca referință {key, name, enabled: null, note}. Populează stats live per AI (ex: curator: {duplicates: n, avgCompleteness: x}; forecaster: {eventsAnalyzed: n}; semantic: {embedded: n}; watchdog: {alerts: n}; marathon: {marathons: n}; translator: {translations: n}).
- **POST /api/ai/hub/settings** {key, enabled} → { ok, key, enabled } — persistă în aisettings. GET /status reflectă.

### AI 1 — Curator (curator): dedup inteligent + completitudine metadata + auto-enrich
- **GET /api/ai/hub/curator/scan** → { duplicates: [ { ids: [content ids], titles: [...], reason: 'same-source'|'similar-title', similarity } ], completeness: [ {contentId, title, score: 0-100, missing: ['year','genres','description','thumbnail','trailer','actors','studio']} ], avgScore, scanned } — REAL: duplicate = (a) grupuri din contentsources cu hits>1 sau conținut diferit legat la același urlhash... de fapt mai simplu: content cu același urlhash în contentsources legat la 2 id-uri diferite NU poate exista (unic pe urlhash) — deci duplicatele = titluri similare: SELECT perechi cu similarity(a.title, b.title) > 0.45 din searchdocs (LIMIT 20 perechi) + conținut ai cărui metadata.url / metadata.finalUrl se regăsește la alt externalid; completeness = scor pe 7 câmpuri (title 15, year 10, genres 15, description 20, thumbnail 15, trailer 10, actors+studio 15 → 100) calculat din content.metadata în SQL/JS. Cache intern 60s.
- **POST /api/ai/hub/curator/enrich** {contentId?, missing?: true, limit?: 5} (requireAuth) → { ok, enriched: [ {contentId, title, added: ['year','genres','actors','studio','description']} ], provider } — REAL: pentru conținutul cu metadata incompletă: dacă externalid începe cu 'tmdb:' fetch TMDB /movie/{id}?append_to_response=credits (adaugă year, genres, actors top-6, studios, overview dacă lipsesc); dacă 'jikan:anime:' fetch Jikan /anime/{id} (synopsis, genres, studios, year); dacă miner: folosește AI 6/describe pattern — LLM z-ai (chat.completions) pentru descriere RO dacă lipsesc surse structurate; update content.metadata în Neon (merge, nu suprascrie câmpurile existente), emite 'content:changed'. Pacing 300ms între fetch-uri, max limit (default 5, max 14). Actualizează și searchdocs prin evenimentul content:changed.
- **POST /api/ai/hub/curator/merge** {keepId, mergeId} (requireAdmin) → { ok } — mută sursele contentsources de la mergeId la keepId, DELETE content WHERE id = mergeId, auditLog('curator.merge'), emite content:changed.

### AI 2 — Trend Forecaster (forecaster): predicție trend-uri din analytics real
- **GET /api/ai/hub/trends/forecast?window=7d** → { window, eventsAnalyzed, rising: [ {contentId, title, thumbnail, type, recentViews, previousViews, momentum: (recent-prev)/max(prev,1), score} ], top: [...], narrative, provider, generatedAt } — REAL: SQL pe viewevents: compara views per content în ultimele N zile vs N zilele anterioare (momentum), top by views; dacă viewevents e aproape gol (< 10 evenimente), sintetizează din content.createdat (adăugări recente) + rating-uri și spune asta onest în narrative (source: 'library-heuristic'). narrative = z-ai LLM (română, 2-3 fraze, timeout 10s, fallback heuristic string cu numerele reale). Cache 5 min.

### AI 3 — Semantic Search (semantic): căutare semantică prin vectori (pgvector)
- Embeddings: încearcă z-ai-web-dev-sdk embeddings dacă există (verify la runtime — dacă SDK-ul nu expune embeddings sau eșuează, fallback deterministic: vector 256-dim din bag-of-words hash-at — token → index sha256(t)%256, tf-idf-ish weight; FUNCȚIONEAZĂ mereu, e onest documentat ca 'hashed-bow'). Stochează în tabela NOUĂ `aisemantic (externalid TEXT PRIMARY KEY, contentid INTEGER, title TEXT, embedding JSONB, dims INTEGER, provider TEXT, updatedat TIMESTAMP DEFAULT NOW())` (adăugat la migrations.js; NU folosi tabela veche vectorembeddings dacă schema nu se potrivește).
- **POST /api/ai/hub/semantic/query** {query, limit?: 12} → { ok, results: [ {contentId, externalid, title, type, thumbnail, score} ], provider, embeddedDocs } — embeddează query-ul cu ACELAȘI provider ca documentele, cosine similarity în JS peste aisemantic (OK pentru mii de docs; scale path documentat: pgvector `<=>` operator când table crește). Auto-embed la primul apel conținutul din content (max 500 docs, incremental — doar ce lipsește), apoi incremental pe content:changed (debounce). 
- **GET /api/ai/hub/semantic/similar/:contentId** → { ok, results: [...] } — găsește rândul, cosine cu toate, top 12 fără el însuși.
- **GET /api/ai/hub/semantic/status** → { embedded, total, provider, dims, lastEmbedAt }.

### AI 4 — Watchdog (watchdog): monitor anomalii cu diagnostic LLM
- **GET /api/ai/hub/watchdog/health** → { ok, score: 0-100, alerts: [ {severity: 'critical'|'warning'|'info', area, message, hint} ], checks: [ {name, status: 'pass'|'warn'|'fail', detail} ], diagnosis, provider, checkedAt } — REAL checks: (1) provideri externi (din starea circuit breaker — vezi cum expune providerii /api/health, importă sau refetch /api/health intern pe port 4000... mai bine: importă modulele de provider state direct dacă sunt exportate, altfel fetch('http://localhost:4000/api/health') intern); (2) DB latency (SELECT 1 timing, fail >500ms warn >200ms); (3) cache hit rate (<20% warn); (4) rate-limit blocks (din stats, >0 warning); (5) ingest errors: numără miner_jobs/failed dacă tabela există (try/catch); (6) searchdocs vs content count (desync >5 warn); (7) uptime. score = 100 - penalties. diagnosis = z-ai LLM (română, ce e în neregulă + ce să faci, timeout 10s, fallback heuristic compus din alerts). Cache 60s.

### AI 5 — Marathon Builder (marathon): maratoane automate ordonate
- **GET /api/ai/hub/marathon/suggestions** → { suggestions: [ {key, title, emoji, count, items: [ {contentId?, externalId, title, thumbnail, year, order} ], rationale } ] } — REAL: din collections.js (exporturile getFranchiseHub()/getTrilogyHub() există de la FAZA 15-a — vezi modules/discover/collections.js) construiește 6-10 maratoane: top francize după număr de părți (James Bond 27, Star Wars...) + trilogiile exacte + un maraton "Biblioteca ta după rating" (top 12 din content după metadata.rating) + "Noutăți 2024-2025" (dacă există). rationale = 1 propoziție română per maraton (fără LLM necesar, dar poți folosi z-ai pentru un titlu attractiv — fallback simplu).
- **POST /api/ai/hub/marathon/create** {key} (requireAuth) → { ok, marathon } — salvează în tabela `marathons` (key, userid req.user.id, title, description=rationale, items=JSONB array {contentId?, externalId, title, thumbnail, year, order}) ON CONFLICT (key) pentru același user... key-ul tabel e UNIQUE global, deci folosește key = `${userId}:${suggestionKey}`. 
- **GET /api/ai/hub/marathon/list** → { data: [ {...marathon, items: [...]} ] } — toate maratoanele publice + ale userului (dacă e autentificat).

### AI 6 — Translator (translator): traduceri descrieri multi-limbă
- **POST /api/ai/hub/translate** {contentId, lang: 'ro'|'en'|'es'|'fr'|'de'} (requireAuth + userRateLimit 10/min) → { ok, contentId, lang, translation, provider } — REAL: ia content.metadata (overview/synopsis/description), traduce prin z-ai LLM (prompt: traducere fidelă, fără spoiler-e noi, max 400 cuvinte; timeout 15s; fallback: dacă LLM pică și target e 'en' și sursa e ro → returnează textul original cu provider 'passthrough'; altfel 503). Salvează în content.metadata.translations = {lang: text} (merge), update Neon, emite content:changed. Dacă descrierea lipsește, folosește AI describe pattern (generează întâi EN prin LLM, apoi traduce).
- **GET /api/ai/hub/translate/status** → { coverage: { total, withTranslations, byLang: {ro: n, ...} } }.

## Migrații (adaugă la modules/platform/migrations.js, idempotent)
- `aisemantic` (schema de mai sus) + index pe contentid.
- nimic altceva — restul tabelelor există deja din 16-a (aisettings, marathons).

## Verificare OBLIGATORIE (curl pe localhost:4000)
1. /api/health ok în continuare (postgres, 97 itemi).
2. /api/ai/hub/status → 6 AI-uri cu enabled:true default + secțiunea existing; stats populate.
3. Toggle: POST /api/ai/hub/settings {key:'curator', enabled:false} → curator/scan returnează 503 disabled; re-activează → funcționează. Verifică persistența în tabela aisettings (key hub:curator).
4. curator/scan → duplicates (cel puțin un grup de titluri similare dacă există) + completeness cu score-uri reale + avgScore; curator/enrich {limit:3} → enriched cu câmpuri adăugate reale TMDB/Jikan (verifică un content înainte/după: metadata primește year/genres/actors/studios); merge — testează pe 2 itemi de test creați ad-hoc, apoi curăță.
5. trends/forecast → eventsAnalyzed real (din viewevents), rising/top, narrative (provider z-ai sau heuristic).
6. semantic/query {query:'desert planet science fiction'} → rezultate relevante (Dune ar trebui să apară; dacă provider hashed-bow, verifică că tokenii 'desert'/'planet'/'science'/'fiction' se regăsesc — Dune are overview EN în metadata pentru itemii TMDB importați... dacă nu, testează cu 'dune arrakis'); similar/:id → 12 vecini; semantic/status → embedded>0, provider.
7. watchdog/health → score, checks (provider pass, db latency real, etc.), alerts, diagnosis.
8. marathon/suggestions → 6+ maratoane cu părți reale (James Bond 27 etc.); marathon/create (cu user înregistrat ad-hoc) → rând în marathons; marathon/list.
9. translate: POST cu un contentId cu descriere EN → traducere RO reală salvată în metadata.translations.ro; translate/status coverage.
10. Gateway: curl 'http://localhost:81/api/ai/hub/status?XTransformPort=4000' → 200.
11. backend.log fără erori noi; backend viu (dacă a căzut: `cd /home/z/my-project/mini-services/animaxia-backend && ( setsid bun run dev > backend.log 2>&1 < /dev/null & )`).
12. Worklog: secțiune Task ID: 16-b cu contractele API înghețate pentru frontend (16-c).

## Reguli
- Doar backend; NU atinge src/. NU rupe endpoint-urile existente (ai/home, ai/ai, search, ingest, scale).
- NU dubla AI-urile existente — hub-ul le referențiază doar.
- Toate răspunsurile JSON; erorile prinde-le cu wrap și next() sau 5xx curat.
- Fiecare AI trebuie să funcționeze ȘI când z-ai SDK pică (fallback heuristic real, provider etichetat onest).
- Limba română pentru textele generate (narrative, diagnosis, rationale, descrieri).
