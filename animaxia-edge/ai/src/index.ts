/**
 * ai/src/index.ts — animaxia-edge-ai: AI / RAG edge accelerator.
 *
 * Fronts the cloud aicloud surface (mini-services/animaxia-backend
 * /modules/aicloud/router.js, mounted at /api/ai and /api/vector) behind the
 * preserved /ai/* prefix. Two acceleration levels cut LLM latency + quota
 * cost without ever serving one user's personalized answer to another:
 *
 *   L1 — answer cache (EMBEDDINGS_CACHE):
 *          ans:assistant:<sha256(bodyJson)>   full assistant JSON answer
 *          ans:rag:<sha256(path\nbodyJson)>   full RAG JSON answer
 *        TTL cfg.ai.ragAnswerTtlSec (default 300s). Only ANONYMOUS requests
 *        are cached — anything carrying Authorization passes through
 *        untouched ('x-edge-ai: bypass-auth'), because assistant/RAG answers
 *        are user-personalized (profile, memories, quota snapshot).
 *   L2 — retrieval pre-warm (EMBEDDINGS_CACHE):
 *          emb:vec:<sha256(queryText)>        /api/vector/search JSON
 *        Every RAG miss ALSO warms the retrieval step the cloud pipeline
 *        runs (vectorSearch { query, kind: 'content', topK 18 } — mirroring
 *        runRag's retrieve default), TTL cfg.ai.embeddingsTtlSec.
 *
 * Routes (the gateway preserves the /ai prefix):
 *   POST /ai/assistant                            — 120s upstream budget; an
 *                                                   SSE upstream streams
 *                                                   through unbuffered,
 *                                                   never cached.
 *   POST /ai/rag/{chat,recommend,summarize,explain} — L1 + L2 acceleration.
 *   POST /ai/embeddings { text, topK? }           — explicit retrieval endpoint.
 *   GET  /ai/cloud/status | /ai/tools             — SWR cache 60/300/900s.
 *   ANY  /ai/personal/*, /ai/admin/*,             — user/admin-scoped
 *        /ai/assistant/history, /ai/tools/run       passthrough (requireAuth
 *                                                   siblings from the same
 *                                                   cloud router), never cached.
 *   GET  /ai/health                               — liveness + config snapshot.
 *
 * Cloud contracts verified against the monolith source (never guessed):
 *   • POST /api/ai/assistant { message, history? } → JSON { ok, reply,
 *     provider, degraded, toolsUsed, memoriesUsed, traceId, quota } — NO SSE
 *     today (agent.js buffers the whole reply); the stream branch is
 *     forward-compatible.
 *   • RAG request fields: recommend { query?, limit? }, summarize
 *     { contentId }, explain { contentId, question? }, chat { contentId,
 *     message, history? } — query text = query ?? question ?? message
 *     (summarize is contentId-anchored → no L2 pre-warm).
 *   • POST /api/vector/search { query, kind?, topK? } → { ok, backend,
 *     embedProvider, dims, took, data: [...] } (public, topK clamped 1..24).
 *   • GET /api/ai/cloud/status embeds a per-caller quota snapshot → cached
 *     copies are never served to authorized callers.
 *
 * Responses are tagged 'x-edge-ai': hit | miss | stream | bypass-auth |
 * passthrough. Zero runtime dependencies; Cloudflare Workers (ES2022).
 */

import { jsonOk, jsonError, withSecurityHeaders, withCors, readJsonBody, isAuthorized } from '../../shared/http';
import { upstreamFetch, buildForwardedHeaders } from '../../shared/upstream';
import { loadEdgeConfig } from '../../shared/config';
import { sha256Hex } from '../../shared/jwt';
import { cachedJsonFetch, edgeCacheApi } from '../../shared/cache';
import { withMetrics } from '../../shared/metrics'; // FAZA 9 ops
import { TENANT_HEADER, resolveTenantOf, tenantKeyPrefix } from '../../shared/tenant'; // FAZA 11 multi-tenant
import { SHARD_HEADER, resolveShardOf, shardKeySegment } from '../../shared/shard'; // FAZA 13 shard-aware edge
import type { EdgeEnv, EdgeCtx, EdgeWorker, KvLike } from '../../shared/types';

/* ------------------------------------------------------------- constants ---- */

const AI_TIMEOUT_MS = 120_000;      // LLM calls are slow — generous upstream budget
const VECTOR_TIMEOUT_MS = 30_000;   // embedding / retrieval calls
const RAG_PREWARM_TOP_K = 18;       // mirrors runRag's retrieve default (topK 18)
const EMBEDDINGS_DEFAULT_TOP_K = 8; // mirrors /api/vector/search default
const EMBEDDINGS_MAX_TEXT = 600;    // the cloud embeds String(query).slice(0, 600)

const RAG_PATHS = new Set(['/ai/rag/chat', '/ai/rag/recommend', '/ai/rag/summarize', '/ai/rag/explain']);

/** requireAuth / requireAdmin siblings from the cloud aicloud router. */
const USER_SCOPED_PATHS = new Set(['/ai/assistant/history', '/ai/tools/run']);
const USER_SCOPED_PREFIXES = ['/ai/personal/', '/ai/admin/'];

/* --------------------------------------------------------------- helpers ---- */

/** Copy a response, tagging it with the edge-AI cache verdict. */
function tagAi(response: Response, state: string): Response {
  const headers = new Headers(response.headers);
  headers.set('x-edge-ai', state);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** Rebuild a stored JSON cache value as a 200 response. */
function cachedJsonResponse(text: string): Response {
  return new Response(text, { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

/** Rebuild an upstream response whose body was already buffered via .text(). */
function bufferedResponse(text: string, upstream: Response): Response {
  return new Response(text, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: new Headers(upstream.headers),
  });
}

/** Pass an upstream response through untouched (streaming body). */
function passThroughResponse(upstream: Response): Response {
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: new Headers(upstream.headers),
  });
}

/** KV read that treats hiccups as a cache miss. */
async function safeGet(kv: KvLike, key: string): Promise<string | null> {
  try {
    return await kv.get(key);
  } catch {
    return null;
  }
}

/** Buffer the request body once: raw bytes for the upstream call + parsed JSON. */
async function readBody(request: Request): Promise<{ raw: ArrayBuffer; parsed: Record<string, unknown> | null }> {
  const raw = await request.clone().arrayBuffer();
  const parsed = await readJsonBody(request);
  return { raw, parsed };
}

/** The cloud vector/search contract clamps topK into 1..24. */
function clampTopK(value: unknown, fallback: number): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(24, Math.max(1, n));
}

/**
 * Query text driving the L2 retrieval pre-warm — the exact fields the cloud
 * RAG router reads: recommend→query, explain→question, chat→message
 * (summarize is contentId-anchored and carries no query text).
 */
function extractQueryText(body: Record<string, unknown>): string {
  const candidate = body.query ?? body.question ?? body.message;
  return typeof candidate === 'string' ? candidate.trim().slice(0, EMBEDDINGS_MAX_TEXT) : '';
}

function isJsonContentType(contentType: string): boolean {
  return contentType.includes('json');
}

function isEventStreamContentType(contentType: string): boolean {
  return contentType.includes('text/event-stream');
}

/* ------------------------------------------------ POST /ai/assistant -------- */

/**
 * Assistant passthrough with optional whole-answer caching. The cloud today
 * returns buffered JSON (agent.js); if it ever switches to SSE, the stream is
 * proxied unbuffered and never cached. Only anonymous requests participate
 * in the answer cache — the cloud /assistant is requireAuth + per-user
 * memory, so authorized answers are strictly passthrough.
 */
async function handleAssistant(
  request: Request,
  env: EdgeEnv,
  ctx: EdgeCtx,
  url: URL,
  tenant: string,
  shard: number, // FAZA 13
): Promise<Response> {
  const cfg = await loadEdgeConfig(env);
  const { raw, parsed } = await readBody(request);
  const kv = env.EMBEDDINGS_CACHE;
  const authorized = isAuthorized(request);

  const cacheable = cfg.ai.cacheStreaming && !authorized && kv !== undefined && parsed !== null;

  let key: string | null = null;
  if (cacheable && kv) {
    // FAZA 11: answer caches are tenant-scoped (global keeps the legacy key).
    // FAZA 13: + shard segment right after the tenant prefix (s<shard>:).
    key = `${tenantKeyPrefix(tenant)}${shardKeySegment(shard)}ans:assistant:${await sha256Hex(JSON.stringify(parsed))}`;
    const hit = await safeGet(kv, key);
    if (hit !== null) return tagAi(cachedJsonResponse(hit), 'hit');
  }

  const upstream = await upstreamFetch({
    env, kind: 'ai', path: '/ai/assistant', search: url.search, method: 'POST',
    headers: buildForwardedHeaders(request, { [TENANT_HEADER]: tenant, [SHARD_HEADER]: String(shard) }), body: raw, timeoutMs: AI_TIMEOUT_MS,
  });

  const contentType = upstream.headers.get('content-type') || '';
  if (isEventStreamContentType(contentType)) {
    return tagAi(passThroughResponse(upstream), 'stream');
  }

  if (key && kv && upstream.status >= 200 && upstream.status < 300 && isJsonContentType(contentType)) {
    const text = await upstream.text();
    ctx.waitUntil(
      kv.put(key, text, { expirationTtl: Math.max(60, cfg.ai.ragAnswerTtlSec) }).catch(() => undefined),
    );
    return tagAi(bufferedResponse(text, upstream), 'miss');
  }

  return tagAi(passThroughResponse(upstream), authorized ? 'bypass-auth' : 'passthrough');
}

/* ------------------------------------------- POST /ai/rag/{chat,…} ---------- */

/**
 * RAG endpoints with the two-level edge acceleration:
 *   L1 hit  → cached answer served ('hit')
 *   L1 miss → cloud passthrough (120s), answer stored + L2 retrieval pre-warm
 * Authorized requests bypass both levels ('bypass-auth') — rag answers embed
 * the caller's taste profile / match score.
 */
async function handleRag(
  request: Request,
  env: EdgeEnv,
  ctx: EdgeCtx,
  url: URL,
  path: string,
  tenant: string,
  shard: number, // FAZA 13
): Promise<Response> {
  const cfg = await loadEdgeConfig(env);
  const { raw, parsed } = await readBody(request);
  const kv = env.EMBEDDINGS_CACHE;
  const authorized = isAuthorized(request);

  if (!authorized && kv && parsed) {
    // Level 1 — anonymous answer cache (FAZA 11: tenant-scoped key,
    // FAZA 13: + shard segment right after the tenant prefix).
    const key = `${tenantKeyPrefix(tenant)}${shardKeySegment(shard)}ans:rag:${await sha256Hex(`${path}\n${JSON.stringify(parsed)}`)}`;
    const hit = await safeGet(kv, key);
    if (hit !== null) return tagAi(cachedJsonResponse(hit), 'hit');

    const upstream = await upstreamFetch({
      env, kind: 'ai', path, search: url.search, method: 'POST',
      headers: buildForwardedHeaders(request, { [TENANT_HEADER]: tenant, [SHARD_HEADER]: String(shard) }), body: raw, timeoutMs: AI_TIMEOUT_MS,
    });

    const contentType = upstream.headers.get('content-type') || '';
    if (isEventStreamContentType(contentType)) {
      return tagAi(passThroughResponse(upstream), 'stream');
    }
    if (upstream.status >= 200 && upstream.status < 300) {
      const text = await upstream.text();
      const queryText = extractQueryText(parsed);
      // L1 store + L2 retrieval pre-warm, best-effort in the background.
      ctx.waitUntil(storeRagAnswer(env, kv, key, text, queryText, cfg.ai.ragAnswerTtlSec, cfg.ai.embeddingsTtlSec, tenant, shard));
      return tagAi(bufferedResponse(text, upstream), 'miss');
    }
    return tagAi(passThroughResponse(upstream), 'passthrough');
  }

  // Authorized (user-scoped answers) or no cache binding → untouched passthrough.
  const upstream = await upstreamFetch({
    env, kind: 'ai', path, search: url.search, method: 'POST',
    headers: buildForwardedHeaders(request, { [TENANT_HEADER]: tenant, [SHARD_HEADER]: String(shard) }), body: raw, timeoutMs: AI_TIMEOUT_MS,
  });
  const contentType = upstream.headers.get('content-type') || '';
  if (isEventStreamContentType(contentType)) {
    return tagAi(passThroughResponse(upstream), 'stream');
  }
  return tagAi(passThroughResponse(upstream), authorized ? 'bypass-auth' : 'passthrough');
}

/**
 * Persist the RAG answer (L1) and pre-warm the retrieval result (L2): POST
 * /api/vector/search { query, kind: 'content', topK 18 } — the same call the
 * cloud RAG retrieve step makes — stored under emb:vec:<sha256(queryText)>.
 * Runs inside ctx.waitUntil; never throws.
 */
async function storeRagAnswer(
  env: EdgeEnv,
  kv: KvLike,
  answerKey: string,
  answerText: string,
  queryText: string,
  answerTtlSec: number,
  embeddingsTtlSec: number,
  tenant: string, // FAZA 11 — scopes the L2 pre-warm key
  shard: number, // FAZA 13 — scopes the L2 pre-warm key
): Promise<void> {
  await kv.put(answerKey, answerText, { expirationTtl: Math.max(60, answerTtlSec) }).catch(() => undefined);
  if (!queryText) return; // summarize mode has no query text — nothing to pre-warm
  try {
    const res = await upstreamFetch({
      env, kind: 'vector', path: '/vector/search', method: 'POST',
      headers: new Headers({ 'content-type': 'application/json', [SHARD_HEADER]: String(shard) }),
      body: JSON.stringify({ query: queryText, kind: 'content', topK: RAG_PREWARM_TOP_K }),
      timeoutMs: VECTOR_TIMEOUT_MS,
    });
    if (res.status >= 200 && res.status < 300) {
      const text = await res.text();
      await kv
        .put(`${tenantKeyPrefix(tenant)}${shardKeySegment(shard)}emb:vec:${await sha256Hex(queryText)}`, text, { expirationTtl: Math.max(60, embeddingsTtlSec) })
        .catch(() => undefined);
    }
  } catch {
    /* best-effort pre-warm — the next request simply recomputes */
  }
}

/* ------------------------------------------------- POST /ai/embeddings ------ */

/**
 * Explicit retrieval endpoint: /api/vector/search for a text query, cached
 * under emb:vec:<sha256(text)>. Public data (kind 'content'), so caching is
 * independent of Authorization.
 */
async function handleEmbeddings(request: Request, env: EdgeEnv, ctx: EdgeCtx, tenant: string, shard: number): Promise<Response> {
  const cfg = await loadEdgeConfig(env);
  const body = await readJsonBody(request);
  if (!body || typeof body.text !== 'string' || !body.text.trim()) {
    return jsonError(400, 'invalid_text', 'body must be { text: string, topK?: number }');
  }
  const text = body.text.trim().slice(0, EMBEDDINGS_MAX_TEXT);
  const topK = clampTopK(body.topK, EMBEDDINGS_DEFAULT_TOP_K);
  const kv = env.EMBEDDINGS_CACHE;
  // FAZA 11: tenant-scoped; FAZA 13: + shard segment after the tenant prefix.
  const key = `${tenantKeyPrefix(tenant)}${shardKeySegment(shard)}emb:vec:${await sha256Hex(text)}`;

  if (kv) {
    const hit = await safeGet(kv, key);
    if (hit !== null) return tagAi(cachedJsonResponse(hit), 'hit');
  }

  const res = await upstreamFetch({
    env, kind: 'vector', path: '/vector/search', method: 'POST',
    headers: new Headers({ 'content-type': 'application/json', [SHARD_HEADER]: String(shard) }),
    body: JSON.stringify({ query: text, kind: 'content', topK }),
    timeoutMs: VECTOR_TIMEOUT_MS,
  });
  if (res.status >= 200 && res.status < 300) {
    const payloadText = await res.text();
    if (kv) {
      ctx.waitUntil(kv.put(key, payloadText, { expirationTtl: Math.max(60, cfg.ai.embeddingsTtlSec) }).catch(() => undefined));
    }
    return tagAi(bufferedResponse(payloadText, res), 'miss');
  }
  return tagAi(passThroughResponse(res), 'passthrough');
}

/* ------------------------------ GET /ai/cloud/status, /ai/tools ------------ */

/**
 * Public GET endpoints through the SWR/stale-if-error cache (shared/cache.ts,
 * key ai:<path>). Authorized callers bypass the cache: /api/ai/cloud/status
 * embeds a per-caller quota snapshot that must not be cross-served.
 */
async function handleCachedGet(
  request: Request,
  env: EdgeEnv,
  ctx: EdgeCtx,
  url: URL,
  path: string,
  tenant: string,
  shard: number, // FAZA 13
): Promise<Response> {
  if (isAuthorized(request)) {
    const res = await upstreamFetch({
      env, kind: 'ai', path, search: url.search, method: 'GET',
      headers: buildForwardedHeaders(request, { [TENANT_HEADER]: tenant, [SHARD_HEADER]: String(shard) }),
    });
    return tagAi(passThroughResponse(res), 'bypass-auth');
  }
  return cachedJsonFetch({
    env,
    ctx,
    // FAZA 11: tenant-scoped; FAZA 13: + shard segment after the tenant prefix.
    key: `${tenantKeyPrefix(tenant)}${shardKeySegment(shard)}ai:${path}`,
    fetchUpstream: () => upstreamFetch({
      env, kind: 'ai', path, search: url.search, method: 'GET',
      headers: buildForwardedHeaders(request, { [TENANT_HEADER]: tenant, [SHARD_HEADER]: String(shard) }),
    }),
    opts: { ttlSec: 60, swrSec: 300, staleIfErrorSec: 900 },
    cacheApi: edgeCacheApi(),
  });
}

/* --------------------------------------------------- user-scoped proxy ------ */

/**
 * Passthrough for user/admin-scoped cloud endpoints (never cached):
 * /ai/personal/*, /ai/admin/* and the requireAuth siblings
 * /ai/assistant/history + /ai/tools/run from the same cloud router.
 */
async function handlePassthrough(
  request: Request,
  env: EdgeEnv,
  url: URL,
  path: string,
  tenant: string,
  shard: number, // FAZA 13
): Promise<Response> {
  const method = request.method.toUpperCase();
  const raw = method === 'GET' || method === 'HEAD' ? null : await request.arrayBuffer();
  const res = await upstreamFetch({
    env, kind: 'ai', path, search: url.search, method,
    headers: buildForwardedHeaders(request, { [TENANT_HEADER]: tenant, [SHARD_HEADER]: String(shard) }), body: raw, timeoutMs: AI_TIMEOUT_MS,
  });
  return tagAi(passThroughResponse(res), 'passthrough');
}

/* --------------------------------------------------------------- health ----- */

async function handleHealth(env: EdgeEnv): Promise<Response> {
  const cfg = await loadEdgeConfig(env);
  return jsonOk({
    ok: true,
    worker: 'animaxia-edge-ai',
    embeddingsCache: Boolean(env.EMBEDDINGS_CACHE),
    cacheStreaming: cfg.ai.cacheStreaming,
    multiTenant: true, // FAZA 11: tenant-scoped answer/embeddings caches
  });
}

/* --------------------------------------------------------------- router ----- */

async function handleFetch(request: Request, env: EdgeEnv, ctx: EdgeCtx): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();
  // FAZA 11: resolve the tenant once per request (X-Animaxia-Tenant → JWT
  // claim → 'global'); scopes every cache key + forwards to the origin.
  const tenant = await resolveTenantOf(request, env);
  // FAZA 13: resolve the shard the same way (valid client header override >
  // tenant > content path > 0) — scopes every cache key + rides upstream.
  const shard = resolveShardOf(request, tenant, env);

  let response: Response;
  try {
    if (method === 'GET' && path === '/ai/health') {
      response = await handleHealth(env);
    } else if (method === 'POST' && path === '/ai/assistant') {
      response = await handleAssistant(request, env, ctx, url, tenant, shard);
    } else if (method === 'POST' && RAG_PATHS.has(path)) {
      response = await handleRag(request, env, ctx, url, path, tenant, shard);
    } else if (method === 'POST' && path === '/ai/embeddings') {
      response = await handleEmbeddings(request, env, ctx, tenant, shard);
    } else if (method === 'GET' && (path === '/ai/cloud/status' || path === '/ai/tools')) {
      response = await handleCachedGet(request, env, ctx, url, path, tenant, shard);
    } else if (USER_SCOPED_PREFIXES.some((prefix) => path.startsWith(prefix)) || USER_SCOPED_PATHS.has(path)) {
      response = await handlePassthrough(request, env, url, path, tenant, shard);
    } else {
      response = jsonError(404, 'not_found', `no AI route for ${method} ${path}`);
    }
  } catch (err) {
    response = jsonError(500, 'edge_error', String((err as Error)?.message ?? err));
  }
  return withCors(withSecurityHeaders(response), request);
}

const worker: EdgeWorker = {
  fetch: withMetrics('ai', handleFetch), // FAZA 9 ops: /metrics + request counters
};

export default worker;
