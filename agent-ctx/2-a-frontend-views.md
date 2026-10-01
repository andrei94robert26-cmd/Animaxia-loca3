# Task 2-a — Frontend Views Batch A (Home / Category / Franchise / Search)

Agent: frontend-views subagent (Z.ai Code)
Task ID: 2-a
Date: 2026-09-15

## Scope

Implemented the 4 React views of the Animaxia SPA (dark streaming theme, rose/fuchsia accents, no blue/indigo):
- `src/components/animaxia/views/home-view.tsx`
- `src/components/animaxia/views/category-view.tsx`
- `src/components/animaxia/views/franchise-view.tsx`
- `src/components/animaxia/views/search-view.tsx`

No other file was created, edited or deleted. No changes were needed to any shared foundation component.

## What was built

### HomeView
- 6 parallel `useApi` hooks: library (`api.all limit 16`), TMDB trending movies, TMDB trending TV, Jikan top anime, news (`api.news('all', 6)`), health.
- Full-bleed `HeroCarousel`: up to 5 library items ranked playable → (image+overview) → rest; falls back to trending movies ONLY when the library yields zero candidates (spec said library-first, skip while loading — honored).
- Stats strip: 4 cards (Clapperboard/Film/Tv/Sword icons) fed by `health.db.totalItems` + `countsByType` with skeleton while loading, 0 fallback on error.
- 4 ContentRows (Trending now / Popular anime / Trending TV / Your Animaxia library) with See-all links; each has error → compact ErrorState with retry, empty message, skeleton loading (local `HomeRow` helper).
- Latest news Section with ContentGrid (6 items) + "All news" action button → `/category/news`.
- Popular franchises chip cloud → `/franchise?q=…`.
- Miner CTA gradient banner (rose→fuchsia→transparent) with Pickaxe icon + "Open Miner" → `/admin`.
- Combined ErrorState with refetch-all when library+trending+anime all fail.

### CategoryView (`route.params[0]` = type)
- Title/subtitle map for all/movie/tv/anime/news/sports/mined/featured + capitalize fallback; "Showing X of Y titles" count in header.
- DB grid: `api.all({ type, page, limit: 24 })` + Pagination; page resets to 1 on type change via the render-time state-adjust pattern (no double fetch); smooth scroll-into-view of the grid on page change (`scroll-mt-24` for the sticky navbar).
- Live strip above the grid: movie → TMDB trending day, tv → TMDB popular, anime → Jikan season (normalizes to `NormalizedItem[]` inside the fetcher). Strip errors render compact ErrorState (Jikan is flaky — verified 504 handling live).
- `mined`: rose Alert with miner explanation + "Open Admin panel" button.
- `news`: source filter chips (all/bbc/cnn/nhk/aljazeera) + live ContentGrid, no DB grid.
- `sports`: shadcn Tabs (Football / Formula 1). Football: 7 competition chips, standings Table (rank top-4 emerald, crest images, P/W/D/L/GD/Pts, `overflow-x-auto custom-scrollbar`), fixtures list (home crest — score/vs — away crest, UTC date/time, status badge with Live/Finished/Scheduled/Postponed styles). F1 (fetched lazily when its tab activates): driver standings table + race calendar cards (round in rose tile). All panels: Skeleton loading, ErrorState retry (403 free-tier friendly), EmptyState.

### FranchiseView
- No `q`: PageHeader + responsive grid (2/3/4 cols) of 16 franchise cards (Bookmark gradient tile, hover rose border).
- With `q`: gradient hero panel (fuchsia→rose) + 8 switch chips; three fetches (library search, Jikan anime search, TMDB search); sections "In your library" (hidden when loaded empty), "Anime" row, "Movies & TV" grid; per-section compact errors; single combined EmptyState "No results for 'q'" with "Search instead" when all three are loaded+empty; combined ErrorState when all three fail.

### SearchView
- Big h-12 input (Search icon, clear button) + Search button; input synced from URL `q`; 500 ms debounced live navigation (guarded against loops); form submit navigates immediately.
- Tabs Library / Anime / Movies & TV (single `useApi` keyed `search-{tab}-{q}`, `enabled: q.length > 0`, fetcher normalizes to `{ items, total }`).
- Result count line ("N results for 'q' in Library", "24 of 40" style when truncated), ContentGrid with skeletons, ErrorState with retry, EmptyState variants for no-q (SearchX icon) and zero results.

## Verification performed
- `bunx tsc --noEmit`: zero errors in all 4 files (fixed 4 initial TS18047 null-narrowing errors by replacing `?.`-based empty checks with explicit `!data ||` guards). Remaining project errors are pre-existing in `examples/` and `skills/` folders only.
- Read-only curl of live endpoints to confirm response shapes (all, trending, anime top/season, news, football standings/matches, F1 standings/schedule).
- Headless browser smoke test (agent-browser, isolated session) through the Caddy gateway (`http://localhost:81`): home (hero 5 slides, stats 66/22/20/20, 4 rows, 6 news, 16 chips, miner CTA), category/sports (football tab + F1 tab tables/fixtures), category/news (source chips + grid), category/movie (strip + grid + count), franchise index, franchise?q=Naruto (hero + chips + TMDB grid + Jikan 504 error state), search?q=frieren (count + result card + tab switch). No page errors.

## Notes / surprises
- API shapes matched `types.ts` exactly. `/api/all` includes a `warning` field (local fallback mode) which we intentionally do not surface in UI.
- **Gateway gotcha (important for other agents):** API calls 404 when the app is opened at `http://localhost:3000` DIRECTLY — the `/api/*?XTransformPort=4000` proxying is done by Caddy on port **81**. Always test through `http://localhost:81` (or the preview URL). The 404 `/api/...` lines in dev.log are from direct :3000 access, not a bug.
- Jikan (`/api/anime/season`, `/api/anime/search`) intermittently 504s — error states with retry are in place everywhere it is used.
- Local helpers kept private per file (HomeRow/StatCard, FilterChip/StatusBadge/MatchRow/RaceCard, ResultsBlock) — no shared component changes required.
- Caution: my first agent-browser command accidentally used the shared default browser session (navigated it to `http://localhost:3000/`); all subsequent testing used an isolated `--session 2a-verify`. If agent 2-b saw their page navigate unexpectedly around this time, that is why.
