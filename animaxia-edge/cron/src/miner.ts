/**
 * cron/src/miner.ts — FAZA 12 (additive): the 'miner-sync' scheduled job.
 *
 * One call, every active tenant: POST /api/miner/jobs { type: 'daily-sync',
 * allTenants: true } on the cloud monolith. The monolith owns the tenant
 * iteration (it enqueues one persistent miner_jobs row per active tenant —
 * global + enterprise tenants alike), so the edge job stays dumb exactly
 * like the tmdb/jikan refresh jobs. The POST returns 201 immediately (jobs
 * run asynchronously in the monolith's miner queue), which keeps the cron
 * well under the 30s Cloudflare scheduled-handler budget.
 *
 * Auth: EDGE_ADMIN_JWT Bearer (admin-only route). On 401/403 (missing or
 * rejected secret) the PUBLIC /api/miner/status is warmed as a liveness
 * fallback — same policy as the tmdb/jikan refresh jobs.
 *
 * Result detail carries the scheduled job count so /cron/jobs shows exactly
 * how many tenant syncs were queued.
 */

import type { EdgeEnv } from '../../shared/types';
import { upstreamFetch } from '../../shared/upstream';

export interface MinerSyncResult {
  job: string;
  ok: boolean;
  status: number | null;
  detail: string;
  startedAt: number;
  durationMs: number;
}

interface ScheduleResponse {
  ok?: boolean;
  allTenants?: boolean;
  count?: number;
}

export async function runMinerSync(env: EdgeEnv, startedAt: number): Promise<MinerSyncResult> {
  const durationMs = (): number => Date.now() - startedAt;

  const headers = new Headers({ 'content-type': 'application/json' });
  if (env.EDGE_ADMIN_JWT) {
    headers.set('authorization', `Bearer ${env.EDGE_ADMIN_JWT}`);
  }

  let res: Response;
  try {
    res = await upstreamFetch({
      env,
      kind: 'cloud',
      path: '/api/miner/jobs',
      method: 'POST',
      headers,
      body: JSON.stringify({ type: 'daily-sync', allTenants: true }),
    });
  } catch (err) {
    return {
      job: 'miner-sync',
      ok: false,
      status: null,
      detail: `error: ${String((err as Error)?.message ?? err)}`,
      startedAt,
      durationMs: durationMs(),
    };
  }

  // Admin auth rejected → warm the public status endpoint instead (the
  // tmdb/jikan fallback policy) so the run still proves cloud liveness.
  if (res.status === 401 || res.status === 403) {
    const fb = await upstreamFetch({
      env,
      kind: 'cloud',
      path: '/api/miner/status',
      method: 'GET',
      headers: new Headers(),
    });
    return {
      job: 'miner-sync',
      ok: fb.status >= 200 && fb.status < 300,
      status: fb.status,
      detail: `primary POST /api/miner/jobs → ${res.status} (admin auth rejected); fallback GET /api/miner/status → ${fb.status}`,
      startedAt,
      durationMs: durationMs(),
    };
  }

  let detail = `POST /api/miner/jobs {daily-sync, allTenants} → ${res.status}`;
  if (res.status >= 200 && res.status < 300) {
    try {
      const payload = (await res.json()) as ScheduleResponse | null;
      if (payload && typeof payload === 'object') {
        detail += ` — queued ${payload.count ?? 0} tenant sync job(s)`;
      }
    } catch {
      /* detail stays status-only */
    }
  } else if (!env.EDGE_ADMIN_JWT) {
    detail += ' (no EDGE_ADMIN_JWT secret configured)';
  }

  return {
    job: 'miner-sync',
    ok: res.status >= 200 && res.status < 300,
    status: res.status,
    detail,
    startedAt,
    durationMs: durationMs(),
  };
}
