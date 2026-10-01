# Task 19-3a — Frontend: mini-player global + resume (Player Hub FAZA 19)

## Ce am făcut
- **player-dock.tsx (NOU)**: `PlayerDockProvider` + `usePlayerDock()` → `{ docked, minimizeToDock, restore, close }`; `PlayerDock` = aside fixed bottom-4 right-4 z-50 w-80 sm:w-96 cu `<VideoStage>` reutilizat (mp4/m3u8, initialTime=startedAt, salvare progres ~10s), titlu + „Extinde" (POST progress + navigate /player/:id) + „Închide" (salvare + close). Ascuns pe /player/:id cu același contentId. Doar in-memory cross-navigare (fără persistență la reload, by design).
- **player-controls.tsx**: prop `onPause` aditiv pe VideoStage (apelat doar la pauză reală, nu la ended).
- **player-view.tsx**: resume banner „Continuă de unde ai rămas" (ofertă > 15s și ≤ 3600s; „Continuă redarea" = remount cu initialTime+autoPlay; „Începe de la început" = discard; auto-dismiss la primul play; autoPlay suprimat cât oferta e pending, cu protecție de cursa autoplay-vs-fetch prin playedOnceRef); salvare progres la pause + unmount (stageTimeRef) + minimize; buton „Minimizează" în top-bar doar pentru mp4/m3u8; watchdog FAZA 17 re-înarmat la remount resume (stageNonce în deps).
- **page.tsx**: PlayerDockProvider (în AuthProvider) + `<PlayerDock />` între main și Footer.

## QA
- tsc: 0 erori src; eslint (4 fișiere): 0; dev.log curat.
- Live: login f19admin2 → #/player/2 play ~15s → Minimizează → #/home → dock redă de la 15s (faza19-minidock.png) → Extinde → POST /api/playerhub/progress 200 → banner „Ai oprit la 0:38" (faza19-resume.png) → Continuă → reia la 40s → reload → banner „0:48". 0 erori consolă.

## Pentru agenții următori (19-3b/19-4)
- Dock-ul nu are playlist/queue încă — starea e `DockState` în player-dock.tsx, extensibilă.
- `VideoStageHandle` expune doar getCurrentTime/getDuration — dacă 19-3b are nevoie de play/pause imperativ, extindeți useImperativeHandle aditiv.
- Resume banner: pragurile sunt 15s/3600s în player-view.tsx (efectul de fetch progres).
- Dock + player principal diferit pot coexista (spec: doar același contentId ascunde dock-ul) — audio dublu posibil dacă userul redeschide alt titlu cu dock activ; de decis la 19-3b dacă se pauzează dock-ul.
