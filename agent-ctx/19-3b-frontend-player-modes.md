# Task 19-3b — Frontend: Player modes (playlist queue + preview + endgame)

Task ID: 19-3b
Agent: Z.ai Code (agent FAZA 19-3b — frontend player modes)

## Ce am construit

### A. Mod playlist în player (`#/player/:id`)
- `src/components/animaxia/player/playlist-queue.tsx` (NOU):
  - `usePlaylistContext(contentId)` — fetch REAL /api/playerhub/playlists (auth), apoi GET detaliu DOAR pentru primele 6 playlist-uri (sortate desc după `updatedat` — backend-ul face bump la orice add/remove/reorder, deci playlist-ul proaspăt modificat e mereu în top; NOTĂ ONESTĂ documentată în fișier: un titlu aflat într-un playlist recent neatinse din afara top-6 nu generează coadă, dar cardul „Adaugă la playlist" listează COMPLET playlist-urile). Expune: queues, activeQueue, setActiveQueue, allPlaylists, current, next, prev, addToPlaylist, createAndAdd, removeItem, reload, loading, error.
  - `PlaylistQueue` — card „Coadă de redare": itemuri (thumbnail + titlu + TypeBadge + "#N în coadă"), badge „ACUM" pe itemul curent, click item → /player/:id, butoane SkipBack/SkipNext (navigate la prev/next), selector de coadă (chips) când titlul e în >1 playlist-uri, buton X (hover) per item → DELETE item + toast; listă max-h-[70vh] custom-scrollbar.
  - `AddToPlaylistCard` — neautentificat: card login (→ /auth); autentificat: buton expand → listarea playlist-urilor existente (click → POST items + toast succes/dedupe info) + input „Playlist nou…" + buton „Creează" (POST playlists → POST items → toast + reload, panel se strânge).
  - `NextUpCountdownOverlay` — overlay absolute inset-0 z-30 peste VideoStage: „Următorul în X secunde — {titlu}", bară de progres, butoane „Redă acum"/„Anulează", countdown 5s (interval 1s, guard firedRef), framer-motion fade/scale; la 0 → navigate /player/:id.
- Integrare `player-view.tsx` (CHIRURGICAL): hook + `queuePanel` (PlaylistQueue când queues>0, altfel AddToPlaylistCard) în `<aside aria-label="Playlist">`; grid `lg:grid-cols-[minmax(0,1fr)_340px]` (player col 1, coadă col 2, items-start; pe mobil stivuit sub player); container lărgit la max-w-7xl când panelul există; overlayele reset la schimbarea id; `handleStageEndgame()` apelat în onEnded EXISTENT (trackComplete + handleStageEnded rămân).
- Decizie A-vs-C (prioritate coadă): coadă activă CU next item → countdown (A) doar dacă `settings.autoplayNext`; coadă FĂRĂ next (sau fără coadă) → overlay „Ce urmează?" (C); coadă cu next + autoplayNext off → nimic (respectă setarea).

### B. Preview mode — hover pe content cards
- `src/components/animaxia/content-preview.tsx` (NOU): wrapper `ContentPreview` — hover-capable doar cu `matchMedia('(hover: hover) and (pointer: fine)')` (pe mobil NU apare deloc; SSR-safe: fals la prima randare prin macrotask); dwell 600ms → popover absolut w-64 z-40 (framer-motion scale/fade) cu thumbnail aspect-video, titlu, tip+an, RatingBadge, overview 2 linii, butoane „Redă" (→ /player/:dbId dacă există dbId, altfel comportamentul normal al cardului) și „Detalii" (comportamentul normal de click); închidere la mouse leave cu grace 150ms; poziționare inteligentă above/below + clamp orizontal la viewport.
- Integrare `content-card.tsx` (ADITIV, non-breaking): cele 3 rădăcini (div/a/button) învelite în `<ContentPreview>`; când dispozitivul NU e hover-capable → fragment pur (cardul fix ca înainte, ZERO layout change); popover-ul e SIBLING al rădăcinii cardului → click-ul normal pe card NU e blocat; hover trailer-ul FAZA 15 și atributele AI rămân intacte.

### C. Recomandări la finalul redării (fără coadă activă)
- `src/components/animaxia/player/endgame-recommendations.tsx` (NOU): `EndgameRecommendationsOverlay` — „Ce urmează?" cu grid 3×2 (2 col pe mobil) thumbnail+titlu din `platform.aiPersonalPlayer(contentId).moreLikeThis` (dedupe by id, primele 6), click → /player/:id; butoane „Reia de la început" (remount VideoStage de la 0 cu autoplay) și „Închide"; framer-motion fade-in + stagger pe carduri.
- Refolosește `useApi` cu ACEEAȘI cheie `player-ai-${contentId}` ca PlayerAiCompanion; componenta se montează DOAR când overlay-ul devine vizibil → zero requesturi suplimentare în timpul redării normale (la „ended" cererea lovește cache-ul backend cald de la companion). NOTĂ ONESTĂ: useApi nu are cache partajat între instanțe — cererea de la ended e a doua cerere, dar cache-uită server-side.

### Suport API (aditiv)
- `types.ts`: PlayerHubPlaylistItem + PlayerHubPlaylistDetailResponse.
- `api.ts`: playerHubPlaylists / playerHubCreatePlaylist / playerHubPlaylistDetail / playerHubDeletePlaylist / playerHubAddPlaylistItem / playerHubRemovePlaylistItem / playerHubReorderPlaylist (toate cu authHeaders).

## QA
- `bunx tsc --noEmit` → 0 erori în src/; `bunx eslint` pe toate cele 7 fișiere atinse → 0 probleme (1 error initial „setState in effect" în content-preview — fixat cu patternul macrotask din useApi).
- Browser (port 81, sesiune f19-3b): login f19admin2 OK → #/player/2: card „Adaugă la playlist" → „Playlist nou" → „Test FAZA 19" → toast + COADA APARE cu Sintel „ACUM" #1 (grid 760px player + 340px coadă la viewport 1440) → screenshot faza19-playlist-queue.png → #/player/1: adăugat la playlistul existent prin UI → coadă 2 titluri (BBB „ACUM" #2) → #/player/2 seek la final → video ended → COUNTDOWN „Următorul în X secunde — Big Buck Bunny" (faza19-countdown.png) → auto-navigare la #/player/1 LA 0 → #/player/1 seek la final (ultimul item din coadă) → OVERLAY „Ce urmează?" cu recomandări reale + Reia/Închide (faza19-endgame.png) → re-trigger countdown pe player 2 → „Anulează" oprește navigația ✓ → #/home hover card (matchMedia patched în headless — Chrome headless raportează hover:hover=false, pe desktop real e true) → POPOVER 256×288 cu Redă/Detalii, poziționat above/below inteligent (faza19-preview.png), închide la mouse leave ✓ → sesiune separată anon: card login pe player ✓. 0 erori consolă, 0 page errors, dev.log curat.
- NOTĂ QA: headless Chromium nu raportează `(hover: hover)` — testul B a necesitat patch runtime pe matchMedia (doar în sesiunea de test, zero impact pe codul de producție).

## Stare lăsată
- Playlist-ul „Test FAZA 19" (id 22, user f19admin2, 2 itemuri: Sintel + Big Buck Bunny) a rămas în Neon — date reale de user,无害 pentru platformă (utilizabil pentru demo-uri QA următoare).
- Netouchate: search/pipeline/30B/backend, fallback chain FAZA 17, external FAZA 14, VideoStage/mini-dock/resume (19-2/19-3a), AI trailer hover.
