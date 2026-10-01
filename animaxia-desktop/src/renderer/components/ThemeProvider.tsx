/**
 * components/ThemeProvider.tsx — Theme context wired to the Electron main
 * process.
 *
 * • The SETTING ('system' | 'dark' | 'light') persists in the main-process
 *   settings.json and drives nativeTheme (native menus, window chrome).
 * • The RESOLVED theme ('dark' | 'light') is applied to <html> so the CSS
 *   variables in globals.css switch instantly.
 * • 'system' follows the OS live — nativeTheme 'updated' events are forwarded
 *   as theme:changed.
 *
 * useTheme() → { setting, resolved, setSetting, toggle }
 */

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { applyResolvedTheme } from '../utils/theme';
import type { ThemeSetting, ResolvedTheme } from '../utils/theme';

interface ThemeState {
  setting: ThemeSetting;
  resolved: ResolvedTheme;
  setSetting: (setting: ThemeSetting) => void;
  /** system → dark → light → system (menu / shortcut cycle). */
  toggle: () => void;
}

const ThemeContext = createContext<ThemeState | null>(null);

function hasBridge(): boolean {
  return typeof window !== 'undefined' && Boolean(window.animaxia);
}

const FALLBACK: ThemeState = {
  setting: 'dark',
  resolved: 'dark',
  setSetting: () => {},
  toggle: () => {},
};

export function ThemeProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [setting, setSettingState] = useState<ThemeSetting>('system');
  const [resolved, setResolved] = useState<ResolvedTheme>('dark');

  const apply = useCallback((next: ResolvedTheme) => {
    setResolved(next);
    applyResolvedTheme(next);
  }, []);

  /* boot: ask the main process for the persisted theme */
  useEffect(() => {
    if (!hasBridge()) return;
    window.animaxia.theme
      .get()
      .then(({ setting: s, resolved: r }) => {
        setSettingState(s);
        apply(r);
      })
      .catch(() => apply(window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'));

    const unsubscribe = window.animaxia.theme.onChanged(({ setting: s, resolved: r }) => {
      setSettingState(s);
      apply(r);
    });
    return unsubscribe;
  }, [apply]);

  const setSetting = useCallback((next: ThemeSetting) => {
    setSettingState(next);
    if (!hasBridge()) {
      apply(next === 'light' ? 'light' : 'dark');
      return;
    }
    window.animaxia.theme
      .set(next)
      .then(({ resolved: r }) => apply(r))
      .catch(() => {});
  }, [apply]);

  const toggle = useCallback(() => {
    setSetting(setting === 'system' ? 'dark' : setting === 'dark' ? 'light' : 'system');
  }, [setting, setSetting]);

  const value = useMemo<ThemeState>(() => ({ setting, resolved, setSetting, toggle }), [
    setting,
    resolved,
    setSetting,
    toggle,
  ]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeState {
  const ctx = useContext(ThemeContext);
  return ctx ?? FALLBACK;
}

export default ThemeProvider;
