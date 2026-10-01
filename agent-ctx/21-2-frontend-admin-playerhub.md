# Task 21-2 — Frontend admin: tab „Player Hub" în admin-view

Task ID: 21-2
Agent: Z.ai Code (agent FAZA 21-2 — frontend admin Player Hub)
Date: 2026 (sesiune FAZA 21)

## Ce am construit

Tab nou „Player Hub" în panoul admin (deep-link `#/admin/playerhub`), cu date
100% reale din /api/playerhub (FAZA 19-1). STRICT ADITIV: o componentă nouă
+ tab nou; tab-urile existente neatinse.

## Fișiere

- `src/components/animaxia/admin/admin-playerhub-tab.tsx` NOU (~700 linii):
  - Header: „Player Hub — FAZA 19" + badge v19.1 + „6 funcționalități" +
    chips features (din /status) + indicator „API: /api/playerhub".
  - 4 gauge-uri (Playlist-uri / Itemuri / Trackuri subtitrări / Intrări
    istoric) din /stats totals — auto-refresh 5s cu pauză la document.hidden
    (pattern admin-workers-tab).
  - Card „Activitate 7 zile" — activePlaylistsLast7d din secțiunea admin a
    /stats (Bearer token; mesaj onest dacă secțiunea lipsește).
  - Card „Top continue-watching" — 5 rânduri (thumbnail + titlu + TypeBadge,
    click → /content/:id).
  - Card „Gestionare subtitrări" (ADMIN): formular attach (contentId, label,
    lang, textarea VTT cu placeholder-ul cerut) cu validare client (WEBVTT
    prefix, lang regex, id întreg >0) + toast; sub formular listare „Trackuri
    pe contentul X" (input separat + „Listează") cu rânduri {label, lang, id}
    și „Șterge" per rând cu AlertDialog (pattern playlists-view 21-1:
    preventDefault până la DELETE complet, spinner „Se șterge…").
  - Card „Istoricul meu de redare": continue-watching (primele 8 — thumbnail,
    titlu, „progress: mm:ss", badge „Resume disponibil", surse) + „Vezi tot"
    → #/history.
  - LockCard românesc pentru non-admin (pattern admin-analytics-tab).
- `src/lib/animaxia/api.ts` (ADITIV, 4 metode noi sub comentariu FAZA 21
  task 21-2): playerHubStats, playerHubContinueWatching,
  playerHubAttachSubtitle, playerHubDeleteSubtitle (toate cu authHeaders;
  listarea publică refolosește playerHubSubtitles din 19-2).
- `src/lib/animaxia/types.ts` (ADITIV): PlayerHubStatsResponse (cu admin?
  opțional) + PlayerHubContinueWatchingItem.
- `src/components/animaxia/views/admin-view.tsx` (ADITIV, 5 puncte): import
  AdminPlayerHubTab + icon MonitorPlay; deep-link routeTab 'playerhub' în
  lanțul de ternare (după search-full); TabsTrigger „Player Hub" între
  „Search Full" și „Providers"; TabsContent corespunzător; doc-comment.

## QA static

- `bunx tsc --noEmit` → 0 erori în src/ (doar oglinzile pre-existente
  animaxia-30b/desktop/edge/mobile — documentate în worklog).
- `bunx eslint` pe cele 4 fișiere atinse → 0 probleme.
- dev.log curat (doar GET / 200).

## QA browser (agent-browser, ~25 comenzi)

- Login f19admin2@animaxia.test / F21Frontend!2026 (butonul „Sign in" DIN
  FORMULAR — nu cel din navbar) → redirect #/home.
- `#/admin/playerhub` → tab activ „Player Hub", header complet (v19.1,
  6 funcționalități, chips, API indicator), gauge-uri reale 1/2/1/85.
- „Activitate 7 zile" = 1 (secțiunea admin returnată cu token admin).
- „Top continue-watching" = Big Buck Bunny, Sintel, Crew Girl, The Long
  Watch, President Curtis (reale).
- „Istoricul meu de redare" = Big Buck Bunny „progress: 00:10" + Sintel
  „progress: 00:52" cu badge „Resume disponibil".
- Attach test: contentId 2, label „QA 21-2", lang „en", VTT valid scurt →
  toast succes, track id 14 creat; listare pe 2 în UI îl arată.
- Ștergere prin AlertDialog („Ștergi trackul „QA 21-2"?" → „Șterge
  definitiv") → listare UI „Niciun track", curl `{"data":[]}` — CURAT.
- Auto-refresh 5s verificat: gauge-ul „Trackuri subtitrări" a revenit la 1
  (baseline) după ștergere, fără reload.
- Negativ: VTT invalid („Acesta nu este un fisier VTT valid") → blocat pe
  client, ZERO requesturi POST (curl rămâne gol).
- „Vezi tot" → #/history ✓.
- 0 erori consolă, 0 page errors; mobile 390×844 fără overflow orizontal
  (scrollWidth 390 = clientWidth 390).
- Screenshot full: `agent-ctx/faza21-admin-playerhub.png`.

## Note pentru agenții următori

- Parola f19admin2@animaxia.test rămâne **F21Frontend!2026** (din 21-1).
- Trackul de test QA a fost șters — contentul 2 are 0 trackuri; baseline
  subtitleTracks global = 1 („Română" pe content 3, demo funcțional din
  FAZA 19).
- api.ts are acum 15 metode playerHub* + helper playerHubSubtitleUrl.
