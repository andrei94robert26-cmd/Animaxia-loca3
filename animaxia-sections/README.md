# Animaxia — FAZA 21: Secțiuni UI Complete (meniuri sidebar)

FAZA 21 completează secțiunile UI ale platformei: 3 pagini noi pentru
utilizatori + 1 tab admin nou — toate cu date 100% REALE din API-urile
FAZA 19/20. Strict aditiv; regulile de aur intacte (30B logic neatins,
pipeline FAZA 15–18 neatins, player extern real neatins).

## Pagini noi

### #/history — „Istoricul Meu" (`history-view.tsx`)
- Auth-only (EmptyState + „Conectează-te" pentru anonimi).
- Istoricul real din `/api/users/me/history` + badge Player Hub.
- „Continuă vizionarea" (primele 6 cu progress > 10s) cu Play direct —
  playerul FAZA 19 reia automat de la progres (banner „Ai ostop la mm:ss").
- Tabs Toate / Filme / Seriale / Anime; timestamp relativ în română.

### #/playlists — „Playlist-urile Mele" (`playlists-view.tsx`)
- Auth-only. Playlist-urile reale din `/api/playerhub/playlists`.
- Carduri cu firstItemThumbnail, {n} titluri, expand inline cu lista de
  itemuri, „Redă primul", ștergere cu AlertDialog.
- Badge „Max 20 playlist-uri · salvate în Neon".

### #/stats — „Statistici Platformă" (`stats-view.tsx`, PUBLIC)
- 6 gauge-uri reale din `/api/hub/stats` (conținut, utilizatori,
  vizualizări, comentarii, playlist-uri, subtitrări).
- Angajament: topWatched / topRated / mostLiked (3 coloane).
- Card onește „Date reale vs. capacitate logică": 100 contenturi reale în
  Neon · 30.000.000.000 capacitate logică simulată · 30 shard-uri logice.
- Ultimele 7 zile + „Ce e nou" (3 surse din `/api/hub/feed`).

## Tab admin nou: #/admin/playerhub — „Player Hub" (`admin-playerhub-tab.tsx`)
- Badge v19.1 + 6 features + 4 gauge-uri live (auto-refresh 5s, pauză la
  tab hidden) din `/api/playerhub/stats`.
- „Activitate 7 zile" (secțiune admin), „Top continue-watching".
- **Gestionare subtitrări** (admin): atașare track WebVTT pe orice content
  (validare client WEBVTT/lang/id) + listare + ștergere cu AlertDialog.
- „Istoricul meu de redare" (8 intrări cu badge „Resume disponibil").
- LockCard pentru non-admin.

## Integrare
- `menu.ts`: +3 intrări în grupul „Cont" (Istoricul Meu, Playlist-urile
  Mele, Statistici Platformă) cu iconițe History / ListMusic / BarChart3.
- `page.tsx`: +3 case-uri în renderView.
- `admin-view.tsx`: +tab „Player Hub" (MonitorPlay) + deep-link.
- `api.ts` + `types.ts`: +8 metode / +7 tipuri hub.

## QA
- tsc 0 erori în src/ · eslint 0 pe fișierele atinse.
- Browser: #/stats public cu date reale · auth-gate pe #/history și
  #/playlists · istoric cu resume funcțional („Ai oprit la 0:52") ·
  playlist expandat cu acțiuni · admin tab cu attach/list/delete track
  (curat după QA) · 0 erori consolă · responsive 390×844 fără overflow
  (fix min-w-0 pe grid items cu titluri truncate).
- Regresii: pipeline FAZA 15–18 + playerhub + health — intacte.

## Structură

```
animaxia-sections/
├── README.md
└── frontend/src/
    ├── app/page.tsx                                  ← +3 case-uri (aditiv)
    ├── components/animaxia/
    │   ├── views/history-view.tsx                    ← NOU
    │   ├── views/playlists-view.tsx                  ← NOU
    │   ├── views/stats-view.tsx                      ← NOU
    │   ├── views/admin-view.tsx                      ← +tab Player Hub
    │   └── admin/admin-playerhub-tab.tsx             ← NOU
    └── lib/animaxia/
        ├── menu.ts                                   ← +3 intrări Cont
        ├── api.ts                                    ← +8 metode
        └── types.ts                                  ← +7 tipuri
```

FAZA 21 — COMPLETĂ ✅ Dezvoltare reală, simularea 30B intactă
