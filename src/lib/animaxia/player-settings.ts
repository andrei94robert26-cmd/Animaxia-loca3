'use client';

/**
 * player-settings.ts — FAZA 19: persistent player settings.
 *
 * A tiny module-level store (no provider needed) with localStorage
 * persistence under `animaxia-player-settings-v1`. Loading merges the stored
 * snapshot over the defaults with per-field validation, so the store is
 * resilient to schema evolution and corrupt/partial payloads.
 *
 * Consumers subscribe through `usePlayerSettings()` (useSyncExternalStore —
 * zustand is available in package.json but unused across src/, so this task
 * keeps the established lightweight local-store pattern).
 */

import { useCallback, useSyncExternalStore } from 'react';

export interface PlayerSettings {
  /** Auto-advance to the next queued title when playback ends. */
  autoplayNext: boolean;
  /** Default playback rate (0.25–2), applied to every new video. */
  defaultSpeed: number;
  /** Cinema mode: wider player + page dim overlay. */
  cinemaMode: boolean;
  /** Preferred subtitle language tag (e.g. 'ro'), or null for «Oprit». */
  preferredSubtitleLang: string | null;
  /** 0–1 volume, restored on every video. */
  volume: number;
  muted: boolean;
  /** Persist playback progress to /api/playerhub/progress (signed in only). */
  saveProgress: boolean;
}

export const DEFAULT_PLAYER_SETTINGS: PlayerSettings = {
  autoplayNext: true,
  defaultSpeed: 1,
  cinemaMode: false,
  preferredSubtitleLang: null,
  volume: 1,
  muted: false,
  saveProgress: true,
};

const STORAGE_KEY = 'animaxia-player-settings-v1';

/* ------------------------------ persistence ------------------------------- */

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Reads the stored snapshot and merges it over the defaults — version-proof:
 *  unknown keys are ignored, every known field is re-validated. */
export function loadPlayerSettings(): PlayerSettings {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_PLAYER_SETTINGS };
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const merged: PlayerSettings = { ...DEFAULT_PLAYER_SETTINGS };
    if (typeof parsed.autoplayNext === 'boolean') merged.autoplayNext = parsed.autoplayNext;
    if (typeof parsed.cinemaMode === 'boolean') merged.cinemaMode = parsed.cinemaMode;
    if (typeof parsed.muted === 'boolean') merged.muted = parsed.muted;
    if (typeof parsed.saveProgress === 'boolean') merged.saveProgress = parsed.saveProgress;
    merged.defaultSpeed = clampNumber(parsed.defaultSpeed, 0.25, 2, DEFAULT_PLAYER_SETTINGS.defaultSpeed);
    merged.volume = clampNumber(parsed.volume, 0, 1, DEFAULT_PLAYER_SETTINGS.volume);
    if (typeof parsed.preferredSubtitleLang === 'string' && parsed.preferredSubtitleLang.trim() !== '') {
      merged.preferredSubtitleLang = parsed.preferredSubtitleLang.trim();
    } else if (parsed.preferredSubtitleLang === null) {
      merged.preferredSubtitleLang = null;
    }
    return merged;
  } catch {
    return { ...DEFAULT_PLAYER_SETTINGS };
  }
}

function persistPlayerSettings(settings: PlayerSettings): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* storage unavailable (private mode) — the in-memory store still works */
  }
}

/* ----------------------------- module store ------------------------------- */

type SettingsListener = (settings: PlayerSettings) => void;

let current: PlayerSettings = { ...DEFAULT_PLAYER_SETTINGS };
let hydrated = false;
const listeners = new Set<SettingsListener>();

/** Reads the store, hydrating it from localStorage on first access. */
export function getPlayerSettings(): PlayerSettings {
  if (!hydrated && typeof window !== 'undefined') {
    hydrated = true;
    current = loadPlayerSettings();
  }
  return current;
}

/** Applies a partial update, persists it and notifies every subscriber. */
export function updatePlayerSettings(patch: Partial<PlayerSettings>): PlayerSettings {
  const next = { ...getPlayerSettings(), ...patch };
  current = next;
  persistPlayerSettings(next);
  for (const listener of listeners) listener(next);
  return next;
}

/** Resets to the defaults (persists + notifies). */
export function resetPlayerSettings(): PlayerSettings {
  return updatePlayerSettings({ ...DEFAULT_PLAYER_SETTINGS });
}

export function subscribePlayerSettings(listener: SettingsListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Server/hydration snapshot for useSyncExternalStore — always the defaults. */
function getServerPlayerSettings(): PlayerSettings {
  return DEFAULT_PLAYER_SETTINGS;
}

/* --------------------------------- hook ----------------------------------- */

export interface UsePlayerSettingsResult {
  settings: PlayerSettings;
  /** Partial update — persists to localStorage and syncs every consumer. */
  update: (patch: Partial<PlayerSettings>) => void;
  reset: () => void;
}

/**
 * React binding for the player-settings store — `useSyncExternalStore` over
 * the module store: the server/hydration snapshot is the defaults (no
 * hydration mismatch), the localStorage snapshot is applied right after mount
 * and every later change arrives through the subscription.
 */
export function usePlayerSettings(): UsePlayerSettingsResult {
  const settings = useSyncExternalStore(
    subscribePlayerSettings,
    getPlayerSettings,
    getServerPlayerSettings,
  );

  const update = useCallback((patch: Partial<PlayerSettings>) => {
    updatePlayerSettings(patch);
  }, []);

  const reset = useCallback(() => {
    resetPlayerSettings();
  }, []);

  return { settings, update, reset };
}
