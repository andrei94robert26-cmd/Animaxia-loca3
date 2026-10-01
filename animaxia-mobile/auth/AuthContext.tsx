/**
 * auth/AuthContext.tsx — Session provider.
 *
 * Boot sequence (instant-first):
 *   1. Restore the last user snapshot from SecureStore → render immediately.
 *   2. Validate in the background via GET /api/auth/me (the api client
 *      silently rotates the access token on 401 — single-flight refresh).
 *   3. me() failure with a dead refresh token → client.ts emits 'logout'
 *      and this provider clears the user.
 *
 * Actions: login, register, logout, updateUser (avatar/premium changes keep
 * the provider in sync without a refetch).
 */

import React, { createContext, useCallback, useEffect, useMemo, useState } from 'react';
import * as authApi from '../api/auth';
import { onAuthChange } from '../api/client';
import { getUserSnapshot, clearAll } from './tokenStore';
import type { SessionUser } from './tokenStore';

export interface AuthState {
  user: SessionUser | null;
  /** true while the boot sequence restores/validates the stored session. */
  initializing: boolean;
  login: (email: string, password: string) => Promise<SessionUser>;
  register: (email: string, username: string, password: string) => Promise<SessionUser>;
  logout: () => Promise<void>;
  /** Replace the in-memory user (avatar upload, premium confirm, …). */
  updateUser: (user: SessionUser) => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [initializing, setInitializing] = useState(true);

  /* ------------------------------- boot ---------------------------------- */
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const snapshot = await getUserSnapshot();
      if (cancelled) return;
      if (snapshot) setUser(snapshot); // instant paint, validated below

      if (!snapshot) {
        setInitializing(false);
        return;
      }
      try {
        const me = await authApi.me();
        if (!cancelled) setUser(me.user);
      } catch {
        // 401 with a dead refresh already emitted 'logout' (listener below).
        // Network hiccup → keep the snapshot; screens handle offline.
      } finally {
        if (!cancelled) setInitializing(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  /* --------------------- client-driven session events --------------------- */
  useEffect(() => {
    const unsubscribe = onAuthChange((event) => {
      if (event === 'logout') setUser(null);
      // 'session' = token rotated in the background — no user change needed.
    });
    return unsubscribe;
  }, []);

  /* ------------------------------- actions -------------------------------- */
  const login = useCallback(async (email: string, password: string) => {
    const next = await authApi.login(email, password);
    setUser(next);
    return next;
  }, []);

  const register = useCallback(async (email: string, username: string, password: string) => {
    const next = await authApi.register(email, username, password);
    setUser(next);
    return next;
  }, []);

  const logout = useCallback(async () => {
    await authApi.logout();
    setUser(null);
  }, []);

  const updateUser = useCallback((next: SessionUser) => {
    setUser(next);
  }, []);

  const value = useMemo<AuthState>(
    () => ({ user, initializing, login, register, logout, updateUser }),
    [user, initializing, login, register, logout, updateUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export default AuthContext;
