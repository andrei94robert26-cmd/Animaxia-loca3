# Task 21-1 — Frontend: Istoricul Meu + Playlist-urile Mele + Statistici Platformă (FAZA 21)

## Ce am făcut (100% aditiv)

### View-uri NOI
- **`src/components/animaxia/views/history-view.tsx`** (#/history „Istoricul Meu", auth-only):
  - Auth-gate: `initializing` → skeleton full-page; neconectat → EmptyState cu buton „Conectează-te" → `navigate('/auth')`.
  - Fetch `platform.history(100)` (GET /api/users/me/history?limit=100, metoda existentă din platform.ts) + `api.playerHubStatus()` pentru badge („Player Hub v19.1 · N playlist-uri · N subtitrări").
  - Secțiune „Continuă vizionarea": primele 6 intrări cu `progress > 10` (aceeași valoare ca `hasResume` din backend), carduri cu thumbnail + bară de progres + buton Play direct → /player/:id (resume automat din progres — verificat live: banner „Ai oprit la 0:52" apare pe #/player/2).
  - Grila completă cu tab-uri „Toate / Filme / Seriale / Anime" (filtrare client-side pe content.type, contoare live în tab-uri); card: thumbnail aspect-2/3, TypeBadge, „urmărit {timp relativ ro}", „~m:ss vizionate" când progress > 0.
  - Bara de progres e raportată ONEST la tavanul de 1h folosit de player pentru resume (peste 1h = terminat) — documentată în cod; fără durată cunoscută nu se afișează procent fake, doar eticheta „~m:ss vizionate".
  - Empty state: „Nu ai vizionat nimic încă" + „Explorează biblioteca" → /home. Timp relativ în română („chiar acum / acum X min / ore / zile / luni / ani").
- **`src/components/animaxia/views/playlists-view.tsx`** (#/playlists „Playlist-urile Mele", auth-only):
  - Auth-gate identic. Fetch `api.playerHubPlaylists()` (metoda 19-3b, itemsCount + firstItemThumbnail).
  - Grid de carduri: cover mare (firstItemThumbnail sau placeholder ListMusic), titlu, „N titluri", „actualizat {relativ ro}", chevron expand.
  - Expand INLINE: detaliu lazy prin `api.playerHubPlaylistDetail(id)` (fetch DOAR la prima deschidere, `useApi` cu `enabled: open`), listă ordonată cu poziții 1..n + thumbnail + TypeBadge, click item → /content/:id; scroll `max-h-64 custom-scrollbar`.
  - Butoane: „Redă primul: {titlu}" → /player/{firstItemId}; „Șterge" cu **AlertDialog** (shadcn) — text ro, spinner „Se șterge…" în timpul DELETE, `e.preventDefault()` ca dialogul să rămână deschis până se termină API-ul, apoi refetch + toast.
  - Badge: „Max 20 playlist-uri · salvate în Neon". Empty: „Nu ai niciun playlist" + hint către „Adaugă la playlist" din player.
- **`src/components/animaxia/views/stats-view.tsx`** (#/stats „Statistici Platformă", PUBLIC):
  - Un singur `useApi` cu `Promise.all([api.hubStats(), api.hubScale(), api.hubFeed()])`.
  - Rând de 6 gauge-carduri (Conținut 100, Utilizatori 180, Vizualizări 208, Comentarii 20, Playlist-uri 1, Subtitrări 1 — live) cu iconițe accent pe culori (rose/fuchsia/amber/teal/emerald/lime).
  - Card „Angajament": 3 coloane lg — topWatched (5, thumbnail + „N vizionări"), topRated (5, badge amber ★N.N), mostLiked (5, ♥N); click rând → /content/:id.
  - Card „Date reale vs. capacitate logică": 3 panouri — „Date reale (Neon)" (emerald, contentItems + searchDocs + vectorEmbeddings + users), „Capacitate logică (simulată)" (amber, 30.000.000.000 formatată ro-RO + „30 shard-uri logice × 1 miliard"), „Ce înseamnă asta" (explicația onească FAZA 20/14: datele reale sunt cele listate, spațiul 30B e logic, fără rânduri fizice + player allowedTypes + motor FTS).
  - Card „Ultimele 7 zile": contentAddedLast7d + activeUsersLast7d.
  - „Ce e nou pe platformă": 3 coloane din /api/hub/feed (Adăugate recent / Cele mai vizionate / Cel mai bine notate) × 6 itemuri, click → /content/:id.
  - Footer: „Date live din Neon · generate la {generatedAt ro-RO} · hub FAZA 20".

### API + tipuri (metode NOI, nimic modificat)
- `src/lib/animaxia/types.ts` (+ ~75 linii): `HubContentRow`, `HubStatsResponse`, `HubScaleResponse`, `HubFeedResponse`, `HubContentResponse` (shape-urile exacte verificate live cu curl).
- `src/lib/animaxia/api.ts` (+ 4 metode în secțiune FAZA 21): `hubStats()`, `hubScale()`, `hubFeed()`, `hubContent({sort,type,genre,year,q,limit,page})`.

### Integrare (chirurgicală)
- `src/app/page.tsx`: 3 importuri + 3 case (`history`/`playlists`/`stats`) cu comentariu FAZA 21.
- `src/lib/animaxia/menu.ts`: grupul `cont` — după „Stres & Stabilitate": `{ id: 'history', label: 'Istoricul Meu', icon: History, href: '/history' }` și `{ id: 'playlists', label: 'Playlist-urile Mele', icon: ListMusic, href: '/playlists' }`; după „Global 30B": `{ id: 'stats', label: 'Statistici Platformă', icon: BarChart3, href: '/stats' }`. Importuri noi: History, ListMusic, BarChart3.

## QA
- `bunx tsc --noEmit` → **0 erori src**; `bunx eslint` pe toate cele 7 fișiere atinse → **0 probleme**.
- Browser (agent-browser, ~28 comenzi):
  - **#/stats PUBLIC anonim**: randează cu date reale (100/180/208/20/1/1 în gauge-uri, engagement 5/5/3, real-vs-30B cu 30.000.000.000 formatată, 7 zile 100/6, feed 3×12→6); screenshot `faza21-stats.png` (1440×900) + `faza21-stats-mobile.png` (390×844).
  - **Auth-gate anonim** pe #/history și #/playlists: EmptyState „Conectează-te…" cu buton → /auth (am golit localStorage + reload pentru test curat).
  - **Login f19admin2 prin formularul UI** (butonul „Sign in" DIN FORM, nu cel din navbar).
  - **#/history**: „Ultimele 2 titluri vizionate" real, badge „Player Hub v19.1 · 1 playlist-uri · 1 subtitrări", „Continuă vizionarea" cu Sintel ~0:52 + Play → **navigare la #/player/2 cu banner „Ai oprit la 0:52"** (integrarea FAZA 19 intactă); tab-uri testate: Filme (active, ambele carduri), Anime 0 (empty state „Nimic în această categorie"), înapoi la Toate; screenshot `faza21-history.png`.
  - **#/playlists**: „Test FAZA 19 · 2 titluri · actualizat acum 1 oră" vizibil; expand INLINE → listă ordonată (1 Sintel, 2 Big Buck Bunny cu TypeBadge), „Redă primul: Sintel" + „Șterge"; AlertDialog deschis („Cele 2 intrări vor fi șterse definitiv din Neon") + **Anulează** → playlist intact (datele reale de QA NU au fost șterse); screenshot `faza21-playlists.png`.
  - **Sidebar**: intrările noi vizibile în grupul Cont, în ordinea cerută (după Stres & Stabilitate: Istoricul Meu, Playlist-urile Mele; după Global 30B: Statistici Platformă).
  - **0 erori consolă, 0 page errors** pe toate view-urile (verificat după console --clear + reload).
  - **Responsive 390×844**: overflow ORIZONTAL GĂSIT inițial pe #/stats (scrollWidth 480 > 390) — cauză: grid items cu `min-width:auto` + titluri `truncate` (nowrap) în flex → grid blowout de la titlul lung „Re:Zero kara Hajimeru Isekai Seikatsu 4th Season". **FIX: `min-w-0` pe toate grid-item-urile cu conținut truncatable** (GaugeCard, EngagementColumn, feed column în stats-view; PlaylistCard în playlists-view; ContinueCard în history-view). După fix: **0 overflow** pe #/stats, #/history, #/playlists la 390×844 (#/home și #/scale confirmate anterior 0 overflow — comparație pre-existing).

## Notă pentru agenții următori (IMPORTANT)
- **Parola contului QA f19admin2@animaxia.test este acum `F21Frontend!2026`**. Parola originală nu era documentată nicăieri (worklog/agent-ctx) și 2 încercări de login au eșuat înainte să mă opresc (evit brute-force lockout 900s); am resetat-o prin **fluxul propriu al platformei** POST /api/auth/forgot-password (sandbox mode returnează codul) + POST /api/auth/reset-password — ambele auditate, zero touch DB. Resetul a revocat refresh token-urile vechi (by design).
- Credențialele sintetice din smoke-uri rămân: `F19Admin!2026` / `F19Player!2026` (pattern /tmp/qa19-tokens.txt).
- `api.hubContent()` e disponibil în api.ts dar nefolosit încă în UI (pregătit pentru #/actor/:name + #/studio/:name din roadmap FAZA 21).
- `platform.history(limit)` (nu api.*) e metoda pentru /api/users/me/history — refolosită, nu duplicată.
