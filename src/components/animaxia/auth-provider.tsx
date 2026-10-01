'use client';

/**
 * auth-provider.tsx — Animaxia session context. Restores the session from
 * localStorage on mount (with one silent refresh-token rotation on 401),
 * exposes { user, initializing, login, register, logout, refreshUser, setUser }.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { platform, tokenStore, tryRefresh } from '@/lib/animaxia/platform';
import type { PlatformUser, Preferences } from '@/lib/animaxia/platform';

interface AuthContextValue {
  user: PlatformUser | null;
  initializing: boolean;
  isAdmin: boolean;
  login: (email: string, password: string, code?: string) => Promise<PlatformUser>;
  register: (email: string, username: string, password: string) => Promise<PlatformUser>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<PlatformUser | null>;
  setUser: (user: PlatformUser | null) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<PlatformUser | null>(null);
  const [initializing, setInitializing] = useState(true);

  // Session restore: access token → /auth/me; on 401 → one refresh rotation.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!tokenStore.access) {
        setInitializing(false);
        return;
      }
      try {
        const res = await platform.me();
        if (!cancelled) setUser(res.user);
      } catch {
        if (tokenStore.refresh && (await tryRefresh())) {
          try {
            const res = await platform.me();
            if (!cancelled) setUser(res.user);
          } catch {
            tokenStore.clear();
          }
        } else {
          tokenStore.clear();
        }
      } finally {
        if (!cancelled) setInitializing(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (email: string, password: string, code?: string) => {
    const res = await platform.login({ email, password, code });
    tokenStore.set(res.accessToken, res.refreshToken);
    setUser(res.user);
    return res.user;
  }, []);

  const register = useCallback(async (email: string, username: string, password: string) => {
    const res = await platform.register({ email, username, password });
    tokenStore.set(res.accessToken, res.refreshToken);
    setUser(res.user);
    return res.user;
  }, []);

  const logout = useCallback(async () => {
    const refresh = tokenStore.refresh;
    try {
      if (refresh) await platform.logout(refresh);
    } catch {
      /* best-effort revoke */
    }
    tokenStore.clear();
    setUser(null);
  }, []);

  const refreshUser = useCallback(async () => {
    try {
      const res = await platform.me();
      setUser(res.user);
      return res.user;
    } catch {
      return null;
    }
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      initializing,
      isAdmin: user?.role === 'admin',
      login,
      register,
      logout,
      refreshUser,
      setUser,
    }),
    [user, initializing, login, register, logout, refreshUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

/** Convenience: is the current user's plan at least `plan`? */
export function planAtLeast(user: PlatformUser | null, plan: 'free' | 'plus' | 'pro'): boolean {
  const rank = { free: 0, plus: 1, pro: 2 } as const;
  return (rank[user?.plan ?? 'free'] ?? 0) >= rank[plan];
}

export type { PlatformUser, Preferences };
