'use client';

/**
 * ai-home-settings.tsx — AI Home settings context (FAZA 15).
 *
 * The four AI Home toggles (infiniteScroll, aiCursor, autoTrailers,
 * autoTaxonomy) live in three layers:
 *   1. localStorage — read instantly on mount so the UI never flashes;
 *   2. GET /api/ai/home/settings — backend truth, synced once on mount;
 *   3. POST /api/ai/home/settings — fire-and-forget persist on toggle.
 *
 * setToggle() applies the change optimistically; if the backend rejects it,
 * the previous value is restored and a toast is shown.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/animaxia/api';
import type { AiHomeSettings } from '@/lib/animaxia/types';

export const DEFAULT_AI_HOME_SETTINGS: AiHomeSettings = {
  infiniteScroll: true,
  aiCursor: true,
  autoTrailers: true,
  autoTaxonomy: true,
};

const STORAGE_KEY = 'animaxia:ai-home-settings';

export interface AiHomeSettingsContextValue {
  settings: AiHomeSettings;
  /** True once the localStorage snapshot has been applied (first paint done). */
  loaded: boolean;
  setToggle: (key: keyof AiHomeSettings, value: boolean) => void;
}

const FALLBACK_CONTEXT: AiHomeSettingsContextValue = {
  settings: DEFAULT_AI_HOME_SETTINGS,
  loaded: false,
  setToggle: () => {},
};

const AiHomeSettingsContext = createContext<AiHomeSettingsContextValue>(FALLBACK_CONTEXT);

function readStoredSettings(): AiHomeSettings {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_AI_HOME_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<AiHomeSettings>;
    return { ...DEFAULT_AI_HOME_SETTINGS, ...parsed };
  } catch {
    return DEFAULT_AI_HOME_SETTINGS;
  }
}

function persistSettings(next: AiHomeSettings) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable (private mode) — in-memory state still works */
  }
}

export function AiHomeSettingsProvider({ children }: { children: React.ReactNode }) {
  const [settings, setSettings] = useState<AiHomeSettings>(DEFAULT_AI_HOME_SETTINGS);
  const [loaded, setLoaded] = useState(false);

  /* Local snapshot first (instant), then sync the backend truth once. */
  useEffect(() => {
    const timer = setTimeout(() => {
      setSettings(readStoredSettings());
      setLoaded(true);
      api.aiHome
        .settings()
        .then((res) => {
          if (!res?.settings) return;
          setSettings((prev) => ({ ...prev, ...res.settings }));
          persistSettings(res.settings);
        })
        .catch(() => {
          /* backend unreachable — the localStorage snapshot stays in charge */
        });
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  const setToggle = useCallback((key: keyof AiHomeSettings, value: boolean) => {
    setSettings((prev) => {
      const next = { ...prev, [key]: value };
      persistSettings(next);
      return next;
    });
    void api.aiHome
      .updateSettings({ [key]: value })
      .catch(() => {
        setSettings((prev) => {
          if (prev[key] !== value) return prev;
          const reverted = { ...prev, [key]: !value };
          persistSettings(reverted);
          return reverted;
        });
        toast.error('Setarea AI nu a putut fi salvată', {
          description: 'Backend-ul nu răspunde — am revenit la valoarea anterioară.',
        });
      });
  }, []);

  const value = useMemo(() => ({ settings, loaded, setToggle }), [settings, loaded, setToggle]);

  return <AiHomeSettingsContext.Provider value={value}>{children}</AiHomeSettingsContext.Provider>;
}

export function useAiHomeSettings(): AiHomeSettingsContextValue {
  return useContext(AiHomeSettingsContext);
}
