/**
 * types.ts — Animaxia shared TypeScript types mirroring the backend API contract.
 */

/**
 * FAZA 14 — vimeo + rumble joined the player source types (explicit detection
 * with normalized embed URLs; policy-filtered server-side).
 */
export type PlayerSourceType = 'mp4' | 'm3u8' | 'iframe' | 'youtube' | 'vimeo' | 'rumble';

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

export interface RadioStation {
  id: string | null;
  name: string;
  stream: string;
  image: string | null;
  codec: string;
  bitrate: number;
  country: string;
  countryCode: string;
  tags: string[];
  votes: number;
  homepage: string;
  language: string;
}

export interface RadioLiveResponse {
  total: number;
  filters: { countrycode: string | null; tag: string | null; name: string | null };
  data: RadioStation[];
}

export interface RadioCountry {
  name: string;
  code: string;
  stationcount: number;
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

export interface NewsItem {
  title: string;
  link: string;
  pubDate?: string;
  description?: string;
  image?: string;
  source: string;
}

export interface TvScheduleItem {
  id: number;
  title: string;
  show: string;
  airtime?: string;
  season?: number;
  number?: number;
  network?: string;
  image?: string;
  summary?: string;
  url?: string;
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
  added: { movie: number; tv: number; anime: number; openmovies: number };
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
  /** FAZA 15 — additive flow attribution (how the request was scheduled). */
  flow?: { priority: SearchFlowPriorityKey; shardid: number; queuedMs: number };
  /** FAZA 16 — additive pacing block (per-user rhythm the UI should honor). */
  rate?: SearchRatePacingInfo;
  /** FAZA 17 — additive optimization provenance: 'neon' = this request ran the
   *  real FTS, 'batch' = shared an in-flight identical execution, 'cache' =
   *  served the stored REAL result (≤ cacheTtlMs old), 'bypass' = layer off. */
  opt?: SearchOptSourceInfo;
}

/** GET /api/search/autocomplete — prefix + trigram suggestions (max 8). */
export interface SearchAutocompleteResponse {
  suggestions: { id: number; title: string; type: string; thumbnail: string | null; rating: number | null }[];
  /** FAZA 17 — additive optimization provenance (see SearchOptSourceInfo). */
  opt?: SearchOptSourceInfo;
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
  /** FAZA 15 — additive search flow control snapshot (optional so existing
   *  consumers and older backends keep compiling). */
  flowControl?: SearchFlowControlStatus;
  /** FAZA 15 — additive windowing snapshot (same additive contract). */
  windowing?: SearchWindowingStatus;
  /** FAZA 16 — additive per-user pacing snapshot (pinned: perUserMs, enforced). */
  rateLimit?: SearchRateLimitStatus;
  /** FAZA 16 — additive burst control snapshot (pinned: active, maxBurstPerWindow). */
  burstControl?: SearchRateBurstStatus;
  /** FAZA 17 — additive batching snapshot (pinned: enabled, activeBatches). */
  batching?: SearchOptBatchingStatus;
  /** FAZA 17 — additive cache snapshot (pinned: ttlMs, hits, misses). */
  cache?: SearchOptCacheStatus;
  /** FAZA 17 — additive dedup snapshot (pinned: active, deduplicatedRequests). */
  dedup?: SearchOptDedupStatus;
  /** FAZA 17 — the deterministic pipeline order every search traverses. */
  pipeline?: string[];
  /** FAZA 18 — the integrated-pipeline contract: true when every one of the
   *  10 pinned stages is structurally mounted in the backend process. */
  pipelineIntegrated?: boolean;
  /** FAZA 18 — the exact integrated stage list (alias of pipeline). */
  pipelineStages?: string[];
  /** FAZA 18 — the last 10,000-simultaneous-searches stress verdict
   *  (pinned shape: { concurrent: 10000, passed: true }). */
  stressTest?: SearchStressStatus;
}

/* ---------------- FAZA 15: search flow control (queue + windowing) ---------------- */

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

/* ------------- FAZA 16: search rate management (pacing + anti-spam) ------------- */

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

/* ------------- FAZA 17: search optimization (dedup + batching + cache) ------------- */

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

/* ---------------- FAZA 18: full integration + stress test ---------------- */

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

/* ----------------------- FAZA 16: real scale report ------------------------ */

export type ScaleVerdictStatus = 'not-ready' | 'partial' | 'ready';
export type ScaleGapSeverity = 'critical' | 'high' | 'medium';

export interface ScaleVerdict {
  target: string;
  targetKey: 'users' | 'connectedAccounts' | 'contents' | 'concurrentSearches';
  targetValue: number;
  status: ScaleVerdictStatus;
  currentEstimate: string;
  reasoning: string;
}

export interface ScaleGap {
  severity: ScaleGapSeverity;
  missing: string;
  recommendation: string;
}

export interface ScaleMeasured {
  measuredAt: string;
  uptimeSec: number;
  dbLatencyMs: number;
  searchLatency: { p50Ms: number; p95Ms: number; samples: number };
  items: number;
  users: number;
  searchdocs: number;
  contentsources: number;
  dbSizeBytes: number;
  tableSizes: { name: string; bytes: number }[];
  cache: { hitRate: number; keys: number };
  rateLimit: { max: number; windowMs: number };
  providers: { name: string; state: string; failures: number }[];
  neon: { branch: string; poolMax: number; pool: { total: number; idle: number; waiting: number } };
}

/** GET /api/scale/report — live measurements + honest verdicts + gaps. */
export interface ScaleReport {
  /** Optional in the current backend payload — measuredAt is the source of truth. */
  generatedAt?: string;
  measured: ScaleMeasured;
  targets: { users: number; connectedAccounts: number; contents: number; concurrentSearches: number };
  verdicts: ScaleVerdict[];
  gaps: ScaleGap[];
  conclusion: string;
}

/** GET /api/scale/metrics — light version (measured + verdict statuses). */
export interface ScaleMetrics {
  measured: ScaleMeasured;
  verdicts: { target: string; targetKey: ScaleVerdict['targetKey']; status: ScaleVerdictStatus }[];
  updatedAt: string;
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

/* --------------- FAZA 17: stability lab — resilience / stress / 30B --------------- */

/** GET /api/platform/stability — live resilience snapshot (uncached, poll 5s). */
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

/** POST /api/platform/stress/run request body. */
export interface StressRunRequest {
  suite: 'search' | 'ingest' | 'virtual30b' | 'mixed';
  durationSec?: number;
  concurrency?: number;
  q?: string;
}

/**
 * Per-suite stress extras. FLAT for single suites (search / ingest /
 * virtual30b) and nested under {search, ingest, virtual30b} for 'mixed'
 * (verified live against the 17-a backend).
 */
export interface StressRunExtra {
  /* flat keys (single-suite responses) */
  queries?: number;
  hitQueries?: number;
  errors?: number;
  unique?: number;
  duplicates?: number;
  deepestPage?: number;
  maxPageMs?: number;
  /* nested keys ('mixed' response) */
  search?: { queries: number; hitQueries: number; errors: number };
  ingest?: { unique: number; duplicates: number };
  virtual30b?: { deepestPage: number; maxPageMs: number };
}

/** POST /api/platform/stress/run response (409/429/400 arrive as ApiError). */
export interface StressRunResponse {
  ok: boolean;
  suite: 'search' | 'ingest' | 'virtual30b' | 'mixed';
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

/** GET /api/platform/scale/virtual item — deterministic synthetic entry. */
export interface VirtualCatalogItem {
  index: number;
  title: string;
  type: 'movie' | 'tv' | 'anime' | string;
  year: number;
  rating: number;
  genres: string[];
  overview: string;
  thumbnail: string | null;
  /** Present only on the last item of a page (== nextCursor). */
  cursor: string | null;
}

/** GET /api/platform/scale/virtual response (cursor = base64url {"i","s"}). */
export interface VirtualCatalogResponse {
  ok: boolean;
  engine: string;
  addressSpace: number;
  page: number;
  items: VirtualCatalogItem[];
  nextCursor: string | null;
  tookMs: number;
  simulated: boolean;
}

/* ------------- FAZA 14: global 30B feed (GET /api/platform/feed/global) ------------- */

/**
 * One slot of the 30B logical feed: either a REAL content row (virtual:false,
 * real:true — the Neon overlay at its own id) or a deterministically generated
 * virtual slot (virtual:true, real:false — zero physical storage).
 */
export interface GlobalFeedItem {
  id: number;
  shardid: number;
  virtual: boolean;
  real: boolean;
  title: string;
  type: string;
  year: number;
  rating: number;
  genres: string[];
  overview: string;
  thumbnail: string | null;
  externalid: string | null;
  /** Present only on the last item of a page (== nextCursor). */
  cursor: string | null;
}

/** Per-page + global overlay stats of the 30B feed. */
export interface GlobalFeedStats {
  addressSpace: number;
  shardcount: number;
  shardSpan: number;
  realCount: number;
  realInPage: number;
  virtualInPage: number;
  /** One entry per shard — real rows living on that shard (30 under FAZA 14). */
  perShard: { shardid: number; real: number }[];
}

/**
 * GET /api/platform/feed/global response. The cursor is the same base64url
 * {"i","s"} keyset as the virtual catalog — page N (1-based, limit L) maps to
 * index i = (N-1)*L over the whole 30B space (global index even when a shard
 * filter narrows the window to [shard*1e9, (shard+1)*1e9)).
 */
export interface GlobalFeedResponse {
  ok: boolean;
  engine: string;
  addressSpace: number;
  shardcount: number;
  shardSpan: number;
  /** Active ?shard=n filter (null = whole 30B space). */
  shard: number | null;
  mode: string;
  page: number;
  totalPages: number;
  items: GlobalFeedItem[];
  nextCursor: string | null;
  stats: GlobalFeedStats;
  tookMs: number;
  simulated: boolean;
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

/* --------------------------------- FAZA 19 --------------------------------- */
/* Player Hub (/api/playerhub/*) — playlists, progress/resume and WebVTT
 * subtitle tracks (backend task 19-1). */

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

/* ------------------- FAZA 21 (task 21-1): /api/hub responses ------------------- */

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

/** GET /api/hub/stats response — public platform totals, engagement tops
 *  and 7-day recency (100% SQL aggregations over Neon). */
export interface HubStatsResponse {
  ok: boolean;
  totals: {
    content: number;
    byType: Record<string, number>;
    users: number;
    comments: number;
    watchlistEntries: number;
    watchEntries: number;
    viewEvents: number;
    playlists: number;
    playlistItems: number;
    subtitleTracks: number;
  };
  engagement: {
    topWatched: { id: number; title: string; thumbnail: string | null; type: string; count: number }[];
    topRated: { id: number; title: string; type: string; thumbnail: string | null; rating: number }[];
    mostLiked: { id: number; title: string; type: string; thumbnail: string | null; count: number }[];
  };
  recency: { contentAddedLast7d: number; activeUsersLast7d: number };
  generatedAt: string;
}

/** GET /api/hub/scale response — the honest real-vs-logical-30B report. */
export interface HubScaleResponse {
  ok: boolean;
  real: {
    contentItems: number;
    searchDocs: number;
    vectorEmbeddings: number;
    users: number;
    shards: number;
    shardMode: string;
  };
  view: { capacityClaim: string; note: string };
  player: { allowedTypes: string[] };
  search: { engine: string; pipelineIntegrated: boolean; note: string };
}

/** GET /api/hub/feed response — three live shelves (recent/popular/rated). */
export interface HubFeedResponse {
  ok: boolean;
  sources: { id: string; label: string; data: HubContentRow[] }[];
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
