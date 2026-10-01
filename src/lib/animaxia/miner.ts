'use client';

/**
 * miner.ts — FAZA 12 Miner (ingest + indexing) API client (typed). All calls
 * go through platform.authRequest / platformUrl (relative URLs +
 * XTransformPort, auto-refresh on 401) against the monolith's miner surface:
 *
 *   GET    /api/miner/status              — pool + jobs + per-tenant sources
 *   GET    /api/miner/jobs                — latest jobs (filters: status,
 *                                           tenant, type, limit)
 *   GET    /api/miner/jobs/:id            — full job record incl. logs
 *   POST   /api/miner/jobs                — schedule { type, tenant? } (admin)
 *   POST   /api/miner/jobs                — { allTenants: true } → one
 *                                           daily-sync per active tenant
 *   POST   /api/miner/run/:id             — manual run / re-run (admin)
 *   POST   /api/miner/search/push         — push catalog to search (admin)
 */

import { authRequest } from './platform';

/* --------------------------------- types ---------------------------------- */

export type MinerJobType = 'daily-sync' | 'tmdb-sync' | 'jikan-sync' | 'reindex' | 'manifest-sweep';
export type MinerJobStatus = 'queued' | 'running' | 'done' | 'failed';

export const MINER_JOB_TYPES: { value: MinerJobType; label: string; hint: string }[] = [
  { value: 'daily-sync', label: 'Daily sync', hint: 'TMDB + Jikan page, index + catalog push' },
  { value: 'tmdb-sync', label: 'TMDB sync', hint: 'One TMDB movies page' },
  { value: 'jikan-sync', label: 'Jikan sync', hint: 'One Jikan top-anime page' },
  { value: 'reindex', label: 'Reindex', hint: 'Rebuild the tenant vector index' },
  { value: 'manifest-sweep', label: 'Manifest sweep', hint: 'Scan HLS manifests into the inventory' },
];

export interface MinerJobResult {
  upserted?: number;
  created?: number;
  indexed?: number;
  pushed?: number;
  scanned?: number;
  found?: number;
  provider?: string;
  providers?: string[];
  backend?: string;
  scope?: string;
  errors?: string[];
  [key: string]: unknown;
}

export interface MinerJob {
  id: string;
  type: MinerJobType;
  status: MinerJobStatus;
  tenant: string;
  result: MinerJobResult | null;
  error: string | null;
  attempts: number;
  createdBy: number | null;
  queuedat: string | null;
  startedat: string | null;
  finishedat: string | null;
  logs?: { level: string; message: string; ts: string }[];
  note?: string;
}

export interface MinerTenantRow {
  tenant: string;
  sources: number;
  synced24h: number;
}

export interface MinerStatus {
  ok: boolean;
  service: 'animaxia-miner';
  searchBackend: 'opensearch' | 'local';
  pool: { maxConcurrent: number; running: number };
  jobs: {
    byStatus: Record<string, number>;
    byType: Record<string, number>;
    last: MinerJob | null;
  };
  tenants: MinerTenantRow[];
  manifests: { total: number; tenants: number };
  jobTypes: MinerJobType[];
}

export interface ScheduleMinerJobInput {
  type: MinerJobType;
  tenant?: string;
  page?: number;
  mode?: 'trending' | 'discover';
  limit?: number;
  contentIds?: number[];
  allTenants?: boolean;
}

export interface ScheduleMinerJobResponse {
  ok: boolean;
  job?: MinerJob;
  allTenants?: boolean;
  count?: number;
  jobs?: { id: string; tenant: string; status: string }[];
}

/* ---------------------------------- api ----------------------------------- */

async function minerPost<T>(path: string, body: unknown): Promise<T> {
  return authRequest<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export const minerApi = {
  status: () => authRequest<MinerStatus>('/api/miner/status'),

  jobs: (params: { status?: string; tenant?: string; type?: string; limit?: number } = {}) => {
    const search = new URLSearchParams();
    if (params.status) search.set('status', params.status);
    if (params.tenant) search.set('tenant', params.tenant);
    if (params.type) search.set('type', params.type);
    if (params.limit) search.set('limit', String(params.limit));
    const qs = search.toString();
    return authRequest<{ data: MinerJob[]; total: number }>(
      `/api/miner/jobs${qs ? `?${qs}` : ''}`,
    );
  },

  job: (id: string) => authRequest<MinerJob>(`/api/miner/jobs/${encodeURIComponent(id)}`),

  schedule: (input: ScheduleMinerJobInput) =>
    minerPost<ScheduleMinerJobResponse>('/api/miner/jobs', input),

  run: (id: string) =>
    minerPost<{ ok: boolean; job: MinerJob }>(`/api/miner/run/${encodeURIComponent(id)}`, {}),

  searchPush: (tenant: string, limit = 50) =>
    minerPost<{ ok: boolean; tenant: string; pushed: number; backend: string; key?: string; index?: string }>(
      '/api/miner/search/push',
      { tenant, limit },
    ),
};
