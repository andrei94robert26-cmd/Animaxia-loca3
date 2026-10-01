/**
 * api/auth.ts — /api/auth/* client.
 *
 *   POST /register { email, username, password } → { ok, user, …session }
 *   POST /login    { email, password }           → { ok, user, …session }
 *   POST /refresh  { refreshToken }              → { ok, …session }   (used by client.ts)
 *   POST /logout   { refreshToken }              → { ok, revoked }
 *   GET  /me                                     → { user, stats }
 *
 * The session contract: { accessToken (15 min), refreshToken (rotating, 30d),
 * expiresIn }. Every login/register persists the session + user snapshot via
 * tokenStore.saveSession.
 */

import { request } from './client';
import { saveSession } from '../auth/tokenStore';
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
  const { getRefreshToken, clearAll } = await import('../auth/tokenStore');
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
