/**
 * watchlist/useWatchlist.ts — Watchlist state hook (optimistic add/remove).
 *
 * Backed by /api/users/me/watchlist (GET list · POST add · DELETE remove).
 * Plan limits are enforced server-side (free 20 · plus 200 · pro unlimited);
 * a 403 surfaces the server message (e.g. "Watchlist limit reached") through
 * `lastError`. Screens: Watchlist tab + the content-screen save button.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import * as usersApi from '../api/users';
import { cacheDrop } from '../api/cache';
import { errorMessage } from '../api/client';
import type { WatchlistEntry } from '../api/users';

export interface WatchlistState {
  entries: WatchlistEntry[];
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  lastError: string | null;
  ids: Set<number>;
  load: () => Promise<void>;
  /** Toggle membership for a content id. Returns the new state (true = saved). */
  toggle: (contentId: number) => Promise<boolean>;
  clearLastError: () => void;
}

export function useWatchlist(enabled: boolean): WatchlistState {
  const [entries, setEntries] = useState<WatchlistEntry[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!enabled) return;
    setRefreshing(true);
    setError(null);
    try {
      const res = await usersApi.getWatchlist();
      setEntries(res.data ?? []);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [enabled]);

  useEffect(() => {
    if (enabled) void load();
    else {
      setEntries([]);
      setLoading(false);
    }
  }, [enabled, load]);

  const ids = useMemo(() => new Set(entries.map((e) => e.content.id)), [entries]);

  const toggle = useCallback(
    async (contentId: number): Promise<boolean> => {
      const currentlySaved = ids.has(contentId);
      // Optimistic flip.
      if (currentlySaved) {
        setEntries((prev) => prev.filter((e) => e.content.id !== contentId));
      } else {
        setEntries((prev) => [
          { content: { id: contentId, title: '', type: '', thumbnail: null, externalid: null, metadata: {}, createdat: null, rating: null, year: null }, addedat: null },
          ...prev,
        ]);
      }
      try {
        if (currentlySaved) {
          await usersApi.removeFromWatchlist(contentId);
          setLastError(null);
          return false;
        }
        await usersApi.addToWatchlist(contentId);
        await cacheDrop('mobile:profile');
        setLastError(null);
        void load(); // re-sync with the server rows (real titles/thumbnails)
        return true;
      } catch (err) {
        setLastError(errorMessage(err));
        void load(); // roll back to the truth
        return currentlySaved;
      }
    },
    [ids, load],
  );

  const clearLastError = useCallback(() => setLastError(null), []);

  return { entries, loading, refreshing, error, lastError, ids, load, toggle, clearLastError };
}

export default useWatchlist;
