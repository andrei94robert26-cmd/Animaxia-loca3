# Task ID: 15-2 — FAZA 15 Search Flow Control frontend (agent context record)

Task: Admin tab `#/admin/search-flow` for the Search Flow Control console (queue gauges, chart, priorities, per-shard table, admin runtime settings form).

## What was delivered

Files:
- **NEW** `src/components/animaxia/admin/admin-search-flow-tab.tsx` — the full console (see structure below).
- **MOD** `src/lib/animaxia/types.ts` — new types `SearchFlowPriorityKey`, `SearchFlowControlStatus`, `SearchWindowingStatus`, `SearchFlowConfig`, `SearchFlowHistoryPoint`, `SearchFlowShardStats`, `SearchFlowConsole`; `SearchStatus` extended with optional `flowControl?` / `windowing?` (additive, existing consumers untouched).
- **MOD** `src/lib/animaxia/api.ts` — `api.searchFlow()` next to `searchStatus` (typed `SearchFlowConsole`; apiUrl adds `XTransformPort=4000`, verified).
- **MOD** `src/components/animaxia/views/admin-view.tsx` — `Waves` icon import, `AdminSearchFlowTab` import, `TabsTrigger value="search-flow"` after Shards, `TabsContent`, `routeTab` chain extended with `'search-flow'` (pattern identical to shards).
- Menu step SKIPPED: `src/lib/animaxia/menu.ts` has no admin deep-links (verified — `#/admin/shards` isn't there either).

Tab structure (Romanian labels, zinc/emerald/amber/rose, zero blue/indigo):
1. Emerald banner: „Căutările rămân 100% reale" — coada doar programează fluxul către Neon, FTS byte-identic FAZA 14; priorități high/normal/low + aging anti-înfometare (low→normal 2s, normal→high 5s).
2. Live gauges strip (7 cards, auto-refresh 2s): Coadă, În execuție (inflight/maxConcurrent), Respinate + Expirate (chip emerald „0 țintă" / roșu >0), Procesate (+rată/s), Wait p50/p95, Queue high-water. Extra windowing strip (ferestre declanșate / dispatch-uri / medie batch / max per fereastră).
3. Config cards (5): Max concurrent, Interval fereastră, Batch size, Queue cap, Max wait.
4. Chart recharts (shadcn ChartContainer/ChartTooltip): Area „În coadă" (amber #f59e0b) + „În execuție" (emerald #10b981), X=HH:MM:SS, istoric 180 eșantioane sortate cronologic; empty → „Fără activitate încă".
5. Priorities: HIGH (amber) / NORMAL (zinc) / LOW (zinc-muted) — coadă curentă + procesate + wait p50 + text policy + respinse (doar >0); chip aging în header.
6. Per-shard table: 30 rânduri, `custom-scrollbar max-h-[32rem] overflow-y-auto`, coloane Shard / În coadă / În execuție / Procesate / Respinate; rânduri active amber, dropped>0 roșu.
7. Settings form (admin-only): 4 inputs (Max concurrent 1..2000, Interval ms 10..2000, Batch size 1..1000, Queue cap 100..500000) prefilled din config (re-sync doar când formularul nu e dirty), validare client + notă că validarea/clamping-ul e pe server; POST `/api/search/flow/settings?XTransformPort=4000` prin `authRequest` (Bearer + auto-refresh); 401/403 → toast „Setările fluxului necesită cont de administrator"; succes → „Setări salvate" + refetch; non-admin → notă amber read-only.

## QA (all green)
- `bunx tsc --noEmit`: **0 erori în src/** (erorile rămase sunt pre-existente în animaxia-30b/ + animaxia-desktop/, în afara src/).
- `bunx eslint` pe cele 4 fișiere atinse: **0 probleme**.
- dev.log curat (0 erori, compile OK after hot reload).
- curl prin gateway: `GET /api/search/flow?XTransformPort=4000` → 200 live; `POST /api/search/flow/settings` anonim → 401.
- Browser (agent-browser, :3000): `#/admin/search-flow` randează 0 erori consolă/pagină — banner, 7 gauge-uri („0 țintă" emerald), windowing strip, 5 config cards, grafic recharts cu 2 Areas, 3 priority cards, tabel 30 sharduri, formular; `#/admin` default tot Content; `#/admin/shards` neatins; click manual pe tabul „Search Flow" funcțional.
- E2E settings: utilizator nou f15flow@test.local înregistrat + promovat admin direct în Neon → formular vizibil prefill 250/80/80/10000 → batchSize 100 + intervalMs 120 salvate (toast „Setări salvate", cardurile config actualizate live „120 ms" / „100", backend confirmă) → validare client prinsă cu toast „Batch size trebuie să fie între 1 și 1.000" (999999 respins) → config restaurat la 80/80 prin același formular.
- Screenshots: `agent-ctx/faza15-search-flow-tab.png`, `agent-ctx/faza15-search-flow-admin.png`, `agent-ctx/faza15-search-flow-mobile.png` (responsive 390×844).

## Notes for the next agent (15-3/15-4/15-5)
- `SearchStatus.flowControl`/`windowing` sunt optionale — consumatorii existenți NU trebuie modificați; dacă cineva vrea să le afișeze, sunt deja tipizate.
- History-ul de la backend e deja cronologic (oldest→newest); tabul sortează defensiv în JS, deci e robust și la o eventuală schimbare de ordine.
- Userul de test f15flow@test.local (id 113) a rămas admin în Neon — util pentru QA viitor, de șters dacă devine deranjant.
- maxWaitMs NU e editabil din formular (spec: exact 4 inputs); apare doar în cardurile de config. POST-ul suportă și maxWaitMs dacă se cere viitor.
