/**
 * types.ts — Animaxia shared TypeScript types mirroring the backend API contract.
 */

export type PlayerSourceType = 'mp4' | 'm3u8' | 'iframe' | 'youtube';

export interface PlayerSource {
  type: PlayerSourceType;
  url: string;
  label?: string;
}

export interface ContentMetadata {
  overview?: string;
  synopsis?: string;
  description?: string;
  rating?: number;
  score?: number;
  year?: string | number;
  genres?: string[];
  backdrop?: string;
  source?: string;
  mediaType?: string;
  url?: string;
  status?: string;
  episodes?: number;
  studios?: string[];
  trailerKey?: string;
  tagline?: string;
  runtime?: number;
  cast?: { name: string; character?: string; profile?: string }[];
  mined?: { at?: string; url?: string; siteName?: string; mp4?: string[]; m3u8?: string[]; iframe?: string[]; youtube?: string[] };
  player?: { sources?: PlayerSource[] };
  sources?: PlayerSource[];
  [key: string]: unknown;
}

export interface DbContent {
  id: number;
  externalid: string;
  type: string;
  title: string;
  metadata: ContentMetadata;
  thumbnail: string | null;
  createdat: string;
}

export interface AllResponse {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  data: DbContent[];
  warning?: string;
}

export interface PlayerResponse {
  content: DbContent;
  mode: 'direct' | 'trailer' | 'none';
  allowedTypes: string[];
  sources: PlayerSource[];
  primary: PlayerSource | null;
  note?: string;
}

export interface AnimeItem {
  id: number;
  title: string;
  image?: string;
  score?: number;
  year?: number | string;
  type?: string;
  genres?: string[];
  synopsis?: string;
  url?: string;
  status?: string;
  episodes?: number;
  studios?: string[];
  source?: string;
}

export interface MediaItem {
  id: number;
  title: string;
  image?: string;
  backdrop?: string;
  overview?: string;
  rating?: number;
  year?: string;
  mediaType: 'movie' | 'tv';
  genres?: string[];
  trailerKey?: string;
  tagline?: string;
  runtime?: number;
  cast?: { name: string; character?: string; profile?: string }[];
  source?: string;
}

/* --------------------- FAZA 14: live discover / radio / hubs -------------------- */

export interface DiscoverResponse {
  slug: string;
  title: string;
  page: number;
  total: number;
  totalPages: number;
  legs: number;
  legsOk: number;
  data: MediaItem[];
}

export interface FranchisePart {
  id: number;
  title: string;
  image: string | null;
  overview: string;
  rating: number | null;
  year: string | null;
  mediaType: 'movie';
  source: string;
}

export interface FranchiseCollection {
  id: number;
  name: string;
  overview: string;
  poster: string | null;
  backdrop: string | null;
  partCount: number;
  avgRating: number | null;
  years: { first: string | null; last: string | null } | null;
  parts: FranchisePart[];
}

export interface FranchisesResponse {
  total: number;
  failed: string[];
  data: FranchiseCollection[];
}

export interface FootballTableEntry {
  rank: number;
  team: string;
  teamCrest?: string;
  played: number;
  won: number;
  draw: number;
  lost: number;
  goalsFor: number;
  goalsAgainst: number;
  goalDifference: number;
  points: number;
}

export interface FootballMatch {
  id: number;
  utcDate: string;
  status: string;
  matchday?: number;
  home: string;
  away: string;
  homeCrest?: string;
  awayCrest?: string;
  score: { home: number | null; away: number | null };
}

export interface Competition {
  id: number;
  code: string;
  name: string;
  area?: string;
}

export interface F1Standing {
  position: number;
  driver: string;
  team: string;
  points: number;
  wins: number;
}

export interface F1Race {
  round: number;
  race: string;
  date: string;
  time?: string;
  circuit?: string;
  locality?: string;
  country?: string;
}

export interface MinerExtraction {
  url: string;
  finalUrl?: string;
  title?: string;
  description?: string;
  thumbnail?: string;
  siteName?: string;
  mp4: string[];
  m3u8: string[];
  iframe: string[];
  youtube: string[];
  bytesRead?: number;
  elapsedMs?: number;
  /** Legacy aliases kept for compatibility. */
  bytes?: number;
  ms?: number;
  contentType?: string;
}

export interface HealthResponse {
  status: string;
  service: string;
  version: string;
  env: string;
  uptimeSec: number;
  timestamp: string;
  db: {
    driver: 'postgres' | 'local-fallback';
    connected: boolean;
    totalItems: number;
    countsByType: Record<string, number>;
    lastError?: string;
  };
  cache: { keys: number; hits: number; misses: number; hitRate: number; enabled: boolean; ttlMs: number };
  rateLimit: { windowMs: number; max: number; trackedClients: number; totalLimited: number };
  providers: { name: string; state: string; failures: number; lastError?: string }[];
  player: { allowedTypes: string[] };
}

export interface SeedResponse {
  ok: true;
  added: { movie: number; tv: number; anime: number; demo: number };
  totalItems: number;
  animeSource: string;
}

/* ------------------------- FAZA 15: AI Home engine ------------------------ */

/** One poster in the AI infinite feed / metadata browse grids. */
export interface AiFeedItem {
  id: number;
  title: string;
  image: string | null;
  backdrop: string | null;
  overview: string;
  rating: number | null;
  year: string | null;
  mediaType: 'db' | 'movie' | 'tv' | 'anime';
  genres: string[];
  source: string;
}

/** GET /api/ai/home/feed — numbered pages of exactly `limit` posters. */
export interface AiFeedResponse {
  ai: boolean;
  engine: string;
  page: number;
  limit: number;
  totalPages: number;
  totalItems: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
  sourceMode: 'library' | 'library+external' | 'external';
  items: AiFeedItem[];
  generatedAt: string;
}

/** GET /api/ai/home/browse — feed shape filtered by a metadata dimension. */
export interface AiBrowseResponse {
  ai: boolean;
  dim: string;
  value: string;
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
  items: AiFeedItem[];
  generatedAt: string;
}

/** Taxonomy entries use `name` (genres / categories / decades). */
export interface AiCountEntry {
  name: string;
  count: number;
}

/** GET /api/ai/home/taxonomy — genres & categories from external posters. */
export interface AiTaxonomyResponse {
  ai: boolean;
  generatedAt: string;
  analyzedItems: number;
  sourcesChecked: string[];
  genres: AiCountEntry[];
  categories: AiCountEntry[];
  decades: AiCountEntry[];
}

/** GET /api/ai/home/taxonomy/narration — z-ai narration of the taxonomy. */
export interface AiNarrationResponse {
  ai: boolean;
  provider: 'z-ai' | 'heuristic';
  narration: string | null;
  generatedAt: string;
}

/** A recently added externally-sourced library row (stats payload). */
export interface AiRecentExternal {
  id: number;
  title: string;
  type: string;
  source: string;
  externalid: string | null;
  hasPoster: boolean;
  createdat: string | null;
}

/** GET /api/ai/home/stats — continuous external-load analysis. */
export interface AiExternalStatsResponse {
  ai: boolean;
  live: boolean;
  updatedAt: string;
  library: {
    total: number;
    withGenres: number;
    withYear: number;
    withDescription: number;
    bySource: Record<string, number>;
  };
  posters: { totalInLibrary: number; fromExternal: number };
  contents: { totalInLibrary: number; fromExternal: number };
  externalCatalog: {
    tmdbTrendingMovies: number | null;
    tmdbTrendingTv: number | null;
    jikanTop: number | null;
    checkedAt: string;
  };
  recent: AiRecentExternal[];
  delta: { since: string; newItems: number } | null;
}

/** Metadata dimensions extracted by the AI (sidebar submenus + browse). */
export type MetaDimension = 'year' | 'genre' | 'category' | 'studio' | 'actor' | 'collection' | 'franchise' | 'trilogy';

/** Metadata dimension entries use `value` (unlike taxonomy's `name`). */
export interface AiMetaEntry {
  value: string;
  count: number;
}

/** GET /api/ai/home/metadata — extraction coverage + ordered dimensions. */
export interface AiMetadataResponse {
  ai: boolean;
  generatedAt: string;
  enriching: { pool: number; enriched: number; ttlHours: number };
  coverage: {
    titles: number;
    withYear: number;
    withGenres: number;
    withDescription: number;
    withStudio: number;
    withCast: number;
    withCollection: number;
    withTrailer: number;
  };
  dimensions: Record<MetaDimension, AiMetaEntry[]>;
}

/** GET /api/ai/home/trailers — resolved YouTube trailer for a content key. */
export interface AiTrailerResponse {
  key: string;
  trailerKey: string | null;
  provider: 'tmdb-videos' | 'jikan' | 'youtube-search' | null;
  title: string | null;
  embedUrl: string | null;
  cached: boolean;
  fetchedAt: string;
  note?: string;
}

/** AI Home on/off toggles (persisted backend-side + localStorage mirror). */
export interface AiHomeSettings {
  infiniteScroll: boolean;
  aiCursor: boolean;
  autoTrailers: boolean;
  autoTaxonomy: boolean;
}

/** GET/POST /api/ai/home/settings. */
export interface AiHomeSettingsResponse {
  settings: AiHomeSettings;
  updatedAt: string;
}

/* ------------------- FAZA 16: Neon FTS search + ingest dedup ------------------ */

/** Query params accepted by GET /api/search/advanced (all filters optional). */
export interface SearchFilters {
  q?: string;
  type?: string;
  genre?: string;
  year?: string | number;
  minRating?: number;
  actor?: string;
  studio?: string;
  category?: string;
  sort?: 'score' | 'year' | 'rating' | 'title';
  fuzzy?: boolean;
  limit?: number;
  page?: number;
}

/** GET /api/search/advanced — Neon FTS engine response (engine='animaxia-neon-fts'). */
export interface SearchAdvancedResponse {
  took: number;
  total: number;
  max_score: number;
  page: number;
  limit: number;
  engine: string;
  data: (DbContent & { _score: number })[];
}

/** GET /api/search/autocomplete — prefix + trigram suggestions (max 8). */
export interface SearchAutocompleteResponse {
  suggestions: { id: number; title: string; type: string; thumbnail: string | null; rating: number | null }[];
}

/** GET /api/search/filters — facet values powering the advanced filter bar. */
export interface SearchFiltersOptions {
  genres: AiMetaEntry[];
  actors: AiMetaEntry[];
  years: number[];
  categories: AiMetaEntry[];
  studios: AiMetaEntry[];
}

/** GET /api/search/status — live engine health + rolling latency. */
export interface SearchStatus {
  docs: number;
  engine: string;
  backend: string;
  extensions: { pg_trgm: boolean };
  lastSync: string | null;
  dirty: boolean;
  latency: { p50Ms: number; p95Ms: number; samples: number };
  capacity: { indexedDocs: number };
  /** FAZA 18 — pipeline integration flag + the 10 live stage snapshots
   *  (additive fields; older backends simply omit them). */
  pipelineIntegrated?: boolean;
  pipelineStages?: { order: number; name: string; stats?: Record<string, unknown> }[];
}

/** GET /api/searchaccel/status — FAZA 29-P (PLAN 100X) accel engine stats:
 *  keepalive pool Neon + LRU cache + warming top interogări + prefetch. */
export interface SearchAccelStatus {
  ok: boolean;
  service: string;
  version: string;
  phase: string;
  uptimeSec: number;
  config: {
    ttlMs: number;
    maxKeys: number;
    pingIntervalMs: number;
    warmIntervalMs: number;
    warmTop: number;
  };
  keepalive: {
    purpose: string;
    pings: number;
    errors: number;
    lastPingMs: number | null;
    lastPingAt: number | null;
    avgPingMs: number | null;
  };
  cache: {
    keys: number;
    inflight: number;
    hits: number;
    misses: number;
    hitRate: number;
    evictions: number;
    errors: number;
  };
  warming: { runs: number; warmed: number; errors: number; lastRunAt: number | null };
  prefetch: { accepted: number; rejected: number; alreadyWarm: number };
  popular: { tracked: number };
  db: { driver: string; connected: boolean };
}

/* ---- FAZA 33 (PLAN 100X · WS3): searchux — strat UX peste motorul protejat ---- */

/** GET /api/searchux/suggest — autocomplete instant (cache 60s per prefix,
 *  single-flight, did-you-mean fuzzy pe stratul de sugestie). */
export interface SearchUxSuggest {
  suggestions: { id: number; title: string; type: string; thumbnail: string | null; rating: number | null }[];
  didYouMean?: { q: string; distance: number; count: number }[];
  took: number;
  cache: 'hit' | 'miss';
  engine: string;
}

/** GET /api/searchux/trending — top interogări ANONIMIZATE (text normalizat
 *  + contor; zero identitate) — fuziune searchux + accel popular. */
export interface SearchUxTrending {
  top: { q: string; count: number; lastAt: number; source: string }[];
  pool: number;
  anonymized: boolean;
}

/** GET /api/searchux/facets — fațete dinamice per căutare (tip / gen / an /
 *  notă / sursă), calculate pe un eșantion accelerat din motorul protejat. */
export interface SearchUxFacets {
  facets: {
    types: { value: string; count: number }[];
    genres: { value: string; count: number }[];
    years: { value: string; count: number }[];
    ratings: { value: string; count: number }[];
    sources: { value: string; count: number }[];
  };
  sampled: number;
  total: number;
  engine: string;
  took: number;
  cache: 'hit' | 'miss';
}

/** GET /api/searchux/status — stats onest (cache, trending, reaper ops). */
export interface SearchUxStatus {
  ok: boolean;
  service: string;
  version: string;
  phase: string;
  uptimeSec: number;
  config: {
    ttlMs: number;
    maxKeys: number;
    trendMax: number;
    ratePerMin: number;
    facetSample: number;
    cacheBackend: string;
  };
  suggest: {
    requests: number;
    cacheHits: number;
    cacheMisses: number;
    errors: number;
    didYouMean: number;
    p50Ms: number | null;
    p95Ms: number | null;
    hitRate: number;
  };
  trending: { requests: number; pool: number; merged: number; anonymized: boolean };
  facets: { requests: number; cacheHits: number; errors: number; cachedKeys: number };
  track: { accepted: number; rejected: number };
  reaper: { purpose: string; reapAfterSec: number; intervalMs: number; runs: number; reaped: number; errors: number; lastRunAt: number | null };
  caches: { suggestKeys: number; facetKeys: number; inflight: number };
}

/** One row of the global `contentsources` dedup registry. */
export interface IngestSource {
  id: number;
  urlhash: string;
  url: string;
  originalurl: string;
  kind: 'link' | 'mp4' | 'm3u8' | 'dash' | 'youtube' | 'vimeo' | 'dailymotion' | 'js' | 'embed' | string;
  contentid: number | null;
  externalid: string | null;
  addedby: string;
  hits: number;
  metadata: Record<string, unknown>;
  createdat: string;
  lastseenat: string;
}

/** POST /api/ingest/check — "verify link before adding" lookup. */
export interface IngestCheckResponse {
  ok: boolean;
  exists: boolean;
  duplicate: boolean;
  source: IngestSource | null;
  content: DbContent | null;
}

/** POST /api/ingest/register — records a URL in the dedup registry. */
export interface IngestRegisterResponse {
  ok: boolean;
  registered: boolean;
  duplicate: boolean;
  source: IngestSource;
}

/** GET /api/ingest/sources?limit&page&kind. */
export interface IngestSourcesResponse {
  data: IngestSource[];
  total: number;
  page: number;
}

/** GET /api/ingest/stats. */
export interface IngestStats {
  total: number;
  byKind: Record<string, number>;
  duplicatesBlocked: number;
  lastRegisteredAt: string | null;
  linkedContents: number;
}

/* ============ AR10M — ANIMAXIA REAL 10M (arhitectura reală) =================
 * Contractul modulelor /api/ar10m/* (backend modules/ar10m, port 4000 prin
 * gateway). Contoarele sunt EXCLUSIV reale — valori lipsă → null / "—",
 * niciodată numere simulate. Endpoint-urile pot 404 până la montajul
 * orchestratorului; UI-ul degradează onest.
 * ==========================================================================*/

/** GET /api/ar10m/stats — contori reali + capacitate declarată separat. */
export interface Ar10mStats {
  ok: boolean;
  real: {
    titles: number;
    sources: number;
    users: number;
    legacyTitles: number;
    playableTitles: number;
    shardsConfigured: number;
    shardsOnline: number;
    dbSizeBytes: number;
    lastSyncAt: string | null;
    economicMode: boolean;
    budgetLevel: string;
  };
  capacity: {
    designed: number;
    tested: number | null;
    benchmarked: number | null;
  };
  message: string;
  asOf: string;
}

/** GET /api/ar10m/shards — un slot de shard din registrul real. */
export interface Ar10mShardInfo {
  slot: number;
  name: string;
  configured: boolean;
  mode: string;
  hostMasked: string | null;
  poolActive: boolean;
  openConnections: number;
  state: string | null; // 'closed' | 'open' | 'half-open' | 'inactive' | null (defensiv)
  lastLatencyMs: number | null;
  lastRowCount: number | null;
  lastSpaceBytes: number | null;
  lastUsedAt: string | null;
}

/** GET /api/ar10m/shards — registry + distribuția reală de rânduri. */
export interface Ar10mShards {
  ok: boolean;
  shards: Ar10mShardInfo[];
  distribution: { shardId: number; rows: number; pct: number }[];
}

/** GET /api/ar10m/budget — bugetul real Neon (nivel + praguri + surse). */
export interface Ar10mBudget {
  ok: boolean;
  usage: {
    cuHours: number | null;
    transferBytes: number | null;
    storageBytes: number | null;
    queriesPerMin: number | null;
    cacheHitRate: number | null;
    activeShards: number;
    activePools: number;
  };
  thresholds: { warn: number; economy: number; critical: number; max: number };
  level: 'normal' | 'warning' | 'economic' | 'critical';
  economicMode: boolean;
  sources: { storage: boolean; cuHours: boolean; qpm: boolean };
}

/** GET /api/ar10m/search — un rezultat din catalogul fuzionat AR10M+legacy. */
export interface Ar10mSearchItem {
  id: number;
  title: string;
  year: number | null;
  sourceType: string | null;
  sourceUrl: string | null;
  embedCode: string | null;
  shardId: number | null;
  thumbnailId: number | null;
  catalog: 'ar10m' | 'legacy';
}

/** GET /api/ar10m/search — paginare reală keyset (cursor), zero infinit virtual. */
export interface Ar10mSearchResult {
  ok: boolean;
  q: string;
  year: number | null;
  results: Ar10mSearchItem[];
  nextCursor: string | null;
  cached: boolean;
  negative: boolean;
  elapsedMs: number;
  shards: { queried: number; failed: number };
}

/** GET /api/ar10m/suggest — sugestii din titlurile reale. */
export interface Ar10mSuggestion {
  id: number;
  title: string;
  year: number | null;
}

/* --------------------------- FAZA 16: AI Hub ------------------------------- */

export type AiHubKey = 'curator' | 'forecaster' | 'semantic' | 'watchdog' | 'marathon' | 'translator';

/** Per-AI live stats (only the keys relevant for each AI are present). */
export interface AiHubStats {
  duplicates?: number;
  avgCompleteness?: number;
  eventsAnalyzed?: number;
  embedded?: number;
  total?: number;
  alerts?: number;
  score?: number;
  marathons?: number;
  translations?: number;
}

export interface AiHubAi {
  key: AiHubKey;
  name: string;
  emoji: string;
  description: string;
  enabled: boolean;
  provider: string;
  lastRunAt: string | null;
  stats: AiHubStats;
}

/** GET /api/ai/hub/status. */
export interface AiHubStatusResponse {
  ais: AiHubAi[];
  existing: { key: string; name: string; emoji: string; enabled: null; note: string }[];
  generatedAt: string;
}

/** GET /api/ai/hub/curator/scan. */
export interface CuratorScan {
  duplicates: { ids: number[]; titles: string[]; reason: 'similar-title' | 'same-source' | string; similarity: number }[];
  completeness: { contentId: number; title: string; score: number; missing: string[] }[];
  avgScore: number;
  scanned: number;
  generatedAt: string;
}

/** POST /api/ai/hub/curator/enrich (auth). */
export interface CuratorEnrichResponse {
  ok: boolean;
  enriched: { contentId: number; title: string; added: string[] }[];
  provider: string;
  scanned: number;
  generatedAt: string;
}

/** GET /api/ai/hub/trends/forecast?window=1d|7d|30d. */
export interface TrendForecast {
  window: string;
  days: number;
  eventsAnalyzed: number;
  source: 'viewevents' | 'library-heuristic' | string;
  rising: TrendItem[];
  top: TrendItem[];
  narrative: string;
  provider: string;
  generatedAt: string;
}

export interface TrendItem {
  contentId: number;
  title: string;
  thumbnail: string | null;
  type: string;
  recentViews: number | null;
  previousViews: number | null;
  momentum: number | null;
  score: number | null;
}

/** POST /api/ai/hub/semantic/query. */
export interface SemanticQueryResponse {
  ok: boolean;
  results: { contentId: number; externalid: string; title: string; type: string; thumbnail: string | null; score: number }[];
  provider: string;
  queryProvider: string;
  embeddedDocs: number;
}

/** GET /api/ai/hub/semantic/similar/:contentId. */
export interface SemanticSimilarResponse {
  ok: boolean;
  contentId: number;
  results: SemanticQueryResponse['results'];
  provider: string;
}

/** GET /api/ai/hub/semantic/status. */
export interface SemanticStatus {
  embedded: number;
  total: number;
  provider: string;
  dims: number;
  lastEmbedAt: string | null;
}

/** GET /api/ai/hub/watchdog/health. */
export interface WatchdogHealth {
  ok: boolean;
  score: number;
  alerts: { severity: 'critical' | 'warning' | 'info' | string; area: string; message: string; hint: string }[];
  checks: { name: string; status: 'pass' | 'warn' | 'fail' | string; detail: string }[];
  diagnosis: string;
  provider: string;
  checkedAt: string;
}

/** GET /api/ai/hub/marathon/suggestions. */
export interface MarathonSuggestion {
  key: string;
  title: string;
  emoji: string;
  count: number;
  items: { contentId: number | null; externalId: string; title: string; thumbnail: string | null; year: number | null; order: number }[];
  rationale: string;
}

export interface MarathonSuggestionsResponse {
  suggestions: MarathonSuggestion[];
}

/** POST /api/ai/hub/marathon/create {key} (auth). */
export interface MarathonCreateResponse {
  ok: boolean;
  marathon: {
    id: number;
    key: string;
    userid: number;
    title: string;
    description: string;
    items: MarathonSuggestion['items'];
    createdat: string;
  };
}

/** GET /api/ai/hub/marathon/list. */
export interface MarathonListResponse {
  data: {
    id: number;
    key: string;
    userid: number;
    title: string;
    description: string;
    items: MarathonSuggestion['items'];
    createdat: string;
    mine: boolean;
  }[];
}

/** POST /api/ai/hub/translate {contentId, lang} (auth, 10/min). */
export interface TranslateResponse {
  ok: boolean;
  contentId: number;
  lang: string;
  translation: string;
  provider: string;
}

/** GET /api/ai/hub/translate/status. */
export interface TranslateStatusResponse {
  coverage: { total: number; withTranslations: number; byLang: Record<string, number> };
}

/**
 * Normalized display item used by every card/row/hero component.
 * kind:
 *  - 'db'       → row in the Animaxia library (dbId present)
 *  - 'external' → live provider item (extType + extId present, detail page fetches live)
 *  - 'link'     → opens an external URL (news articles, TVmaze entries)
 */
export interface NormalizedItem {
  key: string;
  kind: 'db' | 'external' | 'link';
  dbId?: number;
  extType?: 'movie' | 'tv' | 'anime';
  extId?: string;
  title: string;
  image?: string | null;
  backdrop?: string | null;
  overview?: string;
  rating?: number | null;
  year?: string | number | null;
  type: string;
  genres?: string[];
  url?: string;
  source?: string;
  playable?: boolean;
}

/* --------------- FAZA 17: stability lab — resilience / stress --------------- */

/** GET /api/platform/stability — live resilience snapshot (uncached, poll 10min). */
export interface StabilitySnapshot {
  ok: boolean;
  uptimeSec: number;
  eventLoopLag: { currentMs: number; p50Ms: number; p95Ms: number };
  memory: {
    rssBytes: number;
    heapUsedBytes: number;
    heapTotalBytes: number;
    externalBytes: number;
    rssLimitBytes: number;
  };
  activeHandles: number | null;
  inFlight: number;
  inFlightMax: number;
  shed: { count: number; lastShedAt: string | null; reason: string | null };
  timeouts: number;
  memoryPurges: number;
  config: {
    requestTimeoutMs: number;
    rssLimitBytes: number;
    shedThresholds: { lagP95Ms: number; lagExtremeMs: number; rssRatio: number };
  };
  pool: { total: number; idle: number; waiting: number };
  search: { coalesced: number; errors: number; offsetCapped: number };
}

/** POST /api/platform/stress/run request body (suite reale, fără simulări). */
export interface StressRunRequest {
  suite: 'search' | 'ingest';
  durationSec?: number;
  concurrency?: number;
  q?: string;
}

/** Per-suite stress extras (chei plate în răspunsurile single-suite). */
export interface StressRunExtra {
  queries?: number;
  hitQueries?: number;
  errors?: number;
  unique?: number;
  duplicates?: number;
}

/** POST /api/platform/stress/run response (409/429/400 arrive as ApiError). */
export interface StressRunResponse {
  ok: boolean;
  suite: 'search' | 'ingest';
  durationMs: number;
  requests: number;
  okCount: number;
  errorCount: number;
  rps: number;
  latency: { p50Ms: number; p95Ms: number; p99Ms: number; maxMs: number };
  maxEventLoopLagMs: number;
  memory: { beforeRssBytes: number; afterRssBytes: number; deltaBytes: number };
  shed: number;
  errors: string[];
  extra: StressRunExtra;
}

/* ---------------- FAZA 21: playlists, subtitles, stats, playerhub ---------------- */

/** GET /api/playlists row (itemCount + first item preview via LATERAL join). */
export interface PlaylistSummary {
  id: number;
  title: string;
  description: string;
  itemCount: number;
  firstThumbnail: string | null;
  firstTitle: string | null;
  createdat: string;
  updatedat: string;
}

export interface Playlist {
  id: number;
  title: string;
  description: string;
  itemCount: number;
  firstThumbnail: string | null;
  firstTitle: string | null;
  createdat: string;
  updatedat: string;
}

/** GET /api/playlists/:id item row (content columns flattened). */
export interface PlaylistItem {
  contentId: number;
  title: string;
  thumbnail: string | null;
  type: string;
  rating: number | null;
  year: number | null;
  position: number;
  addedat: string;
}

/** GET /api/playlists (list) response. */
export interface PlaylistsResponse {
  ok: boolean;
  data: PlaylistSummary[];
}

/** GET /api/playlists/:id response (playlist.itemCount is not live-updated
 *  server-side — trust items.length in the UI). */
export interface PlaylistDetailResponse {
  ok: boolean;
  playlist: Playlist;
  items: PlaylistItem[];
}

/** GET /api/playlists/:id/play response. */
export interface PlaylistPlayResponse extends PlaylistDetailResponse {
  startPos: number;
}

/** Public subtitle track metadata (GET /api/player/subtitles/content/:id). */
export interface SubtitleTrack {
  id: number;
  lang: string;
  label: string;
  /** Relative backend path (/api/player/subtitles/{id}.vtt) — prefix with
   *  apiUrl() so the request goes through the Caddy gateway. */
  src: string;
}

/** GET /api/player/subtitles/content/:id response. */
export interface SubtitlesForContentResponse {
  ok: boolean;
  contentId: number;
  data: SubtitleTrack[];
}

/** GET /api/player/subtitles/list (admin) row. */
export interface SubtitleAdminRow {
  id: number;
  contentId: number;
  contentTitle: string;
  lang: string;
  label: string;
  bytes: number;
  cues: number;
  createdat: string;
}

/** GET /api/users/me/stats (FAZA 21 personal engagement). */
export interface MyStatsResponse {
  ok: boolean;
  watch: {
    historyCount: number;
    totalMinutes: number;
    byType: { type: string; count: number }[];
    avgProgress: number | null;
  };
  engagement: {
    activeDays: number;
    lastActive: string | null;
    streakDays: number;
  };
  watchlistCount: number;
  viewsCount: number;
  topGenres: { genre: string; count: number }[];
  aiUsage: { calls: number; lastUsedAt: string | null } | null;
}

/** GET /api/admin/playerhub/status (admin live gauges). */
export interface PlayerhubStatusResponse {
  ok: boolean;
  playback: {
    total: number;
    last24h: number;
    byKind: Record<string, number>;
  };
  topWatched: {
    contentId: number;
    title: string;
    type: string;
    thumbnail: string | null;
    plays: number;
  }[];
  subtitles: {
    total: number;
    perContent: { contentId: number; title: string; tracks: number }[];
  } | null;
  sources: {
    allowedTypes: string[];
    contentWithSources: number;
    byMode: Record<string, number>;
    note?: string;
  };
  usersWatching: number;
  avgProgress: number | null;
  uptimeSec: number;
  generatedAt: string;
}

/** GET /api/admin/playerhub/history row (the admin's own watch history). */
export interface PlayerhubHistoryEntry {
  contentid: number;
  title: string;
  thumbnail: string | null;
  progress: number;
  watchedat: string;
}

/** GET /api/hub/feed combined entry (origin + raw item, FAZA 20). */
export interface HubFeedEntry {
  origin: 'personal' | 'global' | 'ai' | string;
  item: Record<string, unknown> & { id?: number | string };
}

/** GET /api/hub/feed response (combined cap 24). */
export interface HubFeedResponse {
  ok: boolean;
  personal: { items: unknown[]; source: string; note?: string };
  global: { items: unknown[]; source: string };
  ai: { items: unknown[]; source: string; note?: string };
  combined: HubFeedEntry[];
  combinedCount: number;
  generatedAt: string;
}

/** GET /api/hub/stats response (FAZA 20 — public catalog stats). */
export interface HubStatsResponse {
  ok: boolean;
  source: string;
  totalItems: number;
  countsByType: Record<string, number>;
  metadataCompleteness: number;
  completeness?: { rows: number; thumbnailPct: number; overviewPct: number; genresPct: number; completePct: number };
  sources?: { registry: { total: number }; providers: { value: string; count: number }[] };
  viewevents: {
    total: number;
    last24h: number;
    topViewed: { id: number; title: string; type: string; thumbnail: string | null; views: number }[];
  };
  users: { count: number };
  uptimeSec: number;
  generatedAt: string;
}


/** GET /api/metrics?format=json (public Prometheus-style JSON registry —
 *  shapes kept deliberately loose: route keys are dynamic). */
export interface MetricsJsonResponse {
  service: string;
  uptimeSec: number;
  generatedAt: string;
  http: {
    totalRequests: number;
    serverErrors: number;
    errorRate: number;
    routes: Record<string, { requests: number; errors5xx: number; avgMs: number }>;
  };
  counters?: Record<string, unknown>;
  collectors?: {
    db?: Record<string, unknown>;
    cache?: Record<string, unknown>;
    providers?: Record<string, unknown>;
    ai?: {
      provider?: { provider?: string; available?: boolean; model?: string };
      usage?: { totalCalls?: number; callsToday?: number; errors?: number } & Record<string, unknown>;
    };
    vector?: Record<string, unknown>;
    shards?: Record<string, unknown>;
    miner?: Record<string, unknown>;
  };
  process?: { memoryRssBytes?: number };
}

/* ------------- TS2b: admin user management + moderation queue ------------- */

/** GET /api/admin/users — one row per user (admin-gated). */
export interface AdminUserRow {
  id: number;
  username: string;
  email: string;
  isadmin: boolean;
  role: string;
  emailverified: boolean;
  twofaenabled: boolean;
  banned: boolean;
  createdat: string | null;
  lastloginat: string | null;
}

export interface AdminUsersResponse {
  ok: boolean;
  data: AdminUserRow[];
}

/** PATCH /api/admin/users/:id — { banned?, isadmin? } (admin-gated, guarded). */
export interface AdminUserPatchResponse {
  ok: boolean;
  user: AdminUserRow;
}

export interface ModerationComment {
  id: number;
  body: string;
  createdat: string | null;
  author: string;
  authorid: number;
  contentid: number | null;
  contenttitle: string | null;
  contenttype: string | null;
}

export interface ModerationReview {
  id: number;
  rating: number;
  title: string | null;
  body: string;
  createdat: string | null;
  author: string;
  authorid: number;
  contentid: number | null;
  contenttitle: string | null;
  contenttype: string | null;
}

export interface ModerationParty {
  id: number;
  code: string;
  title: string;
  status: string;
  createdat: string | null;
  updatedat: string | null;
  author: string;
  authorid: number;
  contentid: number | null;
  contenttitle: string | null;
  contenttype: string | null;
}

/** GET /api/admin/moderation — latest 30 comments + 30 reviews + 30 parties. */
export interface AdminModerationResponse {
  ok: boolean;
  comments: ModerationComment[];
  reviews: ModerationReview[];
  parties: ModerationParty[];
}

/** POST /api/auth/2fa/setup — enrollment start (secret NOT yet active). */
export interface TwoFactorSetupResponse {
  ok: true;
  secret: string;
  otpauthUrl: string;
}

/* ----- FAZA 23 (observability): GET /api/summary on animaxia-observability :4050 -----
 * Typed 1:1 after the REAL service output (curl http://localhost:4050/api/summary):
 * 10 gauges in fixed order + pipeline + hub + player + ai + neon + redis +
 * gateway + alerts + synthetics (46 checks) + traces + metrics store info. */

/** One of the 10 live gauges (uptime, backend, neon, redis, gateway, ai_usage,
 *  search_activity, hub_activity, pipeline_health, synthetics). */
export interface ObservabilityGauge {
  id: string;
  label: string;
  value: number;
  unit: string;
  status: 'ok' | 'warn' | 'error';
  detail: string;
}

/** FAZA-18 pipeline layer re-exposed by the observability scraper. */
export interface ObservabilityPipelineLayer {
  id: number;
  name: string;
  stats: Record<string, unknown>;
}

/** FAZA-20 hub route counters (route → requests + p95 latency). */
export interface ObservabilityHubRoute {
  route: string;
  requests: number;
  p95Ms: number | null;
}

/** FAZA-21 three-source hub feed sizes (personal / global / ai). */
export interface ObservabilityFeedSource {
  source: string;
  items: number;
}

/** Alertmanager entry for a pending/firing rule. */
export interface ObservabilityAlertEntry {
  id: string;
  name: string;
  severity: string;
  since: string;
}

/** Latest failed synthetic check (id, name, error, timestamp). */
export interface ObservabilitySyntheticFailure {
  id: string;
  name: string;
  error: string | null;
  ts: string;
}

/** One recent trace as listed by the OTel collector (ring buffer). */
export interface ObservabilityTraceRecent {
  traceId: string;
  service: string;
  name: string;
  durationMs: number;
  status: string;
  startedAt: string;
}

/** Per-service span aggregates (name → spans, errors, errorRate, avgMs). */
export interface ObservabilityTraceService {
  name: string;
  spans: number;
  errors: number;
  errorRate: number;
  avgMs: number;
}

/** GET /api/summary?XTransformPort=4050 — the full FAZA-23 contract. */
export interface ObservabilitySummary {
  ok: boolean;
  service: string;
  generatedAt: string;
  gauges: ObservabilityGauge[];
  pipeline: {
    layers: ObservabilityPipelineLayer[];
    requests5m: number;
    rejections5m: number;
    queueLength: number;
    cacheHitRate: number;
  };
  hub: {
    routes: ObservabilityHubRoute[];
    feed3: { sources: ObservabilityFeedSource[] };
    stats: Record<string, unknown>;
  };
  player: {
    resumeEvents: number;
    subtitleRequests: number;
    playbackErrors: number;
    fallbacks: { total: number; breakdown: { label: string; value: number }[] };
  };
  ai: {
    calls: number;
    errors: number;
    latencyP95: number | null;
    byRoute: { route: string; calls: number }[];
  };
  neon: { connected: boolean; latencyMs: number | null; docs: number; shardsHealthy: number | null };
  redis: { connected: boolean; mode: string; keys: number | null };
  gateway: {
    up: boolean;
    regions: Record<string, { healthy: boolean; latencyMs: number | null }>;
    failovers: number;
    cacheHitRate: number;
  };
  alerts: {
    firing: ObservabilityAlertEntry[];
    pending: ObservabilityAlertEntry[];
    totalRules: number;
  };
  synthetics: {
    total: number;
    passing: number;
    failing: number;
    lastRunAt: string | null;
    byRegion: Record<string, { passing: number; total: number }>;
    recentFailures: ObservabilitySyntheticFailure[];
  };
  traces: {
    active: number;
    spansPerMin: number;
    services: ObservabilityTraceService[];
    recent: ObservabilityTraceRecent[];
  };
  metrics: { families: number; samples: number; retentionDays: number };
}

/* ============================================================================
 * FAZA 29-R (PLAN 100X): RESTAURARE tipuri pierdute la snapshot-restore.
 * Canonic din lineage-ul FAZA 14-19: consolele de
 * administrare căutare (FAZA 15/16/17/18) și Player Hub (FAZA 19).
 * Zero duplicat cu ce există — doar ce lipsea.
 * ==========================================================================*/

/** Priority lanes: high = admin/ops/QA, normal = logged-in users, low = anonymous. */
export type SearchFlowPriorityKey = 'high' | 'normal' | 'low';

/** flowControl block of /api/search/status and /api/search/flow — the live
 *  queue / inflight / wait / drop counters plus per-priority attribution. */
export interface SearchFlowControlStatus {
  queueEnabled: boolean;
  maxConcurrent: number;
  queueCap: number;
  maxWaitMs: number;
  queueLength: number;
  inflight: number;
  maxInflightSeen: number;
  queueHighWater: number;
  admitted: number;
  processed: number;
  errors: number;
  dropped: number;
  timedOut: number;
  lastDroppedAt: string | null;
  lastTimedOutAt: string | null;
  /** Executions per second (rolling). */
  processingRate: number;
  waitP50Ms: number;
  waitP95Ms: number;
  /** Current queue length per priority lane. */
  priorities: Record<SearchFlowPriorityKey, number>;
  /** Human-readable lane policy (high / normal / low / aging keys). */
  priorityPolicy: Record<string, string>;
  processedByPriority: Record<SearchFlowPriorityKey, number>;
  droppedByPriority: Record<SearchFlowPriorityKey, number>;
  waitP50ByPriority: Record<SearchFlowPriorityKey, number>;
}

/** windowing block — search executions are dispatched only inside fixed time
 *  windows (intervalMs), at most batchSize new entries per window. */
export interface SearchWindowingStatus {
  intervalMs: number;
  batchSize: number;
  windowsFired: number;
  windowDispatches: number;
  avgBatchSize: number;
  maxDispatchPerWindow: number;
}

/** Runtime flow config: env defaults + admin overrides via
 *  POST /api/search/flow/settings (server-side clamped). */
export interface SearchFlowConfig {
  enabled: boolean;
  maxConcurrent: number;
  intervalMs: number;
  batchSize: number;
  queueCap: number;
  maxWaitMs: number;
  lowPromoteMs: number;
  normalPromoteMs: number;
}

/** One rolling 1 s history sample of the flow console (last 180 samples). */
export interface SearchFlowHistoryPoint {
  t: string;
  queueLength: number;
  inflight: number;
  rate: number;
  dropped: number;
}

/** One per-shard attribution row of the flow console (30 rows under FAZA 14). */
export interface SearchFlowShardStats {
  shardid: number;
  queueLength: number;
  inflight: number;
  processed: number;
  dropped: number;
}

/** GET /api/search/flow — the full search flow console payload. */
export interface SearchFlowConsole {
  flowControl: SearchFlowControlStatus;
  windowing: SearchWindowingStatus;
  config: SearchFlowConfig;
  history: SearchFlowHistoryPoint[];
  perShard: SearchFlowShardStats[];
}

/** Pacing block on every admitted /advanced response — the UI's source of
 *  truth for its own cooldown affordance (disable ENTER + countdown). */
export interface SearchRatePacingInfo {
  perUserMs: number;
  cooldownMs: number;
}

/** rateLimit block of /api/search/status — the pinned FAZA 16 contract
 *  { perUserMs, enforced } plus the live pacing / cooldown / spam state. */
export interface SearchRateLimitStatus {
  enabled: boolean;
  enforced: boolean;
  perUserMs: number;
  cooldownMs: number;
  cooldownEnforced: boolean;
  spamProtection: { windowMs: number; threshold: number; blockMs: number };
  hits: number;
  cooldownBlocks: number;
  spamBlocked: number;
  trackedUsers: number;
  lastRateLimitAt: string | null;
  lastCooldownAt: string | null;
  lastSpamAt: string | null;
}

/** burstControl block of /api/search/status — the pinned FAZA 16 contract
 *  { active, maxBurstPerWindow } plus live micro-spike detection state. */
export interface SearchRateBurstStatus {
  active: boolean;
  burstActive: boolean;
  maxBurstPerWindow: number;
  windowMs: number;
  events: number;
  lastBurstAt: string | null;
  arrivalsInWindow: number;
  arrivalsPerS: number;
  peak: number;
}

/** Runtime rate config: env defaults + admin overrides via
 *  POST /api/search/rate/settings (server-side clamped). */
export interface SearchRateConfig {
  enabled: boolean;
  perUserMs: number;
  cooldownMs: number;
  spamWindowMs: number;
  spamThreshold: number;
  spamBlockMs: number;
  burstWindowMs: number;
  burstThreshold: number;
}

/** One rolling 1s history sample of the rate console (last 180 samples). */
export interface SearchRateHistoryPoint {
  t: string;
  arrivals: number;
  admitted: number;
  blocked: number;
  tracked: number;
}

/** One per-shard attribution row of the rate console (30 rows). */
export interface SearchRateShardStats {
  shardid: number;
  admitted: number;
  rateLimited: number;
  cooldownActive: number;
  spamBlocked: number;
}

/** GET /api/search/rate — the full Search Rate Management console payload. */
export interface SearchRateConsole {
  rateLimit: SearchRateLimitStatus;
  burstControl: SearchRateBurstStatus;
  config: SearchRateConfig;
  counters: {
    arrivals: number;
    admitted: number;
    admittedAdvanced: number;
    admittedAutocomplete: number;
    completed: number;
    rateLimitHits: number;
    cooldownBlocks: number;
    spamBlocked: number;
    burstEvents: number;
    burstPeak: number;
    trackedUsersHighWater: number;
  };
  history: SearchRateHistoryPoint[];
  perShard: SearchRateShardStats[];
}

/** Optimization provenance block on every /advanced + /autocomplete response:
 *  WHERE the served result came from — always a REAL result, the source only
 *  documents how many users shared the underlying Neon query. */
export interface SearchOptSourceInfo {
  source: 'neon' | 'batch' | 'cache' | 'bypass' | string;
  queryHash: string | null;
  cached: boolean;
  batched: boolean;
}

/** batching block of /api/search/status — the pinned FAZA 17 contract
 *  { enabled: true, activeBatches: N } plus live fan-out state. */
export interface SearchOptBatchingStatus {
  enabled: boolean;
  activeBatches: number;
  batchHits: number;
  created: number;
  completed: number;
  maxFanout: number;
  maxConcurrentBatches: number;
  lastBatchAt: string | null;
  lastBatchCompletedAt: string | null;
}

/** cache block of /api/search/status — the pinned FAZA 17 contract
 *  { ttlMs: 3000, hits: X, misses: Y } plus live entries / ratio state. */
export interface SearchOptCacheStatus {
  enabled: boolean;
  ttlMs: number;
  hits: number;
  misses: number;
  entries: number;
  hitRatio: number;
  evictions: number;
  maxEntries: number;
  lastHitAt: string | null;
  lastMissAt: string | null;
}

/** dedup block of /api/search/status — the pinned FAZA 17 contract
 *  { active: true, deduplicatedRequests: N } plus the served/Neon split. */
export interface SearchOptDedupStatus {
  active: boolean;
  deduplicatedRequests: number;
  cacheServed: number;
  batchServed: number;
  ftsQueries: number;
  ftsErrors: number;
  served: number;
  bypassed: number;
  /** Requests served per REAL Neon query (the ×N reduction factor). */
  reductionFactor: number;
}

/** Runtime optimization config: env defaults + admin overrides via
 *  POST /api/search/opt/settings (server-side clamped). */
export interface SearchOptConfig {
  enabled: boolean;
  cacheTtlMs: number;
  cacheMax: number;
  batchMax: number;
}

/** One rolling 1s history sample of the optimization console (last 180). */
export interface SearchOptHistoryPoint {
  t: string;
  requests: number;
  fts: number;
  cacheHits: number;
  batchHits: number;
  cacheEntries: number;
  activeBatches: number;
}

/** One per-shard attribution row of the optimization console (30 rows). */
export interface SearchOptShardStats {
  shardid: number;
  served: number;
  cacheHits: number;
  batchHits: number;
  ftsQueries: number;
}

/** One live in-flight batch of the console (top 50 by fan-out). */
export interface SearchOptActiveBatch {
  queryHash: string;
  kind: string;
  describe: string;
  fanout: number;
  ageMs: number;
  shards: number;
}

/** GET /api/search/opt — the full Search Optimization Layer console payload. */
export interface SearchOptConsole {
  batching: SearchOptBatchingStatus;
  cache: SearchOptCacheStatus;
  dedup: SearchOptDedupStatus;
  pipeline: string[];
  config: SearchOptConfig;
  counters: {
    served: number;
    ftsQueries: number;
    ftsErrors: number;
    cacheHits: number;
    cacheMisses: number;
    batchHits: number;
    batchesCreated: number;
    batchesCompleted: number;
    batchMaxFanout: number;
    deduplicatedRequests: number;
    cacheEvictions: number;
    bypassed: number;
    reductionFactor: number;
  };
  activeBatches: SearchOptActiveBatch[];
  history: SearchOptHistoryPoint[];
  perShard: SearchOptShardStats[];
}

/** stressTest block of /api/search/status — the pinned FAZA 18 contract
 *  { concurrent: 10000, passed: true } plus the last-run summary. */
export interface SearchStressStatus {
  executed: boolean;
  concurrency: number;
  /** Pinned spec alias for concurrency (stressTest.concurrent = 10000). */
  concurrent: number;
  /** The actual simultaneous burst size (the six pinned sections summed). */
  simultaneous?: number;
  passed: boolean;
  startedAt?: string;
  finishedAt?: string;
  wallMs?: number;
  requests?: {
    total: number;
    answered: number;
    ok: number;
    blocked: number;
    errors: number;
    lost: number;
  };
  dispositions?: {
    ok: number;
    spam_blocked: number;
    cooldown_active: number;
    rate_limited: number;
    error: number;
  };
  neonFtsQueries?: number;
  reductionFactor?: number;
  failures?: string[];
  note?: string;
}

/** One of the six pinned stress sections (identical / different / mixed /
 *  spam / cooldown / rateLimit) with its live outcome. */
export interface SearchStressSectionReport {
  total: number;
  ok: number;
  blocked: { spam_blocked: number; cooldown_active: number; rate_limited: number };
  errors: number;
  answered: number;
  sources: { neon: number; batch: number; cache: number; bypass: number };
  distinctQueries: number;
  waitP50Ms: number;
  waitP95Ms: number;
  maxWaitMs: number;
  breakdown?: { hot: number; autocomplete: number; longtail: number };
}

/** One named assertion of the last stress run (the spec checklist). */
export interface SearchStressAssertion {
  name: string;
  ok: boolean;
  detail: string;
}

/** The 10M-user projection: honest demand math + the real 500-concurrent
 *  sample + the structural caps that bound Neon no matter the demand. */
export interface SearchStressProjection {
  model: {
    users: number;
    searchesPerUserMin: number;
    searchesPerUserMax: number;
    engagementWindowS: number;
    diurnalPeakMultiplier: number;
    avgSearchesPerUser: number;
  };
  totalSearches: number;
  meanArrivalRate: number;
  peakArrivalRate: number;
  simultaneousRealBand: { low: number; high: number };
  structuralCaps: {
    maxConcurrentExecutions: number;
    windowDispatchPerS: number;
    queueCap: number;
    maxWaitMs: number;
    perUserMs: number;
    cooldownMs: number;
    cacheTtlMs: number;
  };
  capacity: {
    sustainedRequestCeilingPerS: number;
    meanDemandVsCeiling: string;
    peakDemandVsCeiling: string;
    effectiveUserCapacityPerS: string;
  };
  realSample: {
    users: number;
    requests: number;
    answered: number;
    ok: number;
    hotUsers: number;
    midTailUsers: number;
    neonExecutions: number;
    reductionFactor: number;
    waitP95Ms: number;
  };
  verdicts: {
    rateLimitWorks: boolean;
    cooldownWorks: boolean;
    antiSpamWorks: boolean;
    queueDoesNotExplode: boolean;
    batchingReduces: boolean;
    cacheReduces: boolean;
    neonNotOverloaded: boolean;
  };
}

/** The full last-run report (GET /api/search/stress → lastRun). */
export interface SearchStressRun {
  version: number;
  startedAt: string;
  finishedAt: string;
  wallMs: number;
  executed: boolean;
  passed: boolean;
  concurrency: number;
  burstTotal: number;
  requests: {
    total: number;
    simultaneous: number;
    answered: number;
    ok: number;
    blocked: number;
    errors: number;
  };
  dispositions: {
    ok: number;
    spam_blocked: number;
    cooldown_active: number;
    rate_limited: number;
    error: number;
  };
  sources: { neon: number; batch: number; cache: number; bypass: number };
  neonFtsQueries: number;
  reductionFactor: number;
  prewarm: { cooldownUsers: number; cooldownRealResults: number; rateLimitUsers: number };
  sections: Record<
    'identical' | 'different' | 'mixed' | 'spam' | 'cooldown' | 'rateLimit',
    SearchStressSectionReport
  >;
  flow: {
    queueHighWater: number;
    maxInflightSeen: number;
    maxConcurrent: number;
    windowsFiredDelta: number;
    windowDispatchesDelta: number;
    droppedDelta: number;
    timedOutDelta: number;
  };
  projection10M: SearchStressProjection;
  semantics: {
    query: string;
    freshSource: string;
    repeatSource: string;
    payloadIdentical: boolean;
  };
  assertions: SearchStressAssertion[];
  failures: string[];
}

/** One entry of the stress runs history (compact). */
export interface SearchStressRunSummary {
  startedAt: string;
  finishedAt: string;
  passed: boolean;
  wallMs: number;
  requests: number;
  answered: number;
  neonFtsQueries: number;
  reductionFactor: number;
}

/** GET /api/search/stress — the FAZA 18 console payload. */
export interface SearchStressConsole {
  running: boolean;
  pipelineIntegrated: boolean;
  pipelineStages: string[];
  concurrency: number;
  burstTotal: number;
  budgetMs: number;
  sections: {
    identical: number;
    different: number;
    mixed: number;
    spam: number;
    cooldown: number;
    rateLimit: number;
  };
  projectionModel: {
    users: number;
    searchesPerUserMin: number;
    searchesPerUserMax: number;
    engagementWindowS: number;
    diurnalPeakMultiplier: number;
  };
  sampleConcurrency: number;
  lastRun: SearchStressRun | null;
  runs: SearchStressRunSummary[];
}

/**
 * GET /api/player/external?url= response — universal, DB-free source
 * resolution (rule 4: playback never depends on the real library size).
 * Failures arrive as HTTP 400 {ok:false, error, allowedTypes, url}.
 */
export interface PlayerExternalResponse {
  ok: boolean;
  type: PlayerSourceType;
  url: string;
  embedUrl: string;
  label: string;
  allowedTypes: string[];
  contentFree: boolean;
}

/** GET /api/playerhub/status response — hub contract + live totals. */
export interface PlayerHubStatus {
  ok: boolean;
  hub: string;
  version: string;
  features: string[];
  totals: { playlists: number; playlistItems: number; subtitleTracks: number };
  user: { id: number; playlistsCount: number } | null;
}

/** GET /api/playerhub/progress/:contentId response (auth) — the caller's
 *  saved resume point in seconds (0 = nothing saved). */
export interface PlayerHubProgress {
  contentId: number;
  progress: number;
  watchedat: string | null;
}

/** One WebVTT subtitle track of a content (listing — no VTT payload). */
export interface PlayerHubSubtitleTrack {
  id: number;
  label: string;
  lang: string;
}

/** One of the caller's playlists (GET /api/playerhub/playlists summary row). */
export interface PlayerHubPlaylistSummary {
  id: number;
  title: string;
  description: string | null;
  itemsCount: number;
  firstItemThumbnail: string | null;
  createdat: string;
  updatedat: string;
}

/** One ordered item of a playlist detail (GET /api/playerhub/playlists/:id). */
export interface PlayerHubPlaylistItem {
  content: {
    id: number;
    externalid: string | null;
    type: string | null;
    title: string | null;
    metadata: Record<string, unknown>;
    thumbnail: string | null;
    createdat: string | null;
  };
  position: number;
  addedat: string | null;
}

/** GET /api/playerhub/playlists/:id response (owner only). */
export interface PlayerHubPlaylistDetailResponse {
  playlist: {
    id: number;
    title: string;
    description: string | null;
    createdat: string | null;
    updatedat: string | null;
  };
  items: PlayerHubPlaylistItem[];
}

/** GET /api/playerhub/stats response — hub totals (incl. watch-history
 *  entries) + the top-5 continue-watching titles by distinct watchers.
 *  The `admin` section (activePlaylistsLast7d) is only present when the
 *  request carries a valid admin Bearer token. */
export interface PlayerHubStatsResponse {
  totals: {
    playlists: number;
    playlistItems: number;
    subtitleTracks: number;
    watchEntries: number;
  };
  topContinueWatching: {
    id: number;
    title: string | null;
    thumbnail: string | null;
    type: string | null;
  }[];
  admin?: {
    activePlaylistsLast7d: number;
  };
}

/** One entry of GET /api/playerhub/continue-watching (auth) — a watched
 *  title with its unified progress/resume info (watchhistory-backed). */
export interface PlayerHubContinueWatchingItem {
  content: {
    id: number;
    externalid: string | null;
    type: string | null;
    title: string | null;
    metadata: Record<string, unknown>;
    thumbnail: string | null;
    createdat: string | null;
  };
  watchedat: string | null;
  progress: number;
  sourcesCount: number;
  hasResume: boolean;
}

/** One content row as returned by /api/hub/content and /api/hub/feed (the
 *  public hub browse shape — metadata is a loose JSONB bag). */
export interface HubContentRow {
  id: number;
  externalid: string | null;
  type: string;
  title: string;
  metadata: Record<string, unknown>;
  thumbnail: string | null;
  createdat: string | null;
}

/** GET /api/hub/content response — faceted browse page. */
export interface HubContentResponse {
  data: HubContentRow[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  facets: {
    types: { value: string; count: number }[];
    genres: { value: string; count: number }[];
    years: { value: string; count: number }[];
  };
}

/* ------------------- FAZA 32 (AI SUITE 100X): 18 motoare AI ------------------- */

/** One engine in the /api/ai/suite/status registry. */
export interface AiSuiteEngine {
  key: string;
  name: string;
  emoji: string;
  description: string;
  enabled: boolean;
  stats: { runs: number; errors: number; lastRunAt: string | null; lastMs: number; lastProvider: string | null };
}

/** GET /api/ai/suite/status response. */
export interface AiSuiteStatusResponse {
  suite: string;
  faza: string;
  generatedAt: string;
  engines: AiSuiteEngine[];
  totals: { total: number; enabled: number; disabled: number };
}

/** Shared engine payload base (every engine answers provider + engine). */
export interface AiSuiteBase {
  engine: string;
  provider: string;
  generatedAt?: string;
}

/** AI Miner — job-uri, surse, catalog. */
export interface AiSuiteMinerData extends AiSuiteBase {
  jobs: {
    total: number;
    byStatus: { status: string; n: number }[];
    byType: { type: string; n: number }[];
    recent: Array<{ id: string; type: string; status: string; attempts: number; queuedat: string | null; finishedat: string | null; error: string | null }>;
  };
  sources: { registered: number; providers: number };
  catalog: { total: number; byType: { type: string; n: number }[]; minedItems: number };
  waves: Array<{ id: number; label: string; provider: string; status: string; progress: number }>;
}

/** AI Miner dry-run. */
export interface AiSuiteMinerDryRun {
  ok: boolean;
  source?: string;
  wouldMine?: number;
  sample?: Array<{ externalId: number | string; title: string; year: string | null; rating: number | null }>;
  note?: string;
  error?: string;
  providers?: string[];
}

/** AI Metadata Dashboard. */
export interface AiSuiteMetadataData extends AiSuiteBase {
  total: number;
  overall: number;
  fields: Array<{ field: string; covered: number; pct: number }>;
  gaps: Array<{ id: number; title: string; type: string; missing: string[] }>;
}

/** AI Analyzer Dashboard. */
export interface AiSuiteAnalyzerData extends AiSuiteBase {
  sampleSize: number;
  avgScore: number;
  distribution: Array<{ range: string; n: number }>;
  top: Array<{ id: number; title: string; type: string; rating: number | null; score: number }>;
  needsAttention: Array<{ id: number; title: string; type: string; rating: number | null; score: number }>;
  byType: Array<{ type: string; n: number; avgScore: number }>;
  note?: string;
}

/** AI News Hub. */
export interface AiSuiteNewsData extends AiSuiteBase {
  total: number;
  sources: Array<{ source: string; ok: boolean; items?: number; error?: string }>;
  byCategory: Array<{ category: string; n: number }>;
  items: Array<{ title: string; link: string | null; source: string; category: string; published: string | null }>;
  aiDigest: string;
  aiProvider: string;
}

/** AI Social Hub. */
export interface AiSuiteSocialData extends AiSuiteBase {
  totals: { comments: number; follows: number; reviews: number; commentVotes: number; reviewLikes: number; activity7d: number; newFollows7d: number };
  commentSentiment: { pozitiv: number; neutru: number; negativ: number };
  topCommented: Array<{ contentid: number; title: string; n: number }>;
  topReviewed: Array<{ contentid: number; title: string; n: number; avgrating: string }>;
  activityByType: Array<{ type: string; n: number }>;
  recentComments: Array<{ id: number; body: string; createdat: string; title: string }>;
  aiDigest: string | null;
  aiProvider: string;
}

/** AI Watch Party. */
export interface AiSuiteWatchPartyData extends AiSuiteBase {
  totals: { parties: number; active: number; members: number; messages: number; uniqueUsers: number };
  activeParties: Array<{ id: number; code: string; title: string; status: string; n: number }>;
  topWatchedInParty: Array<{ contentid: number; title: string; n: number }>;
  aiPicks: Array<{ contentId: number; title: string; type: string; rating: number | null; genres: string[]; reason: string }>;
  note?: string;
}

/** AI Recommendation Engine. */
export interface AiSuiteRecommendationsData extends AiSuiteBase {
  personalized: boolean;
  affinity: { fromHistory: number; topGenres: Array<{ genre: string; n: number }> } | null;
  signals: Array<{ signal: string; active: boolean; weight: string }>;
  trendingNow: Array<{ contentId: number; title: string; views: number }>;
  recommendations: Array<{ contentId: number; title: string; type: string; rating: number; genres: string[]; score: number; reason: string }>;
  note?: string;
}

/** AI Franchise Engine. */
export interface AiSuiteFranchiseData extends AiSuiteBase {
  total: number;
  franchises: Array<{ name: string; size: number; avgRating: number | null; firstYear: string | null; lastYear: string | null; aiScore: number; items: Array<{ title: string; year: string | null; rating: number | null }> }>;
  aiNarrative: string | null;
  aiProvider: string;
  note?: string;
}

/** AI Taxonomy Generator. */
export interface AiSuiteTaxonomyData extends AiSuiteBase {
  sampleSize: number;
  topGenres: Array<{ genre: string; n: number }>;
  clusters: Array<{ pair: string; support: number; strength: number }>;
  keywords: Array<{ word: string; occurrences: number }>;
  proposals: Array<{ name: string; members: number; rationale: string; aiName?: string | null }>;
  aiProvider: string;
  note?: string;
}

/** AI Statistics Dashboard. */
export interface AiSuiteStatsData extends AiSuiteBase {
  totals: { calls: number; promptTokens: number; completionTokens: number; costUsd: number; errors: number; degraded: number; errorRate: number };
  latency: { p50: number; p95: number };
  byFeature: Array<{ feature: string; n: number; avgms: number }>;
  byProvider: Array<{ provider: string; n: number }>;
  daily: Array<{ day: string; n: number }>;
  topErrors: Array<{ feature: string; errormessage: string; n: number }>;
  suiteToggles: Array<{ key: string; value: unknown }>;
}

/** AI Infinite Scroll Engine. */
export interface AiSuiteInfiniteFeedResponse {
  engine: 'infinite';
  provider: string;
  cursor: number;
  nextCursor: number | null;
  total: number;
  seed: string;
  items: Array<{ contentId: number; title: string; type: string; rating: number; genres: string[]; thumbnail: string | null; views7d: number; aiScore: number }>;
}

/** AI Content Scanner. */
export interface AiSuiteScannerData extends AiSuiteBase {
  sampleSize: number;
  healthScore: number;
  severity: Array<{ issue: string; severity: string; n: number }>;
  samples: Record<string, Array<{ id: number; title: string; type: string; len?: number; hint?: string }>>;
}

/** AI Source Discovery Engine. */
export interface AiSuiteDiscoveryData extends AiSuiteBase {
  registry: {
    total: number;
    kinds: number;
    byKind: Array<{ kind: string; n: number; hits: number; lastseen: string | null }>;
    recent: Array<{ url: string; kind: string; hits: number; lastseenat: string | null }>;
  };
  providerProbes: Array<{ provider: string; ok: boolean; ms?: number; error?: string }>;
  proposed: Array<{ id: string; provider: string; kind: string; label: string; value: string; note: string }>;
  note?: string;
}

/** AI Duplicate Detector. */
export interface AiSuiteDuplicatesData extends AiSuiteBase {
  scanned: number;
  candidatesFound: number;
  duplicates: Array<{ type: string; a: { id: number; title: string; rating: number | null }; b: { id: number; title: string; rating: number | null }; score: number }>;
  note?: string;
}

/** AI Poster Scanner. */
export interface AiSuitePosterData extends AiSuiteBase {
  checked: number;
  reachable: number;
  broken: number;
  missingThumbnail: number;
  results: Array<{ id: number; title: string; thumbnail: string; reachable: boolean; httpStatus: number }>;
  vlmSamples: Array<{ id: number; title: string; description: string }>;
  aiProvider: string;
  note?: string;
}

/** AI Trend Analyzer. */
export interface AiSuiteTrendsData extends AiSuiteBase {
  topContent: Array<{ contentid: number; views: number }>;
  genresThisWeek: Array<{ genre: string; n: number }>;
  watchMomentum: { last7: number; prev7: number };
  rising: Array<{ id: number; title: string; now: number; prev: number; delta: number }>;
  aiNarrative: string;
  aiProvider: string;
}

/** AI External Feed Engine. */
export interface AiSuiteFeedsData extends AiSuiteBase {
  catalog: Array<{ id: string; name: string; category: string; url: string }>;
  checks: Array<{ id: string; name: string; category: string; ok: boolean; items?: number; error?: string }>;
  healthy: number;
  note?: string;
}

export interface AiSuiteFeedFetchResponse {
  ok: boolean;
  feed?: { id: string; name: string; url: string };
  items?: Array<{ title: string; link: string | null; category: string; published: string | null }>;
  classified?: number;
  error?: string;
  available?: string[];
}

/** AI Admin dashboard. */
export interface AiSuiteAdminData extends AiSuiteBase {
  db: { content?: number; usage_logs?: number; settings?: number; users?: number };
  recentUsage: Array<{ feature: string; provider: string; latencyms: number; status: string; createdat: string }>;
  recentAudit: Array<{ id: number; action: string; createdat: string }>;
  health: { database: { ok: boolean; content: number }; zaiSdk: string };
}

/* ---- FAZA 34 (PLAN 100X · WS4): playerx — strat experiență player (aditiv) ---- */

/** Tip de marker episod livrat de /api/playerx/markers/:contentId. */
export type PlayerxMarkerKind = 'intro' | 'outro' | 'recap';

/** Un marker episod (skip-intro / skip-outro / recap). `source`:
 *  'estimated' = estimat automat, 'curated' = confirmat de un utilizator. */
export interface PlayerxMarker {
  id: number | string;
  kind: PlayerxMarkerKind;
  startsec: number;
  endsec: number;
  label: 'Intro' | 'Final' | 'Recapitulare';
  source: 'estimated' | 'curated';
}

/** GET /api/playerx/markers/:contentId — markerii episodului (404 onest când
 *  serviciul playerx nu e încă deploys pe instanță). */
export interface PlayerxMarkersResponse {
  ok: boolean;
  contentId: number;
  data: PlayerxMarker[];
  note?: string;
}

/** GET /api/playerx/status — stats onest despre stratul playerx. */
export interface PlayerxStatus {
  ok: boolean;
  service: string;
  phase: string;
  uptimeSec: number;
  storage: string;
  stats: {
    markersCurated: number;
    markersRequests: number;
    skipUses: number;
    settingsSaved: number;
    votesCast: number;
    votesClosed: number;
    activeVotes: number;
  };
  generatedAt: string;
}

/** Un votant din starea votului de party (POST/DELETE cer auth; GET e public). */
export interface PlayerxVoteVoter {
  userid: number;
  username: string;
  contentId: number;
}

/** GET /api/playerx/party/:partyId/votes — starea votului „următoarea
 *  vizionare" al unei petreceri (FAZA 34 WS4). `status` devine 'closed' +
 *  `winner` prinde id-ul câștigătorului după ce GAZDA închide votul;
 *  `tally` mapează contentId (cheie string) → număr de voturi. 404 onest
 *  când petrecerea nu mai există sau s-a încheiat. */
export interface PlayerxVoteState {
  ok: boolean;
  partyId: number;
  contentId: number;
  status: 'open' | 'closed';
  winner: number | null;
  tally: Record<string, number>;
  voters: PlayerxVoteVoter[];
  createdAt: string | null;
  updatedAt: string | null;
}

/** Stilizarea subtitrărilor (Studio de subtitrări) — aplicată live prin
 *  `video::cue` + salvată local (localStorage) și, pentru utilizatori
 *  autentificați, în profil prin PUT /api/playerx/subtitle-settings. */
export interface PlayerxSubtitleSettings {
  fontFamily: 'sans-serif' | 'serif' | 'monospace' | 'Trebuchet MS' | 'Verdana' | 'Georgia' | 'Comic Sans MS';
  /** 50–250 (%). */
  fontSizePct: number;
  /** '#rrggbb'. */
  textColor: string;
  /** '#rrggbb'. */
  bgColor: string;
  /** 0–1. */
  bgOpacity: number;
  edge: 'none' | 'shadow' | 'outline';
  position: 'bottom' | 'top';
  /** 0–20 (%). */
  marginPct: number;
}

export const DEFAULT_PLAYERX_SUBTITLE_SETTINGS: PlayerxSubtitleSettings = {
  fontFamily: 'sans-serif',
  fontSizePct: 100,
  textColor: '#ffffff',
  bgColor: '#000000',
  bgOpacity: 0.6,
  edge: 'shadow',
  position: 'bottom',
  marginPct: 4,
};

/* ------------- FAZA 35 (PLAN 100X · WS5): AI LAB — 8 capabilități ------------- */
/* Contract înghețat FAZA-35-a (/api/ai/lab/*). Ordinea capacităților în registry:
 * companion, recap, mood, shield, dubbing, curation, voice, editor. */

/** One capability in the GET /api/ai/lab/status registry. */
export interface AiLabCapability {
  key: string;
  name: string;
  emoji: string;
  description: string;
  enabled: boolean;
  stats: { runs: number; errors: number; lastRunAt: string | null; lastMs: number; lastProvider: string | null };
}

/** GET /api/ai/lab/status response. */
export interface AiLabStatusResponse {
  suite: string;
  faza: string;
  generatedAt: string;
  capabilities: AiLabCapability[];
  totals: { total: number; enabled: number; disabled: number };
}

/** POST /api/ai/lab/settings response. */
export interface AiLabSettingsResponse {
  ok: boolean;
  key: string;
  enabled: boolean;
}

/** Companion — contextul RAG al unui titlu (GET /companion/context/:contentId).
 *  NOTĂ (FAZA-35-b, verificat live): implementarea live pune contentId/title/type
 *  ÎNĂUNTRUL obiectului context și folosește `avgRating` (contractul scria
 *  `avgReviewRating` la nivelul răspunsului); ambele forme sunt acceptate. */
export interface AiLabCompanionContext {
  contentId?: number;
  title?: string;
  type?: string;
  synopsis: string | null;
  genres: string[];
  year: string | number | null;
  rating: number | null;
  avgReviewRating?: number | null;
  avgRating?: number | null;
  reviews: Array<{ user: string; rating: number; body: string }>;
}

export interface AiLabCompanionContextResponse {
  ok: boolean;
  contentId?: number;
  title?: string;
  context: AiLabCompanionContext;
  ready?: boolean;
  provider?: string;
}

/** Companion — chat (POST /companion/chat). Istoricul maxim trimis de client: 8 mesaje. */
export interface AiLabChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AiLabChatResponse {
  ok: boolean;
  contentId: number;
  answer: string;
  provider: string;
  /** Contract înghețat; implementarea live nu-l trimite întotdeauna —
   *  UI-ul degradează onest la „context disponibil". */
  usedContext?: { synopsis: boolean; reviews: boolean };
}

/** Recap — „Ce ai ratat" (GET /recap/:contentId, auth sau ?userId=). */
export interface AiLabRecapWatched {
  title: string;
  progressPct: number;
  watchedAt: string | null;
}

export interface AiLabRecapResponse {
  ok: boolean;
  contentId: number;
  title: string;
  watched: AiLabRecapWatched[];
  recap: string | null;
  note?: string;
  provider: string;
}

/** Mood — cele 6 stări de spirit (GET /mood/moods).
 *  NOTĂ (FAZA-35-b): implementarea live returnează cheia/emoji/genurile/
 *  descrierea; `label` și `tagline` sunt opționale în apărare — UI-ul
 *  degradează la key/description dacă backend-ul nu le trimite. */
export interface AiLabMood {
  key: string;
  label?: string;
  emoji: string;
  description: string;
  tagline?: string;
  genres: string[];
}

export interface AiLabMoodsResponse {
  ok: boolean;
  moods: AiLabMood[];
}

/** Item generic de playlist AI (mood + editor): id = DB content id. */
export interface AiLabItem {
  id: number;
  title: string;
  type: string;
  year: string | number | null;
  rating: number | null;
  genres: string[];
  posterPath: string | null;
}

/** Mood — playlist generat (GET /mood/generate?mood=&limit=&seed=). */
export interface AiLabMoodGenerateResponse {
  ok: boolean;
  mood: string;
  items: AiLabItem[];
  narrative: string;
  provider: string;
}

/** Shield — filtrare spoilere (POST /shield/filter). */
export interface AiLabShieldResultItem {
  id: string;
  body: string;
  spoiler: boolean;
  confidence: number;
  matched: string[];
  action: string;
}

export interface AiLabShieldResponse {
  ok: boolean;
  results: AiLabShieldResultItem[];
  provider: string;
}

/** Dubbing — titluri fără subtitrare RO (GET /dubbing/missing). */
export interface AiLabDubbingMissingItem {
  contentId: number;
  title: string;
  type: string;
  year: string | number | null;
  hasEn: boolean;
  enSubtitleId: number | null;
}

/** Dubbing — titluri fără subtitrare RO (GET /dubbing/missing).
 *  NOTĂ (FAZA-35-b, verificat live): `total` nu e trimis întotdeauna —
 *  UI-ul degradează la items.length. */
export interface AiLabDubbingMissingResponse {
  ok: boolean;
  items: AiLabDubbingMissingItem[];
  total?: number;
}

/** Dubbing — draft de traducere (POST /dubbing/generate, GET/PUT /dubbing/draft/:contentId). */
export interface AiLabDubbingCue {
  start: number;
  end: number;
  text: string;
  source: string;
}

export interface AiLabDubbingDraft {
  contentId: number;
  title: string;
  cues: AiLabDubbingCue[];
  generatedAt: string;
  provider: string;
  corrected?: boolean;
}

export interface AiLabDubbingDraftResponse {
  ok: boolean;
  draft: AiLabDubbingDraft;
}

/** Dubbing — publicare (POST /dubbing/publish/:contentId, ADMIN). */
export interface AiLabDubbingPublishResponse {
  ok: boolean;
  published: boolean;
  subtitleId: number;
}

/** Curation — „De ce îți recomandăm?" (GET /curation/why/:contentId?userId=). */
export interface AiLabCurationSignal {
  key: string;
  label: string;
  /** Verificat live: valoare numerică normalizată (ex. 0.7) — contractul
   *  o lăsa nedefinită; acceptăm ambele. */
  value: string | number;
  weight: number;
}

export interface AiLabCurationResponse {
  ok: boolean;
  contentId: number;
  title: string;
  note: string;
  signals: AiLabCurationSignal[];
  provider: string;
}

/** Voice — stare serviciu (GET /voice/status). */
export interface AiLabVoiceStatusResponse {
  ok: boolean;
  asr: { ready: boolean };
  tts: { voices: string[]; maxChars: number };
}

/** Voice — speech-to-text (POST /voice/asr). 503 onest când ASR nu e disponibil. */
export interface AiLabAsrResponse {
  ok: boolean;
  text: string;
  provider: string;
}

/** Voice — text-to-speech (POST /voice/tts). 400: text>1024 / voce invalidă / viteză invalidă. */
export interface AiLabTtsResponse {
  ok: boolean;
  audioBase64: string;
  format: string;
  bytes: number;
  provider: string;
}

/** Editor — interpretarea descrierii (POST /editor/generate).
 *  Verificat live: title/maxItems pot fi null. */
export interface AiLabEditorInterpreted {
  title?: string | null;
  genres: string[];
  types: string[];
  keywords: string[];
  mood?: string | null;
  maxItems?: number | null;
}

export interface AiLabPlaylistMeta {
  title: string;
  description: string;
}

export interface AiLabEditorGenerateResponse {
  ok: boolean;
  description: string;
  interpreted: AiLabEditorInterpreted;
  playlist: AiLabPlaylistMeta;
  items: AiLabItem[];
  provider: string;
}

/** Editor — salvare + listele mele (POST /editor/save, GET /editor/lists; AUTH). */
export interface AiLabEditorSaveResponse {
  ok: boolean;
  saved: boolean;
}

export interface AiLabEditorList {
  id: number;
  title: string;
  description: string;
  itemIds: number[];
  createdAt: string;
}

export interface AiLabEditorListsResponse {
  ok: boolean;
  lists: AiLabEditorList[];
}

/* -------- FAZA 36-R (PLAN 100X · WS6): PERSO — Personalizare & Recomandări 2.0 -------- */
/* Contract înghețat FAZA-36-R (/api/perso/*, backend modules/perso — 14 rute).
 * Totul euristică deterministă onestă (method.ml=false peste tot) — profil de
 * gust învățat pasiv, feed „Pentru Tine" cu secțiuni explicite, profile
 * multiple cu PIN, memento-uri de încheiere. */

/** GET /api/perso/status — statistici oneste despre modul (contoare durabile,
 *  cache profil, limite, zero DB query). */
export interface PersoStatus {
  ok: boolean;
  module: string;
  faza: string;
  uptimeSec: number;
  routes: number;
  storage: {
    dir: string;
    files: { profiles: number | null; events: number | null; dismissals: number | null; resets: number | null };
    note: string;
  };
  cache: {
    profileTtlSec: number;
    entries: number;
    maxEntries: number;
    totalHits: number;
    oldestEntryAgeSec: number | null;
    note: string;
  };
  limits: {
    maxProfilesPerAccount: number;
    eventsPerUser: number;
    eventsRatePerMinPerIp: number;
    dismissalTtlDays: number;
    profileTokenTtlSec: number;
  };
  counters: {
    eventsTracked: number;
    eventsByType: { view: number; like: number; complete: number; search: number };
    profileRequests: number;
    profileResets: number;
    feedRequests: number;
    profilesCreated: number;
    profilesUpdated: number;
    profilesDeleted: number;
    profileVerifications: number;
    verificationFails: number;
    remindersRequests: number;
    remindersDismissed: number;
    affinitiesRequests: number;
    explainRequests: number;
  };
  method: PersoMethod;
  generatedAt: string;
}

/** Etichetarea onestă a motorului (identică în toate răspunsurile perso). */
export interface PersoMethod {
  engine: string;
  ml: boolean;
  note: string;
}

/** O dimensiune de afinitate (gen/tip/deceniu/an) cu scor normalizat 0-100. */
export interface PersoAffinity {
  value: string;
  score: number;
  /** Procent normalizat față de maximul intern (0-100). */
  pct: number;
  /** Câte titluri distincte au alimentat această valoare. */
  titles: number;
}

/** Titlul preferat al utilizatorului (greutate agregată din semnale). */
export interface PersoFavoriteTitle {
  contentId: number;
  title: string;
  type: string | null;
  genres: string[];
  year: number | null;
  weight: number;
  signals: string[];
}

/** Profilul de gust învățat pasiv (GET /profile; structura `profile`). */
export interface PersoTasteProfile {
  userId: number;
  empty: boolean;
  learnedAt: string;
  since: string | null;
  lastSignalAt: string | null;
  sources: { watchhistory: number; contentlikes: number; reviews: number; persoEvents: number };
  signals: { watched: number; liked: number; reviewed: number; events: number; total: number };
  topGenres: PersoAffinity[];
  topTypes: PersoAffinity[];
  topDecades: PersoAffinity[];
  topYears: PersoAffinity[];
  diversity: { score: number; distinctGenres: number; note: string };
  favoriteTitles: PersoFavoriteTitle[];
  method: PersoMethod;
}

export interface PersoProfileResponse {
  ok: boolean;
  userId: number;
  identity: string;
  cached: boolean;
  profile: PersoTasteProfile;
  note: string | null;
}

export interface PersoProfileResetResponse {
  ok: boolean;
  userId: number;
  resetAt: string;
  effect: string;
}

/** Un item din feed-ul „Pentru Tine" — secțiune explicită + reason lizibil. */
export interface PersoFeedItem {
  contentId: number;
  title: string;
  type: string;
  year: number | null;
  rating: number | null;
  thumbnail: string | null;
  genres: string[];
  section: 'continue' | 'similar' | 'genre';
  reason: string;
  score: number;
  progressPct?: number | null;
  progressSec?: number;
  remainingMin?: number | null;
  lastWatchedAt?: string | null;
  matchedGenres?: string[];
  matchedGenre?: string;
}

export interface PersoFeedSection {
  key: 'continue' | 'similar' | 'genre';
  label: string;
  count: number;
}

export interface PersoFeedResponse {
  ok: boolean;
  identity?: string;
  userId: number;
  limit: number;
  items: PersoFeedItem[];
  sections: PersoFeedSection[];
  profileSummary: { empty: boolean; topGenres: string[]; signals: number };
  anchorTitle: string | null;
  method: PersoMethod;
  note: string | null;
  generatedAt: string;
}

/** Un profil multiplu al contului (hash-ul PIN-ului NU circulă niciodată). */
export interface PersoAccountProfile {
  id: string;
  name: string;
  emoji: string;
  isMain: boolean;
  hasPin: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface PersoProfilesResponse {
  ok: boolean;
  userId: number;
  identity?: string;
  profiles: PersoAccountProfile[];
  max: number;
  note: string | null;
}

export interface PersoProfileCreateResponse {
  ok: boolean;
  profile: PersoAccountProfile;
  remaining: number;
}

export interface PersoProfileUpdateResponse {
  ok: boolean;
  profile: PersoAccountProfile;
}

export interface PersoProfileDeleteResponse {
  ok: boolean;
  removedId: string;
  remaining: number;
}

/** POST /profiles/:id/verify — token de sesiune profil (JWT-lite, 2h). */
export interface PersoProfileVerifyResponse {
  ok: boolean;
  token: string;
  tokenType: string;
  expiresInSec: number;
  profile: { id: string; name: string; emoji: string; isMain: boolean };
}

/** GET /verify-token — validarea tokenului (payload descoperit onest). */
export interface PersoVerifyTokenResponse {
  ok: boolean;
  payload: { profileId: string; userId: number; name: string; expiresAt: string };
}

/** Un memento de încheiere (titlu abandonat 20-90%, >3 zile). */
export interface PersoReminderItem {
  contentId: number;
  title: string;
  type: string;
  thumbnail: string | null;
  progressPct: number | null;
  progressSec: number;
  remainingMin: number | null;
  idleDays: number;
  lastWatchedAt: string | null;
  seasonFinish: { totalSeasons: number; note: string } | null;
  reason: string;
}

export interface PersoRemindersResponse {
  ok: boolean;
  identity?: string;
  userId: number;
  items: PersoReminderItem[];
  dismissedActive: number;
  criteria: { progressBand: string; staleAfterDays: number; dismissalTtlDays: number };
  method: PersoMethod;
  note: string | null;
  generatedAt: string;
}

export interface PersoReminderDismissResponse {
  ok: boolean;
  userId: number;
  contentId: number;
  dismissedAt: string;
  ttlDays: number;
  effect: string;
}

/** GET /affinities — breakdown detaliat. */
export interface PersoAffinitiesResponse {
  ok: boolean;
  userId: number;
  identity?: string;
  cached: boolean;
  signals: PersoTasteProfile['signals'];
  topGenres: PersoAffinity[];
  topTypes: PersoAffinity[];
  topDecades: PersoAffinity[];
  topYears: PersoAffinity[];
  diversity: { score: number; distinctGenres: number; note: string };
  favoriteTitles: PersoFavoriteTitle[];
  method: PersoMethod;
  note: string | null;
}

/** GET /explain/:contentId — de ce e recomandat un item. */
export interface PersoExplainReason {
  key: string;
  label: string;
  detail: string;
  points: number;
}

export interface PersoExplainResponse {
  ok: boolean;
  contentId: number;
  title: string;
  type: string;
  genres: string[];
  year: number | null;
  userId: number | null;
  identity: string;
  recommended: boolean;
  score: number;
  reasons: PersoExplainReason[];
  profileEmpty: boolean;
  method: PersoMethod;
  note: string | null;
}

/** POST /events — semnal de interacțiune (cache-ul profilului se invalidează). */
export interface PersoEventResponse {
  ok: boolean;
  userId: number;
  identity: string;
  event: { type: string; contentId?: number; weight: number; term?: string; at: string };
  stored: number;
  profileCacheInvalidated: boolean;
  note: string;
}
