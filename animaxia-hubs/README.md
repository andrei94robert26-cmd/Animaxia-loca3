# Animaxia — FAZA 20: Hub-uri API Complete

FAZA 20 livrează hub-urile API complete ale platformei Animaxia — 9 rute
100% REALE (agregări SQL peste datele reale din Neon), strict aditive.
Regulile de aur intacte: spațiul logic 30B simulat neatins, pipeline-ul de
căutare FAZA 15–18 neatins, playerul extern real neatins.

## Rute — `modules/hub/hub.js` (mount: `app.use('/api/hub', cacheMiddleware(), hubRouter)`)

| Rută | Ce face |
|---|---|
| `GET /api/hub/content` | Faceted browse real: filtre `type`/`genre`/`year`/`q` (ILIKE titlu) + sortări `recent`/`rating`/`title`/`popular` (viewevents) + paginare + **facets calculate pe setul filtrat** (types/genres top 30/years top 30) |
| `GET /api/hub/stats` | Statistici publice: totals (content/byType/users/comments/watchlist/watch/playlists FAZA 19), engagement (topWatched/topRated/mostLiked), recency (7 zile) |
| `GET /api/hub/scale` | Scară ONESTĂ: datele reale (contentItems, searchDocs, vectorEmbeddings, users, 30 shards logici) alături de claim-ul logic 30B + allowedTypes live din player + pipelineIntegrated live |
| `GET /api/hub/years` | Ani lansare: {year, count, sample ≤3 thumbnails} — jsonb real |
| `GET /api/hub/genres` | Genuri: {genre, count, sample} — array_to_string pe metadata->genres |
| `GET /api/hub/actors` | Actori: {actor, count, sample} — metadata.actors (există real pe titlurile minate) |
| `GET /api/hub/studios` | Studiouri: metadata.studios (real pe 2 titluri; SQL-ul suportă cast/studio/network pentru viitor) |
| `GET /api/hub/feed` | 3 surse reale într-un apel: recent / popular / rated (12 fiecare) |
| `GET /api/hub/recommendations` | 12 recomandări publice reale: genul cel mai vizitat global + backfill onest din top-ul global (split fromGenre/backfilled raportat) |

## Oneștețe arhitecturală

- Hub-ul de conținut NU este motorul de căutare — `q` e simplu ILIKE pe titlu
  (browse/facets); full-text search rămâNE 100% în pipeline-ul FAZA 15–18
  (Neon FTS real, 10 etape, neatins).
- Hub-ul de scară raportează datele REALE alături de claim-ul logic 30B —
  exact filosofia platformei (30B = spațiu logic simulat, datele reale sunt
  în `content`, `searchdocs`, `vectorembeddings`).
- Coverage actori/studiouri raportat onest în răspunsuri (metadata reală
  conține actori pe titlurile minate — 2/100 la livrare).

## QA

- `tests/smoke-hubs.mjs` — **35 checks / 6 secțiuni**: content faceted (10,
  inclusiv cache MISS→HIT real), stats (5), scale (6 — consistență internă
  contentItems === stats.totals.content cu cache-busting), facets (7 —
  cross-check Drama 27 === 27 Δ0), feed+recommendations (4 — 12 distincte),
  regresii (3 — pipeline 10 etape + health + playerhub). **35/35 passed.**
- Regresii de platformă: /api/search/status pipelineIntegrated:true ·
  /api/health ok · /api/playerhub/status 19.1 intact.

## Structură

```
animaxia-hubs/
├── README.md                        ← acest fișier
├── monolith/
│   ├── modules/hub/hub.js           ← 9 rute hub (666 linii)
│   ├── server.js                    ← mount /api/hub (aditiv)
│   └── tests/smoke-hubs.mjs         ← 35 checks QA
```

FAZA 20 — COMPLETĂ ✅ Dezvoltare reală, simularea 30B intactă
