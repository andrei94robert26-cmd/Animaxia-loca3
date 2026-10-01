/**
 * shared/upstream.ts — origin resolution + hardened upstream fetch.
 *
 *   • originFor(env, kind) maps /api /ai /vector /mobile /ws prefixes to
 *     their configured origins (per-service override → CLOUD_ORIGIN →
 *     http://127.0.0.1:4000), applying the documented path rewrites:
 *         /ai/*     → ${origin}/api/ai/*
 *         /vector/* → ${origin}/api/vector/*
 *         /mobile/* → ${origin}/api/mobile/*
 *         /api/*    → ${origin}/api/*   (unchanged)
 *   • upstreamFetch() adds: timeout (AbortSignal), one retry on network
 *     errors or 502/503/504, no-store subrequests, forwarded identity
 *     headers (x-forwarded-for / proto / request id).
 */

import type { EdgeEnv } from './types';
import { clientIpOf, requestIdOf } from './http';

export type OriginKind = 'cloud' | 'ai' | 'vector' | 'mobile' | 'ws';

const DEFAULT_CLOUD = 'http://127.0.0.1:4000';

function trimBase(base: string | undefined, fallback: string): string {
  const v = (base && base.trim()) || fallback;
  return v.replace(/\/+$/, '');
}

/** Resolve the origin base URL for a service kind. */
export function originFor(env: EdgeEnv, kind: OriginKind): string {
  const cloud = trimBase(env.CLOUD_ORIGIN, DEFAULT_CLOUD);
  switch (kind) {
    case 'cloud': return cloud;
    case 'ai': return trimBase(env.AI_ORIGIN, cloud);
    case 'vector': return trimBase(env.VECTOR_ORIGIN, cloud);
    case 'mobile': return trimBase(env.MOBILE_ORIGIN, cloud);
    case 'ws': return trimBase(env.WS_ORIGIN, cloud).replace(/^http/, 'ws');
  }
}

/**
 * Map an inbound edge path to its upstream path:
 *   /api/x      → /api/x            (cloud gateway, unchanged)
 *   /ai/x       → /api/ai/x         (ai-service)
 *   /vector/x   → /api/vector/x     (vector-service)
 *   /mobile/x   → /api/mobile/x     (mobile-service)
 */
export function upstreamPathFor(kind: OriginKind, path: string): string {
  switch (kind) {
    case 'ai': return path.startsWith('/ai') ? `/api/ai${path.slice(3)}` : `/api/ai${path}`;
    case 'vector': return path.startsWith('/vector') ? `/api/vector${path.slice(7)}` : `/api/vector${path}`;
    case 'mobile': return path.startsWith('/mobile') ? `/api/mobile${path.slice(7)}` : `/api/mobile${path}`;
    default: return path;
  }
}

/** Headers forwarded to the origin (hop-by-hop + CF-injected stripped). */
export function buildForwardedHeaders(request: Request, extra: Record<string, string> = {}): Headers {
  const headers = new Headers();
  const skip = new Set([
    'host', 'cf-connecting-ip', 'cf-ipcountry', 'cf-ray', 'cf-visitor',
    'cdn-loop', 'x-forwarded-for', 'x-forwarded-proto',
  ]);
  for (const [name, value] of request.headers.entries()) {
    if (skip.has(name)) continue;
    headers.set(name, value);
  }
  const ip = clientIpOf(request);
  if (ip) headers.set('x-forwarded-for', ip);
  headers.set('x-forwarded-proto', 'https');
  headers.set('x-animaxia-edge', '1');
  headers.set('x-request-id', requestIdOf(request));
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return headers;
}

const RETRYABLE_STATUS = new Set([502, 503, 504]);

export interface UpstreamArgs {
  env: EdgeEnv;
  kind: OriginKind;
  path: string;            // inbound edge path (rewritten via upstreamPathFor)
  search?: string;         // query string incl. '?', preserved
  method?: string;
  headers?: Headers;       // already-forwarded headers (buildForwardedHeaders)
  body?: ArrayBuffer | string | null;
  timeoutMs?: number;      // default 15s
  retries?: number;        // default 1 (on network error / 502/503/504)
  cacheOverrideNoStore?: boolean;
}

/**
 * Fetch the upstream service with timeout + retry. Never throws for network
 * failures — returns a 502 Response so callers can apply stale-if-error.
 */
export async function upstreamFetch(args: UpstreamArgs): Promise<Response> {
  const {
    env, kind, path, search = '', method = 'GET', headers, body,
    timeoutMs = 15_000, retries = 1,
  } = args;

  const base = originFor(env, kind);
  const upstreamPath = upstreamPathFor(kind, path);
  const url = `${base}${upstreamPath}${search}`;

  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const init: RequestInit = {
        method,
        headers: headers || new Headers(),
        redirect: 'manual',
      };
      if (body && method !== 'GET' && method !== 'HEAD') init.body = body;
      if (timeoutMs > 0) init.signal = AbortSignal.timeout(timeoutMs);
      const res = await fetch(url, init);
      if (RETRYABLE_STATUS.has(res.status) && attempt < retries) {
        continue; // one more try
      }
      return res;
    } catch (err) {
      lastError = err as Error;
      if (attempt >= retries) break;
    }
  }

  return new Response(JSON.stringify({
    error: 'edge_upstream_unavailable',
    message: `Cannot reach ${kind} upstream at ${url}`,
    detail: lastError ? String(lastError.message ?? lastError) : null,
  }), { status: 502, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

/** True when the URL's host is on the player segment allowlist. */
export function hostAllowed(url: URL, allowHosts: string[]): boolean {
  const host = url.hostname.toLowerCase();
  return allowHosts.some((h) => host === h.toLowerCase() || host.endsWith(`.${h.toLowerCase()}`));
}
