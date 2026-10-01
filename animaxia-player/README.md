# Animaxia — FAZA 19: Player Avansat (Player Hub + Player v2)

FAZA 19 dezvoltă complet playerul platformei Animaxia — totul 100% REAL,
cu regulile de aur intacte: spațiul logic 30B simulat neatins, motorul de
căutare Neon FTS neatins (pipeline-ul FAZA 15–18 intact), playerul extern
real (YouTube/Vimeo/Rumble/MP4/HLS/iframe) neatuns în nucleu — doar extins.

## Ce conține această fază

### Backend — Player Hub API (`monolith/modules/player/hub.js`)
- **3 tabele noi reale în Neon**: `playlists`, `playlistitems` (UNIQUE per
  playlist+content), `subtitletracks` — migrări idempotente aditive în
  `modules/platform/migrations.js` (44/44 statements OK).
- **18 rute** pe `/api/playerhub`:
  - `GET /status` — contract public (features + totals + user count)
  - `GET /continue-watching` — ultimele 12 din istoric cu progress + hasResume
  - Playlists CRUD complet: creare (limită 20/user), listare cu itemsCount +
    firstItemThumbnail, detaliu cu items ordonate, PATCH, DELETE, adăugare
    item (dedupe + limită 200/playlist), eliminare cu renumerotare, reorder
    cu validare de set exact — izolare strictă pe proprietar
  - Progress/resume: `GET /progress/:contentId`, `POST /progress` (upsert în
    **watchhistory** — istoric unificat cu FAZA 1: `/api/users/me/history`
    vede aceleași intrări), `DELETE /progress/:contentId`
  - Subtitles WebVTT: listare publică, servire track cu
    `Content-Type: text/vtt` + cache 1h, atașare/ștergere doar admin cu
    audit log (limite: 8 trackuri/content, VTT ≤256KB, `WEBVTT` obligatoriu)
  - `GET /stats` — totals publice + top continue-watching + secțiune admin
- Eveniment platformă `playlist:changed` în bus-ul existent.

### Frontend — Player v2
- **`player-controls.tsx`** — `VideoStage`: control bar custom complet
  (play/pause, timeline cu buffered + scrub, volum, viteză 0.25×–2×,
  subtitrări WebVTT reale din Player Hub, calitate HLS reală prin nivelurile
  hls.js, fullscreen, PiP, skip ±10s), shortcuts tastatură (Space/K, ←/→,
  ↑/↓, M, F, C, S, I) cu popover-help „?", auto-hide 2.8s, mod cinema cu
  overlay dim + container extins.
- **`player-dock.tsx`** — mini-player global persistent: minimizează redarea
  mp4/HLS într-un dock fixat bottom-right care SUPRAVIEȚUIE navigării între
  pagini, cu „Extinde" (salvează progres + revine la player) și „Închide".
- **`playlist-queue.tsx`** — mod playlist: coadă laterală cu playlist-urile
  reale care conțin titlul curent (badge „ACUM", next/prev, auto-play next cu
  countdown 5s anulabil) + card „Adaugă la playlist" (playlist existent sau
  creare nouă).
- **`endgame-recommendations.tsx`** — overlay „Ce urmează?" la finalul redării
  cu 6 recomandări reale (aiPersonalPlayer) când nu există coadă activă.
- **`content-preview.tsx`** — mod preview: popover la hover pe cardurile de
  conținut (desktop, delay 600ms) cu thumbnail, meta, rating, overview și
  acțiuni rapide „Redă"/„Detalii".
- **Resume + salvare progres** în `player-view.tsx`: banner „Continuă de unde
  ai rămas" („Ai oprit la mm:ss") cu „Continuă redarea"/„Începe de la
  început", salvare automată la 10s + pause + unmount + minimize — numai
  mp4/HLS (embed-urile nu expun timpul).
- **`player-settings.ts`** — setări persistente localStorage: autoplayNext,
  defaultSpeed, cinemaMode, preferredSubtitleLang, volume, muted, saveProgress.

## Regulile de aur (verificate în QA)

- Pipeline-ul de căutare FAZA 15–18: `pipelineIntegrated: true`, 10 etape,
  stressTest passed — **regresii complete trecute** (smoke-searchfull 43/43,
  smoke-searchopt 53/53, smoke-searchrate 58/58, smoke-searchflow 61/61,
  smoke-sharding 47/47).
- Feed global 30B + sharding logic 30×1B: neatinse.
- Playerul extern real (modules/player/player.js): neatins — hub.js doar
  stă alături; resolveExternalSource/resolvePlayer byte-identice.
- Fallback chain FAZA 17 + external URL FAZA 14 + AI companion + miner:
  intacte în player-view.

## QA

- `tests/smoke-playerhub.mjs` — **53 checks** (contracte publice, playlists
  CRUD complet cu limite și izolare, progres + istoric unificat, subtitrări
  admin + servire VTT, regresii pipeline/health/player extern).
- tsc 0 erori în src/ · eslint 0 probleme pe fișierele atinse · browser:
  0 erori consolă, calea de aur completă (login → resume banner → coadă
  playlist → redare cu controale custom), responsive 390×844 fără overflow.

## Structură

```
animaxia-player/
├── README.md                                    ← acest fișier
├── monolith/
│   ├── modules/player/hub.js                    ← Player Hub API (18 rute)
│   ├── modules/platform/migrations.js           ← +3 tabele +3 indici (aditiv)
│   ├── modules/platform/events.js               ← +playlist:changed (aditiv)
│   ├── server.js                                ← mount /api/playerhub (aditiv)
│   └── tests/smoke-playerhub.mjs                ← 53 checks QA
└── frontend/src/
    ├── app/page.tsx                             ← PlayerDockProvider (aditiv)
    ├── components/animaxia/
    │   ├── player/player-controls.tsx           ← VideoStage (control bar v2)
    │   ├── player/player-dock.tsx               ← mini-player global
    │   ├── player/playlist-queue.tsx            ← coadă + add-to-playlist
    │   ├── player/endgame-recommendations.tsx   ← „Ce urmează?"
    │   ├── content-preview.tsx                  ← hover preview
    │   ├── content-card.tsx                     ← integrare preview (aditiv)
    │   └── views/player-view.tsx                ← integrare completă (aditiv)
    └── lib/animaxia/
        ├── player-settings.ts                   ← setări persistente
        ├── types.ts                             ← tipuri PlayerHub (aditiv)
        └── api.ts                               ← metode playerHub (aditiv)
```

FAZA 19 — COMPLETĂ ✅ Dezvoltare reală, simularea 30B intactă
