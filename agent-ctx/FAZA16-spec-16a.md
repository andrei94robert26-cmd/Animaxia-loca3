# FAZA 16 — Task 16-a (backend): Motor de căutare Neon + dedup global + store-uri Neon + raport scală

Ești Task ID **16-a** în proiectul Animaxia. CITEȘTE ÎNTÂI /home/z/my-project/worklog.md (secțiunile 0, 6, 7, 15-0/15-a, 15-b, 15-c) ca să înțelegi munca anterioară. LA FINAL trebuiе să adaugi secțiunea ta în worklog (append, nu overwrite; secțiunea începe cu o linie care conține exact `---`).

## Context
Platforma Animaxia: backend Express monolith la /home/z/my-project/mini-services/animaxia-backend (port 4000, rulează cu `bun --watch` deci editările se hot-reload — verifică cu `curl -s localhost:4000/api/health`), frontend Next.js pe :3000, gateway Caddy :81 (`/api/...?XTransformPort=4000`). Neon PostgreSQL e driverul ACTIV (97 itemi în tabela `content`, coloane: id, externalid UNIQUE, type, title, metadata JSONB, thumbnail, createdat). Neon are deja extensiile: pg_trgm (deja creat pe baza de date), vector (pgvector), plpgsql. Full-text search (websearch_to_tsquery / to_tsvector) verificat funcțional. DB size: 14 MB.

Fișiere-cheie de studiat ÎNAINTE de editare:
- db.js (abstracție driver, exportă query/getContentByExternalId/upsertContent; upsertContent face SELECT-then-INSERT cu ON CONFLICT(externalid))
- modules/platform/sql.js (rows/one/query), modules/platform/migrations.js (ensurePlatformSchema cu DDL idempotent, coloane lowercase-fără-underscore, rulează la boot)
- modules/platform/events.js (emitPlatform/events bus; 'content:changed' emis de server.js invalidateHttpCache)
- modules/search/search.js (motorul ACTUAL local in-memory BM25 — îl vei RESCRIE)
- modules/ai/home.js (folosește fișiere JSON locale data/ai-home-settings.json, data/ai-home-enrichment.json, data/ai-home-trailers.json — le muți în Neon)
- modules/workers/workers.js (generează thumbnail-uri SVG în data/thumbnails/, servește GET /api/workers/thumbnails/:file — muți stocarea în Neon)
- server.js (mount-uri routere; search montat la app.use('/api/search', ...))

## Sarcinile tale (tot codul în /home/z/my-project/mini-services/animaxia-backend)

### 1. TABELE NOI (adaugă statement-uri idempotente la modules/platform/migrations.js)
Stil: coloane lowercase-fără-underscore. Toate `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`:
- `searchdocs (id SERIAL PRIMARY KEY, contentid INTEGER NOT NULL UNIQUE, externalid TEXT, type TEXT, title TEXT NOT NULL, tsv tsvector, year INTEGER, rating DOUBLE PRECISION, genres TEXT[] DEFAULT '{}', actors TEXT[] DEFAULT '{}', studios TEXT[] DEFAULT '{}', category TEXT, syncedat TIMESTAMP DEFAULT NOW())` + GIN index pe tsv, GIN trigram pe title (`USING GIN (title gin_trgm_ops)`), btree pe year, btree pe type, GIN pe genres, GIN pe actors.
- `contentsources (id SERIAL PRIMARY KEY, urlhash TEXT NOT NULL UNIQUE, url TEXT NOT NULL, originalurl TEXT, kind TEXT NOT NULL DEFAULT 'link', contentid INTEGER, externalid TEXT, addedby TEXT DEFAULT 'manual', hits INTEGER DEFAULT 1, metadata JSONB DEFAULT '{}', createdat TIMESTAMP DEFAULT NOW(), lastseenat TIMESTAMP DEFAULT NOW())` + index pe contentid, index pe kind.
- `aisettings (key TEXT PRIMARY KEY, value JSONB NOT NULL, updatedat TIMESTAMP DEFAULT NOW())`
- `aienrichment (externalid TEXT PRIMARY KEY, payload JSONB NOT NULL, updatedat TIMESTAMP DEFAULT NOW())`
- `aitrailercache (cachekey TEXT PRIMARY KEY, payload JSONB NOT NULL, updatedat TIMESTAMP DEFAULT NOW())`
- `thumbnailcache (file TEXT PRIMARY KEY, svg TEXT NOT NULL, contentid INTEGER, createdat TIMESTAMP DEFAULT NOW())`
- `marathons (id SERIAL PRIMARY KEY, key TEXT UNIQUE, userid INTEGER, title TEXT NOT NULL, description TEXT, items JSONB NOT NULL DEFAULT '[]', createdat TIMESTAMP DEFAULT NOW())` + index pe key.
- pg_trgm: `CREATE EXTENSION IF NOT EXISTS pg_trgm` în try/catch (deja instalat; defensiv).

### 2. RESCRIE modules/search/search.js → motor Neon Postgres FTS
Etichetă engine: `animaxia-neon-fts`. Păstrează contractul de mount (server.js deja montează /api/search — NU schimba server.js pentru search).
- **Sync**: `syncIndex()` citește toate rândurile din `content`, extrage din metadata JSONB: year (metadata.year), rating (metadata.rating ?? metadata.score), genres (metadata.genres), actors (metadata.actors ?? metadata.cast — array de string-uri sau obiecte {name}), studios (metadata.studios ?? metadata.studio), category (type). Upsert în searchdocs (ON CONFLICT (contentid) DO UPDATE toate câmpurile + tsv = to_tsvector('simple', title + ' ' + genres.join(' ') + ' ' + primele 500 chars din overview/synopsis/description)). Config 'simple' (titluri internaționale). Abonează-te la 'content:changed' → debounce 3s → resync în background (async lock coalescing). Boot: lazy (prima interogare declanșează ensureSynced).
- **GET /api/search/advanced** — păstrează TOȚI parametrii existenți (q, type, genre, year, minRating, sort=score|year|rating|title, fuzzy, limit≤50) + NOI: actor, studio, category, page → { took, total, max_score, page, limit, engine, data: [rânduri content join + _score] }.
  - Text match: `tsv @@ websearch_to_tsquery('simple', $q)`; dacă 0 hit-uri și fuzzy!=='false', fallback trigram: `title % $q OR title ILIKE '%q%' (pe cuvinte)`. Scoring combinat: ts_rank(tsv, query) * 2 + similarity(title, q) + (title ILIKE 'q%' → +0.5). Dacă q e gol DAR există filtre → query doar-filtre cu sort (fără scor text).
  - Filtre în SQL: type egalitate; year egalitate (integer); genre prin contenție array case-insensitive; actor prin `EXISTS (SELECT 1 FROM unnest(actors) a WHERE a ILIKE '%'||$actor||'%')`; studio la fel pe studios; category egalitate; minRating >=.
  - Sortări: score, year DESC NULLS LAST, rating DESC, title ASC. Paginație LIMIT/OFFSET cu page (default 1).
  - Join înapoi la `content` pentru rândul complet + _score. total = COUNT peste setul filtrat.
  - Ține rolling p50/p95 din ultimele 50 interogări pentru /status.
- **GET /api/search/autocomplete?q=** — trigram + prefix pe searchdocs.title (`title %> q OR title ILIKE 'q%'`, order by similarity DESC, rating DESC, limit 8) → { suggestions: [{id, title, type, thumbnail, rating}] } (id = contentid).
- **GET /api/search/filters** — valori distincte pentru dropdown-uri UI din searchdocs prin SQL (unnest pentru array-uri): { genres: [{value,count}], actors: [{value,count}] top 50, years: [desc], categories: [{value,count}], studios: [{value,count}] top 50 }.
- **POST /api/search/index** (requireAuth+requireAdmin) — resync complet forțat → { ok, indexed }.
- **GET /api/search/status** — { docs, engine: 'animaxia-neon-fts', backend: 'neon-postgresql', extensions: { pg_trgm: true }, lastSync, dirty, latency: { p50Ms, p95Ms, samples }, capacity: { indexedDocs } }.
- Backward compat: apelanții vechi trimit q/type/genre/year/minRating/sort/fuzzy/limit — toate trebuie să meargă în continuare.

### 3. MODUL NOU modules/ingest/dedup.js — registru global dedup surse (mount în server.js la '/api/ingest' ÎNAINTE de rutele /api/content)
Fiecare sursă externă (URL / embed / iframe / JS) ingerată vreodată se înregistrează în `contentsources` — același link NU se stochează NICIODATĂ de două ori.
- **normalizeSource(url)**: trim; gol → null. Detecție kind: `.mp4`→mp4, `.m3u8`→m3u8, `.mpd`→dash, youtube (watch?v=|youtu.be/|/embed/|/shorts/) → extrage id-ul de 11 caractere → canonic `youtube:{id}` kind youtube; vimeo.com/ID → `vimeo:{id}`; dailymotion /video/{id} → `dailymotion:{id}`; începe cu '<' sau conține '<script'/'<iframe' → extrage primul src="..." dacă există, altfel hash tot codul trim-at, kind js sau embed; altfel link generic. Pentru URL-uri: lowercase protocol+host, strip fragment hash, strip parametri tracking (utm_*, fbclid, gclid, ref, ref_src, spm), sortează parametri query rămași alfabetic, strip trailing slash. urlhash = sha256 hex din string-ul normalizat.
- **POST /api/ingest/check** {url} → { ok, exists, duplicate, source, content } — public; verifică registru după urlhash; dacă există, întoarce sursa + rândul content legat (dacă e).
- **POST /api/ingest/register** {url, kind?, contentId?, externalId?, addedBy?} (rate-limit 30/min) → { ok, registered: bool, duplicate: bool, source } — INSERT ... ON CONFLICT (urlhash) DO UPDATE SET hits = contentsources.hits + 1, lastseenat = NOW() RETURNING; registered=false când rândul exista deja (duplicate=true).
- **GET /api/ingest/sources?limit=50&page=&kind=** → { data, total, page }.
- **GET /api/ingest/stats** → { total, byKind, duplicatesBlocked (count hits>1), lastRegisteredAt, linkedContents }.
- **Hook central**: editează db.js `upsertContent` — DUPĂ un upsert reușit (path-ul postgres), extrage toate sursele din metadata content-ului (metadata.url, metadata.finalUrl, metadata.player, metadata.sources[] {src,kind}, metadata.trailer, metadata.youtube) și înregistrează fiecare în contentsources (best-effort, niciodată throw, addedBy='upsert'). Asta acoperă FIECARE cale de ingest (miner, POST /api/content, discover add, AI enrichment, add extern din frontend). Verifică că miner.js beneficiază (cheamă upsertContent); adaugă apeluri explicite doar dacă un path ocolește upsertContent.
- Test: înregistrează același URL YouTube de două ori → a doua oară duplicate:true, hits=2.

### 4. MUTĂ STORE-URILE LOCALE ai/home.js ÎN NEON (editează modules/ai/home.js)
Înlocuiește persistența data/*.json cu tabelele Neon (păstrează codul pe fișiere DOAR ca fallback când driver === 'local'):
- settings → `aisettings` (key 'home', value JSON cu cele 4 toggle-uri: infiniteScroll, aiCursor, autoTrailers, autoTaxonomy). Păstrează response shape-urile identice.
- enrichment pool → `aienrichment` (externalid PK, payload JSONB) — aceleași semantic TTL (updatedat), același comportament de creștere.
- trailers cache → `aitrailercache` (cachekey PK, payload JSONB, TTL 7 zile după updatedat) — păstrează response shape-urile identice.
NU schimba response shape-urile — frontend-ul FAZA 15-b depinde de ele. Elimină scrierile în data/*.json când postgres e activ.

### 5. MUTĂ SVG THUMBNAIL-URILE ÎN NEON (editează modules/workers/workers.js)
- Task-ul de generare thumbnail-uri: stochează textul SVG în tabela `thumbnailcache` (file='{contentid}.svg', svg, contentid) în loc de disk. GET /api/workers/thumbnails/:file citește din tabelă (fallback la fișierul de pe disk dacă table miss — cale de migrare). Migrează 1385.svg existent la boot dacă tabela e goală și fișierul există.

### 6. MODUL NOU modules/platform/scale.js — raport scală REAL (mount la '/api/scale' în server.js)
- **GET /api/scale/report** (public) → raport comprehensiv ONEST calculat din măsurători live:
  - `measured`: dbLatencyMs (timing real SELECT 1), searchLatency {p50Ms,p95Ms,samples}, items/users/searchdocs/contentsources counts, dbSizeBytes (pg_database_size), tableSizes (top 10 după dimensiune), cache {hitRate, keys}, rateLimit {max, windowMs}, uptimeSec, providers [{name,state,failures}], neon {branch:'metadata_01', poolMax}.
  - `targets`: { users: 10000000, connectedAccounts: 10000000, contents: 30000000000, concurrentSearches: 10000000 }.
  - `verdicts`: array, unul per țintă (10M utilizatori, 10M conturi conectate simultan, 30B contente, 10M căutări simultane) cu status: 'not-ready'|'partial'|'ready', currentEstimate (estimare onestă single-node), reasoning — în română.
  - `gaps`: 12-18 lipsuri reale de inginerie în română cu severity critical|high|medium, missing, recommendation (single Express node vs fleet orizontal + load balancer; cache in-process vs cluster Redis; rate limiter local vs distribuit; fără CDN; Neon branch unic vs read replicas + sharding; 30B docs cere cluster de search dedicat OpenSearch/Elasticsearch sau Postgres shard-at + object storage; fără message queue; pool conexiuni 10 vs mii → pgBouncer; fără multi-region; fără load testing; fără k8s autoscaling; monitoring minimal).
  - `conclusion`: paragraf verdict onest în română.
- **GET /api/scale/metrics** → versiune ușoară pentru auto-refresh dashboard (measured + statusuri verdicte).
- Toate măsurătorile calculate LIVE (counteri SQL reali, timing real). Verdictele/lipsurile sunt analiză de inginerie cu numere live injectate. Fii onest: un singur proces Node + un singur branch Neon NU poate susține 10M utilizatori / 30B contente / 10M căutări simultane astăzi — raportul spune asta clar.

### 7. Editări server.js (minimale, additive)
- Mount /api/ingest (dedup.js) ÎNAINTE de rutele content; mount /api/scale (scale.js). NU atinge alte mount-uri.

## Verificare (OBLIGATORIE, totul prin curl pe localhost:4000)
1. /api/health încă ok (driver postgres).
2. Tabelele noi există (interoghează information_schema printr-un script bun rapid folosind pg din node_modules, DATABASEURL din .env).
3. Search: /api/search/advanced?q=dune → rezultate Neon cu engine=animaxia-neon-fts; filtre &year=2024, &genre=Action, &actor=Dwayne, &type=movie, &sort=year; query cu typo (fallback fuzzy trigram — 'dune' să matchuiască Dune); q='' + doar filtre; page=2; /api/search/autocomplete?q=du; /api/search/filters; /api/search/status (docs≈97 + latency); POST /api/search/index 401 fără auth.
4. Dedup: înregistrează același URL youtube de două ori → primul {registered:true,duplicate:false}, al doilea {registered:false,duplicate:true,hits:2}; /api/ingest/check același URL → exists:true; /api/ingest/sources + /stats; upsert content cu metadata.sources → auto-înregistrat (addedBy=upsert).
5. ai/home settings GET/POST → persistat în aisettings; GET /api/ai/home/trailers?title=Dune&key=... funcțional + rând în aitrailercache.
6. Thumbnails: creează utilizator test prin /api/auth/register, promovează-l admin prin SQL, POST /api/workers/thumbnails {contentId:1}, GET /api/workers/thumbnails/1.svg → 200 din Neon; curăță utilizatorul test.
7. Scale: /api/scale/report raport complet cu numere live; /api/scale/metrics.
8. Gateway: curl 'http://localhost:81/api/search/advanced?q=dune&XTransformPort=4000' → 200.
9. Backend încă rulează (bun --watch hot-reload; dacă a căzut restart: `cd /home/z/my-project/mini-services/animaxia-backend && ( setsid bun run dev > backend.log 2>&1 < /dev/null & )` — așteaptă 3s, verifică health). Verifică backend.log fără erori noi.
10. Scrie secțiunea ta în worklog (Task ID: 16-a) — include contractele API înghețate pe care le-ai implementat ca agentul de frontend (16-c) să poată integra fără să citească tot codul tău.

## Reguli
- Doar backend; NU atinge src/ (frontend). NU rupe endpoint-uri existente (FAZA 15-b depinde de shape-urile ai/home; view-ul de search depinde de shape-urile /advanced + /autocomplete).
- ES modules, stil casă (wrap async, utils/logger.js), coloane DB lowercase-fără-underscore, migrații idempotente, path-urile best-effort nu aruncă niciodată erori.
- Dacă .env lipsește sau TMDB 401 (incident cunoscut de reset de sesiune), rulează /home/z/my-project/restore-env.sh dacă există, altfel restaurează .env din public/animaxia-cloud.zip, și restartează backend-ul.
