/**
 * cron/src/index.ts — animaxia-edge-cron: scheduled jobs + standalone
 * management routes for the FAZA 8 edge layer.
 *
 * scheduled(event, env, ctx):
 *   event.cron is matched against cfg.cron.jobs (shared/config.ts, KV-
 *   overridable) by schedule + enabled flag; every matched job runs through
 *   runJob(), which records a CronJobResult to EDGE_CACHE under
 *   cron:log:<ts>:<job> (TTL 7 days, via ctx.waitUntil). Any UNMATCHED
 *   trigger — the every-5-minutes analytics flush (see [triggers] in
 *   wrangler.toml), or a cron added to wrangler.toml before the config knows
 *   about it — runs the analytics buffer flush through the SVC_ANALYTICS
 *   service binding (recorded as the job 'analytics-flush').
 *
 * Jobs (defaults from DEFAULT_CONFIG.cron.jobs — exact cron expressions live
 * in wrangler.toml [triggers]; cloud contracts verified in the monolith):
 *   daily-picks    daily 05:00 UTC — GET /api/all (public cache warm-up)
 *   weekly-recap   Mondays 06:00 UTC — GET /api/analytics/trending?window=7d&limit=20
 *   tmdb-refresh   every 6h (minute 0) — POST /api/workers/refresh
 *                  {source:'tmdb'} (adminAuth,
 *   jikan-refresh  every 6h (minute 30) — POST /api/workers/refresh
 *                  {source:'jikan'}) with public fallback
 *                               GET /api/movies?limit=1 / /api/anime?limit=1
 *                               on 401/403 — e.g. when EDGE_ADMIN_JWT is not
 *                               configured. NOTE: the cloud refresh handler
 *                               REQUIRES { source } in the body (400
 *                               otherwise) and CronJobSpec carries no body
 *                               field, so the source is derived from the job
 *                               name ('tmdb-*' → tmdb, 'jikan-*' → jikan).
 *   cleanup-logs   0 3 * * *   edge-only: delete waf:* + cron:log:* keys
 *                               from EDGE_CACHE (they carry TTLs; the sweep
 *                               only speeds namespace compaction). This run's
 *                               own log entry is written afterwards and so
 *                               survives its own cleanup.
 *   cleanup-sessions 0 4 * * * edge-only: delete rl:* (EDGE_RATELIMIT) +
 *                               replay:* (EDGE_REPLAY) keys.
 *   miner-sync     30 4 * * *  — POST /api/miner/jobs {type:'daily-sync',
 *                               allTenants:true} (adminAuth; public fallback
 *                               GET /api/miner/status) — FAZA 12: the monolith
 *                               enqueues one daily-sync per ACTIVE tenant.
 *
 * Standalone management routes (for wrangler dev / zone routing):
 *   GET  /cron/health      — liveness + configured job count (public).
 *   GET  /cron/jobs        — requireInternalAuth: config + the newest ≤ 20
 *                            cron:log:* records, newest first.
 *   GET|POST /cron/run/:job — requireInternalAuth: run one job now
 *                            (404 'unknown_job' when not configured; the
 *                            built-in 'analytics-flush' is also runnable).
 *
 * One job's failure never breaks the scheduled handler — runJob catches
 * everything and reports ok:false + detail. Zero runtime dependencies;
 * Cloudflare Workers (ES2022).
 */

import { jsonOk, jsonError, withSecurityHeaders, withCors, requireInternalAuth } from '../../shared/http';
import { loadEdgeConfig } from '../../shared/config';
import type { CronJobSpec } from '../../shared/config';
import { upstreamFetch } from '../../shared/upstream';
import { withMetrics, edgeMetrics } from '../../shared/metrics'; // FAZA 9 ops
import { runMinerSync } from './miner'; // FAZA 12 miner ingest
import type { EdgeEnv, EdgeCtx, EdgeWorker, CronJobResult, KvLike } from '../../shared/types';

/* ------------------------------------------------------------- constants ---- */

const CRON_LOG_PREFIX = 'cron:log:';
const CRON_LOG_TTL_SEC = 604_800;      // 7 days of run history
const CLEANUP_LIST_LIMIT = 500;        // keys swept per namespace per run
const JOBS_LIST_LIMIT = 100;           // cron:log keys scanned for /cron/jobs
const JOBS_RESULT_LIMIT = 20;          // newest results returned
const FLUSH_JOB = 'analytics-flush';
const FLUSH_INTERNAL_URL = 'https://analytics.edge.internal/analytics/flush';

/* --------------------------------------------------------------- helpers ---- */

/** Split a config endpoint into path + query ('?…' kept in search). */
function splitEndpoint(endpoint: string): { path: string; search: string } {
  const idx = endpoint.indexOf('?');
  if (idx === -1) return { path: endpoint, search: '' };
  return { path: endpoint.slice(0, idx), search: endpoint.slice(idx) };
}

/**
 * POST /api/workers/refresh (cloud contract) REQUIRES { source: 'tmdb' |
 * 'jikan' } in the body — an empty body 400s. CronJobSpec has no body field,
 * so the source is derived from the job name.
 */
function refreshSourceFor(name: string): 'tmdb' | 'jikan' | null {
  if (name.startsWith('tmdb')) return 'tmdb';
  if (name.startsWith('jikan')) return 'jikan';
  return null;
}

function isOkStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

/** Delete every key under a prefix (best-effort, bounded). */
async function deletePrefix(kv: KvLike, prefix: string, limit = CLEANUP_LIST_LIMIT): Promise<number> {
  let deleted = 0;
  try {
    const list = await kv.list({ prefix, limit });
    for (const k of list.keys) {
      try {
        await kv.delete(k.name);
        deleted += 1;
      } catch {
        /* skip — next sweep retries */
      }
    }
  } catch {
    /* best-effort */
  }
  return deleted;
}

/** Persist one run record (best-effort, via ctx.waitUntil). */
async function recordCronLog(env: EdgeEnv, name: string, result: CronJobResult): Promise<void> {
  if (!env.EDGE_CACHE) return;
  try {
    await env.EDGE_CACHE.put(
      `${CRON_LOG_PREFIX}${Date.now()}:${name}`,
      JSON.stringify(result),
      { expirationTtl: CRON_LOG_TTL_SEC },
    );
  } catch {
    /* best-effort */
  }
}

/* ------------------------------------------------------------ cloud jobs ---- */

/**
 * Run one config-driven cloud job. adminAuth jobs carry the EDGE_ADMIN_JWT
 * Bearer token; on 401/403 (missing/invalid secret) the public
 * fallbackEndpoint is warmed instead and both statuses land in the detail.
 */
async function runCloudJob(name: string, spec: CronJobSpec, env: EdgeEnv, startedAt: number): Promise<CronJobResult> {
  const durationMs = (): number => Date.now() - startedAt;
  const primary = splitEndpoint(spec.endpoint);
  const method = spec.method.toUpperCase();

  const headers = new Headers();
  if (spec.adminAuth && env.EDGE_ADMIN_JWT) {
    headers.set('authorization', `Bearer ${env.EDGE_ADMIN_JWT}`);
  }
  let body: string | null = null;
  const source = refreshSourceFor(name);
  if (method !== 'GET' && method !== 'HEAD' && source) {
    headers.set('content-type', 'application/json');
    body = JSON.stringify({ source });
  }

  const res = await upstreamFetch({
    env, kind: 'cloud', path: primary.path, search: primary.search, method, headers, body,
  });

  if ((res.status === 401 || res.status === 403) && spec.fallbackEndpoint) {
    const fallback = splitEndpoint(spec.fallbackEndpoint);
    const fallbackMethod = (spec.fallbackMethod || 'GET').toUpperCase();
    const fbRes = await upstreamFetch({
      env, kind: 'cloud', path: fallback.path, search: fallback.search,
      method: fallbackMethod, headers: new Headers(),
    });
    return {
      job: name,
      ok: isOkStatus(fbRes.status),
      status: fbRes.status,
      detail: `primary ${method} ${primary.path} → ${res.status} (admin auth rejected); fallback ${fallbackMethod} ${fallback.path} → ${fbRes.status}`,
      startedAt,
      durationMs: durationMs(),
    };
  }

  return {
    job: name,
    ok: isOkStatus(res.status),
    status: res.status,
    detail: `${method} ${primary.path}${primary.search} → ${res.status}`
      + (spec.adminAuth && !env.EDGE_ADMIN_JWT ? ' (no EDGE_ADMIN_JWT secret configured)' : ''),
    startedAt,
    durationMs: durationMs(),
  };
}

/* ---------------------------------------------------------- edge-only jobs -- */

/**
 * cleanup-logs — compact the EDGE_CACHE namespace: waf:* block logs +
 * cron:log:* run history (all carry their own TTLs; deleting them just
 * speeds up KV compaction).
 */
async function runCleanupLogs(env: EdgeEnv, startedAt: number): Promise<CronJobResult> {
  const durationMs = (): number => Date.now() - startedAt;
  const kv = env.EDGE_CACHE;
  if (!kv) {
    return { job: 'cleanup-logs', ok: false, status: null, detail: 'EDGE_CACHE binding not configured', startedAt, durationMs: durationMs() };
  }
  const waf = await deletePrefix(kv, 'waf:');
  const logs = await deletePrefix(kv, CRON_LOG_PREFIX);
  return {
    job: 'cleanup-logs',
    ok: true,
    status: null,
    detail: `deleted ${waf + logs} keys (waf: ${waf}, cron:log: ${logs})`,
    startedAt,
    durationMs: durationMs(),
  };
}

/**
 * cleanup-sessions — compact the rate-limit (rl:*) and anti-replay
 * (replay:*) namespaces; buckets carry TTLs, the sweep only accelerates
 * their expiry. Missing bindings simply have nothing to clean.
 */
async function runCleanupSessions(env: EdgeEnv, startedAt: number): Promise<CronJobResult> {
  const durationMs = (): number => Date.now() - startedAt;
  let rl = 0;
  let replay = 0;
  if (env.EDGE_RATELIMIT) rl = await deletePrefix(env.EDGE_RATELIMIT, 'rl:');
  if (env.EDGE_REPLAY) replay = await deletePrefix(env.EDGE_REPLAY, 'replay:');
  return {
    job: 'cleanup-sessions',
    ok: true,
    status: null,
    detail: `deleted ${rl + replay} keys (rl: ${rl}, replay: ${replay})`,
    startedAt,
    durationMs: durationMs(),
  };
}

/* -------------------------------------------------------- analytics flush --- */

/**
 * The 5-minute analytics buffer flush: POST /analytics/flush on the
 * analytics worker through the SVC_ANALYTICS service binding, authenticated
 * with the shared x-internal-token.
 */
async function runAnalyticsFlush(env: EdgeEnv, ctx: EdgeCtx): Promise<CronJobResult> {
  const startedAt = Date.now();
  const durationMs = (): number => Date.now() - startedAt;
  let result: CronJobResult;

  if (!env.SVC_ANALYTICS) {
    result = {
      job: FLUSH_JOB, ok: false, status: null,
      detail: 'SVC_ANALYTICS service binding not configured — flush skipped',
      startedAt, durationMs: durationMs(),
    };
  } else {
    try {
      const res = await env.SVC_ANALYTICS.fetch(new Request(FLUSH_INTERNAL_URL, {
        method: 'POST',
        headers: { 'x-internal-token': env.EDGE_INTERNAL_TOKEN || '' },
      }));
      let detail = `POST /analytics/flush (service binding) → ${res.status}`;
      if (isOkStatus(res.status)) {
        try {
          const payload = (await res.json()) as { drained?: number; batches?: number; failed?: unknown[]; retained?: number } | null;
          if (payload && typeof payload === 'object') {
            detail += ` — drained ${payload.drained ?? 0}, batches ${payload.batches ?? 0}, failed ${Array.isArray(payload.failed) ? payload.failed.length : 0}, retained ${payload.retained ?? 0}`;
          }
        } catch {
          /* detail stays status-only */
        }
      }
      result = {
        job: FLUSH_JOB, ok: isOkStatus(res.status), status: res.status, detail,
        startedAt, durationMs: durationMs(),
      };
    } catch (err) {
      result = {
        job: FLUSH_JOB, ok: false, status: null,
        detail: `error: ${String((err as Error)?.message ?? err)}`,
        startedAt, durationMs: durationMs(),
      };
    }
  }

  ctx.waitUntil(recordCronLog(env, FLUSH_JOB, result));
  return result;
}

/* ---------------------------------------------------------------- runJob ---- */

/**
 * Run one cron job by name + spec, record the result, never throw. Jobs are
 * dispatched edge-only handlers first (cleanup-*), then config cloud
 * endpoints; a config job with an empty endpoint and no handler reports
 * ok:false instead of failing the scheduled handler.
 */
async function runJob(name: string, spec: CronJobSpec, env: EdgeEnv, ctx: EdgeCtx): Promise<CronJobResult> {
  const startedAt = Date.now();
  let result: CronJobResult;
  try {
    if (name === 'cleanup-logs') {
      result = await runCleanupLogs(env, startedAt);
    } else if (name === 'cleanup-sessions') {
      result = await runCleanupSessions(env, startedAt);
    } else if (name === 'miner-sync' || name.startsWith('miner-')) {
      // FAZA 12: dedicated runner — the cloud body ({daily-sync, allTenants})
      // carries fields CronJobSpec cannot express (see cron/src/miner.ts).
      result = await runMinerSync(env, startedAt);
    } else if (spec.endpoint) {
      result = await runCloudJob(name, spec, env, startedAt);
    } else {
      result = {
        job: name, ok: false, status: null,
        detail: 'edge-only job with no built-in handler and no cloud endpoint',
        startedAt, durationMs: Date.now() - startedAt,
      };
    }
  } catch (err) {
    result = {
      job: name, ok: false, status: null,
      detail: `error: ${String((err as Error)?.message ?? err)}`,
      startedAt, durationMs: Date.now() - startedAt,
    };
  }
  ctx.waitUntil(recordCronLog(env, name, result));
  return result;
}

/* ------------------------------------------------------------- scheduled ---- */

async function handleScheduled(event: { cron: string; scheduledTime: number }, env: EdgeEnv, ctx: EdgeCtx): Promise<void> {
  edgeMetrics.inc('animaxia_edge_cron_runs_total', { cron: event.cron }); // FAZA 9 ops
  const cfg = await loadEdgeConfig(env);
  const matched = Object.entries(cfg.cron.jobs).filter(([, spec]) => spec.enabled && spec.schedule === event.cron);
  if (matched.length > 0) {
    for (const [name, spec] of matched) {
      const result = await runJob(name, spec, env, ctx); // runJob never throws
      edgeMetrics.inc('animaxia_edge_cron_jobs_total', { job: name, ok: result.ok ? 'true' : 'false' }); // FAZA 9 ops
    }
    return;
  }
  // Unmatched trigger (the */5 analytics flush, or a cron not yet in config).
  await runAnalyticsFlush(env, ctx);
}

/* --------------------------------------------------------- management API --- */

async function handleJobs(request: Request, env: EdgeEnv): Promise<Response> {
  if (!requireInternalAuth(request, env)) {
    return jsonError(401, 'unauthorized', 'internal auth required (Bearer EDGE_ADMIN_JWT or x-internal-token)', {}, { 'www-authenticate': 'Bearer' });
  }
  const cfg = await loadEdgeConfig(env);
  const jobs = Object.entries(cfg.cron.jobs).map(([name, spec]) => ({
    name,
    schedule: spec.schedule,
    enabled: spec.enabled,
    endpoint: spec.endpoint,
    method: spec.method,
    adminAuth: spec.adminAuth === true,
    fallbackEndpoint: spec.fallbackEndpoint ?? '',
    fallbackMethod: spec.fallbackMethod ?? 'GET',
  }));

  const results: Array<{ key: string; result: CronJobResult }> = [];
  const kv = env.EDGE_CACHE;
  if (kv) {
    try {
      const list = await kv.list({ prefix: CRON_LOG_PREFIX, limit: JOBS_LIST_LIMIT });
      // Keys are cron:log:<epochMs>:<name> — lexicographic desc = newest first.
      const keys = list.keys.map((k) => k.name).sort().reverse().slice(0, JOBS_RESULT_LIMIT);
      const values = await Promise.all(keys.map((key) => kv.get(key).catch(() => null)));
      for (let i = 0; i < keys.length; i++) {
        const raw = values[i];
        if (raw === null) continue;
        try {
          results.push({ key: keys[i], result: JSON.parse(raw) as CronJobResult });
        } catch {
          /* skip corrupt record */
        }
      }
    } catch {
      /* best-effort */
    }
  }
  return jsonOk({ ok: true, jobs, results });
}

async function handleRun(request: Request, env: EdgeEnv, ctx: EdgeCtx, path: string): Promise<Response> {
  if (!requireInternalAuth(request, env)) {
    return jsonError(401, 'unauthorized', 'internal auth required (Bearer EDGE_ADMIN_JWT or x-internal-token)', {}, { 'www-authenticate': 'Bearer' });
  }
  const name = decodeURIComponent(path.slice('/cron/run/'.length)).trim();
  if (!name) {
    return jsonError(404, 'unknown_job', 'job name required: /cron/run/:job');
  }
  if (name === FLUSH_JOB) {
    return jsonOk(await runAnalyticsFlush(env, ctx));
  }
  const cfg = await loadEdgeConfig(env);
  const spec = cfg.cron.jobs[name];
  if (!spec) {
    return jsonError(404, 'unknown_job', `no cron job named '${name}'`);
  }
  return jsonOk(await runJob(name, spec, env, ctx));
}

/* --------------------------------------------------------------- router ----- */

async function handleFetch(request: Request, env: EdgeEnv, ctx: EdgeCtx): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();

  let response: Response;
  try {
    if (method === 'GET' && path === '/cron/health') {
      const cfg = await loadEdgeConfig(env);
      response = jsonOk({ ok: true, worker: 'animaxia-edge-cron', jobs: Object.keys(cfg.cron.jobs).length });
    } else if (method === 'GET' && path === '/cron/jobs') {
      response = await handleJobs(request, env);
    } else if ((method === 'GET' || method === 'POST') && path.startsWith('/cron/run/')) {
      response = await handleRun(request, env, ctx, path);
    } else {
      response = jsonError(404, 'not_found', `no cron route for ${method} ${path}`);
    }
  } catch (err) {
    response = jsonError(500, 'edge_error', String((err as Error)?.message ?? err));
  }
  return withCors(withSecurityHeaders(response), request);
}

const worker: EdgeWorker = {
  fetch: withMetrics('cron', handleFetch), // FAZA 9 ops: /metrics + request counters
  scheduled: handleScheduled,
};

export default worker;
