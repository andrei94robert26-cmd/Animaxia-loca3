'use client';

/**
 * hooks.ts — Small client data-fetching hook used by all Animaxia views.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export interface UseApiResult<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  refetch: () => Promise<void>;
}

/**
 * Fetches `fetcher` whenever `key` changes (and `enabled` is true).
 * Safe against setState-after-unmount and identity changes of the fetcher.
 */
export function useApi<T>(
  key: string,
  fetcher: () => Promise<T>,
  options: { enabled?: boolean } = {},
): UseApiResult<T> {
  const { enabled = true } = options;
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(enabled);

  const fetcherRef = useRef(fetcher);
  useEffect(() => {
    fetcherRef.current = fetcher;
  });
  const mountedRef = useRef(true);

  const run = useCallback(async () => {
    // Yield once so state updates happen in a microtask, never synchronously
    // inside an effect body (avoids cascading renders / React Compiler rule).
    await Promise.resolve();
    setLoading(true);
    setError(null);
    try {
      const result = await fetcherRef.current();
      if (mountedRef.current) {
        setData(result);
        setLoading(false);
      }
    } catch (e) {
      if (mountedRef.current) {
        setError(e instanceof Error ? e.message : 'Request failed');
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    if (!enabled) return undefined;
    // Deferred via macrotask so setState never runs synchronously in the
    // effect body; the timer is cancelled on cleanup (unmount / key change).
    const timer = setTimeout(() => {
      void run();
    }, 0);
    return () => {
      clearTimeout(timer);
      mountedRef.current = false;
    };
  }, [key, enabled, run]);

  // When disabled, expose an idle state regardless of any stale internals.
  if (!enabled) {
    return { data: null, error: null, loading: false, refetch: run };
  }

  return { data, error, loading, refetch: run };
}
