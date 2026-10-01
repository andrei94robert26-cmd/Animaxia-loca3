# Task 2-b — Frontend views batch B (Content / Player / Recommendations / Admin)

Agent: frontend-views subagent (Z.ai Code)
Date: 2026-09-15

## Scope

Exactly 4 owned files, fully rewritten from stubs:

- `src/components/animaxia/views/content-view.tsx`
- `src/components/animaxia/views/player-view.tsx`
- `src/components/animaxia/views/recommendations-view.tsx`
- `src/components/animaxia/views/admin-view.tsx`

No other file was created, edited or deleted. All foundation files treated as frozen.

## What was built

### content-view.tsx
- Two data paths: numeric id → `api.content()` (DbContent), `ext:type:id` → live `api.animeById/tvById/movieById` seeded instantly from `extItemCache`.
- Backdrop hero (h-[38vh] min-h-[260px], to-t + to-r gradient overlays), overlapping info panel (-mt-20 sm:-mt-28) with poster / Film placeholder, TypeBadge + RatingBadge + year + rose source chip, h1, genre chips (max 4 + "+N").
- DB actions: "Watch now" (rose, → /player/:id) + "Franchise" (→ /franchise?q=).
- EXT actions: "Add to Animaxia" → `api.upsertContent` with externalid `jikan:anime:{id}` / `tmdb:{type}:{id}`, metadata {overview/synopsis, rating/score, year, genres, backdrop?, source, mediaType, player.sources[youtube] when trailerKey}; success → toast + navigate to the new record id.
- Body grid lg:grid-cols-3: Story section, detail chips (runtime/episodes/status/studios), fuchsia Alert for `metadata.mined` (siteName, url link, extracted date, mp4/m3u8/iframe/youtube count chips), Details card (Type/Year/Rating/Source/External id mono-truncate/Added/Genres).
- "More like this" ContentRow (DB only, limit 13, self filtered, skipped for type=featured).
- Full-page skeleton, 404 → EmptyState "Title not found" + back, generic errors → ErrorState with retry.

### player-view.tsx
- `api.player(id)` with mode badge (direct=emerald / trailer=amber / none=zinc).
- Player surface aspect-video rounded-2xl: mp4 `<video>`, m3u8 via **dynamic `import('hls.js')`** with `Hls.isSupported()` → `loadSource` + `attachMedia`, native Safari HLS fallback via `canPlayType('application/vnd.apple.mpegurl')`, cancelled-flag + `hls.destroy()` cleanup (exact spec logic); youtube iframe with autoplay=1&rel=0; iframe with sandbox allowlist + no-referrer.
- Source switcher chips (rose active) when sources.length > 1; "Allowed by policy" chips line.
- mode 'none'/!primary → EmptyState with `data.note` + "Mine a stream" card (Input + Pickaxe button → `api.miner({url, externalId, type})` → toast + refetch).
- Info card below player (poster thumb, title, TypeBadge, line-clamp-3 overview, "View details" → /content/:id).
- Loading skeleton, 404 → EmptyState + back to home.

### recommendations-view.tsx
- PageHeader "For You"; gradient-border (rose→fuchsia→amber p-[1px]) "Surprise me" card with Dices button → `api.animeRandom()`; error → toast "Jikan is rate-limited — try again shortly".
- Roll result: flex-col sm:flex-row featured layout (poster sm:w-56, TypeBadge anime + RatingBadge, meta year · type · episodes, genre chips, line-clamp-4 synopsis, outline "Details" → /content/ext:anime:{id} (item cached into extItemCache first) + rose outline "Roll again").
- Rows: Top anime (animeTop → /category/anime), Top rated movies (moviesTop → /category/movie), Popular TV (tvPopular → /category/tv), Fresh in your library (all limit 14 sort createdat → /category/all).

### admin-view.tsx
- `useApi('admin-health', api.health)` + Refresh button; 4 stat cards: System (service+version, env chip, uptime h/m), Database (postgres=emerald "Neon PostgreSQL connected" / local-fallback=amber "Local fallback" with lastError Tooltip, totalItems big), Cache (hitRate %, keys, hits/misses, ttl), Rate limit (max/windowMs, trackedClients, totalLimited).
- Tabs: **Content** (type Select all/movie/tv/anime/news/sports/mined/featured with page reset, refresh, total count, shadcn Table with poster/title+externalid/TypeBadge/createdat/AlertDialog delete (Trash2, destructive, toast + list & health refetch), Pagination limit 10, skeleton rows, dimmed-stale table while refetching); **Miner** (URL + Type Select + optional External ID form, Pickaxe "Mine & UPSERT" with loading, 3 preset chips, result card with thumbnail/meta/siteName · bytes · ms, per-type source chips (FileVideo/Radio/Code2/Youtube + mono truncated urls), "Open in library" button, raw JSON `<pre>` max-h-96 custom-scrollbar, inline ErrorState compact + toast on failure); **Providers** (circuit state badges closed=emerald healthy / open=rose circuit open / half-open=amber, failures count, lastError with Tooltip, "Also configured (not routed yet)" 26 muted badges); **About** (rose gradient CTA → `<a href="/animaxia-backend.zip" download>` Download ZIP, "Re-sync trending content" → api.seed + toast with added counts, API reference mini-table with method chips, footer note "Backend port 4000 · accessed via gateway ?XTransformPort=4000").

## Key decisions / workarounds

- **Stale-data guard (important pattern for any view keyed by route param):** `useApi` keeps the previous key's data while refetching after a key change, and does NOT clear it on error. All route-param-driven views therefore gate on identity (`db.data.id === Number(ref)`, `player.data.content.id === id`, `String(ext.data.data.id) === extId`) and treat mismatches as loading; otherwise a 404 after navigation kept rendering the previous title. PlayerView additionally derives `effectiveSource` (active source must exist in current `data.sources`, else falls back to `data.primary`) to avoid a one-frame stale video flash.
- ext detail fallback chain: live data → extItemCache instant item → skeleton; error + no cache → not-found/error states.
- Mined items may have empty-string thumbnails and `siteName` instead of `source` — handled in `dbSourceLabel`.
- Backend falls back to a YouTube trailer for source-less titles (so mode 'none' is rare); the EmptyState uses `data.note` when present.
- No shared component needed changes; all helpers (Chip, SourceChip, PosterFrame, formatDate, formatUptime/formatBytes/formatMs, badges) are local per file.

## Verification

- `bunx tsc --noEmit`: no errors in animaxia code (remaining project errors are pre-existing in examples/ and skills/).
- Browser smoke tests via agent-browser through the Caddy gateway `http://localhost:81` (NOT :3000 — /api 404s there): content/1 (hero, badges, Story, Details, More like this 12 items), content/ext:anime:1535 (Death Note live), content/ext:movie:550 (Fight Club live, 139 min chip), content/65 (mined Alert panel), content/9999 (404 panel), player/1 (mp4 + policy line), player/3 (HLS: video readyState=4, both m3u8 chips, switch to Mux re-attached, duration 634s), player/64 (YouTube autoplay params), player/65 (multi-source switcher rose active), player/9999 (404), recommendations (4 rows + dice error toast verified; Jikan /random 502s while its circuit is open — success path is same useApi flow), admin (4 stats, type filter → 3 mined rows, pagination page 2, delete dialog opens + Cancel, miner form + presets fill, providers incl. jikan "circuit open", About ZIP link + API reference). No page errors anywhere.
- Mutations (upsert/delete/miner/seed) intentionally NOT executed — left for orchestrator verification.

## API shape notes (from curl)

- 404 body: `{"error":"Content not found"}` (both /api/content/:id and player).
- /api/all warning field present in local-fallback mode; mined rows have empty-string thumbnails and metadata.siteName.
- Health provider states observed: closed/open (+half-open possible); jikan currently `open` with lastError "jikan responded 504 ...".
- TMDB tv detail includes `episodes`/`seasons`; anime detail includes `status`/`episodes`/`studios` — surfaced as detail chips.
