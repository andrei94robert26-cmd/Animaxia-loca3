/**
 * hooks/useApi.ts — Declarative data hook for the mobile screens.
 *
 *   const home = useApi(mobile.getHomeCached, []);
 *   const personal = useApi(user ? ai.aiPersonalHome : null, [user?.id]);
 *
 *   home.data / home.loading / home.error / home.stale / home.refetch()
 *
 * • The fetcher returns { data, stale } (api/cache.ts CachedResult) so the
 *   hook surfaces offline-served payloads via `stale` (screens render an
 *   offline banner instead of an error).
 * • Pass `null` as the fetcher to disable the call (auth-gated screens).
 * • deps work like useEffect deps — identity of the fetcher itself is NOT a
 *   dependency, matching the react-hooks/exhaustive-deps convention of
 *   useCallback'd fetchers.
 * • `refetch()` bumps an internal counter, re-running the effect.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { DependencyList } from 'react';
import { errorMessage } from '../api/client';

export interface CachedShape<T> {
  data: T;
  stale: boolean;
}

export interface ApiState<T> {
  data: T | null;
  loading: boolean;
  /** true while the (re)fetch is in flight AND stale data is still shown. */
  refreshing: boolean;
  error: string | null;
  /** true when data was served from the offline cache. */
  stale: boolean;
  refetch: () => void;
}

export function useApi<T>(
  fetcher: (() => Promise<CachedShape<T>>) | null,
  deps: DependencyList,
): ApiState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState<boolean>(fetcher !== null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [tick, setTick] = useState(0);
  const hasData = useRef(false);

  useEffect(() => {
    if (!fetcher) {
      setData(null);
      setError(null);
      setStale(false);
      setLoading(false);
      hasData.current = false;
      return;
    }

    let cancelled = false;
    const hadData = hasData.current;
    if (hadData) setRefreshing(true);
    else setLoading(true);
    setError(null);

    fetcher()
      .then((result) => {
        if (cancelled) return;
        setData(result.data);
        setStale(result.stale);
        hasData.current = true;
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(errorMessage(err));
        setStale(false);
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
        setRefreshing(false);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher !== null, tick, ...deps]);

  const refetch = useCallback(() => {
    setTick((n) => n + 1);
  }, []);

  return { data, loading, refreshing, error, stale, refetch };
}

export default useApi;
