/**
 * shared/types.ts — central type contracts for the Animaxia Edge layer.
 *
 * Every worker (worker/ = gateway, search/, ai/, auth/, player/, analytics/,
 * cron/) imports its bindings contract from here. The local test harness
 * (tests/local-harness.ts) implements in-memory stubs that are structurally
 * compatible with these interfaces, so the same code runs on Cloudflare and
 * under `bun tests/smoke-edge.mjs` without changes.
 *
 * Zero runtime dependencies. Cloudflare Workers runtime (ES2022).
 */

/* ------------------------------------------------------------------ KV ---- */

/** Minimal KV surface used by edge code (subset of KVNamespace). */
export interface KvLike {
  get(key: string, type: 'json'): Promise<unknown>;
  get(key: string, type: 'text'): Promise<string | null>;
  get(key: string, type: 'arrayBuffer'): Promise<ArrayBuffer | null>;
  get(key: string): Promise<string | null>;
  getWithMetadata(key: string, type: 'json'): Promise<KvEntryWithMetadata<unknown>>;
  getWithMetadata(key: string, type: 'text'): Promise<KvEntryWithMetadata<string | null>>;
  put(key: string, value: string | ReadableStream | ArrayBuffer, options?: KvPutOptions): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string; limit?: number }): Promise<{ keys: KvListKey[]; list_complete: boolean }>;
}

export interface KvPutOptions {
  expirationTtl?: number; // seconds (min 60 on real KV)
  metadata?: unknown;
}

export interface KvEntryWithMetadata<T> {
  value: T;
  metadata: unknown | null;
}

export interface KvListKey {
  name: string;
  expiration?: number;
  metadata?: unknown;
}

/* ------------------------------------------------------------------ R2 ---- */

/** Minimal R2 object surface used by edge code. */
export interface R2ObjectLike {
  key: string;
  size: number;
  httpEtag: string;
  uploaded?: Date;
  body?: ReadableStream | null;
  writeHttpMetadata(headers: Headers): void;
}

export interface R2Like {
  get(key: string, options?: { range?: { offset: number; length?: number } }): Promise<R2ObjectLike | null>;
  head(key: string): Promise<R2ObjectLike | null>;
  put(key: string, value: ReadableStream | ArrayBuffer | Uint8Array | string, options?: {
    httpMetadata?: Record<string, string>;
    customMetadata?: Record<string, string>;
  }): Promise<R2ObjectLike | null>;
  delete(key: string | string[]): Promise<void>;
}

/* ------------------------------------------------------------- Cache API --- */

/** Minimal subset of the Workers Cache API (caches.default). */
export interface CacheStorageLike {
  match(request: Request | string): Promise<Response | null>;
  put(request: Request | string, response: Response): Promise<void>;
  delete(request: Request | string): Promise<boolean>;
}

/* ----------------------------------------------------------------- DO ------ */

/** Minimal Durable Object namespace surface (subset of DurableObjectNamespace). */
export interface DoNamespaceLike {
  idFromName(name: string): { name: string; toString(): string };
  get(id: { name: string; toString(): string }): { fetch(request: Request): Promise<Response> };
}

/* -------------------------------------------------------------- Queue ------ */

export interface QueueMessageBody {
  body: unknown;
  id?: string;
  timestamp?: number;
  attempts?: number;
}

export interface QueueLike {
  send(message: unknown, options?: { contentType?: string }): Promise<void>;
  sendBatch(messages: Array<{ body: unknown }>): Promise<void>;
}

export interface QueueBatch<Body = unknown> {
  messages: Array<QueueMessageBody & { body: Body }>;
  ackAll(): void;
  retryAll(options?: { delaySeconds?: number }): void;
  ack(message: QueueMessageBody): void;
  retry(message: QueueMessageBody, options?: { delaySeconds?: number }): void;
}

/* --------------------------------------------------------- service binding - */

/** Service binding to another edge worker (subset of Fetcher). */
export interface ServiceBindingLike {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

/* ------------------------------------------------------------------ ctx ---- */

export interface EdgeCtx {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException?(): void;
}

/* ------------------------------------------------------------- payloads ---- */

/** JWT payload exactly as the cloud auth-service issues it (HS256):
 *  { sub, email, plan, typ: 'access', iat, exp } + optional edge extensions
 *  (jti for anti-replay, dvp = sha256(deviceId) for device binding). */
export interface EdgeJwtPayload {
  sub?: number | string;
  email?: string;
  plan?: string;
  typ?: string;
  iat?: number;
  exp?: number;
  jti?: string;
  dvp?: string;
  tenant?: string; // FAZA 11 — tenant slug claim (tenant-aware signing secret)
  [extra: string]: unknown;
}

export interface RateResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetSec: number; // epoch seconds when the window resets
}

export interface WafVerdict {
  blocked: boolean;
  rule: string | null; // 'bot' | 'sqli' | 'xss' | 'traversal' | 'query-size' | 'null-byte'
  reason: string;
}

export interface CacheVerdict {
  state: 'HIT' | 'MISS' | 'STALE' | 'STALE-ERROR' | 'BYPASS' | 'DISABLED';
  ageSec: number;
}

/* ------------------------------------------------------------- KV records -- */

/** L2 cache record stored in EDGE_CACHE (see shared/cache.ts). */
export interface CacheRecord {
  v: 1;
  status: number;
  contentType: string;
  storedAt: number; // epoch ms
  freshUntil: number; // storedAt + ttl*1000
  swrUntil: number; // freshUntil + swr*1000
  sieUntil: number; // swrUntil + staleIfError*1000
  bodyB64: string;
  headers: Record<string, string>;
}

/** Catalog snapshot for edge search (see search/src/index.ts). */
export interface CatalogItem {
  id: number;
  title: string;
  type: string;
  thumbnail: string | null;
  genres?: string[];
  year?: number | null;
  rating?: number | null;
}

export interface CatalogSnapshot {
  v: 1;
  fetchedAt: number;
  source: string;
  items: CatalogItem[];
}

/** Analytics event queued to ANALYTICS_QUEUE. */
export interface AnalyticsEvent {
  contentId: number;
  event: 'view' | 'play' | 'complete';
  userId?: number | null;
  ts: number;
  ip?: string | null;
  ua?: string | null;
}

export interface TrendingRow {
  contentId: number;
  title: string | null;
  thumbnail: string | null;
  score: number;
  plays: number;
  views: number;
}

export interface CronJobResult {
  job: string;
  ok: boolean;
  status: number | null;
  detail: string;
  startedAt: number;
  durationMs: number;
}

/* ------------------------------------------------------------------ env ---- */

/**
 * Full edge environment. Individual workers declare the subset they need;
 * the gateway declares everything (it fronts all sub-workers through
 * service bindings). Every binding name below matches wrangler.toml files.
 */
export interface EdgeEnv {
  /* KV namespaces */
  EDGE_CONFIG?: KvLike;       // global runtime config (key "config")
  EDGE_CACHE?: KvLike;        // SWR / stale-if-error L2 cache
  EDGE_RATELIMIT?: KvLike;    // KV fallback store for rate limiting
  EDGE_REPLAY?: KvLike;       // anti-replay jti registry
  SEARCH_CACHE?: KvLike;      // search: catalog snapshot + query cache
  EMBEDDINGS_CACHE?: KvLike;  // ai: embeddings cache
  ANALYTICS_TREND?: KvLike;   // analytics: trending counters + buffers

  /* R2 buckets */
  MEDIA_BUCKET?: R2Like;      // thumbnails, offline-test.mp4
  HLS_CACHE?: R2Like;         // optional write-through for popular HLS segments

  /* Durable Object + Queue */
  RATE_LIMITER?: DoNamespaceLike;
  ANALYTICS_QUEUE?: QueueLike;

  /* Service bindings (gateway → sub-workers) */
  SVC_SEARCH?: ServiceBindingLike;
  SVC_AI?: ServiceBindingLike;
  SVC_AUTH?: ServiceBindingLike;
  SVC_PLAYER?: ServiceBindingLike;
  SVC_ANALYTICS?: ServiceBindingLike;

  /* Vars (wrangler [vars]) */
  CLOUD_ORIGIN?: string;      // monolith / cloud gateway, default http://127.0.0.1:4000
  AI_ORIGIN?: string;         // ai-service origin (defaults to CLOUD_ORIGIN, path /api/ai/*)
  VECTOR_ORIGIN?: string;     // vector-service origin (defaults to CLOUD_ORIGIN, path /api/vector/*)
  MOBILE_ORIGIN?: string;     // mobile-service origin (defaults to CLOUD_ORIGIN, path /api/mobile/*)
  WS_ORIGIN?: string;         // assistant live WebSocket upstream (defaults to CLOUD_ORIGIN)
  EDGE_ENV?: string;          // 'production' | 'development'
  ORIGIN_REGIONS?: string;    // FAZA 22 — geo-routing gate: JSON {"eu":"https://…","us":"https://…","asia":"https://…"} (see shared/geo.ts). Unset/invalid = OFF (default, pre-FAZA-22 behavior)

  /* Secrets (wrangler secret put …) */
  JWT_SECRET?: string;        // exact HS256 secret; wins over derivation
  AUTHSECRET?: string;        // cloud env passthrough (AUTHSECRET)
  DATABASEURL?: string;       // cloud env passthrough — derived secret = sha256("animaxia-auth:<DATABASEURL>")
  EDGE_ADMIN_JWT?: string;    // optional admin token for cron admin endpoints
  EDGE_INTERNAL_TOKEN?: string; // optional shared token edge → cloud internal calls
}

/** Standard worker default export shape. */
export interface EdgeWorker {
  fetch(request: Request, env: EdgeEnv, ctx: EdgeCtx): Promise<Response>;
  scheduled?(event: { cron: string; scheduledTime: number }, env: EdgeEnv, ctx: EdgeCtx): Promise<void>;
  queue?(batch: QueueBatch, env: EdgeEnv, ctx: EdgeCtx): Promise<void>;
}
