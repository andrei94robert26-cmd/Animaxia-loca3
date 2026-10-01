/**
 * search/src/index.ts — ANIMAXIA EDGE SEARCH worker.
 *
 * Answers search + autocomplete at the edge from a catalog snapshot
 * (search/src/catalog.ts: in-isolate singleton → SEARCH_CACHE KV → cloud
 * GET /api/all rebuild) so most queries never touch the cloud. The gateway
 * routes these inbound paths here with the URL preserved:
 *
 *   GET  /search?q=&limit=&fuzzy=true|false — fuzzy search over the snapshot
 *        via shared/fuzzy.ts (cloud search-service semantics: term expansion
 *        with edit distance ≤ 2, max cfg.search.maxVariants variants). With
 *        no snapshot available it transparently proxies the cloud
 *        /api/search/advanced and tags 'x-edge-search: cloud-fallback'.
 *   GET  /autocomplete?q=&limit= — prefix / word-boundary suggestions from
 *        the snapshot; cloud /api/search/autocomplete passthrough fallback.
 *   POST /search/refresh — internal: force a snapshot rebuild, bypassing the
 *        memory singleton + KV age (requireInternalAuth: EDGE_ADMIN_JWT as a
 *        Bearer token or EDGE_INTERNAL_TOKEN via x-internal-token).
 *   GET  /search/health — worker + snapshot stats (never calls the cloud).
 *
 * Cloud contracts mirrored (modules/search/search.js):
 *   /api/search/advanced     → { took, total, max_score, data }
 *   /api/search/autocomplete → { suggestions: [{ id, title, type, thumbnail }] }
 */

import type { EdgeCtx, EdgeEnv, EdgeWorker } from '../../shared/types';
import { loadEdgeConfig } from '../../shared/config';
import { jsonError, jsonOk, requireInternalAuth, withCors, withSecurityHeaders } from '../../shared/http';
import { buildForwardedHeaders, upstreamFetch } from '../../shared/upstream';
import { withMetrics } from '../../shared/metrics'; // FAZA 9 ops
import { autocomplete, fuzzySearch } from '../../shared/fuzzy';
import { TENANT_HEADER, resolveTenantOf } from '../../shared/tenant'; // FAZA 11 multi-tenant
import { SHARD_HEADER, resolveShardOf, shardOfTenantSlug } from '../../shared/shard'; // FAZA 13 shard-aware edge
import { loadCatalog, peekCatalog } from './catalog';

/* ------------------------------------------------------------- helpers ----- */

/** Copy an upstream response with one extra header (fallback passthroughs). */
function withHeader(upstream: Response, name: string, value: string): Response {
  const headers = new Headers(upstream.headers);
  headers.set(name, value);
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

/** Parse an int query param: empty/invalid → fallback, otherwise clamped. */
function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

/** Tri-state query bool; anything not explicitly false-ish is true (cloud parity). */
function parseBool(raw: string | null, fallback: boolean): boolean {
  if (raw === null || raw.trim() === '') return fallback;
  return !['false', '0', 'off', 'no'].includes(raw.trim().toLowerCase());
}

/** Validate ?q= — trimmed, 1..128 chars (mirrors the 400s the cloud issues). */
function validQuery(url: URL): { q: string } | null {
  const q = (url.searchParams.get('q') ?? '').trim();
  if (!q || q.length > 128) return null;
  return { q };
}

function methodNotAllowed(method: string, allow: string): Response {
  return jsonError(405, 'method_not_allowed', `Method ${method} is not allowed here.`, { allow }, { allow });
}

/* ------------------------------------------------------------ handlers ----- */

/** GET /search — edge fuzzy search over the catalog snapshot.
 *  FAZA 11: the snapshot is tenant-scoped (X-Animaxia-Tenant / JWT claim).
 *  FAZA 13: + shard segment in the snapshot key (s<shard>:). */
async function handleSearch(request: Request, env: EdgeEnv, url: URL, tenant: string, shard: number): Promise<Response> {
  const cfg = await loadEdgeConfig(env);
  const parsed = validQuery(url);
  if (!parsed) {
    return jsonError(400, 'bad_query', 'Query parameter "q" is required (1..128 characters after trimming).');
  }
  const { q } = parsed;
  const limit = clampInt(url.searchParams.get('limit'), cfg.search.limit, 1, 50);
  const fuzzy = parseBool(url.searchParams.get('fuzzy'), cfg.search.fuzzy);

  const started = Date.now();
  const snapshot = await loadCatalog(env, cfg, false, tenant, shard);
  if (!snapshot) {
    // No snapshot (cloud + KV unavailable) → transparent cloud passthrough,
    // original query string preserved (q + any type/genre/year/sort filters).
    const upstream = await upstreamFetch({
      env,
      kind: 'cloud',
      path: '/api/search/advanced',
      search: url.search,
      method: 'GET',
      headers: buildForwardedHeaders(request, { [TENANT_HEADER]: tenant, [SHARD_HEADER]: String(shard) }), // FAZA 13
    });
    return withHeader(upstream, 'x-edge-search', 'cloud-fallback');
  }

  const scored = fuzzySearch(snapshot.items, q, {
    limit,
    fuzzy,
    maxVariants: cfg.search.maxVariants,
  });
  const results = scored.map((entry) => ({
    id: entry.item.id,
    title: entry.item.title,
    type: entry.item.type,
    thumbnail: entry.item.thumbnail,
    year: entry.item.year ?? null,
    rating: entry.item.rating ?? null,
    score: Math.round(entry.score),
    matchedTerm: entry.matchedTerm,
  }));

  return jsonOk({
    ok: true,
    query: q,
    source: 'edge',
    tenant, // FAZA 11: observability — which tenant's catalog answered
    shard, // FAZA 13: observability — which shard's key space answered
    tookMs: Date.now() - started,
    results,
  }, { headers: { 'x-edge-search': 'edge' } });
}

/** GET /autocomplete — prefix / word-boundary title suggestions. */
async function handleAutocomplete(request: Request, env: EdgeEnv, url: URL, tenant: string, shard: number): Promise<Response> {
  const cfg = await loadEdgeConfig(env);
  const parsed = validQuery(url);
  if (!parsed) {
    return jsonError(400, 'bad_query', 'Query parameter "q" is required (1..128 characters after trimming).');
  }
  const { q } = parsed;
  const limit = clampInt(url.searchParams.get('limit'), 8, 1, 20);

  const snapshot = await loadCatalog(env, cfg, false, tenant, shard);
  if (!snapshot) {
    const upstream = await upstreamFetch({
      env,
      kind: 'cloud',
      path: '/api/search/autocomplete',
      search: url.search,
      method: 'GET',
      headers: buildForwardedHeaders(request, { [TENANT_HEADER]: tenant, [SHARD_HEADER]: String(shard) }), // FAZA 13
    });
    return withHeader(upstream, 'x-edge-search', 'cloud-fallback');
  }

  return jsonOk({
    ok: true,
    query: q,
    suggestions: autocomplete(snapshot.items, q, limit),
  }, { headers: { 'x-edge-search': 'edge' } });
}

/** POST /search/refresh — internal; force a snapshot rebuild. */
async function handleRefresh(request: Request, env: EdgeEnv): Promise<Response> {
  if (!requireInternalAuth(request, env)) {
    return jsonError(401, 'unauthorized', 'Send EDGE_ADMIN_JWT as "Authorization: Bearer <token>" or EDGE_INTERNAL_TOKEN via the x-internal-token header.');
  }
  const cfg = await loadEdgeConfig(env);
  const snapshot = await loadCatalog(env, cfg, true);
  if (!snapshot) {
    return jsonError(502, 'catalog_unavailable', 'Forced catalog rebuild failed — the cloud /api/all endpoint is unreachable or returned an unexpected shape.');
  }
  return jsonOk({
    ok: true,
    items: snapshot.items.length,
    fetchedAt: snapshot.fetchedAt,
    source: snapshot.source,
  });
}

/** GET /search/health — worker + snapshot stats (no cloud calls).
 *  FAZA 11: ?tenant=<slug> peeks a specific tenant's catalog.
 *  FAZA 13: the peek follows the tenant's shard (hash) key space. */
async function handleHealth(env: EdgeEnv, url: URL): Promise<Response> {
  const cfg = await loadEdgeConfig(env);
  const tenant = (url.searchParams.get('tenant') || 'global').toLowerCase();
  const shard = shardOfTenantSlug(tenant, env); // FAZA 13 — no request context: tenant hash
  const snapshot = await peekCatalog(env, cfg, tenant, shard);
  return jsonOk({
    ok: true,
    worker: 'animaxia-edge-search',
    multiTenant: true, // FAZA 11
    sharding: true, // FAZA 13
    tenant,
    shard,
    catalog: snapshot
      ? {
          items: snapshot.items.length,
          ageSec: Math.max(0, Math.floor((Date.now() - snapshot.fetchedAt) / 1000)),
          source: snapshot.source,
        }
      : null,
  });
}

/* ------------------------------------------------------------- routing ----- */

async function route(request: Request, env: EdgeEnv): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method.toUpperCase();
  const readable = method === 'GET' || method === 'HEAD';

  if (path === '/search') {
    if (!readable) return methodNotAllowed(method, 'GET');
    const tenant = await resolveTenantOf(request, env); // FAZA 11
    return handleSearch(request, env, url, tenant, resolveShardOf(request, tenant, env)); // FAZA 13
  }
  if (path === '/autocomplete' || path === '/search/autocomplete') {
    if (!readable) return methodNotAllowed(method, 'GET');
    const tenant = await resolveTenantOf(request, env); // FAZA 11
    return handleAutocomplete(request, env, url, tenant, resolveShardOf(request, tenant, env)); // FAZA 13
  }
  if (path === '/search/refresh') {
    if (method !== 'POST') return methodNotAllowed(method, 'POST');
    return handleRefresh(request, env);
  }
  if (path === '/search/health' || path === '/health') {
    if (!readable) return methodNotAllowed(method, 'GET');
    return handleHealth(env, url);
  }
  return jsonError(404, 'not_found', `No search-worker route for ${method} ${path}`);
}

/* ---------------------------------------------------------------- entry ---- */

const worker: EdgeWorker = {
  fetch: withMetrics('search', async (request: Request, env: EdgeEnv, _ctx: EdgeCtx): Promise<Response> => {
    let inner: Response;
    if (request.method === 'OPTIONS') {
      inner = new Response(null, { status: 204 }); // withCors answers preflights
    } else {
      try {
        inner = await route(request, env);
      } catch (err) {
        inner = jsonError(500, 'internal_error', `Unhandled search-worker error: ${String((err as Error)?.message ?? err)}`);
      }
    }
    return withCors(withSecurityHeaders(inner), request);
  }), // FAZA 9 ops: /metrics + request counters
};

export default worker;
