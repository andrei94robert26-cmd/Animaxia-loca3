/**
 * shared/cache.ts — edge response cache with the full FAZA 8 semantics:
 *
 *   • fresh window (config.edge.cacheTtlSec, default 60s)  → HIT
 *   • stale-while-revalidate (edge.swrSec, default 600s)   → STALE is served
 *     immediately while a background revalidation runs (ctx.waitUntil)
 *   • stale-if-error (edge.staleIfErrorSec, default 24h)   → STALE-ERROR is
 *     served when the origin errors or times out
 *
 * Two stores, fastest first:
 *   L1 — Workers Cache API (caches.default), colo-local, TTL via the
 *        response Cache-Control header, keyed by a synthetic URL.
 *   L2 — KV (EDGE_CACHE binding), the source of truth for SWR/SIE windows
 *        (CacheRecord JSON, base64 body — JSON APIs only, bounded size).
 *
 * Responses are tagged X-Edge-Cache: HIT | MISS | STALE | STALE-ERROR |
 * BYPASS | DISABLED plus X-Edge-Age seconds. Never cache requests carrying
 * Authorization (callers must skip those) or non-2xx bodies.
 */

import type { EdgeEnv, EdgeCtx, CacheRecord } from './types';

const KV_PREFIX = 'cache:';
const L1_ORIGIN = 'https://edge-cache.animaxia.internal';
const MAX_CACHEABLE_BYTES = 2 * 1024 * 1024; // 2 MB body cap for the KV tier

/**
 * Access the Workers Cache API (caches.default) when running on Cloudflare.
 * Returns undefined under bun/local tests — callers pass it as
 * `cacheApi` (the harness injects CacheApiStub instead). Never throws.
 */
export function edgeCacheApi(): CacheApiLike | undefined {
  try {
    const g = globalThis as unknown as { caches?: { default?: unknown } };
    if (g.caches && g.caches.default) {
      const c = g.caches.default as { match(r: Request | string): Promise<Response | null>; put(r: Request | string, res: Response): Promise<void>; delete(r: Request | string): Promise<boolean> };
      return c;
    }
  } catch { /* not available */ }
  return undefined;
}

export interface CacheOptions {
  ttlSec: number;
  swrSec: number;
  staleIfErrorSec: number;
}

export interface CacheApiLike {
  match(r: Request | string): Promise<Response | null>;
  put(r: Request | string, res: Response): Promise<void>;
  delete(r: Request | string): Promise<boolean>;
}

export interface CachedFetchArgs {
  env: EdgeEnv;
  ctx?: EdgeCtx;
  key: string;                    // logical cache key, e.g. "api:/api/all"
  fetchUpstream: () => Promise<Response>;
  opts: CacheOptions;
  cacheApi?: CacheApiLike;        // caches.default (injectable for tests)
}

function b64encode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let raw = '';
  for (const b of bytes) raw += String.fromCharCode(b);
  return btoa(raw);
}

function b64decode(b64: string): string {
  const raw = atob(b64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function l1Request(key: string): Request {
  return new Request(`${L1_ORIGIN}/${encodeURIComponent(key)}`);
}

function tagHeaders(state: string, ageSec: number, extra?: Record<string, string>): Record<string, string> {
  return {
    'x-edge-cache': state,
    'x-edge-age': String(Math.max(0, Math.floor(ageSec))),
    ...(extra || {}),
  };
}

function rebuildFromRecord(record: CacheRecord, state: string): Response {
  const headers = new Headers();
  for (const [k, v] of Object.entries(record.headers || {})) headers.set(k, v);
  headers.set('content-type', record.contentType);
  for (const [k, v] of Object.entries(tagHeaders(state, (Date.now() - record.storedAt) / 1000))) {
    headers.set(k, v);
  }
  return new Response(b64decode(record.bodyB64), { status: record.status, headers });
}

async function storeRecord(
  args: CachedFetchArgs,
  upstream: Response,
): Promise<CacheRecord | null> {
  const ct = upstream.headers.get('content-type') || 'application/json; charset=utf-8';
  const cacheControl = (upstream.headers.get('cache-control') || '').toLowerCase();
  if (upstream.status < 200 || upstream.status >= 300) return null;
  if (/private|no-store/.test(cacheControl)) return null;

  const bodyText = await upstream.text();
  if (bodyText.length > MAX_CACHEABLE_BYTES) return null;

  const now = Date.now();
  const record: CacheRecord = {
    v: 1,
    status: upstream.status,
    contentType: ct,
    storedAt: now,
    freshUntil: now + args.opts.ttlSec * 1000,
    swrUntil: now + (args.opts.ttlSec + args.opts.swrSec) * 1000,
    sieUntil: now + (args.opts.ttlSec + args.opts.swrSec + args.opts.staleIfErrorSec) * 1000,
    bodyB64: b64encode(bodyText),
    headers: {
      etag: upstream.headers.get('etag') || '',
      'x-cache-tags': upstream.headers.get('x-cache-tags') || '',
    },
  };

  // L2 (source of truth for SWR/SIE windows).
  if (args.env.EDGE_CACHE) {
    const ttl = Math.ceil((args.opts.ttlSec + args.opts.swrSec + args.opts.staleIfErrorSec) || 60);
    await args.env.EDGE_CACHE.put(KV_PREFIX + args.key, JSON.stringify(record), {
      expirationTtl: Math.max(60, ttl),
    }).catch(() => {});
  }
  // L1 (colo-local fast path) — rebuild the upstream response for the caller
  // and put a copy with a Cache-Control TTL into the Cache API.
  if (args.cacheApi) {
    const headers = new Headers();
    headers.set('content-type', ct);
    headers.set('cache-control', `public, max-age=${Math.max(1, args.opts.ttlSec)}`);
    headers.set('date', new Date(now).toUTCString());
    const cached = new Response(bodyText, { status: upstream.status, headers });
    await args.cacheApi.put(l1Request(args.key), cached.clone()).catch(() => {});
  }

  return record;
}

/** The blocking revalidation step — always returns a usable Response. */
async function revalidate(args: CachedFetchArgs, fallbackRecord: CacheRecord | null): Promise<Response> {
  let upstream: Response | null = null;
  let failure: unknown = null;
  try {
    upstream = await args.fetchUpstream();
  } catch (err) {
    failure = err;
  }

  const upstreamFailed = !upstream || upstream.status >= 500;

  if (upstreamFailed) {
    // Origin error → stale-if-error when an old record is still inside the SIE window.
    if (fallbackRecord && Date.now() < fallbackRecord.sieUntil) {
      return rebuildFromRecord(fallbackRecord, 'STALE-ERROR');
    }
    if (upstream) return upstream; // 5xx passthrough
    return new Response(JSON.stringify({
      error: 'edge_upstream_unavailable',
      message: 'Origin is unreachable and no fresh stale copy exists.',
      detail: failure ? String((failure as Error)?.message ?? failure) : undefined,
    }), { status: 502, headers: { 'content-type': 'application/json; charset=utf-8', ...tagHeaders('STALE-ERROR', 0) } });
  }
  if (!upstream) {
    // Unreachable (defensive — upstreamFailed already handled null).
    return new Response(JSON.stringify({ error: 'edge_upstream_unavailable', message: 'Origin unreachable.' }), {
      status: 502, headers: { 'content-type': 'application/json; charset=utf-8', ...tagHeaders('STALE-ERROR', 0) },
    });
  }

  // Success → store + return fresh MISS (or HIT for callers that revalidated
  // in the background — they receive the stored copy path separately).
  const record = await storeRecord(args, upstream);
  if (!record) {
    // Not storable (non-2xx/private/oversized) — pass through untouched.
    const headers = new Headers(upstream.headers);
    for (const [k, v] of Object.entries(tagHeaders('BYPASS', 0))) headers.set(k, v);
    return new Response(upstream.body, { status: upstream.status, headers });
  }
  const headers = new Headers(upstream.headers);
  for (const [k, v] of Object.entries(tagHeaders('MISS', 0))) headers.set(k, v);
  return new Response(b64decode(record.bodyB64), { status: record.status, headers });
}

/**
 * Cached JSON fetch implementing HIT / MISS / STALE (SWR) / STALE-ERROR (SIE).
 * Callers decide cacheability (public GETs only — never Authorization).
 */
export async function cachedJsonFetch(args: CachedFetchArgs): Promise<Response> {
  const { opts } = args;
  if (opts.ttlSec <= 0) {
    const headers = new Headers();
    for (const [k, v] of Object.entries(tagHeaders('DISABLED', 0))) headers.set(k, v);
    const upstream = await args.fetchUpstream();
    const out = new Response(upstream.body, { status: upstream.status, headers: new Headers(upstream.headers) });
    for (const [k, v] of Object.entries(tagHeaders('DISABLED', 0))) out.headers.set(k, v);
    return out;
  }

  const now = Date.now();

  // L1 fast path — Cache API hit inside the fresh window.
  if (args.cacheApi) {
    const hit = await args.cacheApi.match(l1Request(args.key)).catch(() => null);
    if (hit) {
      const storedAt = hit.headers.get('date') ? Date.parse(hit.headers.get('date') as string) : 0;
      const ageSec = storedAt ? (now - storedAt) / 1000 : 0;
      if (ageSec < opts.ttlSec) {
        const headers = new Headers(hit.headers);
        for (const [k, v] of Object.entries(tagHeaders('HIT', ageSec))) headers.set(k, v);
        return new Response(hit.body, { status: hit.status, headers });
      }
      await args.cacheApi.delete(l1Request(args.key)).catch(() => {});
    }
  }

  // L2 — KV record drives SWR / SIE decisions.
  let record: CacheRecord | null = null;
  if (args.env.EDGE_CACHE) {
    try {
      const raw = await args.env.EDGE_CACHE.get(KV_PREFIX + args.key);
      if (raw) record = JSON.parse(raw) as CacheRecord;
    } catch { /* KV hiccup → treat as miss */ }
  }

  if (record) {
    if (now < record.freshUntil) {
      return rebuildFromRecord(record, 'HIT');
    }
    if (now < record.swrUntil) {
      // Serve stale immediately; revalidate in the background.
      if (args.ctx) {
        args.ctx.waitUntil(revalidate(args, record).then(() => undefined).catch(() => undefined));
      }
      return rebuildFromRecord(record, 'STALE');
    }
    // Beyond SWR → blocking revalidation (which knows about SIE fallback).
    return revalidate(args, record);
  }

  return revalidate(args, null);
}

/** Invalidate a cache key (admin / write-through hooks). */
export async function cacheInvalidate(env: EdgeEnv, key: string): Promise<void> {
  if (!env.EDGE_CACHE) return;
  await env.EDGE_CACHE.delete(KV_PREFIX + key).catch(() => {});
}

/** Purge every cached key with a prefix. Returns the deleted count. */
export async function cachePurgePrefix(env: EdgeEnv, prefix: string, limit = 500): Promise<number> {
  if (!env.EDGE_CACHE) return 0;
  let deleted = 0;
  try {
    const list = await env.EDGE_CACHE.list({ prefix: KV_PREFIX + prefix, limit });
    for (const k of list.keys) {
      await env.EDGE_CACHE.delete(k.name).catch(() => {});
      deleted += 1;
    }
  } catch { /* best-effort */ }
  return deleted;
}
