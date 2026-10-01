/**
 * api/cache.ts — Offline response cache on AsyncStorage.
 *
 * Strategy: stale-while-error.
 *   • cached(key, fetcher)          — network-first; on ANY network/5xx failure
 *                                     the last stored value is served with
 *                                     { stale: true } so screens can show an
 *                                     offline banner instead of an error.
 *   • cachedFresh(key, maxAge, fn)  — cache-first while the entry is younger
 *                                     than maxAge (used for /api/mobile/config
 *                                     and other slow-moving payloads).
 *
 * Values are JSON-serialised into envelopes { value, at } under the
 * `@animaxia/cache/` prefix. Cache drops by key prefix power cache
 * invalidation after mutations (e.g. watchlist changes drop `watchlist:*`).
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const PREFIX = '@animaxia/cache/';

interface CacheEnvelope<T> {
  value: T;
  at: number;
}

export interface CachedResult<T> {
  data: T;
  /** true when the payload came from the offline cache (network failed). */
  stale: boolean;
  fetchedAt: number;
}

async function readEnvelope<T>(key: string): Promise<CacheEnvelope<T> | null> {
  try {
    const raw = await AsyncStorage.getItem(PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CacheEnvelope<T>;
    if (!parsed || typeof parsed.at !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeEnvelope<T>(key: string, value: T): Promise<void> {
  try {
    const envelope: CacheEnvelope<T> = { value, at: Date.now() };
    await AsyncStorage.setItem(PREFIX + key, JSON.stringify(envelope));
  } catch {
    /* storage full / unavailable — caching is best-effort */
  }
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  const env = await readEnvelope<T>(key);
  return env ? env.value : null;
}

export async function cacheSet<T>(key: string, value: T): Promise<void> {
  await writeEnvelope(key, value);
}

/** Drop every entry whose key starts with the given prefix. */
export async function cacheDrop(prefix: string): Promise<void> {
  try {
    const all = await AsyncStorage.getAllKeys();
    const doomed = all.filter((k) => k.startsWith(PREFIX + prefix));
    if (doomed.length > 0) await AsyncStorage.multiRemove(doomed);
  } catch {
    /* best-effort */
  }
}

/** Network-first with stale-on-error fallback. */
export async function cached<T>(key: string, fetcher: () => Promise<T>): Promise<CachedResult<T>> {
  try {
    const fresh = await fetcher();
    await writeEnvelope(key, fresh);
    return { data: fresh, stale: false, fetchedAt: Date.now() };
  } catch (err) {
    const env = await readEnvelope<T>(key);
    if (env) return { data: env.value, stale: true, fetchedAt: env.at };
    throw err;
  }
}

/** Cache-first while the entry is fresh; otherwise network + refresh the entry. */
export async function cachedFresh<T>(key: string, maxAgeMs: number, fetcher: () => Promise<T>): Promise<CachedResult<T>> {
  const env = await readEnvelope<T>(key);
  if (env && Date.now() - env.at < maxAgeMs) {
    return { data: env.value, stale: false, fetchedAt: env.at };
  }
  return cached(key, fetcher);
}
