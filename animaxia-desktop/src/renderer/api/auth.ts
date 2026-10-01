/**
 * api/auth.ts — /api/auth/* client.
 *
 *   POST /register         { email, username, password } → { ok, user, …session }
 *   POST /login            { email, password }           → { ok, user, …session }
 *   POST /refresh          { refreshToken }              → { ok, …session }   (used by client.ts)
 *   POST /logout           { refreshToken }              → { ok, revoked }
 *   GET  /me                                             → { user, stats }
 *   POST /forgot-password  { email }                     → { ok, sandbox, code? }
 *   POST /reset-password   { email, code, newPassword }  → { ok }
 *
 * The session contract: { accessToken (15 min), refreshToken (rotating, 30d),
 * expiresIn }. Every login/register persists the session + user snapshot via
 * tokenStore.saveSession.
 */

import { request } from './client';
import { clearAll, getRefreshToken, saveSession } from '../auth/tokenStore';
import type { SessionUser, StoredSession } from '../auth/tokenStore';

export interface AuthStats {
  watchlist: number;
  history: number;
  comments: number;
}

export interface LoginResponse extends StoredSession {
  ok: boolean;
  user: SessionUser;
}

export interface MeResponse {
  user: SessionUser;
  stats: AuthStats;
}

/** Password login. Persists session + user snapshot, returns the user. */
export async function login(email: string, password: string): Promise<SessionUser> {
  const res = await request<LoginResponse>('/api/auth/login', {
    method: 'POST',
    auth: false,
    body: { email: email.trim().toLowerCase(), password },
  });
  await saveSession(
    { accessToken: res.accessToken, refreshToken: res.refreshToken, expiresIn: res.expiresIn },
    res.user,
  );
  return res.user;
}

/** Account creation (password ≥ 8 chars, username 3–24 [a-zA-Z0-9._-]). */
export async function register(email: string, username: string, password: string): Promise<SessionUser> {
  const res = await request<LoginResponse>('/api/auth/register', {
    method: 'POST',
    auth: false,
    body: { email: email.trim().toLowerCase(), username: username.trim(), password },
  });
  await saveSession(
    { accessToken: res.accessToken, refreshToken: res.refreshToken, expiresIn: res.expiresIn },
    res.user,
  );
  return res.user;
}

/** Revoke the refresh token server-side, then wipe the local session. */
export async function logout(): Promise<void> {
  const refreshToken = await getRefreshToken();
  try {
    if (refreshToken) {
      await request<{ ok: boolean; revoked: boolean }>('/api/auth/logout', {
        method: 'POST',
        auth: false,
        body: { refreshToken },
      });
    }
  } catch {
    /* server-side revocation is best-effort — always clear locally */
  }
  await clearAll();
}

/** Fresh profile snapshot + counts. */
export function me(): Promise<MeResponse> {
  return request<MeResponse>('/api/auth/me');
}

/* ------------------------------ password reset ------------------------------ */

export interface ForgotPasswordResponse {
  ok: boolean;
  message: string;
  /** true when the server has no SMTP configured and returns the code inline
   * (sandbox) — production emails it instead. */
  sandbox: boolean;
  /** Present only in sandbox mode, so the flow is completable end-to-end. */
  code?: string;
  codeExpiresInMin?: number;
}

/**
 * Request a reset code. Always resolves ok for existing AND unknown emails
 * (no user enumeration). In sandbox mode the 6-digit code comes back in the
 * response; otherwise it is emailed.
 */
export function forgotPassword(email: string): Promise<ForgotPasswordResponse> {
  return request<ForgotPasswordResponse>('/api/auth/forgot-password', {
    method: 'POST',
    auth: false,
    body: { email: email.trim().toLowerCase() },
  });
}

/** Consume the code, set a new password (every session is revoked server-side). */
export function resetPassword(
  email: string,
  code: string,
  newPassword: string,
): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>('/api/auth/reset-password', {
    method: 'POST',
    auth: false,
    body: { email: email.trim().toLowerCase(), code: code.trim(), newPassword },
  });
}
