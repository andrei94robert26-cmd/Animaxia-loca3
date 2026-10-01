# Task 19-4a — QA backend: Player Hub smoke suite

Agent: QA backend (FAZA 19-4a)
Target: `mini-services/animaxia-backend/tests/smoke-playerhub.mjs` (NOU, 605 linii) + 2 rulări complete pe monolitul :4000 (backend existent, nerepornit).

## Ce am făcut
1. Citit worklog secțiunile 19-0…19-3b, pattern-ul `tests/smoke-searchfull.mjs` (header/helper-e/record/promoteAndLoginAdmin/structură secțiuni/final non-zero exit) și sursa completă `modules/player/hub.js` (731 linii, 18 rute) + `modules/users/profile.js` (istoric) + montările din `server.js`.
2. Verificat live înainte de scriere: backend :4000 sănătos (postgres connected, 99 items), `/api/playerhub/status` contract, content 2 fără trackuri de subtitrări (limita 8 nu interferează), ruta reală de player extern = `GET /api/content/:id/player` (grep server.js linia 402 — `/api/player/:id` NU există; `/api/player/external` e altcebază — resolverul universal FAZA 14).
3. Scris suita zero-dependențe (bun-native fetch; `pg` doar pentru promovarea admin QA, ca în pattern), cu identități rotative `10.79.x.y` unice per request (limitatorul global 120/60s/IP neatins), helper-e `getJson/postJson/patchJson/deleteJson/getText`, `record()` cu ✓/✗, exit non-zero la orice eșec, output final `PLAYERHUB SMOKE: X passed, Y failed`.
4. Suita acoperă EXACT specificația: A contracte publice (status hub/version/6 features/totals 3 chei, subtitles public, stats + top ≤5, 4× 401 anon); B playlists CRUD complet (create 201 + 400 titlu 1 char/fără titlu, listare itemsCount, add + 404 content + dedupe 200 duplicate:true, detaliu poziții, reorder valid [3,2] + set greșit [3,999] → 400, PATCH, izolare user 2 → 404, DELETE, limita 20 → al 21-lea 409, cleanup integral + verificare listă goală); C progress unificat (saved:true, progress=137+watchedat, DOVADA prin /api/users/me/history, continue-watching shape complet, -5 → 400, 999999 → 404 GET+POST, DELETE reset → 0, 401 anon); D subtitles admin (attach 201 cu track.id, listare publică, servire VTT cu Content-Type text/vtt + corp WEBVTT/"Salut QA", non-admin 403, vtt invalid 400, lang "x1!" 400, DELETE 200 + re-DELETE 404); E regresii (pipeline 15–18: pipelineIntegrated + 10 etape + stressTest.concurrent 10000; health ok+db.connected; /api/content/2/player cu allowedTypes).

## Rezultat
- Rularea 1: **53 passed, 0 failed** (prima iterație completă — zero fix-uri necesare).
- Rularea 2 (stabilitate): **53 passed, 0 failed**, EXIT=0.
- Curățenie: totals post-rulare identice cu baseline-ul pre-rulare (playlists=1 — „Test FAZA 19" de la 19-3b, playlistItems=2, subtitleTracks=2 — trackul QA știars), content total 99 nemodificat, progresul userului QA resetat prin API, zero erori noi în log (ultimele [ERROR] sunt artefacte vechi 12:38–12:39 + un 400 „Invalid cursor" de la alt client la 14:17, înaintea suitei).
- Singurul output non-check: warning de deprecare SSL din `pg-connection-string` la promovarea admin (identic cu pattern-ul smoke-searchfull, benign, nu afectează exit code-ul).
- Bug-uri REALE găsite: **niciunul**. Toate cele 18 rute se comportă exact conform contractului din 19-1 (401/403/404/409/400 inclusiv).

## Notă pentru agenții următori
- Suita se rulează cu `bun tests/smoke-playerhub.mjs` din `mini-services/animaxia-backend` (DATABASEURL se încarcă din .env pentru promovarea admin).
- Ruta de regresie player este `/api/content/:id/player` (NU `/api/player/:id`).
