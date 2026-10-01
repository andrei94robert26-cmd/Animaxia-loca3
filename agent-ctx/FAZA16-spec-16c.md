# FAZA 16 — Task 16-c (frontend): Căutare avansată + view Raport Scală + view AI Hub + meniuri sidebar

Ești Task ID **16-c** (frontend) în proiectul Animaxia la /home/z/my-project. CITEȘTE ÎNTÂI /home/z/my-project/worklog.md — OBLIGATORIU: secțiunile 1-c (fundație frontend: src/lib/animaxia/types.ts, api.ts, router.ts, hooks.ts useApi, componente states/content-card/content-grid/pagination/section), 13-UI (sidebar menu.ts structura grupurilor, sidebar.tsx, home-panels.tsx), 15-b (AiHomeSettingsProvider, ai-cursor, home-ai-feed, meta-view, pattern-urile de integrare), și secțiunile 16-a + 16-b (backend nou — CONTRACTELE API ÎNGHEȚATE sunt acolo; citește-le cu atenție înainte să scrii api.ts). LA FINAL adaugi secțiunea ta în worklog (append; începe cu `---`; template Task ID / Agent / Task / Work Log / Stage Summary).

## Context
- Frontend Next.js 16 single-route SPA: src/app/page.tsx cu hash routing (#/home, #/search, #/meta/:dim, ...). Toate view-urile în src/components/animaxia/views/, panourile în src/components/animaxia/.
- API client: src/lib/animaxia/api.ts — toate request-urile prin gateway relativ: fetch(`/api/...?XTransformPort=4000`). Hook: useApi(key, fetcher) din hooks.ts.
- Design system: dark #0a0a10, accent rose/fuchsia (FĂRĂ albastru/indigo), rounded-xl, border-white/10, badge-uri tip: anime=rose movie=amber tv=teal news=orange sports=lime mined=fuchsia. Română peste tot.
- Backend live pe :4000 cu NOILE endpoint-uri (contracte complete în worklog 16-a/16-b):
  - **Search Neon FTS**: GET /api/search/advanced?q=&type=&genre=&year=&minRating=&actor=&studio=&category=&sort=score|year|rating|title&fuzzy=&limit=&page= → {took,total,max_score,page,limit,engine,data:[content rows + _score]}; GET /api/search/autocomplete?q= → {suggestions:[{id,title,type,thumbnail,rating}]}; GET /api/search/filters → {genres:[{value,count}],actors:[{value,count}] (poate fi gol — metadata nu are cast decât după enrich),years:[int desc],categories:[{value,count}],studios:[{value,count}]}; GET /api/search/status → {docs,engine,backend,lastSync,dirty,latency:{p50Ms,p95Ms,samples},capacity}. engine='animaxia-neon-fts'.
  - **Ingest dedup**: POST /api/ingest/check {url} → {ok,exists,duplicate,source,content}; POST /api/ingest/register {url,kind?,contentId?,externalId?,addedBy?} → {ok,registered,duplicate,source}; GET /api/ingest/sources?limit&page&kind → {data,total,page}; GET /api/ingest/stats → {total,byKind,duplicatesBlocked,lastRegisteredAt,linkedContents}.
  - **Scale report**: GET /api/scale/report → {generatedAt,measured{dbLatencyMs,searchLatency{p50Ms,p95Ms,samples},items,users,searchdocs,contentsources,dbSizeBytes,tableSizes,cache,rateLimit,uptimeSec,providers,neon},targets{users,connectedAccounts,contents,concurrentSearches},verdicts[{target,status:'not-ready'|'partial'|'ready',currentEstimate,reasoning}],gaps[{area,severity:'critical'|'high'|'medium',missing,recommendation}],conclusion}; GET /api/scale/metrics → versiune ușoară (measured + verdicts).
  - **AI Hub**: GET /api/ai/hub/status → {ais:[{key,name,emoji,description,enabled,provider,lastRunAt,stats}],existing:[...]}; POST /api/ai/hub/settings {key,enabled} → {ok,key,enabled}; per-AI: GET /api/ai/hub/curator/scan → {duplicates:[{ids,titles,reason,similarity}],completeness:[{contentId,title,score,missing}],avgScore,scanned}; POST /api/ai/hub/curator/enrich {contentId?,missing?,limit} (auth) → {ok,enriched:[{contentId,title,added}],provider}; POST /api/ai/hub/curator/merge {keepId,mergeId} (admin); GET /api/ai/hub/trends/forecast?window=7d → {window,eventsAnalyzed,rising:[...],top:[...],narrative,provider,source}; POST /api/ai/hub/semantic/query {query,limit} → {ok,results:[{contentId,externalid,title,type,thumbnail,score}],provider,embeddedDocs}; GET /api/ai/hub/semantic/similar/:contentId; GET /api/ai/hub/semantic/status; GET /api/ai/hub/watchdog/health → {ok,score,alerts:[{severity,area,message,hint}],checks:[{name,status,detail}],diagnosis,provider}; GET /api/ai/hub/marathon/suggestions → {suggestions:[{key,title,emoji,count,items:[{contentId,externalId,title,thumbnail,year,order}],rationale}]}; POST /api/ai/hub/marathon/create {key} (auth); GET /api/ai/hub/marathon/list; POST /api/ai/hub/translate {contentId,lang} (auth, 10/min) → {ok,contentId,lang,translation,provider}; GET /api/ai/hub/translate/status → {coverage:{total,withTranslations,byLang}}. AI oprit → 503 {error,disabled:true}.
- Pentru auth în teste: POST /api/auth/register {email,username,password} → tokens; Bearer Authorization header (vezi src/lib/animaxia/platform.ts / auth provider-ul existent pentru helper-ul de token).

## Sarcinile tale

### 1. types.ts + api.ts — tipuri + metode NOI (additive, nu sparge existentele)
- Tipuri: SearchFilters, SearchAdvancedResponse, SearchFiltersOptions, SearchStatus, IngestCheckResponse, IngestRegisterResponse, IngestSource, IngestStats, ScaleReport (cu sub-tipuri), ScaleMetrics, AiHubStatus/AiHubAi, CuratorScan, TrendForecast, SemanticQueryResponse, WatchdogHealth, MarathonSuggestion(s), TranslateResponse etc.
- api.*: searchAdvanced(params), searchAutocomplete, searchFilters, searchStatus, ingestCheck(url), ingestRegister(...), ingestSources, ingestStats, scaleReport, scaleMetrics, aiHubStatus, aiHubToggle, curatorScan, curatorEnrich, curatorMerge, trendsForecast, semanticQuery, semanticSimilar, semanticStatus, watchdogHealth, marathonSuggestions, marathonCreate, marathonList, translateContent, translateStatus.

### 2. View SearchView EXTINS (src/components/animaxia/views/search-view.tsx)
Rescrie/extinde view-ul existent (păstrează tab-urile Library/Anime/Movies & TV dacă există — verificați structura actuală):
- **Bară de filtre avansate** deasupra rezultatelor tab-ului Library: input Nume (q), select An (din /api/search/filters years), select Gen (genres), select Categorie (categories), input Actor (cu autocomplete simplu din actors), input Studio, select Sortare (Relevanță/An/Rating/Titlu), slider sau select Notă minimă. Buton "Caută" + "Resetează filtrele".
- **Badge motor**: "⚡ Neon FTS · {took}ms · {total} rezultate · p95 {p95Ms}ms" (took din răspuns, p95 din /status — fetch status o dată la mount + la fiecare căutare refresh). Sub el, când filtrele active: chips cu filtrele active (click × remove).
- **Debounce 400ms** pe q; filtrele declanșează căutare imediat la change. Paginare (componenta Pagination existentă) cu limit 24 — trimite limit=24&page=.
- Fără q dar cu filtre → căutare doar-filtre (backend suportă). Zero rezultate → EmptyState cu sugestii din /filters (chips genuri populare click → setează filtrul).
- **Panou "Verifică link înainte de adăugare"** (secțiune sub filtre, Collapsible "Ai un link de adăugat? Verifică duplicat"): input URL + buton Verifică → api.ingestCheck → dacă exists: card galben "⚠ Link deja în Neon — {source.kind} · adăugat {date} · hits {n}" + buton "Deschide conținutul" dacă are content; altfel card verde "✓ Link nou — poate fi adăugat fără duplicat" + buton "Înregistrează în Neon" → ingestRegister → toast.
- Păstrează tab-urile externe (Anime/Movies&TV) intacte funcțional.

### 3. View NOU ScaleReportView (#/scale) — src/components/animaxia/views/scale-report-view.tsx
- PageHeader "Raport Scalabilitate" + subtitlu "10M utilizatori · 30B contente · 10M căutări simultane — analiză reală, live" + badge auto-refresh 30s (useApi + interval).
- **4 carduri țintă** (grid 2x2 md:4x1): 10M Utilizatori / 10M Conturi conectate simultan / 30B Contente externe / 10M Căutări simultane — fiecare cu status badge: not-ready=roșu "NE-GATA", partial=amber "PARȚIAL", ready=emerald "GATA", currentEstimate + iconiță (Users/Link2/Database/Zap).
- **Metrici măsurate LIVE** (grid de tiles): DB latency (ms), Search p50/p95 (ms, samples), Itemi bibliotecă, Utilizatori, Search docs, Surse înregistrate, DB size (formatează MB/GB), Cache hit rate %, Uptime, Provideri (stări cu puncte colorate), tabel top 10 tabele după dimensiune (custom scrollbar max-h-64).
- **Lista lipsurilor (gaps)**: carduri cu severity chip (critical=roșu, high=amber, medium=zinc), area bold, missing, recommendation "→ ...". Sortate critical→high→medium. max-h-96 overflow-y-auto custom-scrollbar.
- **Concluzie**: blockquote cu border-rose/500 textul conclusion.
- Buton "Reîmprospătează măsurătorile" → refetch + toast.

### 4. View NOU AiHubView (#/aihub) — src/components/animaxia/views/ai-hub-view.tsx
- PageHeader "AI Hub" + subtitlu "Toate AI-urile platformei — {n} active, comutabile live" + LIVE badge.
- **Grilă carduri AI** (din /status ais[]): fiecare card: emoji + name, description, provider chip (z-ai=rose, heuristic=zinc, sql=teal), Switch on/off (optimist + toast + revert la eroare), stats inline (ex: curator "5 grupuri duplicate · scor mediu 78%", semantic "97/97 docs · hashed-bow", watchdog "score 80"), panou detaliu expandabil (Collapsible) cu datele live per AI:
  - Curator: lista duplicates (ids, titles, similarity progress bar) + completeness top 8 (title, score Progress, missing chips) + buton "Îmbogățește metadata acum" (POST enrich {missing:true, limit:5}; dacă 401 → toast "Conectează-te"; dacă 503 disabled → notice) + listă enriched rezultat cu câmpurile added.
  - Forecaster: narrative în blockquote + rising list (title, momentum %, recentViews) + window Tabs (1z/7z/30z).
  - Semantic: input căutare semantică + buton → results grid compact (ContentCard sau listă cu thumbnail+title+score) + "Similar cu:" — lasă input de contentId... mai simplu: la click pe un rezultat, deschide #/content/{id}; stats provider.
  - Watchdog: score mare (0-100 cu culoare), checks list (pass=emerald check icon, warn=amber, fail=red), alerts, diagnosis blockquote.
  - Marathon: suggestions orizontale scrollable (no-scrollbar): card maraton cu emoji, title, "N părți", strip thumbnails (max 6 + "+N"), rationale, buton "Salvează maratonul" (auth; toast succes/eroare) — click parte → #/content/ext:movie:{id} sau db id.
  - Translator: coverage (total, withTranslations, byLang chips) + mini-form: select contentId dintr-un dropdown simplu cu primele 50 titluri (fetch api.all limit 50) + select limbă (ro/en/es/fr/de) + buton Traduce → rezultat în card + toast (rate-limit 429 → toast "Prea multe cereri — încearcă peste un minut").
- **Secțiunea "AI-uri existente"** (existing din /status): listă simplă de rânduri cu nume + notă + link-uri către #/home (feed AI), #/meta (taxonomy) etc. — fără switch (sunt gestionate în Home).
- Fiecare panou: skeleton loading + ErrorState retry + EmptyState. Dacă un AI e oprit: panoul arată Switch-ul + notice "AI oprit — activează-l ca să vezi datele".

### 5. Sidebar: meniuri NOI (src/lib/animaxia/menu.ts + verifică sidebar.tsx randare)
- În grupul "AI Metadata": adaugă PRIMA intrare {label: 'AI Hub', emoji: '🤖', target: '/aihub'} (înainte de cele 8 dimensiuni).
- În grupul "Cont": adaugă {label: 'Raport Scală', emoji: '📊', target: '/scale'} (după Gestionare & Duplicate).
- Page.tsx: case 'aihub' → AiHubView, case 'scale' → ScaleReportView (urmează pattern-ul exact al routelor existente — parseHash în router.ts trebuie extins dacă rutele noi nu sunt acoperite de pattern-uri; verifică router.ts targetForItem/parseHash).

### 6. Integrare dedup în fluxul de adăugare (home-panels.tsx AddContentForm)
- În AddContentForm (formularul "Adaugă conținut" din PlatformHero): DUPĂ ce userul introduce URL și ÎNAINTE de submit — buton mic "Verifică duplicat" lângă submit: api.ingestCheck(url) → dacă duplicate: toast warning "Acest link există deja în Neon {— hits N}" + dezactivează submit (sau confirmare dublă); la submit reușit prin /api/miner: sursele se înregistrează automat (hook-ul backend). Toast de succes să menționeze "salvat în Neon, verificat anti-duplicat".

## Reguli
- Frontend doar în src/ (NU atinge mini-services/). TypeScript strict curat: `bunx tsc --noEmit` → 0 erori noi în src/ (baseline: 0). Lint: `bun run lint` fără probleme NOI (baseline existent în alte foldere).
- Fără albastru/indigo; rose/fuchsia/amber/teal/emerald/zinc palette. Responsive (mobile 390px testat mental: grile colapsate, fără overflow orizontal). Footer sticky existent — nu-l strica (structura flex există în page.tsx).
- Folosește componentele shadcn/ui existente (Card, Tabs, Switch, Select, Input, Button, Collapsible, Progress, Badge, Dialog) și pe cele din animaxia (Section, PageHeader, ContentCard, states).
- useApi(key, fetcher) pentru fetching; nu useState+useEffect manual dacă useApi potrivindu-se (urmărește pattern-urile din views existente).
- Toate textele în română.
- NU sparge view-urile existente (home/category/content/player/franchise/search tab-uri externe/admin etc.).

## Verificare OBLIGATORIE
1. `bunx tsc --noEmit` → 0 erori în src/ (compară cu baseline — dacă există erori pre-existente în afara src/, ignoră-le).
2. `bun run lint` → fără probleme noi din fișierele tale.
3. Verifică dev.log (citește doar ultimele ~50 linii) — compilare curată, GET / 200.
4. Browser E2E prin gateway :81 cu agent-browser (skill-ul agent-browser; sesiune izolată):
   - #/search: filtrele randate; caută "dune" → rezultate + badge "⚡ Neon FTS"; filtrează An + Gen → rezultate filtrate; badge took ms vizibil; autocomplete dropdown dacă implementat; panoul de verificat link: introdu un URL YouTube deja înregistrat (cere-mi... nu — înregistrează tu unul prin API în prealabil prin fetch direct în consolă sau curl înainte de test) → cardul galben de duplicat.
   - #/scale: 4 carduri țintă cu statusuri NOT-READY (roșu), metrici live (DB latency, p95 search), gaps listă, concluzie, refresh buton.
   - #/aihub: 6 carduri AI cu switch-uri; toggle un AI off → panou notice + repornit on; Curator expandat cu duplicate reale; Watchdog expandat cu score; Marathon cu carduri și părți; Semantic căutare "desert planet" → Dune în rezultate.
   - Sidebar: grup AI Metadata are "🤖 AI Hub" prima intrare; grup Cont are "📊 Raport Scală"; click → navigare corectă.
   - Mobile 390x844: fără overflow orizontal pe toate cele 3 view-uri noi.
   - ZERO erori de consolă/pagină.
   - Screenshots: agent-ctx/faza16-{search,scale,aihub,mobile}.png.
5. Worklog: secțiune Task ID: 16-c cu ce ai implementat + contractele UI finale.

Dacă browser E2E pică din cauza limitelor de mediu (pointer coarse etc.), documentează onest ce ai verificat și ce nu.
