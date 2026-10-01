'use client';

/**
 * sharding.ts — FAZA 13 Animaxia Sharding & Multi-Node API client (typed).
 * All calls are PUBLIC (no Bearer token) through platform.anonRequest with
 * relative gateway URLs built by apiUrl (XTransformPort, monolith :4000),
 * the same mechanism api.ts uses for public endpoints:
 *
 *   GET  /api/shards         — full shard console status (model snapshot,
 *                              schema migration state, per-shard pools,
 *                              search + vector cluster node health, ops
 *                              counters with p50/p95 latencies)
 *   GET  /api/shards/health  — lightweight synthetics (one status per shard)
 *
 *   POST /api/shards/reindex — admin-only (NOT exposed here; the console is
 *                              read-only by design)
 */

import { apiUrl } from './api';
import { anonRequest } from './platform';

/* --------------------------------- types ---------------------------------- */

/** Model snapshot from modules/sharding/model.js (SHARDCOUNT, branch map). */
export interface ShardModelInfo {
  shardcount: number;
  shards: { shardid: number; branch: string; urlConfigured?: boolean }[];
  mode: 'logical' | 'physical';
}

/** Whether the FAZA 13 shardid columns exist on each table. */
export interface ShardSchemaStatus {
  content?: boolean;
  searchdocs?: boolean;
  vectorembeddings?: boolean;
}

/** Live pg pool counters for one shard branch. */
export interface ShardPoolStats {
  total: number;
  idle: number;
  waiting: number;
}

/** Query/error counters accumulated per shard entry. */
export interface ShardPoolQueryStats {
  queries: number;
  errors: number;
}

/** One entry from listShardPools() — the per-shard Neon branch pool. */
export interface ShardPoolInfo {
  shardid: number;
  branch: string;
  mode: 'main' | 'branch';
  urlConfigured?: boolean;
  connected: boolean;
  healthy?: boolean;
  lastError?: string | null;
  pool?: ShardPoolStats;
  stats?: ShardPoolQueryStats;
}

/** One node of the FTS search cluster or the pgvector cluster. */
export interface ClusterNodeInfo {
  shardid: number;
  branch: string;
  mode: 'main' | 'branch';
  healthy: boolean;
  docs: number;
  latencyMs?: number;
  lastError?: string | null;
}

/** searchCluster / vectorCluster health section of /api/shards. */
export interface ClusterHealth {
  enabled: boolean;
  mode?: 'logical' | 'physical';
  nodes: ClusterNodeInfo[];
  healthy?: boolean;
  generatedAt?: string;
}

/** FAZA 14 — additive logical address-space block of /api/shards: the 30B
 *  space as 30 shards × 1 billion ids (mode 'logical' = one Neon branch;
 *  'physical' = dedicated SHARDnURL pools). */
export interface ShardsLogicalInfo {
  addressSpace: number;
  shardcount: number;
  shardSpan: number;
  mode: 'logical' | 'physical';
}

/** ops.search / ops.vector rolling counters of /api/shards. */
export interface ClusterOps {
  enabled: boolean;
  queries: number;
  errors: number;
  coalesced?: number;
  upserts?: number;
  nodesHealthy: number;
  nodesTotal: number;
  latencyP50Ms?: number;
  latencyP95Ms?: number;
  byShard?: Record<string, { queries?: number; errors?: number; upserts?: number }>;
  lastError?: string | null;
}

/** Full GET /api/shards payload (each section degrades to {error} on the
 * backend, so every field beyond `ok` is a tolerant optional). */
export interface ShardsStatus {
  ok: boolean;
  generatedAt?: string;
  model?: ShardModelInfo;
  schema?: ShardSchemaStatus;
  pools?: ShardPoolInfo[];
  /** FAZA 14 — {addressSpace, shardcount, shardSpan, mode}. */
  logical?: ShardsLogicalInfo;
  searchCluster?: ClusterHealth;
  vectorCluster?: ClusterHealth;
  ops?: {
    search?: ClusterOps;
    vector?: ClusterOps;
  };
}

/** GET /api/shards/health — one synthetic status line per shard. */
export interface ShardHealthEntry {
  shardid: number;
  branch: string;
  mode: 'main' | 'branch';
  status: 'healthy' | 'degraded' | 'down';
}

export interface ShardsHealth {
  ok: boolean;
  shards: ShardHealthEntry[];
}

/* --------------------------------- client ---------------------------------- */

/**
 * Full shard console status. anonRequest (no Bearer — the endpoint is public
 * read-only) goes through the Caddy gateway via apiUrl's XTransformPort and
 * throws a descriptive PlatformError on non-ok responses or network failure.
 */
export function fetchShards(): Promise<ShardsStatus> {
  return anonRequest<ShardsStatus>(apiUrl('/api/shards'));
}

/** Lightweight per-shard synthetics (search + vector pools probed). */
export function fetchShardsHealth(): Promise<ShardsHealth> {
  return anonRequest<ShardsHealth>(apiUrl('/api/shards/health'));
}

/**
 * Derives the row status chip label for one shard, mirroring the backend's
 * /api/shards/health synthetics:
 *   down     — pool not connected or explicitly unhealthy
 *   degraded — pool errors recorded, a lingering lastError, or an unhealthy
 *              search/vector cluster node on that shard
 *   healthy  — otherwise
 */
export function shardStatusLabel(
  pool: Pick<ShardPoolInfo, 'connected' | 'healthy' | 'lastError' | 'stats'> | null | undefined,
  clusterNodes: ClusterNodeInfo[] | null | undefined,
): 'healthy' | 'degraded' | 'down' {
  if (pool) {
    if (!pool.connected || pool.healthy === false) return 'down';
    if ((pool.stats?.errors ?? 0) > 0 || pool.lastError) return 'degraded';
  }
  if (clusterNodes?.some((n) => !n.healthy)) return 'degraded';
  return 'healthy';
}
