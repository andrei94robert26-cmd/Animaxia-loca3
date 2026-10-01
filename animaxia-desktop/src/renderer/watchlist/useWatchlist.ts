/**
 * watchlist/useWatchlist.ts — Watchlist state hook (desktop port of the mobile
 * FAZA 6 hook).
 *
 * Backed by /api/users/me/watchlist (GET list · POST add · DELETE remove),
 * wrapped in the offline cache (key 'watchlist') so the list still renders
 * while offline. Mutations drop the local cache entry (the api module already
 * drops 'mobile:profile') and re-sync from the server.
 *
 * Optimistic add/remove with rollback: a pending op is layered over the server
 * rows so the UI flips instantly; failures revert to the server truth and
 * surface the message through `lastError` (plan-limit 403s included).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import * as usersApi from '../api/users';
import { cacheDrop, cached } from '../api/cache';
import { useApi } from '../hooks/useApi';
import { errorMessage } from '../api/client';
import type { WatchlistEntry } from '../api/users';

export interface WatchlistState {
  entries: WatchlistEntry[];
  loading: boolean;
  /** true while a re-sync is in flight with data on screen. */
  refreshing: boolean;
  /** List-level fetch error (network/5xx with no cached copy). */
  error: string | null;
  /** true when the list was served from the offline cache. */
  stale: boolean;
  /** Last mutation error (plan limit, network, …) — shown inline, dismissible. */
  lastError: string | null;
  ids: Set<number>;
  /** Re-sync the list from the server (also used as retry). */
  load: () => void;
  /** Toggle membership for a content id. Resolves to the new state (true = saved). */
  toggle: (contentId: number) => Promise<boolean>;
  clearLastError: () => void;
}

/** Placeholder row for an optimistic add (real columns arrive on re-sync). */
function placeholderEntry(contentId: number): WatchlistEntry {
  return {
    content: {
      id: contentId,
      title: '',
      type: '',
      thumbnail: null,
      rating: null,
      year: null,
      externalid: null,
      metadata: {},
      createdat: null,
    },
    addedat: null,
  };
}

export function useWatchlist(enabled: boolean): WatchlistState {
  const [tick, setTick] = useState(0);
  const [optimistic, setOptimistic] = useState<Map<number, 'add' | 'remove'>>(new Map());
  const [lastError, setLastError] = useState<string | null>(null);

  const list = useApi(
    enabled ? () => cached('watchlist', () => usersApi.getWatchlist()) : null,
    [enabled, tick],
  );

  const serverEntries = useMemo<WatchlistEntry[]>(() => list.data?.data ?? [], [list.data]);

  /* Optimistic overlay: pending adds prepend, pending removes drop out. */
  const entries = useMemo<WatchlistEntry[]>(() => {
    const added: WatchlistEntry[] = [];
    for (const [id, op] of optimistic) {
      if (op === 'add' && !serverEntries.some((entry) => entry.content.id === id)) {
        added.push(placeholderEntry(id));
      }
    }
    return [...added, ...serverEntries.filter((entry) => optimistic.get(entry.content.id) !== 'remove')];
  }, [optimistic, serverEntries]);

  const ids = useMemo<Set<number>>(() => new Set(entries.map((entry) => entry.content.id)), [entries]);

  const load = useCallback(() => {
    setTick((n) => n + 1);
  }, []);

  const clearOp = useCallback((contentId: number) => {
    setOptimistic((prev) => {
      if (!prev.has(contentId)) return prev;
      const next = new Map(prev);
      next.delete(contentId);
      return next;
    });
  }, []);

  const toggle = useCallback(
    async (contentId: number): Promise<boolean> => {
      if (!enabled) return false;
      const onServer = serverEntries.some((entry) => entry.content.id === contentId);
      const currentlySaved = onServer ? optimistic.get(contentId) !== 'remove' : optimistic.get(contentId) === 'add';

      setLastError(null);
      setOptimistic((prev) => {
        const next = new Map(prev);
        next.set(contentId, currentlySaved ? 'remove' : 'add');
        return next;
      });

      try {
        if (currentlySaved) {
          await usersApi.removeFromWatchlist(contentId);
        } else {
          await usersApi.addToWatchlist(contentId);
        }
        await cacheDrop('watchlist'); // local offline-cache entry (profile key is dropped by the api module)
        clearOp(contentId);
        setTick((n) => n + 1); // re-sync with the server rows
        return !currentlySaved;
      } catch (err) {
        setLastError(errorMessage(err));
        clearOp(contentId); // roll back to the server truth
        setTick((n) => n + 1);
        return currentlySaved;
      }
    },
    [enabled, serverEntries, optimistic, clearOp],
  );

  const clearLastError = useCallback(() => setLastError(null), []);

  /* Leaving signed-out state clears any stale optimistic overlay. */
  useEffect(() => {
    if (!enabled) setOptimistic(new Map());
  }, [enabled]);

  return {
    entries,
    loading: enabled && list.loading,
    refreshing: list.refreshing,
    error: list.error,
    stale: list.stale,
    lastError,
    ids,
    load,
    toggle,
    clearLastError,
  };
}

export default useWatchlist;
