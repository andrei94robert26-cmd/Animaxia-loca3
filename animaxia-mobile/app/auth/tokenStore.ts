/**
 * auth/tokenStore.ts — Durable token + user-snapshot persistence.
 *
 * Native:  expo-secure-store (Keychain / Keystore — never plain-text files).
 * Web:     AsyncStorage fallback (expo runs the same tree on web during dev).
 *
 * Stores the Animaxia session contract issued by POST /api/auth/login |
 * /register | /refresh:
 *   { accessToken, refreshToken, expiresIn }   — access JWT (15 min, Bearer)
 *                                               + rotating refresh token (30d)
 * plus the last `user` snapshot so the app can boot instantly offline.
 */

import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

const KEY_SESSION = '@animaxia/session';
const KEY_USER = '@animaxia/user';

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

const isNative = Platform.OS === 'ios' || Platform.OS === 'android';

/* --------------------------- secure value helpers --------------------------- */

async function secureGet(key: string): Promise<string | null> {
  if (isNative) {
    try {
      return await SecureStore.getItemAsync(key);
    } catch {
      return null;
    }
  }
  return AsyncStorage.getItem(key);
}

async function secureSet(key: string, value: string): Promise<void> {
  if (isNative) {
    try {
      await SecureStore.setItemAsync(key, value);
      return;
    } catch {
      /* fall through to AsyncStorage */
    }
  }
  await AsyncStorage.setItem(key, value);
}

async function secureDelete(key: string): Promise<void> {
  if (isNative) {
    try {
      await SecureStore.deleteItemAsync(key);
      return;
    } catch {
      /* fall through */
    }
  }
  await AsyncStorage.removeItem(key);
}

/* ------------------------------- public API -------------------------------- */

export async function getAccessToken(): Promise<string | null> {
  const raw = await secureGet(KEY_SESSION);
  if (!raw) return null;
  try {
    const session = JSON.parse(raw) as StoredSession;
    return session.accessToken ?? null;
  } catch {
    return null;
  }
}

export async function getRefreshToken(): Promise<string | null> {
  const raw = await secureGet(KEY_SESSION);
  if (!raw) return null;
  try {
    const session = JSON.parse(raw) as StoredSession;
    return session.refreshToken ?? null;
  } catch {
    return null;
  }
}

export async function saveSession(session: StoredSession, user?: SessionUser | null): Promise<void> {
  await secureSet(KEY_SESSION, JSON.stringify(session));
  if (user !== undefined) {
    if (user === null) await secureDelete(KEY_USER);
    else await secureSet(KEY_USER, JSON.stringify(user));
  }
}

export async function getUserSnapshot(): Promise<SessionUser | null> {
  const raw = await secureGet(KEY_USER);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SessionUser;
  } catch {
    return null;
  }
}

export async function clearAll(): Promise<void> {
  await secureDelete(KEY_SESSION);
  await secureDelete(KEY_USER);
}
