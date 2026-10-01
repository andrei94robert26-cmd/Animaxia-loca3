/**
 * api/client.ts — The single HTTP core every api/* module goes through.
 *
 * Responsibilities:
 *   • absolute URL assembly (apiUrl() base + query string)
 *   • Bearer access-token injection (15-min JWT from /api/auth/*)
 *   • automatic token refresh on 401 — SINGLE-FLIGHT: concurrent requests
 *     that hit 401 share one /api/auth/refresh call (rotating refresh tokens
 *     would otherwise be burned by parallel refreshes)
 *   • one retry of the original request after a successful refresh
 *   • AbortController timeouts (15s — matches the gateway upstream timeout)
 *   • typed ApiError with { status, code, upgrade, body } so screens can
 *     branch on 401 (sign in), 402 (upgrade), 429 (slow down)
 *   • a tiny auth-change event bus so AuthContext re-syncs after a
 *     client-side refresh or a forced logout
 *
 * Token persistence itself lives in auth/tokenStore.ts (localStorage).
 */

import { apiUrl, REQUEST_TIMEOUT_MS } from './config';
import { getAccessToken, getRefreshToken, saveSession, clearAll, type StoredSession } from '../auth/tokenStore';

/* --------------------------------- errors ---------------------------------- */

export class ApiError extends Error {
  status: number;
  /** Machine code from the backend (AUTH_REQUIRED, ADMIN_REQUIRED, …). */
  code: string | null;
  /** true on 402 quota responses — the UI links to the Premium screen. */
  upgrade: boolean;
  /** Raw JSON body when present. */
  body: Record<string, unknown> | null;

  constructor(
    message: string,
    status: number,
    opts: { code?: string | null; upgrade?: boolean; body?: Record<string, unknown> | null } = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = opts.code ?? null;
    this.upgrade = Boolean(opts.upgrade);
    this.body = opts.body ?? null;
  }
}

export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError;
}

/** Human message for any thrown value. */
export function errorMessage(err: unknown): string {
  if (isApiError(err)) {
    if (err.status === 0) return 'Cannot reach Animaxia — check your connection';
    return err.message;
  }
  if (err instanceof Error) return err.message;
  return 'Something went wrong';
}

/* --------------------------------- options --------------------------------- */

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | null | undefined>;
  /** false for /api/auth/* (no Authorization header, no refresh retry). */
  auth?: boolean;
  timeoutMs?: number;
}

/** Auth endpoints never trigger the refresh-retry loop (they issue sessions). */
const AUTH_PATHS = new Set([
  '/api/auth/login',
  '/api/auth/register',
  '/api/auth/refresh',
  '/api/auth/logout',
  '/api/auth/forgot-password',
  '/api/auth/reset-password',
]);

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const base = `${apiUrl()}${path.startsWith('/') ? path : `/${path}`}`;
  if (!query) return base;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) params.append(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

/* ----------------------------- auth event bus ------------------------------- */

export type AuthEvent = 'session' | 'logout';
type Listener = (event: AuthEvent) => void;
const listeners = new Set<Listener>();

function emitAuth(event: AuthEvent): void {
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch {
      /* broken listeners must not break the bus */
    }
  }
}

export function onAuthChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/* ------------------------------- raw request -------------------------------- */

async function rawRequest<T>(url: string, options: RequestOptions, token: string | null): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method: options.method ?? 'GET',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
  } catch {
    throw new ApiError('Cannot reach Animaxia — check your connection', 0);
  } finally {
    clearTimeout(timer);
  }

  let body: unknown = null;
  const text = await res.text().catch(() => '');
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }

  if (!res.ok) {
    const record = (body && typeof body === 'object' ? (body as Record<string, unknown>) : null) ?? null;
    throw new ApiError(
      (record && typeof record.error === 'string' && record.error) || `Request failed (${res.status})`,
      res.status,
      {
        code: record && typeof record.code === 'string' ? record.code : null,
        upgrade: Boolean(record?.upgrade),
        body: record,
      },
    );
  }
  return body as T;
}

/* --------------------------- refresh (single-flight) ------------------------- */

let refreshInFlight: Promise<string | null> | null = null;

/**
 * Rotate the session via POST /api/auth/refresh. Concurrent callers share one
 * in-flight promise — a rotating refresh token can only be used once.
 * @returns the fresh access token, or null when the session is gone (cleared).
 */
export async function refreshSession(): Promise<string | null> {
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      const refreshToken = await getRefreshToken();
      if (!refreshToken) return null;
      try {
        // NOTE: direct rawRequest — no auth header, no re-entry into refresh.
        const session = await rawRequest<StoredSession & { ok: boolean }>(
          buildUrl('/api/auth/refresh'),
          { method: 'POST', body: { refreshToken } },
          null,
        );
        await saveSession({
          accessToken: session.accessToken,
          refreshToken: session.refreshToken,
          expiresIn: session.expiresIn,
        });
        emitAuth('session');
        return session.accessToken;
      } catch {
        await clearAll();
        emitAuth('logout');
        return null;
      } finally {
        refreshInFlight = null;
      }
    })();
  }
  return refreshInFlight;
}

/* --------------------------------- request ---------------------------------- */

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const wantsAuth = options.auth !== false;
  const url = buildUrl(path, options.query);
  let token = wantsAuth ? await getAccessToken() : null;

  try {
    return await rawRequest<T>(url, options, token);
  } catch (err) {
    const retriable =
      isApiError(err) &&
      err.status === 401 &&
      wantsAuth &&
      token !== null &&
      !AUTH_PATHS.has(path);
    if (!retriable) throw err;

    // 401 with a stored session → one silent refresh + one retry.
    const fresh = await refreshSession();
    if (!fresh) throw err;
    return await rawRequest<T>(url, options, fresh);
  }
}
