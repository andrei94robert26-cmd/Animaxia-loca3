/**
 * api.ts — Animaxia API client. All requests go through the gateway using
 * relative URLs with the XTransformPort query param (backend runs on :4000).
 * Never hardcode hosts or ports in fetch URLs.
 */

import type {
  AiBrowseResponse,
  AiExternalStatsResponse,
  AiFeedItem,
  AiFeedResponse,
  AiHomeSettings,
  AiHomeSettingsResponse,
  AiHubKey,
  AiHubStatusResponse,
  AiMetadataResponse,
  AiNarrationResponse,
  AiTaxonomyResponse,
  AiTrailerResponse,
  AllResponse,
  AnimeItem,
  Competition,
  CuratorEnrichResponse,
  CuratorScan,
  DbContent,
  DiscoverResponse,
  F1Race,
  F1Standing,
  FootballMatch,
  FootballTableEntry,
  FranchisesResponse,
  GlobalFeedResponse,
  HealthResponse,
  HubContentResponse,
  HubFeedResponse,
  HubScaleResponse,
  HubStatsResponse,
  IngestCheckResponse,
  IngestRegisterResponse,
  IngestSourcesResponse,
  IngestStats,
  MarathonCreateResponse,
  MarathonListResponse,
  MarathonSuggestionsResponse,
  MediaItem,
  MetaDimension,
  MinerExtraction,
  NewsItem,
  NormalizedItem,
  PlayerExternalResponse,
  PlayerHubPlaylistDetailResponse,
  PlayerHubPlaylistSummary,
  PlayerHubContinueWatchingItem,
  PlayerHubProgress,
  PlayerHubStatsResponse,
  PlayerHubStatus,
  PlayerHubSubtitleTrack,
  PlayerResponse,
  RadioCountry,
  RadioLiveResponse,
  ScaleMetrics,
  ScaleReport,
  SearchAdvancedResponse,
  SearchAutocompleteResponse,
  SearchFilters,
  SearchFiltersOptions,
  SearchFlowConsole,
  SearchRateConsole,
  SearchOptConsole,
  SearchStressConsole,
  SearchStatus,
  SeedResponse,
  SemanticQueryResponse,
  SemanticSimilarResponse,
  SemanticStatus,
  StabilitySnapshot,
  StressRunRequest,
  StressRunResponse,
  TranslateResponse,
  TranslateStatusResponse,
  TrendForecast,
  TvScheduleItem,
  VirtualCatalogResponse,
  WatchdogHealth,
} from './types';

export const BACKEND_PORT = 4000;

/** API error with the parsed JSON body attached (FAZA 16: 429 pacing
 *  responses carry { error, code, retryInMs } the UI needs for its
 *  „Așteaptă un moment…” affordance). */
export class ApiError extends Error {
  status: number;
  body: Record<string, unknown> | null;
  constructor(message: string, status: number, body: Record<string, unknown> | null = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

type ParamValue = string | number | boolean | undefined | null;

export function apiUrl(path: string, params?: Record<string, ParamValue>): string {
  const search = new URLSearchParams();
  search.set('XTransformPort', String(BACKEND_PORT));
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
    }
  }
  return `${path}?${search.toString()}`;
}

/** FAZA 19 — direct `<track src>` URL for a WebVTT subtitle track. The URL
 *  is relative (same origin) with the gateway port marker, exactly like every
 *  other request: the browser fetches it through Caddy, which forwards to the
 *  backend where the raw VTT is served public with a 1h cache. */
export function playerHubSubtitleUrl(contentId: number, trackId: number): string {
  return apiUrl(`/api/playerhub/subtitles/${contentId}/${trackId}`);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers as Record<string, string> | undefined) },
    });
  } catch {
    throw new ApiError('Cannot reach the Animaxia backend — it may be restarting', 0);
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const message =
      (body as { error?: string } | null)?.error || `Request failed with status ${res.status}`;
    throw new ApiError(message, res.status, body as Record<string, unknown> | null);
  }
  return body as T;
}

/** Bearer header for FAZA 16 auth endpoints (same storage key as platform.ts
 *  tokenStore — read directly here to avoid a circular import). */
function authHeaders(): Record<string, string> {
  try {
    const token = window.localStorage.getItem('animaxia.accessToken');
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

export const api = {
  /* ------------------------------- core ------------------------------- */
  health: () => request<HealthResponse>(apiUrl('/api/health')),
  all: (p: { page?: number; limit?: number; type?: string; search?: string; sort?: string } = {}) =>
    request<AllResponse>(apiUrl('/api/all', p)),
  content: (id: number | string) => request<DbContent>(apiUrl(`/api/content/${id}`)),
  contentByExternalId: (externalid: string) =>
    request<DbContent>(apiUrl(`/api/content/external/${encodeURIComponent(externalid)}`)),
  player: (id: number | string) => request<PlayerResponse>(apiUrl(`/api/content/${id}/player`)),
  /** FAZA 14 — GET /api/player/external — universal, DB-free source
   *  resolution (rule 4: playback never depends on the real library size).
   *  400 errors surface as ApiError with the backend message. */
  playerExternal: (url: string) =>
    request<PlayerExternalResponse>(apiUrl('/api/player/external', { url })),

  /* ------------- FAZA 19: Player Hub (/api/playerhub) — task 19-1 ------------- */
  /** GET /api/playerhub/status — hub contract + live totals (public). */
  playerHubStatus: () => request<PlayerHubStatus>(apiUrl('/api/playerhub/status')),
  /** GET /api/playerhub/progress/:contentId — the caller's resume point
   *  (auth). 404 when the content id does not exist. */
  playerHubProgress: (contentId: number) =>
    request<PlayerHubProgress>(apiUrl(`/api/playerhub/progress/${contentId}`), {
      headers: authHeaders(),
    }),
  /** POST /api/playerhub/progress — fire-and-forget friendly: the player
   *  pings every ~10s of playback; callers may `.catch(() => {})` safely.
   *  `duration` is validated but intentionally not persisted server-side. */
  playerHubSaveProgress: (contentId: number, seconds: number, duration?: number) =>
    request<{ ok: boolean; saved: boolean; progress: number }>(apiUrl('/api/playerhub/progress'), {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ contentId, seconds, ...(duration != null ? { duration } : {}) }),
    }),
  /** GET /api/playerhub/subtitles/:contentId — public WebVTT track listing
   *  (no VTT payloads; the raw tracks live at playerHubSubtitleUrl). */
  playerHubSubtitles: (contentId: number) =>
    request<{ data: PlayerHubSubtitleTrack[] }>(apiUrl(`/api/playerhub/subtitles/${contentId}`)),

  /* ----- FAZA 19 (task 19-3b): playlists (/api/playerhub/playlists) ----- */
  /** GET /api/playerhub/playlists — the caller's playlists, most recently
   *  updated first (auth). */
  playerHubPlaylists: () =>
    request<{ data: PlayerHubPlaylistSummary[] }>(apiUrl('/api/playerhub/playlists'), {
      headers: authHeaders(),
    }),
  /** POST /api/playerhub/playlists — create a playlist (auth, max 20/user). */
  playerHubCreatePlaylist: (title: string, description?: string) =>
    request<{ ok: true; playlist: PlayerHubPlaylistSummary }>(apiUrl('/api/playerhub/playlists'), {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ title, ...(description ? { description } : {}) }),
    }),
  /** GET /api/playerhub/playlists/:id — detail with ordered items (owner). */
  playerHubPlaylistDetail: (id: number) =>
    request<PlayerHubPlaylistDetailResponse>(apiUrl(`/api/playerhub/playlists/${id}`), {
      headers: authHeaders(),
    }),
  /** DELETE /api/playerhub/playlists/:id — remove a playlist (owner). */
  playerHubDeletePlaylist: (id: number) =>
    request<{ ok: true; deleted: boolean }>(apiUrl(`/api/playerhub/playlists/${id}`), {
      method: 'DELETE',
      headers: authHeaders(),
    }),
  /** POST /api/playerhub/playlists/:id/items — add a content (dedupe →
   *  { added: false, duplicate: true }). */
  playerHubAddPlaylistItem: (playlistId: number, contentId: number) =>
    request<{ ok: true; added: boolean; duplicate: boolean }>(
      apiUrl(`/api/playerhub/playlists/${playlistId}/items`),
      {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ contentId }),
      },
    ),
  /** DELETE /api/playerhub/playlists/:id/items/:contentId — remove + renumber. */
  playerHubRemovePlaylistItem: (playlistId: number, contentId: number) =>
    request<{ ok: true; removed: boolean }>(
      apiUrl(`/api/playerhub/playlists/${playlistId}/items/${contentId}`),
      {
        method: 'DELETE',
        headers: authHeaders(),
      },
    ),
  /** POST /api/playerhub/playlists/:id/reorder — exact-set reorder. */
  playerHubReorderPlaylist: (playlistId: number, contentIds: number[]) =>
    request<{ ok: true; reordered: boolean; count: number }>(
      apiUrl(`/api/playerhub/playlists/${playlistId}/reorder`),
      {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ contentIds }),
      },
    ),
  /* ---- FAZA 21 (task 21-2): Player Hub admin console extras ---- */
  /** GET /api/playerhub/stats — public hub totals (+ watch entries) and the
   *  top-5 continue-watching titles; the `admin` section only comes back
   *  for admin tokens (send the Bearer header whenever we have one). */
  playerHubStats: () =>
    request<PlayerHubStatsResponse>(apiUrl('/api/playerhub/stats'), {
      headers: authHeaders(),
    }),
  /** GET /api/playerhub/continue-watching — the caller's last watched
   *  titles with unified progress/resume info (auth). */
  playerHubContinueWatching: () =>
    request<{ data: PlayerHubContinueWatchingItem[] }>(
      apiUrl('/api/playerhub/continue-watching'),
      {
        headers: authHeaders(),
      },
    ),
  /** POST /api/playerhub/subtitles/:contentId — attach a WebVTT track
   *  (admin only; max 8 per content, VTT must start with "WEBVTT"). */
  playerHubAttachSubtitle: (
    contentId: number,
    body: { label: string; lang: string; vtt: string },
  ) =>
    request<{ ok: true; track: PlayerHubSubtitleTrack }>(
      apiUrl(`/api/playerhub/subtitles/${contentId}`),
      {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(body),
      },
    ),
  /** DELETE /api/playerhub/subtitles/:contentId/:trackId — detach a track
   *  (admin only, audit-logged server-side). */
  playerHubDeleteSubtitle: (contentId: number, trackId: number) =>
    request<{ ok: true; deleted: boolean }>(
      apiUrl(`/api/playerhub/subtitles/${contentId}/${trackId}`),
      {
        method: 'DELETE',
        headers: authHeaders(),
      },
    ),

  /* ------- FAZA 21 (task 21-1): public platform hubs (/api/hub) ------- */
  /** GET /api/hub/stats — platform totals, engagement tops, 7-day recency. */
  hubStats: () => request<HubStatsResponse>(apiUrl('/api/hub/stats')),
  /** GET /api/hub/scale — real Neon numbers vs. the logical 30B capacity. */
  hubScale: () => request<HubScaleResponse>(apiUrl('/api/hub/scale')),
  /** GET /api/hub/feed — the 3 live shelves (recent / popular / rated). */
  hubFeed: () => request<HubFeedResponse>(apiUrl('/api/hub/feed')),
  /** GET /api/hub/content — faceted browse (sort: recent|rating|title|popular). */
  hubContent: (
    p: { sort?: string; type?: string; genre?: string; year?: string; q?: string; limit?: number; page?: number } = {},
  ) => request<HubContentResponse>(apiUrl('/api/hub/content', p)),

  upsertContent: (body: {
    externalid: string;
    type?: string;
    title: string;
    thumbnail?: string | null;
    metadata?: Record<string, unknown>;
  }) =>
    request<{ ok: true; record: DbContent; created: boolean }>(apiUrl('/api/content'), {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  deleteContent: (id: number) =>
    request<{ ok: true; deleted: DbContent }>(apiUrl(`/api/content/${id}`), { method: 'DELETE' }),
  miner: (body: { url: string; type?: string; externalId?: string }) =>
    request<{ ok: true; extraction: MinerExtraction; record: DbContent }>(apiUrl('/api/miner'), {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  seed: () =>
    request<SeedResponse>(apiUrl('/api/admin/seed'), { method: 'POST', body: '{}' }),

  /* ------------------------------- anime ------------------------------- */
  animeTop: (page = 1) => request<{ data: AnimeItem[] }>(apiUrl('/api/anime/top', { page })),
  animeSearch: (q: string, limit = 20) =>
    request<{ data: AnimeItem[] }>(apiUrl('/api/anime/search', { q, limit })),
  animeSeason: () => request<{ data: AnimeItem[] }>(apiUrl('/api/anime/season')),
  animeRandom: () => request<{ data: AnimeItem }>(apiUrl('/api/anime/random')),
  animeById: (id: string | number) => request<{ data: AnimeItem }>(apiUrl(`/api/anime/${id}`)),

  /* ------------------------------ movies / tv ------------------------------ */
  moviesTrending: (window: 'day' | 'week' = 'day', page = 1) =>
    request<{ data: MediaItem[] }>(apiUrl('/api/movies/trending', { window, page })),
  moviesPopular: (page = 1) => request<{ data: MediaItem[] }>(apiUrl('/api/movies/popular', { page })),
  moviesTop: (page = 1) => request<{ data: MediaItem[] }>(apiUrl('/api/movies/top', { page })),
  moviesUpcoming: (page = 1) => request<{ data: MediaItem[] }>(apiUrl('/api/movies/upcoming', { page })),
  moviesSearch: (q: string, page = 1) =>
    request<{ data: MediaItem[] }>(apiUrl('/api/movies/search', { q, page })),
  movieById: (id: string | number) => request<{ data: MediaItem }>(apiUrl(`/api/movies/${id}`)),
  tvTrending: (window: 'day' | 'week' = 'day', page = 1) =>
    request<{ data: MediaItem[] }>(apiUrl('/api/tv/trending', { window, page })),
  tvPopular: (page = 1) => request<{ data: MediaItem[] }>(apiUrl('/api/tv/popular', { page })),
  tvTop: (page = 1) => request<{ data: MediaItem[] }>(apiUrl('/api/tv/top', { page })),
  tvSearch: (q: string, page = 1) => request<{ data: MediaItem[] }>(apiUrl('/api/tv/search', { q, page })),
  tvById: (id: string | number) => request<{ data: MediaItem }>(apiUrl(`/api/tv/${id}`)),
  tvSchedule: () => request<{ data: TvScheduleItem[] }>(apiUrl('/api/tv/schedule')),

  /* -------------------------------- news -------------------------------- */
  news: (source: string = 'all', limit = 20) =>
    request<{ data: NewsItem[] }>(apiUrl('/api/news', { source, limit })),

  /* ------------------------------- sports ------------------------------- */
  footballCompetitions: () => request<{ data: Competition[] }>(apiUrl('/api/sports/football/competitions')),
  footballStandings: (competition = 'PL') =>
    request<{ data: { competition: string; table: FootballTableEntry[] } }>(
      apiUrl('/api/sports/football/standings', { competition }),
    ),
  footballMatches: (competition = 'PL', limit = 10) =>
    request<{ data: FootballMatch[] }>(apiUrl('/api/sports/football/matches', { competition, limit })),
  f1Standings: () => request<{ data: F1Standing[] }>(apiUrl('/api/sports/f1/standings')),
  f1Schedule: () => request<{ data: F1Race[] }>(apiUrl('/api/sports/f1/schedule')),

  /* -------------------- FAZA 14: live menus, radio, hubs -------------------- */
  discover: (slug: string, page = 1) =>
    request<DiscoverResponse>(apiUrl(`/api/discover/${encodeURIComponent(slug)}`, { page })),
  radioLive: (p: { countrycode?: string; tag?: string; name?: string; limit?: number } = {}) =>
    request<RadioLiveResponse>(apiUrl('/api/radio/live', p)),
  radioCountries: () =>
    request<{ total: number; data: RadioCountry[] }>(apiUrl('/api/radio/countries')),
  franchises: () => request<FranchisesResponse>(apiUrl('/api/franchises')),
  trilogies: () => request<FranchisesResponse>(apiUrl('/api/trilogies')),

  /* -------------------- FAZA 15: AI Home engine (/api/ai/home) -------------------- */
  aiHome: {
    feed: (page = 1, limit = 20) =>
      request<AiFeedResponse>(apiUrl('/api/ai/home/feed', { page, limit })),
    taxonomy: () => request<AiTaxonomyResponse>(apiUrl('/api/ai/home/taxonomy')),
    narration: () => request<AiNarrationResponse>(apiUrl('/api/ai/home/taxonomy/narration')),
    stats: (since?: string) =>
      request<AiExternalStatsResponse>(apiUrl('/api/ai/home/stats', { since })),
    metadata: () => request<AiMetadataResponse>(apiUrl('/api/ai/home/metadata')),
    metadataRefresh: () =>
      request<{ ok: boolean; running: boolean; enriched: number; refreshedAt: string }>(
        apiUrl('/api/ai/home/metadata/refresh'),
        { method: 'POST', body: '{}' },
      ),
    browse: (dim: MetaDimension, value: string, page = 1) =>
      request<AiBrowseResponse>(apiUrl('/api/ai/home/browse', { dim, value, page })),
    trailer: (key: string, title?: string) =>
      request<AiTrailerResponse>(apiUrl('/api/ai/home/trailers', { key, title })),
    trailerStatus: () =>
      request<{
        resolved: number;
        byProvider: Record<string, number>;
        store: string;
        updatedAt: string;
      }>(apiUrl('/api/ai/home/trailers/status')),
    trailerWarm: (keys: string[]) =>
      request<{ queued: number }>(apiUrl('/api/ai/home/trailers/warm'), {
        method: 'POST',
        body: JSON.stringify({ keys }),
      }),
    settings: () => request<AiHomeSettingsResponse>(apiUrl('/api/ai/home/settings')),
    updateSettings: (patch: Partial<AiHomeSettings>) =>
      request<AiHomeSettingsResponse>(apiUrl('/api/ai/home/settings'), {
        method: 'POST',
        body: JSON.stringify(patch),
      }),
  },

  /* ------------- FAZA 16: Neon FTS search (animaxia-neon-fts) ------------- */
  searchAdvanced: (filters: SearchFilters) =>
    request<SearchAdvancedResponse>(
      apiUrl('/api/search/advanced', {
        q: filters.q,
        type: filters.type,
        genre: filters.genre,
        year: filters.year,
        minRating: filters.minRating,
        actor: filters.actor,
        studio: filters.studio,
        category: filters.category,
        sort: filters.sort,
        fuzzy: filters.fuzzy,
        limit: filters.limit,
        page: filters.page,
      }),
    ),
  searchAutocomplete: (q: string) =>
    request<SearchAutocompleteResponse>(apiUrl('/api/search/autocomplete', { q })),
  searchFilters: () => request<SearchFiltersOptions>(apiUrl('/api/search/filters')),
  searchStatus: () => request<SearchStatus>(apiUrl('/api/search/status')),
  /** FAZA 15 — GET /api/search/flow — the full search flow console
   *  (flowControl + windowing + config + history + perShard). Public, in-memory
   *  and fast; the admin tab polls it every 2 s. */
  searchFlow: () => request<SearchFlowConsole>(apiUrl('/api/search/flow')),
  /** FAZA 16 — GET /api/search/rate — the full Search Rate Management
   *  console (rateLimit + burstControl + config + counters + history +
   *  perShard). Public, in-memory and fast; the admin tab polls it every 2 s. */
  searchRate: () => request<SearchRateConsole>(apiUrl('/api/search/rate')),
  /** FAZA 17 — GET /api/search/opt — the full Search Optimization Layer
   *  console (batching + cache + dedup + pipeline + config + counters +
   *  active batch list + history + perShard). Public, in-memory and fast;
   *  the admin tab polls it every 2 s. */
  searchOpt: () => request<SearchOptConsole>(apiUrl('/api/search/opt')),
  /** FAZA 18 — GET /api/search/stress — the Full Integration + Stress Test
   *  console (pipelineIntegrated + the pinned sections + the last full run
   *  report with all assertions + the 10M projection + runs history).
   *  Public read-only; the admin tab polls it every 2 s. */
  searchStress: () => request<SearchStressConsole>(apiUrl('/api/search/stress')),

  /* ------------------- FAZA 16: ingest dedup registry ------------------- */
  ingestCheck: (url: string) =>
    request<IngestCheckResponse>(apiUrl('/api/ingest/check'), {
      method: 'POST',
      body: JSON.stringify({ url }),
    }),
  ingestRegister: (body: { url: string; kind?: string; contentId?: number; externalId?: string; addedBy?: string }) =>
    request<IngestRegisterResponse>(apiUrl('/api/ingest/register'), {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  ingestSources: (p: { limit?: number; page?: number; kind?: string } = {}) =>
    request<IngestSourcesResponse>(apiUrl('/api/ingest/sources', p)),
  ingestStats: () => request<IngestStats>(apiUrl('/api/ingest/stats')),

  /* --------------------- FAZA 16: real scale report --------------------- */
  scaleReport: () => request<ScaleReport>(apiUrl('/api/scale/report')),
  scaleMetrics: () => request<ScaleMetrics>(apiUrl('/api/scale/metrics')),

  /* ------------------------ FAZA 16: AI Hub (6 AI) ----------------------- */
  aiHubStatus: () => request<AiHubStatusResponse>(apiUrl('/api/ai/hub/status')),
  aiHubToggle: (key: AiHubKey, enabled: boolean) =>
    request<{ ok: boolean; key: AiHubKey; enabled: boolean }>(apiUrl('/api/ai/hub/settings'), {
      method: 'POST',
      body: JSON.stringify({ key, enabled }),
    }),
  curatorScan: () => request<CuratorScan>(apiUrl('/api/ai/hub/curator/scan')),
  curatorEnrich: (body: { contentId?: number; missing?: boolean; limit?: number } = { missing: true, limit: 5 }) =>
    request<CuratorEnrichResponse>(apiUrl('/api/ai/hub/curator/enrich'), {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(body),
    }),
  curatorMerge: (keepId: number, mergeId: number) =>
    request<{ ok: boolean; keepId: number; merged: number }>(apiUrl('/api/ai/hub/curator/merge'), {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ keepId, mergeId }),
    }),
  trendsForecast: (window: '1d' | '7d' | '30d' = '7d') =>
    request<TrendForecast>(apiUrl('/api/ai/hub/trends/forecast', { window })),
  semanticQuery: (query: string, limit = 12) =>
    request<SemanticQueryResponse>(apiUrl('/api/ai/hub/semantic/query'), {
      method: 'POST',
      body: JSON.stringify({ query, limit }),
    }),
  semanticSimilar: (contentId: number | string) =>
    request<SemanticSimilarResponse>(apiUrl(`/api/ai/hub/semantic/similar/${encodeURIComponent(String(contentId))}`)),
  semanticStatus: () => request<SemanticStatus>(apiUrl('/api/ai/hub/semantic/status')),
  watchdogHealth: () => request<WatchdogHealth>(apiUrl('/api/ai/hub/watchdog/health')),
  marathonSuggestions: () => request<MarathonSuggestionsResponse>(apiUrl('/api/ai/hub/marathon/suggestions')),
  marathonCreate: (key: string) =>
    request<MarathonCreateResponse>(apiUrl('/api/ai/hub/marathon/create'), {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ key }),
    }),
  marathonList: () => request<MarathonListResponse>(apiUrl('/api/ai/hub/marathon/list')),
  translateContent: (contentId: number, lang: 'ro' | 'en' | 'es' | 'fr' | 'de') =>
    request<TranslateResponse>(apiUrl('/api/ai/hub/translate'), {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ contentId, lang }),
    }),
  translateStatus: () => request<TranslateStatusResponse>(apiUrl('/api/ai/hub/translate/status')),

  /* ------- FAZA 17: stability lab — live resilience, real stress, 30B ------- */
  platform: {
    /** GET /api/platform/stability — uncached live snapshot (UI polls at 5s). */
    stability: () => request<StabilitySnapshot>(apiUrl('/api/platform/stability')),
    /** POST /api/platform/stress/run — real in-process load test.
     *  Server errors (409 lock / 429 rate limit / 400 bad suite) surface as
     *  ApiError with the backend message; the view maps them to RO toasts. */
    stressRun: (body: StressRunRequest) =>
      request<StressRunResponse>(apiUrl('/api/platform/stress/run'), {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    /** GET /api/platform/scale/virtual — deterministic 30B virtual catalog. */
    virtualCatalog: (params: { cursor?: string; limit?: number; seed?: string } = {}) =>
      request<VirtualCatalogResponse>(apiUrl('/api/platform/scale/virtual', params)),
    /** FAZA 14 — GET /api/platform/feed/global — the 30B logical feed with
     *  the REAL Neon overlay. Cursor = base64url {i,s} keyset over the whole
     *  30B space (page N → i=(N-1)*limit, global index even under ?shard=n,
     *  which narrows the window to [n*1e9,(n+1)*1e9)); deep jumps are O(1). */
    globalFeed: (params: { cursor?: string; limit?: number; shard?: number; seed?: string } = {}) =>
      request<GlobalFeedResponse>(apiUrl('/api/platform/feed/global', params)),
  },
};

/** FAZA 17 — build a virtual-catalog cursor client-side, byte-for-byte like
 *  the backend: base64url(JSON {i:<index>, s:<seed>}). Enables O(1) jumps to
 *  ANY page without server round-trips (verified live against :4000). */
export function buildVirtualCursor(index: number, seed: string): string {
  const json = JSON.stringify({ i: index, s: seed });
  const b64 =
    typeof btoa === 'function'
      ? btoa(json)
      : Buffer.from(json, 'utf8').toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/* ----------------------------- normalizers ----------------------------- */

export function dbToItem(c: DbContent): NormalizedItem {
  const md = c.metadata || {};
  const sources = md.player?.sources || md.sources;
  return {
    key: `db-${c.id}`,
    kind: 'db',
    dbId: c.id,
    title: c.title,
    image: c.thumbnail || md.backdrop || null,
    backdrop: md.backdrop || null,
    overview: md.overview || md.synopsis || md.description || undefined,
    rating: typeof md.rating === 'number' ? md.rating : typeof md.score === 'number' ? md.score : null,
    year: (md.year as string | number | undefined) ?? null,
    type: c.type || 'mined',
    genres: Array.isArray(md.genres) ? md.genres.map(String) : undefined,
    playable: Boolean(sources && sources.length > 0),
    source: typeof md.source === 'string' ? md.source : undefined,
  };
}

export function animeToItem(a: AnimeItem): NormalizedItem {
  return {
    key: `anime-${a.id}`,
    kind: 'external',
    extType: 'anime',
    extId: String(a.id),
    title: a.title,
    image: a.image || null,
    overview: a.synopsis || undefined,
    rating: a.score ?? null,
    year: a.year ?? null,
    type: 'anime',
    genres: a.genres,
    url: a.url,
    source: a.source || 'jikan',
  };
}

export function mediaToItem(m: MediaItem): NormalizedItem {
  return {
    key: `${m.mediaType}-${m.id}`,
    kind: 'external',
    extType: m.mediaType,
    extId: String(m.id),
    title: m.title,
    image: m.image || m.backdrop || null,
    backdrop: m.backdrop || null,
    overview: m.overview || undefined,
    rating: m.rating ?? null,
    year: m.year ?? null,
    type: m.mediaType,
    genres: m.genres,
    source: m.source || 'tmdb',
  };
}

export function newsToItem(n: NewsItem): NormalizedItem {
  return {
    key: `news-${n.link}`,
    kind: 'link',
    title: n.title,
    image: n.image || null,
    overview: n.description || undefined,
    type: 'news',
    url: n.link,
    source: n.source,
  };
}

export function scheduleToItem(s: TvScheduleItem): NormalizedItem {
  return {
    key: `tvschedule-${s.id}`,
    kind: 'link',
    title: `${s.show} — ${s.title}`,
    image: s.image || null,
    overview: s.summary || undefined,
    type: 'tv',
    url: s.url,
    source: s.network || 'TVmaze',
  };
}

/**
 * FAZA 15: AI infinite-feed item → NormalizedItem.
 * mediaType 'db' is a Neon library row; anything else is a live external
 * provider item (movie / tv / anime) with the id as a string extId.
 */
export function feedToItem(i: AiFeedItem): NormalizedItem {
  const isDb = i.mediaType === 'db';
  const extType = isDb ? undefined : (i.mediaType as 'movie' | 'tv' | 'anime');
  return {
    key: isDb ? `db-${i.id}` : `${i.mediaType}-${i.id}`,
    kind: isDb ? 'db' : 'external',
    dbId: isDb ? i.id : undefined,
    extType,
    extId: isDb ? undefined : String(i.id),
    title: i.title,
    image: i.image || i.backdrop || null,
    backdrop: i.backdrop || null,
    overview: i.overview || undefined,
    rating: i.rating ?? null,
    year: i.year ?? null,
    type: isDb ? 'mined' : i.mediaType,
    genres: Array.isArray(i.genres) && i.genres.length > 0 ? i.genres : undefined,
    source: i.source,
  };
}
