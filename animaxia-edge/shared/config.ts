/**
 * shared/config.ts — KV-driven runtime configuration (binding EDGE_CONFIG,
 * key "config"), with a 60s per-isolate in-memory cache and safe defaults.
 *
 * Same pattern as animaxia-cloud/cdn/cloudflare/src/worker.js, extended for
 * the full FAZA 8 edge layer. Every tunable knob (cache TTLs, SWR windows,
 * rate limits, WAF toggles, auth policy, cron job endpoints) can be flipped
 * at runtime by writing one JSON value into KV — no redeploy needed.
 */

import type { EdgeEnv } from './types';

export const CONFIG_KEY = 'config';
export const CONFIG_CACHE_MS = 60_000;

export interface EdgeConfig {
  maintenance: boolean;
  edge: {
    cacheTtlSec: number;          // fresh window (spec: 60s edge cache)
    swrSec: number;               // stale-while-revalidate window
    staleIfErrorSec: number;      // stale-if-error window (origin down)
    cacheablePrefixes: string[];  // public GET prefixes eligible for caching
    bypassPrefixes: string[];     // never cached (auth, mutations, admin)
  };
  rateLimit: {
    ipPerMin: number;             // per-IP global limit
    userPerMin: number;           // per authenticated user
    heavyPerMin: number;          // AI / expensive endpoints per user
  };
  waf: {
    enabled: boolean;
    blockBots: boolean;
    sql: boolean;
    xss: boolean;
    traversal: boolean;
    maxQueryBytes: number;
    logTtlSec: number;
  };
  auth: {
    enforceReplay: boolean;       // reject reused jti tokens
    deviceBinding: 'off' | 'soft' | 'strict'; // strict = tokens with dvp must match device header
    accessTtlSec: number;        // expected access-token TTL (replay registry TTL)
  };
  ai: {
    embeddingsTtlSec: number;     // KV embeddings cache TTL
    ragAnswerTtlSec: number;      // KV RAG answer cache TTL
    cacheStreaming: boolean;      // also cache complete assistant answers
  };
  search: {
    catalogKey: string;           // KV key of the catalog snapshot
    catalogTtlSec: number;        // snapshot freshness target
    fuzzy: boolean;
    maxVariants: number;          // fuzzy expansion variants per term (cloud uses 3)
    limit: number;                // default results limit
  };
  player: {
    manifestTtlSec: number;       // rewritten m3u8 cache TTL
    segmentTtlSec: number;        // segment cache TTL (immutable-ish)
    allowHosts: string[];         // segment proxy allowlist (open-proxy protection)
    r2WriteThrough: boolean;      // mirror popular .ts segments into R2
  };
  analytics: {
    batchSize: number;            // queue consumer → cloud batch size
    flushIntervalSec: number;     // KV buffer flush cadence (cron)
    trendBuckets: number;         // sliding hourly buckets for trending
    trendTtlSec: number;
  };
  cron: {
    jobs: Record<string, CronJobSpec>;
  };
}

export interface CronJobSpec {
  schedule: string;        // cron expression (informational; real triggers in wrangler.toml)
  enabled: boolean;
  endpoint: string;        // cloud path called by the job ('' = edge-only job)
  method: string;
  adminAuth?: boolean;     // true → send EDGE_ADMIN_JWT as Bearer
  fallbackEndpoint?: string; // public endpoint warmed when adminAuth is unavailable
  fallbackMethod?: string;
}

export const DEFAULT_CONFIG: EdgeConfig = {
  maintenance: false,
  edge: {
    cacheTtlSec: 60,
    swrSec: 600,
    staleIfErrorSec: 86_400,
    cacheablePrefixes: [
      '/api/all', '/api/content', '/api/anime', '/api/movies', '/api/tv',
      '/api/sports', '/api/news', '/api/health', '/api/search',
      '/mobile/home', '/mobile/config',
    ],
    bypassPrefixes: ['/api/auth', '/api/users', '/api/security', '/api/admin', '/auth'],
  },
  rateLimit: { ipPerMin: 600, userPerMin: 180, heavyPerMin: 30 },
  waf: {
    enabled: true,
    blockBots: true,
    sql: true,
    xss: true,
    traversal: true,
    maxQueryBytes: 8_192,
    logTtlSec: 86_400,
  },
  auth: { enforceReplay: true, deviceBinding: 'soft', accessTtlSec: 900 },
  ai: { embeddingsTtlSec: 86_400, ragAnswerTtlSec: 300, cacheStreaming: true },
  search: { catalogKey: 'catalog:v1', catalogTtlSec: 600, fuzzy: true, maxVariants: 3, limit: 20 },
  player: {
    manifestTtlSec: 30,
    segmentTtlSec: 3_600,
    allowHosts: [
      'test-streams.mux.dev',
      'commondatastorage.googleapis.com',
      'storage.googleapis.com',
      'stream.mux.com',
      // Real cloud data: the "Animaxia HLS Demo" content (id 3) streams from
      // Apple's public demo CDN — added so /player/manifest/3 rewrites live.
      'devstreaming-cdn.apple.com',
    ],
    r2WriteThrough: true,
  },
  analytics: { batchSize: 25, flushIntervalSec: 300, trendBuckets: 24, trendTtlSec: 172_800 },
  cron: {
    jobs: {
      'daily-picks': {
        schedule: '0 5 * * *',
        enabled: true,
        endpoint: '/api/all',
        method: 'GET',
        fallbackEndpoint: '',
      },
      'weekly-recap': {
        schedule: '0 6 * * 1',
        enabled: true,
        endpoint: '/api/analytics/trending?window=7d&limit=20',
        method: 'GET',
        fallbackEndpoint: '',
      },
      'tmdb-refresh': {
        schedule: '0 */6 * * *',
        enabled: true,
        endpoint: '/api/workers/refresh',
        method: 'POST',
        adminAuth: true,
        fallbackEndpoint: '/api/movies?limit=1',
        fallbackMethod: 'GET',
      },
      'jikan-refresh': {
        schedule: '30 */6 * * *',
        enabled: true,
        endpoint: '/api/workers/refresh',
        method: 'POST',
        adminAuth: true,
        fallbackEndpoint: '/api/anime?limit=1',
        fallbackMethod: 'GET',
      },
      'cleanup-logs': { schedule: '0 3 * * *', enabled: true, endpoint: '', method: 'GET' },
      'cleanup-sessions': { schedule: '0 4 * * *', enabled: true, endpoint: '', method: 'GET' },
      // FAZA 12 (miner): dedicated runner (cron/src/miner.ts) — POST body
      // {type:'daily-sync', allTenants:true} enqueues one job per ACTIVE
      // tenant on the monolith; public /api/miner/status is the fallback.
      'miner-sync': {
        schedule: '30 4 * * *',
        enabled: true,
        endpoint: '/api/miner/jobs',
        method: 'POST',
        adminAuth: true,
        fallbackEndpoint: '/api/miner/status',
        fallbackMethod: 'GET',
      },
    },
  },
};

/* --------------------------------------------------------- loader ---------- */

let cached: EdgeConfig | null = null;
let cachedAt = 0;

function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === null || patch === undefined) return base;
  if (typeof base !== 'object' || base === null || Array.isArray(base)) {
    return (patch as T) ?? base;
  }
  if (typeof patch !== 'object' || Array.isArray(patch)) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    const b = (base as Record<string, unknown>)[k];
    out[k] = b !== undefined && typeof b === 'object' && b !== null && !Array.isArray(b)
      ? deepMerge(b, v)
      : v;
  }
  return out as T;
}

/** Load config: KV value deep-merged over DEFAULT_CONFIG, 60s isolate cache. */
export async function loadEdgeConfig(env: EdgeEnv, force = false): Promise<EdgeConfig> {
  const now = Date.now();
  if (!force && cached && now - cachedAt < CONFIG_CACHE_MS) return cached;
  let stored: unknown = null;
  try {
    if (env.EDGE_CONFIG) stored = await env.EDGE_CONFIG.get(CONFIG_KEY, 'json');
  } catch { /* KV hiccup → defaults */ }
  let merged = deepMerge(DEFAULT_CONFIG, stored);
  if (!Array.isArray(merged.edge.cacheablePrefixes) || merged.edge.cacheablePrefixes.length === 0) {
    merged = { ...merged, edge: { ...merged.edge, cacheablePrefixes: DEFAULT_CONFIG.edge.cacheablePrefixes } };
  }
  cached = merged;
  cachedAt = now;
  return merged;
}

/** Test/inspection helper: drop the isolate cache. */
export function resetConfigCache(): void {
  cached = null;
  cachedAt = 0;
}
