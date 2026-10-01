# PLANUL 100X — TRANSFORMAREA COMPLETĂ A PLATFORMEI ANIMAXIA
### De la platformă funcțională → platformă de clasă mondială. Un update masiv, de la A la Z.

**Versiune:** 1.0 · **Statut:** PLAN (doar planificare — ZERO execuție, ZERO fișiere modificate)
**Domeniu:** TOT ce există în platforma Animaxia — frontend web, backend, 9 servicii live, AI, date, mobile, desktop, edge, ops, securitate, monetizare
**Durată estimată:** FAZA 29 → FAZA 50 (22 faze de lucru, ~20 workstream-uri)

---

# ⛔ CARTEA PROTECȚIEI — REGULA DE AUR (NICIODATĂ ÎNCĂLCATĂ)

Următoarele componente sunt **INTANGIBILE** pe toată durata planului 100X. Nicio fază, nicio sarcină, nicio subagent nu are voie să modifice, să șteargă, să rescrie sau să "refactorizeze" vreun byte din ele:

| # | Componentă protejată | Locație | Regulă |
|---|---------------------|---------|--------|
| 1 | **FAZA 18** — pipeline-ul de căutare cu 10 straturi | `modules/search/pipeline.js` | ZERO atingeri |
| 2 | **FAZA 20** — hub-urile reale (6 endpoints `/api/hub/*`) | `modules/hub/hub.js` | ZERO atingeri |
| 3 | **FAZA 21** — istoric, playlist-uri, statistici, admin-playerhub | `views/history, playlists, stats` + module backend | ZERO atingeri |
| 4 | **FAZA 23** — observabilitate (alerte, dashboards, synthetics, Prometheus) | `:4050` + `animaxia-ops/` | ZERO atingeri (doar strat aditiv nou) |
| 5 | **FAZA 24** — stabilitate globală (autoscaler, LB geo, failover, shaping) | `:4060` | ZERO atingeri (doar strat aditiv nou) |
| 6 | **FAZA 25** — produsele livrate | — | ZERO atingeri |
| 7 | **FAZA 28** — lansarea publică + fix-urile 28-E | `Caddyfile.faza28-live`, `edge-live/`, shims build | ZERO atingeri |
| 8 | **Motorul de căutare real** — Neon FTS (pg_trgm + FTS) | `modules/search/search.js` | ZERO atingeri de cod; optimizări doar pe straturile din JUR (cache, replici, infra) cu poartă de aprobare |
| 9 | **Simularea 30B** — logica de scară | `global-30b-view`, `sharding/` | ZERO atingeri |
| 10 | **Pipeline-ul real** (ingest → dedup → index) | `modules/ingest/`, `modules/miner/` nucleu | ZERO atingeri de logică; extinderi doar prin module NOI aditive |
| 11 | **Hub-ul real** | `modules/hub/` | ZERO atingeri |
| 12 | **Player-ul real** (FAZA 17) | `modules/player/player.js` + nucleul `player-view` | ZERO atingeri de nucleu; doar componente în jurul lui |
| 13 | **AI Hub (FAZA 16)** | `modules/ai/hub.js`, `ai-hub-view` | ZERO atingeri |
| 14 | **AI Home (FAZA 15)** | `modules/ai/home.js`, motorul metadata | ZERO atingeri |

**Principiul de execuție 100X:** fiecare îmbunătățire se construiește **ADITIV** — componente noi, endpoint-uri noi, module noi, servicii noi, straturi noi. Cele protejate sunt doar **consumate, observate și susținute infrastructural**. După fiecare fază, suitele de regresie existente (launch-faza28-infra 73, launch-qa 50, smoke-hubs 35, smoke-faza21 43, stability-faza24 94, smoke-observability 77, faza28-e-verify 40) trebuie să rămână **100% VERZI** — dovada obiectivă că nimic protejat nu s-a stricat.

---

# PARTEA I — VIZIUNEA 100X

## De unde plecăm (A-Z, starea de fapt)

**Animaxia** este o platformă de streaming completă, construită în 28+ faze, cu:

- **9 servicii live:** Frontend :3000 · Backend :4000 · Realtime :4010 · Watchdog :4020 · Redis :4030 · Gateway :4040 · Observability :4050 · Stability :4060 · Edge-live :8181/:8443/:8080 (+ Caddy preview :81)
- **Frontend SPA:** 25 views + 12 tab-uri admin, 9 grupuri de meniu, 28 categorii virtuale, 196 țări, player complet, social, AI, premium
- **Backend monolit:** 26 module (search, social, aicloud, cache, discover, sharding, platform, hub, sports, ops, analytics, news, observability, workers, movies, mobile, premium, tenant, ingest, tv, security, anime, player, users, miner, ai)
- **Surse de date reale:** Neon Postgres (141 titluri în bibliotecă), TMDB, Jikan (anime), TVMaze, RSS știri, F1/fotbal
- **Aplicații surori:** Mobile (Expo/React Native), Desktop (Electron), Edge (6 Cloudflare Workers), Ops (dashboards/alerte/runbooks/synthetics)
- **Lansare publică funcțională:** https://f1nue7cmtwz1-d.space-z.ai/ — frontend + lanț API complet, zero 502

## Unde mergem — 5 piloni ai transformării 100X

| Pilon | Astăzi | Ținta 100X |
|-------|--------|-----------|
| **1. Viteză & Fiabilitate** | p95 FTS 640ms (alertă activă), catalog 141 titluri, 1 regiune sandbox | p95 perceput < 100ms prin cache-edge, uptime public 99.9% sintetic, deploy continuu sigur |
| **2. Conținut & Catalog** | 141 titluri în bibliotecă, discover live TMDB | 100.000+ titluri indexate progresiv, metadate bogate (cast, trailere, episoade), poster/backdrop complet |
| **3. Experiență & Design** | UI funcțional dark, 25 views | Design system 2.0 cu motion, WCAG 2.1 AA, PWA instalabilă, i18n RO/EN, gamification |
| **4. Inteligență (AI nou)** | AI Hub + AI Home + AI Cloud (protejate) | 8 capabilități AI NOI aditive: companion, recap, mood, spoiler-shield, dublări, curation, asistent voce, AI editor |
| **5. Creștere & Monetizare** | Premium cu Stripe + plans, tenant/billing | Funnel complet: onboarding, abonamente, familii, cadouri, promoții, analytics de produs |

**Principiul de numărare 100X:** fiecare workstream definește o metrică-cheie cu valoare de azi și țintă multiplicată (ex: catalog ×700, viteză percepută ×6, feature-uri engagement ×10). "100x" înseamnă salt de ordin de mărime pe fiecare axă, obținut fără a strica nimic din ce există.

---

# PARTEA II — AUDITUL COMPLET A-Z (inventarul exact)

## A. Infrastructură & Servicii
| Serviciu | Port | Rol | Observații audit |
|----------|------|-----|------------------|
| Frontend (Next.js 16) | 3000 | SPA unică `/` | 25 views, bundle mare — split posibil |
| Backend (Bun + pg) | 4000 | API complet, 26 module | 1650+ cereri/0 erori; entry `server.js` + shims 28-E |
| Realtime (socket.io) | 4010 | social live, watch-party | shim PORT adăugat în 28-E |
| Watchdog | 4020 | respawn servicii | funcțional |
| Redis-global | 4030 | cache, spamlock, rate | RESP2, PING health |
| Gateway | 4040 | 3 regiuni, rate-limit, perimetru | hub 240/min, search 120/min |
| Observability | 4050 | metriți, alerte, synthetics 46/46 | alerta `fts-latency-high` FIRING (onest) |
| Stability | 4060 | autoscaler, LB geo, failover, shaping | 94/94 QA |
| Edge-live | 8181/8443/8080 | TLS+h2, failover chain, DNS alias | zero-502 prin construcție |
| Caddy preview | 81 | fereastra publică sandbox | mapare XTransformPort |

## B. Frontend web — 25 views
`home, recommendations, category, meta, aihub, content, player, search, auth, profile, premium, history, playlists, stats, social, feed, franchise, franchise-hub, edge, stability-lab, global-30b, scale-report, mobile, admin (12 tab-uri), news/status (pierdute în restaurarea FAZA 24 — de reconstituit)`

## C. Backend — 26 module grupate pe funcții
Căutare (protejat) · Social (7) · AI Cloud (8) · Cache · Discover · Sharding · Platform (10) · Hub (protejat) · Sport (2) · Ops · Analytics (2) · News RSS · Observability · Workers (4 task-uri) · Movies TMDB · Mobile · Premium (2) · Tenant (9) · Ingest · TV TVMaze · Security · Anime Jikan · Player (protejat nucleu) · Users (6) · Miner · AI (protejat)

## D. Date & Conținut
- Neon Postgres: **141 itemi** (58 filme, 21 ani, 25 genuri, 230 studiouri, 24 actori) — cel mai mare deficit față de promisiunea platformei
- Discover live: 28 slug-uri TMDB · Radio live · RSS știri · F1/fotbal
- Cache pipeline strat 9: 41–67% hit rate

## E. Aplicații surori
Mobile (Expo, 9 ecrane, offline video) · Desktop (Electron, mini-player, tray, updater, deep-link) · Edge (6 Workers: search, auth, analytics, player, ai, worker + cron miner) · Ops (15 dashboards, 12 runbooks, synthetics)

## F. Datorii tehnice cunoscute (oneste)
1. `fts-latency-high` FIRING — p95 640ms execuții Neon FTS (nu e 502, nu e infra)
2. Views FAZA 25–28 pierdute la restaurarea snapshot: `news-view`, `status-view`, `launch-banner` — de reconstituit
3. Catalog mic (141) vs. capacitate declarată 30B — gap de conținut real
4. Instanța publică FC separată de sandbox — orice schimbare trebuie să treacă prin pipeline-ul de build (lecția 28-E-2)

---

# PARTEA III — CELE 20 DE WORKSTREAM-URI 100X (FAZA 29 → FAZA 50)

> Fiecare workstream: țintă · acțiuni concrete · fișiere NOI (aditive) · KPI · protecție.

---

## WS1 — SĂNĂTATE PUBLICĂ & DEPLOY CONTINUU (P0) — FAZA 29 + 29-P + 30 + 31
*Integrează roadmap-ul deja convenit: curățare cod → performanță → stabilizare → operațional.*

**Ținta 100X:** de la "verificat manual după incident" → "zero regresie detectabilă automat în < 60s".

- **FAZA 29 — Curățare cod (igienă, zero logică):** eliminare cod mort neutilizat în fișiere NEprotejate, `bun run lint` curat, tipizare strictă la fișierele noi, deduplicare `tool-results/`, arhivare screenshot-uri fază în `docs/screenshots/`. Nu se atinge niciun fișier protejat.
- **FAZA 29-P — Performanță în jurul motorului protejat:** `fts-latency-high` se rezolvă 100% pe straturi ADITIVE: (a) cache warming programat pentru top-500 interogări populare (strat 9 existent — doar alimentat, nu modificat), (b) predicție prefetch pe hover card, (c) strat de cache edge-live pentru `q` repetate, (d) rutare read-replica Neon dacă e activată în cont. ⚠️ Poartă de aprobare: ORICE schimbare la nivelul indexului FTS/DB cere acordul TĂU explicit — planul nu o face singur.
- **FAZA 30 — Stabilizare:** soak test 24h cu synthetics, buget de eroare SLO 99.9%, remedieri doar pe componente noi.
- **FAZA 31 — Operațional:** runbook-uri noi pentru fiecare workstream 100X, rotunjirea suitei `faza28-e-verify.sh` într-un `health-public-100x.sh` zilnic, post-mortem template.
- **Reconstituire FAZA 25–28 pierdute:** views `news-view`, `status-view`, `launch-banner` recreate 1:1 după specificațiile din worklog (aditiv, în `views/`).

**KPI:** alerte infra verzi 24/7 · p95 căutare percepută < 200ms (cache) · suite regresie 100% verzi după fiecare fază.

---

## WS2 — CATALOG & CONȚINUT ×700 — FAZA 32
**Ținta 100X:** de la 141 titluri → **100.000+ titluri** indexate progresiv (×700), cu metadate complete.

- **Miner 2.0 (modul NOU `modules/catalog/` — minerul existent doar consumat):** orchestrator de ingestie în valuri pe pagini TMDB/Jikan/TVMaze (respectând rate-limit-urile surselor), coadă persistentă în Redis, job-uri rezumabile, progres vizibil în admin.
- **Îmbogățire metadate:** poster + backdrop de înaltă rezoluție, galerii imagini, trailere YouTube embed, cast complet cu poze, ghid episoade pentru seriale/anime, rating-uri multiple (TMDB/IMDb/MyAnimeList).
- **Dedup inteligent** prin fingerprint compus (titlu normalizat + an + sursă) — strat NOU înaintea ingest-ului protejat, care primește deja date curate.
- **Calitate:** badge "sursă" pe carduri, acoperire poster > 98%, trailer > 60% din titlurile populare.
- **UI nou:** pagina "Ce e nou în bibliotecă" + contor live în hero ("Biblioteca: 12.483 titluri").

**Fișiere noi:** `modules/catalog/orchestrator.js`, `modules/catalog/enrich.js`, `views/library-growth-view.tsx`, `admin/admin-catalog-tab.tsx`.
**KPI:** itemi indexați · acoperire poster/trailer/cast · timp mediu ingest/titlu.

---

## WS3 — CĂUTARE UX — STRAT NOU PESTE MOTORUL PROTEJAT — FAZA 33
**Ținta 100X:** de la "caut și aștept" → "caut și văd instant". Motorul Neon FTS rămâNE INTACT — se construiește doar stratul de experiență deasupra.

- **Autocomplete instant** (endpoint NOU `/api/search/suggest` cu debouncing 150ms, cache Redis 60s pe prefix, trending din istoric anonimizat) — consumă același API de căutare, nu-l modifică.
- **Căutare universala (Cmd+K / Ctrl+K):** command-palette globală cu navigare rapidă views + căutare conținut + acțiuni ("redonează ultimul", "pornește playlist-ul X").
- **Filtre & fațete:** gen, an, rating, sursă, tip — aplicate client-side + prin parametri existenți.
- **Istoric & salvate:** căutările mele recente, căutări salvate, sugestii "greseală de tastare?" (fuzzy pe stratul de sugestie, NU în motor).
- **Rezultate bogate:** carduri cu scor relevanță vizual, highlight termeni, grupare Filme/Seriale/Anime.

**Fișiere noi:** `views/search-view` extensii aditive în componente copil, `components/animaxia/command-palette.tsx`, backend `modules/searchux/` (doar proxy + cache spre API-ul protejat).
**KPI:** timp până la primul rezultat vizibil < 300ms · rata abandon căutare < 15% · adopție Cmd+K > 30% sesiuni.

---

## WS4 — PLAYER EXPERIENCE — STRAT ADITIV — FAZA 34
*Player-ul real (FAZA 17) rămâNE neatins. Se construiesc doar componente în jurul lui.*

- **Subtitle studio:** stilizare subtitrări live (font, mărime, culoare, fundal, poziție) cu preview — setările se salvează în profil.
- **Markeri episod:** skip-intro / skip-outro / recap — date marker livrate de endpoint NOU, randate ca butoane temporale în dock.
- **Mini-player persistent:** la navigare în interiorul SPA, redarea continuă într-un dock colapsabil (componentă NOUă care găzduiește player-ul existent, nu-l înlocuiește).
- **Watch-together 2.0:** UI polish pe watch-party (participanți cu avatare, chat sincronizat, vot următorul episod) — doar stratul de prezentare peste realtime-ul existent.
- **Scurtături extinse + help overlay** (tasta "?").
- **"Continuă de unde ai rămas" global:** banner de resume pe home cu poziția exactă (consumă istoricul protejat FAZA 21, nu-l modifică).

**Fișiere noi:** `components/animaxia/player/subtitle-studio.tsx`, `player/markers.tsx`, `player/mini-dock.tsx`, `player/shortcuts-help.tsx`.
**KPI:** utilizare skip-intro > 50% din redări cu markeri · sesiuni cu watch-together +20% · completare redări +15%.

---

## WS5 — AI NOI — 8 CAPABILITĂȚI ADITIVE — FAZA 35
*AI Hub (16), AI Home (15), AI Cloud — toate protejate. Se adaugă module NOI, pe lângă, care le consumă.*

1. **AI Companion** — chat contextual pe titlu ("de ce s-a terminat așa?", "ce înseamnă cutare referință") cu RAG peste sinopsis/recenzii.
2. **AI Recap** — "ce ai ratat": rezumatul ultimelor episoade vizionate înainte de a porni episodul nou.
3. **AI Mood Playlists** — "ce vreau seara asta": playlist generat din dispoziție (relaxat, captivant, nostalgic) peste bibliotecă.
4. **AI Spoiler Shield** — filtrează comentariile/recenziile care conțin spoilere pentru ce n-ai văzut încă.
5. **AI Dublare & Subtitrări** — generare subtitrări traduse RO pentru conținut fără (prin SDK), cu editor de corectură în admin.
6. **AI Curation Notes** — "de ce îți recomandăm" — explicație pe scurt de pe cardul de recomandare.
7. **AI Voice** — căutare și comenzi vocale (ASR) + descriere audio (TTS) pentru accesibilitate.
8. **AI Editor de Liste** — transformă o descriere liberă ("thrillere coreene lungi") într-un playlist real.

**Fișiere noi:** `modules/ainew/{companion,recap,mood,shield,dubbing,curation,voice,editor}.js` + `views/ai-lab-view.tsx` (hub separat, AI Hub neatins).
**KPI:** utilizatori care folosesc ≥1 AI nou/săptămână · rating utilitate AI > 4/5 · subtitrări generate/ore conținut.

---

## WS6 — PERSONALIZARE & RECOMANDĂRI 2.0 — FAZA 36
- Profil de gust învățat pasiv (genuri, epoci, durată sesiune) — serviciu NOU separat.
- "Pentru Tine" cu secțiuni explicite: Fiindcă ai văzut X · Asezonat cu gustul tău · Gap-uri din francizele tale.
- Profile multiple per cont (Copii, Familie, Petrecere) cu PIN.
- Memento-uri de încheiere: seriale lăsate la 1 episod de final.
- **Zero atingeri la recomandările existente** — strat nou de prezentare și ranking aditiv.

**KPI:** CTR secțiuni personalizate · diversitate titluri accesate · profiluri multiple activate.

## WS7 — SOCIAL & COMUNITATE 2.0 — FAZA 37
- Recenzii cu rating structurat + "util?", sortare, filtrare spoilere (leagă AI Shield).
- Follow + cronologie unificată (activitatea prietenilor: a văzut, a adăugat la listă, a lansat watch-party).
- Clubs & dezbateri pe francize (Marvel, anime etc.) cu moderare.
- Citate & momente favorite partajabile (card imagine cu citat + timestamp).
- Turnee de predicții pe evenimente live (F1/fotbal — sursele există deja).

**KPI:** utilizatori activi social/săptămână · recenzii/titlu · participare watch-party.

## WS8 — GAMIFICATION — FAZA 38
- XP & nivele pentru activități reale (vizionări finalizate, recenzii utile, participare party).
- Insigne pe categorii reale ale platformei (Maratonist, Călător Global — 196 țări, Colecționar Francize).
- Streak-uri săptămânale + misiuni sezoniere ("Toamna Anime").
- Clasamente pe insigne + tabloul de bord personal (views NOU `#/achievements`).
- Cinematică de nivel-up (framer-motion) — feedback vizual bogat.

**KPI:** DAU/WAU · retenenție 30 zile · misiuni completate/utilizator.

## WS9 — NOTIFICĂRI & ENGAGEMENT — FAZA 39
- Centru de notificări in-app (clopoțel cu istoric, marcate citite).
- Email digest săptămânal personalizat (mailer-ul există — strat nou de conținut).
- Web Push (PWA) pentru: episod nou din serialul urmărit, watch-party invitație, pret lista Mea intră în bibliotecă.
- Setări granulare pe categorii de notificare (profilul are deja NotificationSettings în mobile/desktop — se aduce la paritate pe web).

**KPI:** rata de deschidere digest · reactivare utilizatori adormiți · notificări blocate < 10%.

## WS10 — DESIGN SYSTEM 2.0 — FAZA 40
- Fundament vizual 2.0: scară tipografică, spațiere, elevație, radii — tokens centralizați (globals.css, componente rămân shadcn/ui).
- Motion language: tranziții unificate (durations/easings), page-transitions în router, hover micro-interactions pe carduri, skeleton shimmer.
- **Teme noi:** pe lângă dark — "Midnight Purple", "Cinema Contrast" (accesibil), light rafinat; comutator în profil.
- Accesibilitate WCAG 2.1 AA audit + remedieri: contrast, focus vizibil, navegare tastatură completă, sr-only, ARIA pe componente interactive.
- Modele de densitate (comfort/compact) pentru grid-uri lungi + scrollbar custom.
- Empty states ilustrate, states de eroare prietenoase, mesaje de loading cu personalitate ( mascot Animaxia).

**KPI:** Lighthouse Accessibility > 95 · zero violări contrast · scor satisfacție UI.

## WS11 — PERFORMANCE WEB 100X — FAZA 41
- Code-splitting pe views (dynamic import în router) — bundle inițial −40%.
- Virtualizare listele lungi (196 țări, categorii mari) — randare doar vizibilul.
- Image pipeline: `next/image` cu sizes responsive, lazy + blur placeholder, AVIF/WebP.
- Prefetch inteligent: la hover pe card → prefetch detaliu; la seara cu trafic mic → prefetch recomandări.
- Web Vitals în productie legat la observabilitatea existentă (strat aditiv de span-uri browser — otel-browser există, doar extins cu noi măsători).

**KPI:** LCP < 1.5s · INP < 100ms · CLS < 0.05 · bundle JS inițial < 200KB gzip.

## WS12 — PWA & OFFLINE — FAZA 42
- Manifest complet + instalare (manifest.webmanifest există — adus la standard installability: icons full-set, shortcuts, screenshots).
- Service worker 2.0: shell offline, cache stale-while-revalidate pentru browse, queue offline pentru "adaugă la listă".
- Pagina offline friendly (offline.html există — îmbogățită cu identitate vizuală).
- "Descarcă pentru mai târziu": poster + metadate + (unde e permis) video offline-test pattern ca MVP (mobile are deja util offline — adus la paritate web).

**KPI:** instalări PWA · sesiuni pornite offline · rata de revenire utilizatori instalați.

## WS13 — I18N — RO/EN (+extins) — FAZA 43
- next-intl (deja în deps) activat: RO implicit, EN complet, structură pentru alte limbi.
- Traducere toate views-urile NEprotejate (cele protejate primesc wrapper de traducere în jurul textelor, fără a le modifica fișierul sursă — textele printr-un strat de mesaje extern aditiv).
- Formatare date/numere localizată + selector de limbă în profil + persistență.

**KPI:** acoperire traduceri > 98% · utilizatori EN activi măsurați.

## WS14 — MOBILE APP 2.0 — FAZA 44
- Paritate views noi 100X (gamification, notificări push native EAS, AI Lab).
- Performanță listare (FlatList optimizată, imagini cache native).
- Deep links + universal links pe animaxia.live.
- EAS Build pipeline documentat (eas.json există) + build intern testat.

**KPI:** timp pornire app < 2s · crash-free sessions > 99.5% · rating magazine interne.

## WS15 — DESKTOP APP 2.0 — FAZA 45
- Mini-player global (deja există — extins cu media keys OS + always-on-top opțional).
- Updater complet testat (updater.js există) cu canal beta.
- Scurtături globale OS (play/pause globală) + tray îmbunătățit.
- Auto-fill login OS keychain (tokenStore există — strat keytar opțional aditiv).

**KPI:** sesiuni medii desktop · utilizare scurtături globale.

## WS16 — SECURITATE & HARDENING — FAZA 46
- Promovare 2FA (TOTP există — onboarding clar + recovery codes UI).
- Management sesiuni active (dispozitive, revoke individual).
- Audit log admin (cine, ce, când) — tabel nou + vizualizare în admin.
- CSP strict + SRI pe asset-urile publice, headers prin edge-live (config aditivă în twin edge, Caddyfile.faza28-live doar extins cu directive noi, existentul neatins).
- Secret rotation: `.env-deploy.mjs` regenerat cu chei noi versionate, chei vechi revocate controlat.
- Raport securitate intern trimestrial + rezolvare automată a dependințelor (bun audit).

**KPI:** conturi cu 2FA > 25% · zero vulnerabilități critice cunoscute · 100% acțiuni admin auditate.

## WS17 — ADMIN & CMS 2.0 — FAZA 47
- Tab nou "Conținut": coada de ingestie WS2, aprobare/editare metadate, corectare postere.
- Moderation queue unificată (comentarii, recenzii, raportări) cu acțiuni în masă.
- **Feature flags** per funcționalitate 100X — pornește/oprește fără deploy (tabel + endpoint + SDK mic frontend).
- **A/B testing** simplu (variantă A/B pe home & carduri, măsurat în analytics).
- Comunicate platformă: banner global (launch-banner reconstituit devine sistem de anunțuri).

**KPI:** timp mediu de moderare · experimente lansate/săptămână · zero deployuri doar pentru comutatoare.

## WS18 — MONETIZARE & PREMIUM 2.0 — FAZA 48
- Planuri restructurate: Free (cu ads-onesting simulator onest), Basic, Premium, Familie (6 profiluri) — plans.js există, se extinde aditiv.
- Promoții & prețuri regionale, cupoane, cadou abonament.
- Paywall elegant cu preview de valoare (ce deblochează, primele 30 zile).
- Facturare & istoric plăți self-service.
- Upsell onest: niciodată pe funcțiile de bază existente — doar pe cele noi 100X.

**KPI:** conversie trial→plătit > 8% · ARPU · churn lunar < 5%.

## WS19 — ANALYTICS & PRODUCT INTELLIGENCE — FAZA 49
- Funnel complet: vizitare → înregistrare → prima redare → abonat.
- Cohort & retenție pe săptămâni.
- Heatmap colectiv anonimizat pe views (evenimente, nu screenshots).
- Dashboard produs în admin (admin-analytics-tab există — tab nou aditiv "Product").
- Toate evenimentele trec prin analytics-ul existent (modul consumat, nu modificat).

**KPI:** timp la primă redare < 10 min pentru utilizator nou · decizii de produs lansate din date/lună.

## WS20 — EDGE & GLOBAL ACCELERATION — FAZA 50
- Cele 6 Workers Cloudflare (cod există în `animaxia-edge/`) — documentat deploy real cu wrangler, mapat pe `animaxia.live`.
- Cache "everything" la edge pentru discover/metadata (TTL-uri pe slug), purge programat la ingestie.
- Geo acceleration: rutare regiune cea mai apropiată prin gateway-ul existent (config aditivă).
- HTTP/3 + 0-RTT acolo unde platforma permite (extindere config edge, nucleul neatins).

**KPI:** TTFB global median < 100ms · hit-rate edge > 70% pe discover · utilizatori deserviți < 50ms de un POP.

---

# PARTEA IV — ROADMAP-UL DE EXECUȚIE (ordine & dependențe)

```
2026 Q4  ── FAZA 29  (curățare)      ─┐
            FAZA 29-P (perf cache)    ├─ P0: sănătate + fundație
            FAZA 30  (stabilizare)    │
            FAZA 31  (operațional)    │
            FAZA 25-28 reconstituire ─┘
              │
2026 Q4–2027 Q1 ── FAZA 32 (catalog ×700) ──▶ paralel: FAZA 41 (perf web)
              │
2027 Q1 ── FAZA 33 (căutare UX) ─▶ FAZA 34 (player strat) ─▶ FAZA 36 (personalizare)
              │
         FAZA 35 (AI noi — poate începe în paralel cu 33/34)
              │
2027 Q1–Q2 ── FAZA 37 (social 2.0) ─▶ FAZA 38 (gamification) ─▶ FAZA 39 (notificări)
              │
         FAZA 40 (design 2.0 — continuu, trase prin toate)
              │
2027 Q2 ── FAZA 42 (PWA) ─▶ FAZA 43 (i18n) ─▶ FAZA 44 (mobile 2.0) ─▶ FAZA 45 (desktop 2.0)
              │
2027 Q2–Q3 ── FAZA 46 (securitate) ─▶ FAZA 47 (admin/CMS) ─▶ FAZA 48 (monetizare)
              │
2027 Q3 ── FAZA 49 (analytics) ─▶ FAZA 50 (edge global) ──▶ ✅ PLAN 100X COMPLET
```

**Reguli de ordonare:**
1. P0 (29–31 + reconstituire) nu se amână niciodată — fundația sănătoasă.
2. Catalog (32) și perf web (41) pornesc primele — toate celelalte cresc în valoare peste un catalog bogat și rapid.
3. Fazele marcate "paralel" pot rula în subagenți simultan (task-uri a/b/c) cu worklog sincronizat.
4. Design 2.0 (40) se aplică incremental în fiecare fază, nu ca rescriere la final.

---

# PARTEA V — PROTOCOLUL DE EXECUȚIE (cum se lucrează fără să strici nimic)

1. **Sprint per fază:** fiecare FAZA = analiză → plan detaliat → implementare aditivă → QA → raport cu declarație fixă.
2. **QA obligatoriu după fiecare fază:** toate suitele de regresie protejate + suite noi per workstream; orice roșu blochează faza următoare.
3. **Zero atingeri:** orice fișier din Cartea Protecției apare în diff → faza e respinsă automat.
4. **Rate-limit discipline:** toate probele respectă bucket-urile (search 120/min, hub 240/min, ai 60/min, repeat 30/min).
5. **Worklog:** fiecare task (subagenți inclusiv) citește și scrie în `worklog.md` cu ID de fază.
6. **Deploy public:** fiecare fază trece prin pipeline-ul de build al platformei (lecția FAZA 28-E-2: verify public, nu doar localhost) — suite `health-public-100x.sh` pe instanța publică înainte de "gata".
7. **Aprobările tale:** fazele cu ⚠️ (ex: orice atingere DB-level, prețuri finale, limbi noi) se opresc și cer confirmare explicită.

---

# PARTEA VI — TABLOUL KPI 100X (înainte → după)

| Metrică | Astăzi | Țintă 100X |
|---------|--------|-----------|
| Titluri în bibliotecă | 141 | 100.000+ |
| p95 căutare percepută | 640ms (alertă) | < 200ms (cache+edge) |
| Bundle JS inițial | monolit | < 200KB gzip (−40%) |
| Lighthouse Accessibility | neauditat | > 95 |
| LCP (4G) | neauditat | < 1.5s |
| Capabilități AI | 3 familii (protejate) | +8 noi aditive |
| Limbi | RO | RO + EN (+extins) |
| Instalabilitate | browser only | PWA + mobile + desktop |
| Feature flags | 0 | toate funcțiile 100X |
| Suite regresie | ~420 check-uri | ~420 + 200 noi |
| Uptime public monitorizat | verificare manuală | sintetic 24/7 + alerte |

---

# PARTEA VII — RISCURI & MITIGĂRI

| Risc | Probabilitate | Mitigare |
|------|---------------|----------|
| Atingere accidentală a componentei protejate | Medie | Cartea Protecției în promptul fiecărui subagent + verificare diff automată + suite regresie |
| Rate-limit surse externe (TMDB/Jikan) la ingestie mare | Mare | Orchestrator cu valuri + backoff + cote pe sursă |
| Catalog mare → căutare mai lentă | Medie | Paginare + cache warming; FTS-ul protejat primește interogări deja filtrate |
| Instanța publică divergentă față de sandbox | Medie | Suite publice după fiecare fază (protocol V.6) |
| Scope creep (plan prea mare) | Mare | P0 primele, apoi valuri; fiecare fază independent lansabilă |
| Costuri AI (SDK) la scară | Medie | Cote per utilizator + cache răspunsuri + feature flags de cost |

---

# PARTEA VIII — CE NU FACE PLANUL (oneste)

- NU rescrie, NU refactorizează, NU "îmbunătățește" niciun fișier protejat — nici măcar o linie.
- NU atinge indexul FTS/DB fără aprobarea ta explicită (poarta ⚠️ din FAZA 29-P).
- NU introduce middleware nou de caching extern (MySQL/Redis extern) peste stack-ul existent.
- NU alterează pretențiile oneste ale platformei (30B rămâne simularea protejată; biblioteca reală raportează numere reale).
- NU execută nimic din acest document fără comanda ta explicită per fază.

---

## SUMAR EXECUTIV (12 rânduri)

1. **20 workstream-uri · 22 faze (29→50) · 0 atingeri ale componentelor protejate.**
2. P0 = sănătate: curățare, performanță în jurul motorului, stabilizare, operațional + reconstituirea views pierdute 25–28.
3. Cel mai mare salt: catalog ×700 (141 → 100.000+) prin miner 2.0 aditiv cu respectarea surselor.
4. Căutarea devine instant prin strat UX nou (autocomplete, Cmd+K) — motorul FTS intact.
5. Player-ul primește strat bogat (subtitrări stilizate, skip-intro, mini-player) fără o linie modificată în nucleu.
6. 8 AI noi (companion, recap, mood, spoiler-shield, dublări, curation, voce, editor) pe lângă AI-ul protejat.
7. Engagement complet: social 2.0, gamification cu XP/insigne/misiuni, notificări & digest.
8. Design System 2.0 + WCAG 2.1 AA + teme noi, aplicat incremental.
9. Performance: bundle −40%, virtualizare, AVIF, prefetch — LCP < 1.5s.
10. PWA instalabilă + offline; mobile & desktop aduse la paritate 2.0.
11. Securitate (2FA, audit, CSP), Admin/CMS cu feature flags & A/B, monetizare cu familii/cadouri, analytics de produs, edge global Cloudflare.
12. Fiecare fază: aditivă, regresie verde, verificată public, aprobată de tine înainte de următoarea.

---

*PLAN 100X ANIMAXIA — v1.0. Statut: PLANIFICARE COMPLETĂ. Nicio componentă protejată nu a fost atinsă. Niciun fișier al platformei nu a fost modificat la redactarea acestui plan. Execuția începe doar la comanda ta, per fază.*
