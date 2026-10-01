# Animaxia 30B — FAZA 14 (Sharding logic 30×1M + 30B logic + redare reală)

Prefix aditiv FAZA 14 din `animaxia-cloud.zip`. Regulile definitive ale
platformei (livrate 2026-09-19), implementate strict aditiv peste FAZA 1–13.

## Regulile definitive → implementare

| Regula definitivă | Implementare |
|---|---|
| **30 miliarde de conținuturi — SIMULATE LOGIC** | `logicalAddressSpace()` = 30 × 1.000.000.000. ID-uri 0 … 29.999.999.999. Volumul se generează determinist O(1) (`generateVirtualItem`), NU se stochează fizic. |
| **ID-uri până la 30B + paginare O(1)** | Feed-ul global paginează keyset pe fereastră `[i, i+limit)` — pagina 1.500.000.000 răspunde în ~1ms (dovedit live: synthetics + browser). Zero scan-uri, zero OFFSET. |
| **Feed global 30B** | `GET /api/platform/feed/global` — overlay REAL: rândurile reale `content` apar la id-ul lor propriu (un PK range scan indexat), restul sloturilor sunt virtuale deterministe. Item: `{id, shardid, virtual XOR real, title, type, year, rating, genres, overview, thumbnail}`. |
| **Căutare globală 30B** | Clusterele search + vector acoperă tot spațiul logic prin 30 noduri; rezultatele rămân 100% REALE (searchdocs/content reale). `/api/search/status` + `/advanced` + `/api/shards` expun `logical: {addressSpace: 30000000000, shardcount, shardSpan, mode}`. |
| **Sharding logic 30×1 miliard** | `SHARDCOUNT=30` (default nou în `model.js` + `.env` + edge `shard.ts` + wrangler `[vars]`). Shardul `s` acoperă EXACT `[s×1e9, (s+1)×1e9 − 1]` (`computeShardIdFromContentId = floor(id/1e9) % 30`). `computeShardIdFromTenant = fnv1a % 30`. Fizic rămâne activabil prin `SHARD{n}URL` fără schimbare de cod. |
| **Coalesced-logical (nimic nu cade la 30 noduri)** | În mode logical clusterele execută O interogare unită + O `GROUP BY shardid` pentru atribuire (2 interogări în loc de 60/120 per căutare/scrape). `cluster.execution: 'coalesced-logical' \| 'fanout'`. Mode physical păstrează fan-outul per nod. |
| **Metadata reală 100% în Neon** | Tabele reale: `content`, `searchdocs`, `vectorembeddings`, `miner_sources`, `miner_manifests` (+ registry `contentsources`). Doar VOLUMUL e simulat — metadata reală rămâne reală. |
| **Player redă real extern, independent de Neon** | `GET /api/player/external?url=` — rezolvare universală FĂRĂ DB: YouTube (watch/shorts/youtu.be → embed nocookie), Vimeo (→ player embed), Rumble, MP4 direct, HLS master.m3u8, orice iframe/embed JS. Policy `PLAYERALLOW*` + SSRF guard. UI: card „Redare URL extern" în player, mereu vizibil. |
| **Dedup — un link real salvat o dată** | `contentsources.urlhash` UNIQUE (sha256 al URL-ului canonic) — linkul se salvează O dată, reutilizabil oriunde (`hits++` la reînregistrare); `content.externalid` UNIQUE per rând. |
| **Console per-shard** | `#/admin/shards` — 30 rânduri, scroll `max-h-[32rem]`, chip „30 × 1 miliard ID-uri · spațiu logic 30.000.000.000", auto-refresh 15s. |
| **AI aware de shard** | Cache-uri AI/vector per-shard (`t:<tenant>:s<n>:…`), afinitate tenant → shard, embedding-uri stamp-uite `computeShardIdFromVectorRef` (restamp idempotent la boot după schimbarea modulului). |

## Structura prefixului

```
animaxia-30b/
├── README.md, .env.example
├── monolith/                  # mini-services/animaxia-backend (oglinzi live)
│   ├── server.js              # ruta /api/player/external + boot restamp FAZA 14
│   ├── modules/sharding/      # model.js (30×1B + SHARD_SPAN_IDS + logicalAddressSpace)
│   │                          # routes.js (câmp `logical`), migrations.js (restampVectorShardIds)
│   ├── modules/platform/stress.js   # GET /api/platform/feed/global (feed-ul global 30B)
│   ├── modules/player/player.js     # vimeo/rumble + resolveExternalSource (zero DB)
│   ├── modules/search/search.js     # câmp `logical` în /status + /advanced (cluster)
│   ├── services/{search,vector}-cluster/  # coalesced-logical (query + health)
│   └── tests/smoke-sharding.mjs     # 47 check-uri (A–G), live :4000
├── edge/
│   ├── shared/shard.ts        # default 30 + SHARD_SPAN_IDS + logicalAddressSpace
│   ├── wrangler/*.toml        # SHARDCOUNT="30" în [vars] (worker/search/ai/player)
│   └── tests/                 # smoke-edge (196), tenant-edge (61), local-harness
├── frontend/                  # src/ (oglinzi live)
│   ├── src/lib/animaxia/      # types/api/menu/sharding — globalFeed + playerExternal
│   ├── src/app/page.tsx       # case 'global30b'
│   └── src/components/animaxia/views/global-30b-view.tsx  # #/global30b (NOU)
│                              # + player-view (vimeo/rumble/URL extern, scroll admin)
└── ops/                       # synthetics/run.mjs (suite `global30b`, 84 total) + METRICS.md §7
```

## QA (2026-09-19)

- Monolit: `bun tests/smoke-sharding.mjs` — **47 passed / 0 failed** (inclusiv
  secțiunea G: feed global, O(1) deep page, shard ranges, player extern, SSRF).
- Edge: typecheck **0 erori**; smoke-edge **196/0**; tenant-edge **61/0**;
  e2e-edge **35/0** (monolit live :4000); lint **PASS**.
- Ops: `bun run ops:synthetics` — **84 passed / 0 failed / 0 soft** (suita nouă
  `global30b`: 9 check-uri).
- Frontend: `tsc --noEmit` **0 erori** în `src/`, eslint `src/` curat;
  browser (headless) — home, `#/global30b` (salt la pagina 1.500.000.000 în
  1ms, REAL/SIMULAT chips), `#/player/1` (URL extern YouTube redat),
  `#/admin/shards` (30 rânduri + scroll), `#/scale` (card Conformitate 30B) —
  **0 erori de consolă** pe toate rutele.

## Configurare

Vezi `.env.example`. Esențial: `SHARDCOUNT=30` (monolit + edge vars),
`SEARCHCLUSTENABLED=true`, `VECTORCLUSTENABLED=true`,
`PLAYERALLOW{MP4,M3U8,IFRAME,YOUTUBE,VIMEO,RUMBLE}=true`. Modul fizic per
branch: `SHARD{n}URL` — fără nicio schimbare de cod.

## Onestitate arhitecturală

30B sunt **simulare logică** (generare deterministă + overlay real), nu stocare
fizică: Neon ține doar conținuturile REALE (97 la momentul livrării), cu
metadate 100% reale. Izolarea fizică per branch se activează prin config, iar
health-ul/metricile/alertele o acoperă automat. Capacitatea fizică reală de
30 miliarde de rânduri rămâne limitată de stocarea fizică Neon (documentat în
raportul `#/scale`).
