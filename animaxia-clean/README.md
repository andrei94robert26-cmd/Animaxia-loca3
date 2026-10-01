# animaxia-clean — CURĂȚAREA TOTALĂ a platformei

**Starea înainte:** FAZA 20 + FAZA 21 complete, cu reziduuri QA acumulate în fazele 5–21
(177 utilizatori sintetici de test, 3 itemi demo, rânduri de test în content, tenanți demo).

**Starea după:** platformă 100% reală, 100% API-driven. Fiecare rând afișat în UI vine
din Huburile API reale sau a fost creat prin acțiuni reale ale utilizatorilor reali.

## Ce a fost eliminat (fake / demo / test / placeholder)

### Frontend (`src/`)
- `auth-view.tsx` — `DEMO_ACCOUNT` (credențiale demo hardcodate) + chip-ul „Use demo admin"
- `admin-view.tsx` — `MINER_PRESETS` (URL-uri demo one-click) + hint „Demo admin: …"
- `admin-analytics-tab.tsx`, `admin-security-tab.tsx`, `admin-workers-tab.tsx` — hint-uri „Demo admin: …"
- `player-view.tsx` — `EXTERNAL_EXAMPLES` (rickroll YouTube / MP4 demo / HLS demo)
- `ai-view.tsx` — `DESCRIBE_EXAMPLES` (titluri fictive „Neon Requiem", „Flour & Feelings")
- `mobile-view.tsx` — `AI_QUOTA_CHIPS` (cote hardcodate prezentate ca „live")
- `home-ai-feed.tsx` — starea inițială placeholder `{totalPages: 50, totalItems: 1000}`
- `footer.tsx` — „built for demonstration purposes" → positioning real
- Șters: `src/app/api/route.ts` (scaffold „Hello, world!"), `src/lib/db.ts` (scaffold Prisma nefolosit)

### Backend (`mini-services/animaxia-backend/`)
- `seed.js` — `DEMO_ITEMS` → `OPEN_MOVIES`: itemul „Animaxia HLS Demo" (streamuri de test
  Apple BipBop + Mux) eliminat; Big Buck Bunny + Sintel re-etichetate onest
  `demo:*` → `blender:*` (filme reale Blender Foundation, MP4 reale); `added.demo` → `added.openmovies`
- `server.js` — linia de boot actualizată; directiva eslint inutilă eliminată
- `db.js` — `stripSslParams()`: warning-ul de boot pg-connection-string (sslmode) eliminat definitiv
- `modules/tenant/tenant-migrations.js` — seed-ul tenant-ului 'demo' eliminat (rămâne doar 'global')
- `tests/smoke-playerhub.mjs` — fixture `contentId: 3` (itemul HLS demo șters) → `contentId: 1` (BBB real)
- Șterse scripturi one-off: `tests-faza10-quick.mjs`, `q16a-check.mjs`;
  în `animaxia-realtime`: `test-quick.mjs`, `hook-e2e.mjs`
  (suitele smoke-*.mjs rămân — sunt QA-ul de record al fazelor protejate)

### Baza de date Neon (curățare tranzacțională, FK-cascade)
- **177 utilizatori sintetici** de QA (`*@synth.animaxia`, `s10*_@test.dev`, `edge-e2e-*`,
  `rate-smoke-*`, `fe-test-*`, `t8b-*`, …) + toate datele lor: 20 comentarii, 3 like-uri,
  6 follow-uri, 27 watchlist, 83 watchhistory, 24 review-uri, 8 subscripții, 29 watch party-uri,
  32 aichats, 14 agentconversations, 23 aiprofiles, 146 aiusagelogs
- **Păstrați (reali):** `admin@animaxia.test`, `iri20rob94@gmail.com` (cont real),
  `f19admin2@animaxia.test` (adminul documentat)
- Content: `demo:hls-stream` (id 3) + `shard-smoke-*` (id 1537) eliminate; BBB/Sintel re-etichetate
- Tenanții `demo` + `acme` (QA FAZA 11) eliminați — rămâne `global`
- `contentsources` golit (5 rânduri QA: example.com, rickroll, test:16a, t16b)
- 15 itemi reali fără etichetă `source` — backfill onest după externalid (tmdb/miner)

## Ce a rămas EXACT cum era (protejat)

- FAZA 20 — 9 rute `/api/hub` + QA smoke-hubs **35/35** (rulat de 2× pe starea finală)
- FAZA 21 — #/history, #/playlists, #/stats, #/admin/playerhub (verificate în browser)
- Motorul de căutare REAL Neon FTS (sync 112/112 documente, `pipelineIntegrated: true`)
- Playerul REAL (BBB/Sintel MP4 redate live în browser, readyState 4)
- Pipeline-ul FAZA 15–18: 10 stages + stressTest 10000 passed (contract pinned)
- 30B logic: capacityClaim `30000000000`, sharding 30×1B, feed global O(1)
- Playlistul FAZA 19 (1 playlist / 2 itemi — fixture real cerut de QA)
- 167 viewevents anonime reale + istoricul real al lui f19admin2 (alimentează resume)

## Procese

- 6 instanțe `bun --watch` duplicate ale backend-ului (tripletul port-race + respawns watchdog)
  → **1 instanță**; serviciul realtime (atârnat după ~18h idle) repornit curat;
  watchdog activ pe :4020.

## QA final (după curățare, pe starea finală)

| Suită | Rezultat |
|---|---|
| smoke-hubs (FAZA 20) | 35/35 ✓ |
| smoke-playerhub (FAZA 19) | 53/53 ✓ |
| smoke-sharding (FAZA 13–14) | 47/47 ✓ |
| smoke-searchflow (FAZA 15) | 61/61 ✓ |
| smoke-searchrate (FAZA 16) | 58/58 ✓ |
| smoke-searchopt (FAZA 17) | 53/53 ✓ |
| smoke-searchfull (FAZA 18) | 43/43 ✓ |
| smoke-social realtime (FAZA 10) | 83/83 ✓ |
| **Total** | **433/433 ✓** |

tsc: 0 erori în `src/` · lint: 0 probleme în `src/` · browser: 0 erori consolă,
0 overflow la 390×844, player real redat, toate paginile cu date live.
