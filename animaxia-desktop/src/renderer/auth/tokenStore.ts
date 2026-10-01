/**
 * auth/tokenStore.ts — Durable token + user-snapshot persistence.
 *
 * Desktop: localStorage (the renderer is a sandboxed, per-user Chromium
 * profile — no Keychain access from the sandboxed renderer by design).
 *
 * Stores the Animaxia session contract issued by POST /api/auth/login |
 * /register | /refresh:
 *   { accessToken, refreshToken, expiresIn }   — access JWT (15 min, Bearer)
 *                                               + rotating refresh token (30d)
 * plus the last `user` snapshot so the app can boot instantly offline.
 */

const KEY_SESSION = 'animaxia.session';
const KEY_USER = 'animaxia.user';

export interface SessionUser {
  id: number;
  email: string;
  username: string;
  avatar: string | null;
  role: string;
  plan: string;
  planexpiresat: string | null;
  preferences: Record<string, unknown>;
  createdat: string | null;
  lastloginat: string | null;
}

export interface StoredSession {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

function readJson<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable — session lives in memory only */
  }
}

/* ------------------------------- public API -------------------------------- */

export async function getAccessToken(): Promise<string | null> {
  const session = readJson<StoredSession>(KEY_SESSION);
  return session?.accessToken ?? null;
}

export async function getRefreshToken(): Promise<string | null> {
  const session = readJson<StoredSession>(KEY_SESSION);
  return session?.refreshToken ?? null;
}

export async function saveSession(session: StoredSession, user?: SessionUser | null): Promise<void> {
  writeJson(KEY_SESSION, session);
  if (user !== undefined) {
    if (user === null) {
      try {
        window.localStorage.removeItem(KEY_USER);
      } catch {
        /* ignore */
      }
    } else {
      writeJson(KEY_USER, user);
    }
  }
}

export async function getUserSnapshot(): Promise<SessionUser | null> {
  return readJson<SessionUser>(KEY_USER);
}

export async function clearAll(): Promise<void> {
  try {
    window.localStorage.removeItem(KEY_SESSION);
    window.localStorage.removeItem(KEY_USER);
  } catch {
    /* ignore */
  }
}
