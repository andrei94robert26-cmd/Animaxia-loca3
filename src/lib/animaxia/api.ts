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
  AiSuiteAdminData,
  AiSuiteAnalyzerData,
  AiSuiteDiscoveryData,
  AiSuiteDuplicatesData,
  AiSuiteFeedFetchResponse,
  AiSuiteFeedsData,
  AiSuiteFranchiseData,
  AiSuiteInfiniteFeedResponse,
  AiSuiteMetadataData,
  AiSuiteMinerData,
  AiSuiteMinerDryRun,
  AiSuiteNewsData,
  AiSuitePosterData,
  AiSuiteRecommendationsData,
  AiSuiteScannerData,
  AiSuiteSocialData,
  AiSuiteStatsData,
  AiSuiteStatusResponse,
  AiSuiteTaxonomyData,
  AiSuiteTrendsData,
  AiSuiteWatchPartyData,
  AiLabAsrResponse,
  AiLabChatMessage,
  AiLabChatResponse,
  AiLabCompanionContextResponse,
  AiLabCurationResponse,
  AiLabDubbingCue,
  AiLabDubbingDraftResponse,
  AiLabDubbingMissingResponse,
  AiLabDubbingPublishResponse,
  AiLabEditorGenerateResponse,
  AiLabEditorListsResponse,
  AiLabEditorSaveResponse,
  AiLabMoodGenerateResponse,
  AiLabMoodsResponse,
  AiLabRecapResponse,
  AiLabSettingsResponse,
  AiLabShieldResponse,
  AiLabStatusResponse,
  AiLabTtsResponse,
  AiLabVoiceStatusResponse,
  AiMetadataResponse,
  AiNarrationResponse,
  AiTaxonomyResponse,
  AiTrailerResponse,
  AdminModerationResponse,
  AdminUserPatchResponse,
  AdminUsersResponse,
  AllResponse,
  AnimeItem,
  Ar10mBudget,
  Ar10mSearchResult,
  Ar10mShards,
  Ar10mStats,
  Ar10mSuggestion,
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
  HealthResponse,
  HubFeedResponse,
  HubStatsResponse,
  IngestCheckResponse,
  IngestRegisterResponse,
  IngestSourcesResponse,
  IngestStats,
  MarathonCreateResponse,
  MarathonListResponse,
  MarathonSuggestionsResponse,
  MediaItem,
  MetricsJsonResponse,
  MyStatsResponse,
  Playlist,
  PlaylistDetailResponse,
  PlaylistItem,
  PlaylistPlayResponse,
  PlaylistsResponse,
  PlayerhubHistoryEntry,
  PlayerhubStatusResponse,
  MetaDimension,
  MinerExtraction,
  NormalizedItem,
  ObservabilitySummary,
  PlayerResponse,
  PlayerxMarker,
  PlayerxMarkerKind,
  PlayerxMarkersResponse,
  PlayerxStatus,
  PlayerxSubtitleSettings,
  PlayerxVoteState,
  PlayerxVoteVoter,
  SearchAdvancedResponse,
  SearchAutocompleteResponse,
  SearchAccelStatus,
  SearchUxFacets,
  SearchUxStatus,
  SearchUxSuggest,
  SearchUxTrending,
  SearchFilters,
  SearchFiltersOptions,
  SearchStatus,
  SeedResponse,
  SubtitleAdminRow,
  SubtitlesForContentResponse,
  SubtitleTrack,
  SemanticQueryResponse,
  SemanticSimilarResponse,
  SemanticStatus,
  StabilitySnapshot,
  StressRunRequest,
  StressRunResponse,
  TranslateResponse,
  TranslateStatusResponse,
  TrendForecast,
  TwoFactorSetupResponse,
  WatchdogHealth,
  SearchFlowConsole,
  SearchRateConsole,
  SearchOptConsole,
  SearchStressConsole,
  PlayerExternalResponse,
  PlayerHubStatus,
  PlayerHubProgress,
  PlayerHubSubtitleTrack,
  PlayerHubPlaylistSummary,
  PlayerHubPlaylistDetailResponse,
  PlayerHubStatsResponse,
  PlayerHubContinueWatchingItem,
  PersoStatus,
  PersoProfileResponse,
  PersoProfileResetResponse,
  PersoFeedResponse,
  PersoProfilesResponse,
  PersoProfileCreateResponse,
  PersoProfileUpdateResponse,
  PersoProfileDeleteResponse,
  PersoProfileVerifyResponse,
  PersoRemindersResponse,
  PersoReminderDismissResponse,
  PersoAffinitiesResponse,
  PersoExplainResponse,
  PersoEventResponse,
} from './types';

export const BACKEND_PORT = 4000;

/** FAZA 23 (observability): animaxia-observability service port (fix, per the
 *  platform contract — see mini-services/animaxia-observability/config.ts). */
export const OBSERVABILITY_PORT = 4050;

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
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

/** FAZA 23 (observability): same gateway pattern as apiUrl(), but pointed at
 *  the observability stack on :4050 (Caddy forwards via XTransformPort). */
export function obsUrl(path: string, params?: Record<string, ParamValue>): string {
  const search = new URLSearchParams();
  search.set('XTransformPort', String(OBSERVABILITY_PORT));
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
    }
  }
  return `${path}?${search.toString()}`;
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
    throw new ApiError(message, res.status);
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
  localSync: () =>
    request<{ ok: true; indexed: number }>(apiUrl('/api/search/index'), {
      method: 'POST',
      headers: authHeaders(),
      body: '{}',
    }),
  all: (p: { page?: number; limit?: number; type?: string; search?: string; sort?: string } = {}) =>
    request<AllResponse>(apiUrl('/api/all', p)),
  content: (id: number | string) => request<DbContent>(apiUrl(`/api/content/${id}`)),
  contentByExternalId: (externalid: string) =>
    request<DbContent>(apiUrl(`/api/content/external/${encodeURIComponent(externalid)}`)),
  player: (id: number | string) => request<PlayerResponse>(apiUrl(`/api/content/${id}/player`)),
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

  /* -------------------- FAZA 14: live menus, hubs -------------------- */
  discover: (slug: string, page = 1) =>
    request<DiscoverResponse>(apiUrl(`/api/discover/${encodeURIComponent(slug)}`, { page })),
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

  /* -- FAZA 15/16/17/18 (restaurate FAZA 29-R): consolele admin căutare -- */
  /** GET /api/search/flow — consola FAZA 15 Search Flow Control (publică,
   *  in-memory; tab-ul admin o pollează la 2s). */
  searchFlow: () => request<SearchFlowConsole>(apiUrl('/api/search/flow')),
  /** GET /api/search/rate — consola FAZA 16 Search Rate Management. */
  searchRate: () => request<SearchRateConsole>(apiUrl('/api/search/rate')),
  /** GET /api/search/opt — consola FAZA 17 Search Optimization Layer. */
  searchOpt: () => request<SearchOptConsole>(apiUrl('/api/search/opt')),
  /** GET /api/search/stress — consola FAZA 18 Full Integration + Stress
   *  (ultimul run complet + proiecția 10M + istoricul runs). */
  searchStress: () => request<SearchStressConsole>(apiUrl('/api/search/stress')),

  /* ------- FAZA 29-P (PLAN 100X): strat accelerare — cache + warming -------
   * Răspuns IDENTIC cu searchAdvanced (+ accel: 'hit'|'miss', originTook la hit).
   * Proxy transparent în fața pipeline-ului protejat (FAZA 18) — zero ocoliri. */
  searchAccelLookup: (filters: SearchFilters) =>
    request<SearchAdvancedResponse & { accel?: 'hit' | 'miss'; originTook?: number }>(
      apiUrl('/api/searchaccel/lookup', {
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
  /** Prefetch la hover pe sugestii — warming în fundal, fire-and-forget. */
  searchPrefetch: (filters: SearchFilters) => {
    console.info('[29P-api] searchPrefetch invoked, q =', filters.q); // TEMP DIAG
    return request<{ ok: boolean; warming?: boolean; cached?: boolean }>(apiUrl('/api/searchaccel/prefetch'), {
      method: 'POST',
      body: JSON.stringify({
        q: filters.q,
        type: filters.type,
        genre: filters.genre,
        year: filters.year,
        minRating: filters.minRating,
        actor: filters.actor,
        studio: filters.studio,
        category: filters.category,
        sort: filters.sort,
        limit: filters.limit,
        page: filters.page,
      }),
    }).catch((err: unknown) => {
      console.warn('[29P-api] prefetch failed:', err); // TEMP DIAG
      return { ok: false };
    });
  },

  /** GET /api/searchaccel/status — stats engine-ul de accelerare FAZA 29-P
   *  (keepalive pool, cache LRU, warming, prefetch). Consumat de status-view. */
  searchAccelStatus: () =>
    request<SearchAccelStatus>(apiUrl('/api/searchaccel/status')),

  /* -- FAZA 33 (PLAN 100X · WS3): searchux — strat UX peste motorul protejat.
   * Sugestii instant (cache 60s/prefix + did-you-mean), trending anonimizat,
   * fațete per căutare, track anonim. Motorul FAZA 18 doar consumat. -- */
  searchuxSuggest: (q: string, limit = 8) =>
    request<SearchUxSuggest>(apiUrl('/api/searchux/suggest', { q, limit })),
  searchuxTrending: (limit = 10) =>
    request<SearchUxTrending>(apiUrl('/api/searchux/trending', { limit })),
  searchuxFacets: (filters: Pick<SearchFilters, 'q' | 'type' | 'genre' | 'year' | 'minRating' | 'category' | 'actor' | 'studio'>) =>
    request<SearchUxFacets>(
      apiUrl('/api/searchux/facets', {
        q: filters.q,
        type: filters.type,
        genre: filters.genre,
        year: filters.year,
        minRating: filters.minRating,
        category: filters.category,
        actor: filters.actor,
        studio: filters.studio,
      }),
    ),
  /** POST /api/searchux/track — eveniment de căutare anonimizat (fire-and-forget). */
  searchuxTrack: (q: string) =>
    request<{ ok: boolean; anonymized: boolean }>(apiUrl('/api/searchux/track'), {
      method: 'POST',
      body: JSON.stringify({ q }),
    }).catch(() => ({ ok: false, anonymized: true })),
  searchuxStatus: () =>
    request<SearchUxStatus>(apiUrl('/api/searchux/status')),

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

  /* ------- FAZA 17: stability lab — live resilience, real stress ------- */
  platform: {
    /** GET /api/platform/stability — uncached live snapshot (UI refresh manual / 10min). */
    stability: () => request<StabilitySnapshot>(apiUrl('/api/platform/stability')),
    /** POST /api/platform/stress/run — real in-process load test.
     *  Server errors (409 lock / 429 rate limit / 400 bad suite) surface as
     *  ApiError with the backend message; the view maps them to RO toasts. */
    stressRun: (body: StressRunRequest) =>
      request<StressRunResponse>(apiUrl('/api/platform/stress/run'), {
        method: 'POST',
        body: JSON.stringify(body),
      }),
  },

  /* -- AR10M (ANIMAXIA REAL 10M): arhitectura reală — /api/ar10m/* prin
   *  gateway. Modulele backend se construiesc în paralel; endpoint-urile pot
   *  404 până la montaj — apelanții degradează onest (fallback legacy la
   *  căutare, "—" la contori), fără numere inventate. -- */

  /** GET /api/ar10m/stats — contori reali + capacitate (proiectată/testată/benchmark). */
  ar10mStats: () => request<Ar10mStats>(apiUrl('/api/ar10m/stats')),

  /** GET /api/ar10m/shards — registrul real de 15 sloturi + distribuția de rânduri. */
  ar10mShards: () => request<Ar10mShards>(apiUrl('/api/ar10m/shards')),

  /** GET /api/ar10m/budget — nivelul real de buget Neon + praguri + surse. */
  ar10mBudget: () => request<Ar10mBudget>(apiUrl('/api/ar10m/budget')),

  /** GET /api/ar10m/search — căutare în catalogul fuzionat AR10M+legacy,
   *  paginare keyset reală prin cursor (niciodată infinit virtual). */
  ar10mSearch: (q: string, opts: { year?: string | number; limit?: number; cursor?: string } = {}) =>
    request<Ar10mSearchResult>(
      apiUrl('/api/ar10m/search', { q, year: opts.year, limit: opts.limit, cursor: opts.cursor }),
    ),

  /** GET /api/ar10m/suggest — sugestii instant din titlurile reale. */
  ar10mSuggest: (q: string) =>
    request<{ ok: boolean; suggestions: Ar10mSuggestion[] }>(apiUrl('/api/ar10m/suggest', { q })),

  /* ------- FAZA 21 (frontend): playlists, subtitles, stats, playerhub, hub ------- */

  /* ------------- FAZA 19 (restaurat FAZA 29-R): Player Hub (/api/playerhub) ------------- */
  /** GET /api/playerhub/status — contract hub + totaluri live (public). */
  playerHubStatus: () => request<PlayerHubStatus>(apiUrl('/api/playerhub/status')),
  /** GET /api/playerhub/progress/:contentId — punctul de reluare al
   *  utilizatorului (auth). 404 când id-ul de conținut nu există. */
  playerHubProgress: (contentId: number) =>
    request<PlayerHubProgress>(apiUrl(`/api/playerhub/progress/${contentId}`), {
      headers: authHeaders(),
    }),
  /** POST /api/playerhub/progress — fire-and-forget: player-ul ping-uiește la
   *  ~10s de playback; `duration` e validat dar nu persistat. */
  playerHubSaveProgress: (contentId: number, seconds: number, duration?: number) =>
    request<{ ok: boolean; saved: boolean; progress: number }>(apiUrl('/api/playerhub/progress'), {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ contentId, seconds, ...(duration != null ? { duration } : {}) }),
    }),
  /** GET /api/playerhub/subtitles/:contentId — listă publică de piese WebVTT
   *  (fără payload-uri VTT; piesele brute trăiesc la playerHubSubtitleUrl). */
  playerHubSubtitles: (contentId: number) =>
    request<{ data: PlayerHubSubtitleTrack[] }>(apiUrl(`/api/playerhub/subtitles/${contentId}`)),
  /** GET /api/playerhub/playlists — playlist-urile utilizatorului (auth). */
  playerHubPlaylists: () =>
    request<{ data: PlayerHubPlaylistSummary[] }>(apiUrl('/api/playerhub/playlists'), {
      headers: authHeaders(),
    }),
  /** POST /api/playerhub/playlists — creare playlist (auth, max 20/user). */
  playerHubCreatePlaylist: (title: string, description?: string) =>
    request<{ ok: true; playlist: PlayerHubPlaylistSummary }>(apiUrl('/api/playerhub/playlists'), {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ title, ...(description ? { description } : {}) }),
    }),
  /** GET /api/playerhub/playlists/:id — detaliu cu itemi ordonați (owner). */
  playerHubPlaylistDetail: (id: number) =>
    request<PlayerHubPlaylistDetailResponse>(apiUrl(`/api/playerhub/playlists/${id}`), {
      headers: authHeaders(),
    }),
  /** DELETE /api/playerhub/playlists/:id — șterge playlist (owner). */
  playerHubDeletePlaylist: (id: number) =>
    request<{ ok: true; deleted: boolean }>(apiUrl(`/api/playerhub/playlists/${id}`), {
      method: 'DELETE',
      headers: authHeaders(),
    }),
  /** POST /api/playerhub/playlists/:id/items — adaugă conținut (dedupe →
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
  /** DELETE /api/playerhub/playlists/:id/items/:contentId — șterge + renumerotează. */
  playerHubRemovePlaylistItem: (playlistId: number, contentId: number) =>
    request<{ ok: true; removed: boolean }>(
      apiUrl(`/api/playerhub/playlists/${playlistId}/items/${contentId}`),
      {
        method: 'DELETE',
        headers: authHeaders(),
      },
    ),
  /** POST /api/playerhub/playlists/:id/reorder — reordonare exact-set. */
  playerHubReorderPlaylist: (playlistId: number, contentIds: number[]) =>
    request<{ ok: true; reordered: boolean; count: number }>(
      apiUrl(`/api/playerhub/playlists/${playlistId}/reorder`),
      {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ contentIds }),
      },
    ),
  /** GET /api/playerhub/stats — totaluri publice + top-5 continue-watching;
   *  secțiunea `admin` doar pentru token-uri admin. */
  playerHubStats: () =>
    request<PlayerHubStatsResponse>(apiUrl('/api/playerhub/stats'), {
      headers: authHeaders(),
    }),
  /** GET /api/playerhub/continue-watching — ultimele titluri vizionate cu
   *  progres/resume unificat (auth). */
  playerHubContinueWatching: () =>
    request<{ data: PlayerHubContinueWatchingItem[] }>(
      apiUrl('/api/playerhub/continue-watching'),
      {
        headers: authHeaders(),
      },
    ),
  /** POST /api/playerhub/subtitles/:contentId — atașează piesă WebVTT
   *  (admin; max 8/content, VTT trebuie să înceapă cu "WEBVTT"). */
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
  /** DELETE /api/playerhub/subtitles/:contentId/:trackId — detașează piesă
   *  (admin, audit-logged). */
  playerHubDeleteSubtitle: (contentId: number, trackId: number) =>
    request<{ ok: true; deleted: boolean }>(
      apiUrl(`/api/playerhub/subtitles/${contentId}/${trackId}`),
      {
        method: 'DELETE',
        headers: authHeaders(),
      },
    ),

  /** Real user playlists (Bearer attached via authHeaders). */
  playlists: {
    list: () => request<PlaylistsResponse>(apiUrl('/api/playlists'), { headers: authHeaders() }),
    create: (body: { title: string; description?: string }) =>
      request<{ ok: boolean; playlist: Playlist }>(apiUrl('/api/playlists'), {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(body),
      }),
    get: (id: number | string) =>
      request<PlaylistDetailResponse>(apiUrl(`/api/playlists/${id}`), { headers: authHeaders() }),
    patch: (id: number | string, body: { title?: string; description?: string }) =>
      request<{ ok: boolean; playlist: Playlist }>(apiUrl(`/api/playlists/${id}`), {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify(body),
      }),
    remove: (id: number | string) =>
      request<{ ok: boolean; deleted: number }>(apiUrl(`/api/playlists/${id}`), {
        method: 'DELETE',
        headers: authHeaders(),
      }),
    addItem: (id: number | string, contentId: number) =>
      request<{ ok: boolean; added: boolean; item?: PlaylistItem }>(apiUrl(`/api/playlists/${id}/items`), {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ contentId }),
      }),
    removeItem: (id: number | string, contentId: number) =>
      request<{ ok: boolean; removed: boolean }>(apiUrl(`/api/playlists/${id}/items/${contentId}`), {
        method: 'DELETE',
        headers: authHeaders(),
      }),
    play: (id: number | string, pos?: number) =>
      request<PlaylistPlayResponse>(apiUrl(`/api/playlists/${id}/play`, { pos }), { headers: authHeaders() }),
  },

  /** WebVTT subtitle tracks. The content listing is PUBLIC; admin routes
   *  attach the Bearer header when present. */
  subtitles: {
    forContent: (contentId: number | string) =>
      request<SubtitlesForContentResponse>(apiUrl(`/api/player/subtitles/content/${contentId}/subtitles`)),
    adminList: () =>
      request<{ ok: boolean; data: SubtitleAdminRow[] }>(apiUrl('/api/player/subtitles/list'), {
        headers: authHeaders(),
      }),
    upload: (body: { contentId: number; lang?: string; label?: string; vtt: string }) =>
      request<{ ok: boolean; subtitle: { id: number }; created: boolean }>(apiUrl('/api/player/subtitles'), {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(body),
      }),
    remove: (id: number | string) =>
      request<{ ok: boolean; deleted: number }>(apiUrl(`/api/player/subtitles/${id}`), {
        method: 'DELETE',
        headers: authHeaders(),
      }),
  },

  /** GET /api/users/me/stats — personal engagement (auth). */
  myStats: () => request<MyStatsResponse>(apiUrl('/api/users/me/stats'), { headers: authHeaders() }),

  /** Admin playerhub gauges + the admin's own watch history. */
  playerhub: {
    status: () =>
      request<PlayerhubStatusResponse>(apiUrl('/api/admin/playerhub/status'), { headers: authHeaders() }),
    history: () =>
      request<{ ok: boolean; data: PlayerhubHistoryEntry[] }>(apiUrl('/api/admin/playerhub/history'), {
        headers: authHeaders(),
      }),
  },

  /** FAZA 20 hub routes (public — reused by the #/stats gauges). */
  hub: {
    stats: () => request<HubStatsResponse>(apiUrl('/api/hub/stats')),
    feed: () => request<HubFeedResponse>(apiUrl('/api/hub/feed')),
  },

  /** GET /api/metrics?format=json — public Prometheus-style JSON registry. */
  metricsJson: () => request<MetricsJsonResponse>(apiUrl('/api/metrics', { format: 'json' })),

  /* -------- TS2b (admin producție): user management + moderare -------- */

  /** Admin-gated user management (Bearer attached via authHeaders). */
  adminUsers: {
    list: () => request<AdminUsersResponse>(apiUrl('/api/admin/users'), { headers: authHeaders() }),
    patch: (id: number, body: { banned?: boolean; isadmin?: boolean }) =>
      request<AdminUserPatchResponse>(apiUrl(`/api/admin/users/${id}`), {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify(body),
      }),
  },

  /** GET /api/admin/moderation — coada de moderare (comentarii/recenzii/party). */
  adminModeration: () =>
    request<AdminModerationResponse>(apiUrl('/api/admin/moderation'), { headers: authHeaders() }),

  /* ----- FAZA 23 (observability): animaxia-observability :4050 (public) ----- */

  /** GET /api/summary on :4050 — the 10 live gauges + the full FAZA-23
   *  contract (pipeline, hub, player, ai, neon, redis, gateway, alerts,
   *  synthetics, traces, metrics store) consumed by #/admin/observability. */
  observabilitySummary: () => request<ObservabilitySummary>(obsUrl('/api/summary')),

  /* ---------------- FAZA 32 (AI SUITE 100X): 18 motoare /api/ai/suite ---------------- */

  /** Registry — all 18 engines with toggles + runtime stats. */
  aiSuiteStatus: () => request<AiSuiteStatusResponse>(apiUrl('/api/ai/suite/status')),

  /** Toggle an engine (persisted in aisettings `suite:<key>`). */
  aiSuiteSettings: (key: string, enabled: boolean) =>
    request<{ ok: boolean; key: string; enabled: boolean }>(apiUrl('/api/ai/suite/settings'), {
      method: 'POST',
      body: JSON.stringify({ key, enabled }),
    }),

  aiSuiteMiner: () => request<AiSuiteMinerData>(apiUrl('/api/ai/suite/miner/data')),
  aiSuiteMinerDryRun: (provider: string) =>
    request<AiSuiteMinerDryRun>(apiUrl('/api/ai/suite/miner/dry-run', { provider })),
  aiSuiteMetadata: () => request<AiSuiteMetadataData>(apiUrl('/api/ai/suite/metadata/data')),
  aiSuiteAnalyzer: () => request<AiSuiteAnalyzerData>(apiUrl('/api/ai/suite/analyzer/data')),
  aiSuiteNews: () => request<AiSuiteNewsData>(apiUrl('/api/ai/suite/news/data')),
  aiSuiteNewsRefresh: () => request<AiSuiteNewsData>(apiUrl('/api/ai/suite/news/refresh')),
  aiSuiteSocial: () => request<AiSuiteSocialData>(apiUrl('/api/ai/suite/social/data')),
  aiSuiteWatchParty: () => request<AiSuiteWatchPartyData>(apiUrl('/api/ai/suite/watchparty/data')),
  aiSuiteRecommendations: (limit = 12) =>
    request<AiSuiteRecommendationsData>(apiUrl('/api/ai/suite/recommendations/data', { limit })),
  aiSuiteFranchise: () => request<AiSuiteFranchiseData>(apiUrl('/api/ai/suite/franchise/data')),
  aiSuiteTaxonomy: () => request<AiSuiteTaxonomyData>(apiUrl('/api/ai/suite/taxonomy/data')),
  aiSuiteStats: () => request<AiSuiteStatsData>(apiUrl('/api/ai/suite/stats/data')),
  aiSuiteInfiniteFeed: (cursor: number, seed: string, genre?: string) =>
    request<AiSuiteInfiniteFeedResponse>(
      apiUrl('/api/ai/suite/infinite/feed', { cursor, seed, genre }),
    ),
  aiSuiteScanner: () => request<AiSuiteScannerData>(apiUrl('/api/ai/suite/scanner/data')),
  aiSuiteDiscovery: () => request<AiSuiteDiscoveryData>(apiUrl('/api/ai/suite/discovery/data')),
  aiSuiteDuplicates: () => request<AiSuiteDuplicatesData>(apiUrl('/api/ai/suite/duplicates/data')),
  aiSuitePoster: (sample = 12) =>
    request<AiSuitePosterData>(apiUrl('/api/ai/suite/poster/data', { sample })),
  aiSuiteTrends: () => request<AiSuiteTrendsData>(apiUrl('/api/ai/suite/trends/data')),
  aiSuiteFeeds: () => request<AiSuiteFeedsData>(apiUrl('/api/ai/suite/feeds/data')),
  aiSuiteFeedsFetch: (feedId: string) =>
    request<AiSuiteFeedFetchResponse>(apiUrl(`/api/ai/suite/feeds/fetch/${encodeURIComponent(feedId)}`)),
  aiSuiteAdmin: () => request<AiSuiteAdminData>(apiUrl('/api/ai/suite/admin/data')),

  /* -- FAZA 34 (PLAN 100X · WS4): playerx — strat experiență peste playerul
   *  protejat FAZA 17 (backend FAZA-34-a, contract înghețat; endpoint-urile
   *  pot 404 până la deploy — UI-ul degradează onest la null). -- */

  /** GET /api/playerx/status — stats public despre stratul playerx. */
  playerxStatus: () => request<PlayerxStatus>(apiUrl('/api/playerx/status')),

  /** GET /api/playerx/markers/:contentId — markerii episodului (public). */
  playerxMarkers: (contentId: number) =>
    request<PlayerxMarkersResponse>(apiUrl(`/api/playerx/markers/${contentId}`)),

  /** POST /api/playerx/markers/:contentId — upsert marker (auth). */
  playerxUpsertMarker: (
    contentId: number,
    body: { kind: PlayerxMarkerKind; startsec: number; endsec: number; label?: string },
  ) =>
    request<{ ok: boolean; marker: PlayerxMarker }>(apiUrl(`/api/playerx/markers/${contentId}`), {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(body),
    }),

  /** DELETE /api/playerx/markers/:contentId/:kind — șterge markerul (auth). */
  playerxDeleteMarker: (contentId: number, kind: PlayerxMarkerKind) =>
    request<{ ok: boolean }>(apiUrl(`/api/playerx/markers/${contentId}/${kind}`), {
      method: 'DELETE',
      headers: authHeaders(),
    }),

  /** POST /api/playerx/markers/use — contor anonim de utilizare skip. */
  playerxMarkerUse: (contentId: number, kind: PlayerxMarkerKind) =>
    request<{ ok: boolean; skipUses: number }>(apiUrl('/api/playerx/markers/use'), {
      method: 'POST',
      body: JSON.stringify({ contentId, kind }),
    }),

  /** GET /api/playerx/subtitle-settings — setările de subtitrări din profil
   *  (auth; `settings: null` când utilizatorul nu a personalizat nimic). */
  playerxGetSubtitleSettings: () =>
    request<{ ok: boolean; settings: PlayerxSubtitleSettings | null }>(
      apiUrl('/api/playerx/subtitle-settings'),
      { headers: authHeaders() },
    ),

  /** PUT /api/playerx/subtitle-settings — salvează setările în profil (auth). */
  playerxSaveSubtitleSettings: (settings: PlayerxSubtitleSettings) =>
    request<{ ok: boolean }>(apiUrl('/api/playerx/subtitle-settings'), {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify(settings),
    }),

  /** GET /api/playerx/party/:partyId/votes — starea votului „următoarea
   *  vizionare" (public; 404 onest când petrecerea nu mai există — apelantul
   *  tratează 404-ul ca „cardul dispare"). */
  playerxPartyVotes: (partyId: number) =>
    request<PlayerxVoteState>(apiUrl(`/api/playerx/party/${partyId}/votes`)),

  /** POST /api/playerx/party/:partyId/vote — votează/schimbă votul (auth, doar
   *  membri + gazdă, un vot per user cât timp votul e deschis; 410 după
   *  închidere). */
  playerxPartyVote: (partyId: number, contentId: number) =>
    request<{ ok: boolean; tally: Record<string, number>; voters: PlayerxVoteVoter[] }>(
      apiUrl(`/api/playerx/party/${partyId}/vote`),
      {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ contentId }),
      },
    ),

  /** DELETE /api/playerx/party/:partyId/votes — GAZDA închide votul (auth,
   *  doar gazdă; winner = max tally, departajare deterministă la egalitate). */
  playerxClosePartyVote: (partyId: number) =>
    request<{ ok: boolean; winner: number | null; tally: Record<string, number> }>(
      apiUrl(`/api/playerx/party/${partyId}/votes`),
      {
        method: 'DELETE',
        headers: authHeaders(),
      },
    ),

  /* -- FAZA 35 (PLAN 100X · WS5): AI LAB — 8 capabilități /api/ai/lab/*
   *  (backend FAZA-35-a, contract înghețat; endpoint-urile pot 404 până la
   *  deploy — UI-ul degradează onest). NOTĂ: request() nu are timeout, deci
   *  apelurile lungi z-ai (chat ~5-15s, dubbing 30-60s, tts) așteaptă cum trebuie. -- */

  /** Registry — cele 8 capabilități cu comutatoare + statistici runtime. */
  aiLabStatus: () => request<AiLabStatusResponse>(apiUrl('/api/ai/lab/status')),

  /** Comută o capabilitate (POST /api/ai/lab/settings). */
  aiLabSettings: (key: string, enabled: boolean) =>
    request<AiLabSettingsResponse>(apiUrl('/api/ai/lab/settings'), {
      method: 'POST',
      body: JSON.stringify({ key, enabled }),
    }),

  /* ····························· companion ····························· */

  /** Contextul RAG al unui titlu (sinopsis, genuri, recenzii). */
  aiLabCompanionContext: (contentId: number) =>
    request<AiLabCompanionContextResponse>(apiUrl(`/api/ai/lab/companion/context/${contentId}`)),

  /** Chat cu AI Companion — clientul trimite maxim ultimele 8 mesaje. */
  aiLabCompanionChat: (contentId: number, messages: AiLabChatMessage[]) =>
    request<AiLabChatResponse>(apiUrl('/api/ai/lab/companion/chat'), {
      method: 'POST',
      body: JSON.stringify({ contentId, messages }),
    }),

  /* ······························· recap ······························· */

  /** „Ce ai ratat" — recap pe baza istoricului (auth sau ?userId=; 401 onest
   *  pentru anonimi fără userId — panoul afișează prompt de conectare). */
  aiLabRecap: (contentId: number, userId?: number) =>
    request<AiLabRecapResponse>(
      apiUrl(`/api/ai/lab/recap/${contentId}`, { userId }),
      { headers: authHeaders() },
    ),

  /* ······························· mood ································ */

  /** Cele 6 stări de spirit (relaxat, captivant, nostalgic, energic, misterios, romantic). */
  aiLabMoods: () => request<AiLabMoodsResponse>(apiUrl('/api/ai/lab/mood/moods')),

  /** Generează playlist de dispoziție (seed nou = amestecare nouă). */
  aiLabMoodGenerate: (mood: string, limit: number, seed: string) =>
    request<AiLabMoodGenerateResponse>(
      apiUrl('/api/ai/lab/mood/generate', { mood, limit, seed }),
    ),

  /* ······························· shield ······························ */

  /** Filtrează spoilerele din comentarii (contentId opțional pentru context). */
  aiLabShieldFilter: (body: { contentId?: number; texts: Array<{ id: string; body: string }> }) =>
    request<AiLabShieldResponse>(apiUrl('/api/ai/lab/shield/filter'), {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /* ······························ dubbing ······························ */

  /** Titlurile fără subtitrare RO (public; hasEn = are pistă EN de tradus). */
  aiLabDubbingMissing: (limit = 12) =>
    request<AiLabDubbingMissingResponse>(apiUrl('/api/ai/lab/dubbing/missing', { limit })),

  /** Generează draftul de traducere cu z-ai REAL (ADMIN, 30-60s — fără timeout). */
  aiLabDubbingGenerate: (contentId: number) =>
    request<AiLabDubbingDraftResponse>(apiUrl('/api/ai/lab/dubbing/generate'), {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ contentId }),
    }),

  /** Draftul existent (ADMIN; 404 onest când nu există încă). */
  aiLabDubbingDraft: (contentId: number) =>
    request<AiLabDubbingDraftResponse>(apiUrl(`/api/ai/lab/dubbing/draft/${contentId}`), {
      headers: authHeaders(),
    }),

  /** Salvează corecturile pe cue-uri (ADMIN). */
  aiLabDubbingSaveDraft: (contentId: number, cues: AiLabDubbingCue[]) =>
    request<AiLabDubbingDraftResponse>(apiUrl(`/api/ai/lab/dubbing/draft/${contentId}`), {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({ cues }),
    }),

  /** Publică subtitrarea RO generată (ADMIN). */
  aiLabDubbingPublish: (contentId: number) =>
    request<AiLabDubbingPublishResponse>(apiUrl(`/api/ai/lab/dubbing/publish/${contentId}`), {
      method: 'POST',
      headers: authHeaders(),
    }),

  /* ······························ curation ····························· */

  /** „De ce îți recomandăm?" — note + semnale ponderate (auth sau ?userId=). */
  aiLabCurationWhy: (contentId: number, userId?: number) =>
    request<AiLabCurationResponse>(
      apiUrl(`/api/ai/lab/curation/why/${contentId}`, { userId }),
      { headers: authHeaders() },
    ),

  /* ······························· voice ······························· */

  /** Starea serviciului vocal (voci TTS + limita de caractere). */
  aiLabVoiceStatus: () => request<AiLabVoiceStatusResponse>(apiUrl('/api/ai/lab/voice/status')),

  /** Speech-to-text (audioBase64, înregistrat cu MediaRecorder; 503 onest). */
  aiLabVoiceAsr: (audioBase64: string) =>
    request<AiLabAsrResponse>(apiUrl('/api/ai/lab/voice/asr'), {
      method: 'POST',
      body: JSON.stringify({ audioBase64 }),
    }),

  /** Text-to-speech (text ≤1024, voce opțională, viteză 0.5-2.0). */
  aiLabVoiceTts: (text: string, voice?: string, speed?: number) =>
    request<AiLabTtsResponse>(apiUrl('/api/ai/lab/voice/tts'), {
      method: 'POST',
      body: JSON.stringify({ text, voice, speed }),
    }),

  /* ······························· editor ······························ */

  /** Creează playlist din descriere liberă (interpretare + itemi reali). */
  aiLabEditorGenerate: (description: string, limit?: number) =>
    request<AiLabEditorGenerateResponse>(apiUrl('/api/ai/lab/editor/generate'), {
      method: 'POST',
      body: JSON.stringify({ description, limit }),
    }),

  /** Salvează playlist-ul în colecția mea (AUTH). */
  aiLabEditorSave: (playlist: { title: string; description: string }, itemIds: number[]) =>
    request<AiLabEditorSaveResponse>(apiUrl('/api/ai/lab/editor/save'), {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ playlist, itemIds }),
    }),

  /** Playlist-urile mele salvate (AUTH). */
  aiLabEditorLists: () =>
    request<AiLabEditorListsResponse>(apiUrl('/api/ai/lab/editor/lists'), {
      headers: authHeaders(),
    }),

  /* -- FAZA 36-R (PLAN 100X · WS6): PERSO — Personalizare & Recomandări 2.0
   *  (backend modules/perso, contract înghețat; identitate onestă: Bearer
   *  autentificat → ?user=<id> — anonimul primește 401 explicabil). -- */

  /** Starea modulului perso (contoare oneste, cache, limite). */
  persoStatus: () => request<PersoStatus>(apiUrl('/api/perso/status')),

  /** Profilul de gust învățat pasiv (cache 10 min server-side). */
  persoProfile: (userId?: number) =>
    request<PersoProfileResponse>(apiUrl('/api/perso/profile', { user: userId }), {
      headers: authHeaders(),
    }),

  /** Resetează agregarea învățată (semnalele istorice rămân în tabelele sursă). */
  persoProfileReset: (userId?: number) =>
    request<PersoProfileResetResponse>(apiUrl('/api/perso/profile/reset'), {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ ...(userId != null ? { userId } : {}) }),
    }),

  /** Feed-ul „Pentru Tine" cu secțiuni explicite și reason-uri lizibile. */
  persoFeed: (userId?: number, limit = 24) =>
    request<PersoFeedResponse>(apiUrl('/api/perso/feed', { user: userId, limit }), {
      headers: authHeaders(),
    }),

  /** Profilele multiple ale contului (max 5; hash-ul PIN-ului nu circulă). */
  persoProfiles: (userId?: number) =>
    request<PersoProfilesResponse>(apiUrl('/api/perso/profiles', { user: userId }), {
      headers: authHeaders(),
    }),

  /** Creează un profil ({name, emoji?, pin?} — primul devine principal). */
  persoProfileCreate: (body: { name: string; emoji?: string; pin?: string }, userId?: number) =>
    request<PersoProfileCreateResponse>(apiUrl('/api/perso/profiles'), {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ ...body, ...(userId != null ? { userId } : {}) }),
    }),

  /** Actualizează nume/emoji/PIN (oldPin obligatoriu dacă profilul are PIN). */
  persoProfileUpdate: (
    profileId: string,
    body: { name?: string; emoji?: string; pin?: string | null; oldPin?: string },
    userId?: number,
  ) =>
    request<PersoProfileUpdateResponse>(apiUrl(`/api/perso/profiles/${encodeURIComponent(profileId)}`, { user: userId }), {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify(body),
    }),

  /** Șterge un profil secundar (cel principal e refuzat onest de backend). */
  persoProfileDelete: (profileId: string, userId?: number) =>
    request<PersoProfileDeleteResponse>(apiUrl(`/api/perso/profiles/${encodeURIComponent(profileId)}`, { user: userId }), {
      method: 'DELETE',
      headers: authHeaders(),
    }),

  /** Verifică PIN-ul → token de sesiune profil (JWT-lite, 2h). */
  persoProfileVerify: (profileId: string, pin?: string, userId?: number) =>
    request<PersoProfileVerifyResponse>(apiUrl(`/api/perso/profiles/${encodeURIComponent(profileId)}/verify`), {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ ...(pin ? { pin } : {}), ...(userId != null ? { userId } : {}) }),
    }),

  /** Memento-urile de încheiere (titluri abandonate >3 zile, 20-90%). */
  persoReminders: (userId?: number) =>
    request<PersoRemindersResponse>(apiUrl('/api/perso/reminders', { user: userId }), {
      headers: authHeaders(),
    }),

  /** Respinge un memento (ascuns 30 de zile, apoi reapare onest). */
  persoReminderDismiss: (contentId: number, userId?: number) =>
    request<PersoReminderDismissResponse>(
      apiUrl(`/api/perso/reminders/${contentId}/dismiss`, { user: userId }),
      {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ ...(userId != null ? { userId } : {}) }),
      },
    ),

  /** Breakdown detaliat al afinităților (genuri/decenii/tipuri/diversitate). */
  persoAffinities: (userId?: number) =>
    request<PersoAffinitiesResponse>(apiUrl('/api/perso/affinities', { user: userId }), {
      headers: authHeaders(),
    }),

  /** „De ce îmi recomandați asta?" — linii de reasoning + scor. */
  persoExplain: (contentId: number, userId?: number) =>
    request<PersoExplainResponse>(apiUrl(`/api/perso/explain/${contentId}`, { user: userId }), {
      headers: authHeaders(),
    }),

  /** Semnal de interacțiune (view/like/complete/search; 60/min/IP). */
  persoEvent: (
    body: { type: 'view' | 'like' | 'complete' | 'search'; contentId?: number; weight?: number; term?: string },
    userId?: number,
  ) =>
    request<PersoEventResponse>(apiUrl('/api/perso/events'), {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ ...body, ...(userId != null ? { userId } : {}) }),
    }),
};

/** FAZA 19 (restaurat FAZA 29-R) — URL direct <track src> pentru o piesă WebVTT.
 *  Relativ (same origin) cu markerul de port gateway, ca orice alt request:
 *  browser-ul o fetch-uiește prin Caddy, care forwardează către backend unde
 *  VTT-ul brut e servit public cu cache 1h. */
export function playerHubSubtitleUrl(contentId: number, trackId: number): string {
  return apiUrl(`/api/playerhub/subtitles/${contentId}/${trackId}`);
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
