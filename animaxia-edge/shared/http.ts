/**
 * shared/http.ts — response helpers, CORS, security headers, request
 * identification. Used by every edge worker so all responses share the
 * same hardening profile (nosniff, referrer policy, no fingerprinting).
 */

export function jsonOk(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { 'content-type': 'application/json; charset=utf-8', ...(init.headers || {}) },
  });
}

export function jsonError(status: number, code: string, message: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error: code, message, ...extra }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

/** Copy a response with hardened headers; strips fingerprinting headers. */
export function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', 'strict-origin-when-cross-origin');
  headers.delete('server');
  headers.delete('x-powered-by');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'access-control-allow-headers': 'content-type,authorization,x-animaxia-device,x-request-id,x-trace-id',
  'access-control-max-age': '86400',
};

/** Attach CORS headers; short-circuits OPTIONS preflights with 204. */
export function withCors(response: Response, request: Request): Response {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** Client IP: Cloudflare injects cf-connecting-ip; harness sets it directly. */
export function clientIpOf(request: Request): string {
  return request.headers.get('cf-connecting-ip')
    || request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || '127.0.0.1';
}

/** Stable request id: inbound x-request-id or a fresh edge id. */
export function requestIdOf(request: Request): string {
  return request.headers.get('x-request-id') || `edge-${crypto.randomUUID()}`;
}

/** Trace propagation headers added to upstream calls + responses. */
export function traceHeaders(request: Request): Record<string, string> {
  const h: Record<string, string> = { 'x-request-id': requestIdOf(request) };
  const trace = request.headers.get('x-trace-id');
  if (trace) h['x-trace-id'] = trace;
  return h;
}

/** True when the request carries an Authorization header. */
export function isAuthorized(request: Request): boolean {
  return request.headers.has('authorization');
}

/** Read + bound a JSON request body (≤ maxBytes). Returns null on bad input. */
export async function readJsonBody(request: Request, maxBytes = 512 * 1024): Promise<Record<string, unknown> | null> {
  try {
    const text = await request.text();
    if (text.length > maxBytes) return null;
    if (!text) return {};
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function statusText(state: string): string {
  return `edge:${state}`;
}

/**
 * Internal/admin auth for edge management endpoints (/edge/*, /search/refresh,
 * /cron/run/*, /analytics/flush-log): accepts either the EDGE_ADMIN_JWT as a
 * Bearer token or the EDGE_INTERNAL_TOKEN via the x-internal-token header.
 * Constant-time-ish comparison; always false when no secret is configured.
 */
export function requireInternalAuth(request: Request, env: { EDGE_ADMIN_JWT?: string; EDGE_INTERNAL_TOKEN?: string }): boolean {
  const bearer = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  const internal = request.headers.get('x-internal-token')?.trim();
  const adminSecret = env.EDGE_ADMIN_JWT?.trim();
  const internalSecret = env.EDGE_INTERNAL_TOKEN?.trim();

  if (adminSecret && bearer && safeEqual(bearer, adminSecret)) return true;
  if (internalSecret && internal && safeEqual(internal, internalSecret)) return true;
  return false;
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
