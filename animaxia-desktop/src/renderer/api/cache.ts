/**
 * api/cache.ts — Offline response cache: localStorage + IndexedDB hybrid.
 *
 * Strategy: stale-while-error (desktop FAZA 7 requirement 6).
 *   • cached(key, fetcher)          — network-first; on ANY network/5xx
 *                                     failure the last stored value is served
 *                                     with { stale: true } so screens can
 *                                     show an offline banner instead of an
 *                                     error.
 *   • cachedFresh(key, maxAge, fn)  — cache-first while the entry is younger
 *                                     than maxAge (used for /api/mobile/config).
 *
 * Storage tiers:
 *   • Payload envelopes { value, at } go to IndexedDB ('animaxia-desktop' →
 *     'cache' store) — generous quota, survives restarts.
 *   • When IndexedDB is unavailable (file:// restrictions, private mode),
 *     everything falls back to localStorage under '@animaxia/cache/' —
 *     payloads are small JSON (thumbnails are URLs, not blobs), so the
 *     ~5MB quota is plenty.
 *
 * Mutations drop entries by key prefix (e.g. watchlist changes drop
 * 'mobile:profile') so screens re-sync on the next visit.
 */

const IDB_NAME = 'animaxia-desktop';
const IDB_VERSION = 1;
const IDB_STORE = 'cache';
const LS_PREFIX = '@animaxia/cache/';

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

/* ------------------------------- IndexedDB core ------------------------------ */

let idbPromise: Promise<IDBDatabase | null> | null = null;

function openIdb(): Promise<IDBDatabase | null> {
  if (idbPromise) return idbPromise;
  idbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const request = indexedDB.open(IDB_NAME, IDB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE, { keyPath: 'key' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return idbPromise;
}

function idbRequest<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest): Promise<T | null> {
  return openIdb().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) return resolve(null);
        try {
          const tx = db.transaction(IDB_STORE, mode);
          const request = run(tx.objectStore(IDB_STORE));
          request.onsuccess = () => resolve(request.result as T);
          request.onerror = () => resolve(null);
          tx.onabort = () => resolve(null);
        } catch {
          resolve(null);
        }
      }),
  );
}

/* --------------------------- localStorage fallback ---------------------------- */

function lsKey(key: string): string {
  return LS_PREFIX + key;
}

function lsRead<T>(key: string): CacheEnvelope<T> | null {
  try {
    const raw = window.localStorage.getItem(lsKey(key));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CacheEnvelope<T>;
    if (!parsed || typeof parsed.at !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

function lsWrite<T>(key: string, envelope: CacheEnvelope<T>): void {
  try {
    window.localStorage.setItem(lsKey(key), JSON.stringify(envelope));
  } catch {
    /* quota exceeded — caching is best-effort */
  }
}

/* ------------------------------ unified access -------------------------------- */

async function readEnvelope<T>(key: string): Promise<CacheEnvelope<T> | null> {
  const fromIdb = await idbRequest<CacheEnvelope<T>>('readonly', (store) => store.get(key));
  if (fromIdb && typeof fromIdb.at === 'number' && 'value' in fromIdb) return fromIdb;
  return lsRead<T>(key);
}

async function writeEnvelope<T>(key: string, value: T): Promise<void> {
  const envelope: CacheEnvelope<T> = { value, at: Date.now() };
  const ok = await idbRequest('readwrite', (store) => store.put({ key, ...envelope }));
  // IndexedDB unavailable (null) → mirror to localStorage; also mirror tiny
  // payloads so a locked-down IDB still yields a working offline mode.
  if (ok === null || typeof ok !== 'object') lsWrite(key, envelope);
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  const envelope = await readEnvelope<T>(key);
  return envelope ? envelope.value : null;
}

export async function cacheSet<T>(key: string, value: T): Promise<void> {
  await writeEnvelope(key, value);
}

/** Drop every entry whose key starts with the given prefix (both tiers). */
export async function cacheDrop(prefix: string): Promise<void> {
  // IndexedDB: iterate keys, delete matches.
  const keys = await idbRequest<IDBValidKey[]>('readonly', (store) => store.getAllKeys());
  if (Array.isArray(keys)) {
    const doomed = keys.filter((k) => String(k).startsWith(prefix));
    if (doomed.length > 0) {
      await idbRequest('readwrite', (store) => {
        for (const key of doomed) store.delete(key);
        return store.getAllKeys(); // any request completes the tx
      });
    }
  }
  // localStorage sweep.
  try {
    const doomed: string[] = [];
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (key && key.startsWith(LS_PREFIX + prefix)) doomed.push(key);
    }
    doomed.forEach((key) => window.localStorage.removeItem(key));
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
    const envelope = await readEnvelope<T>(key);
    if (envelope) return { data: envelope.value, stale: true, fetchedAt: envelope.at };
    throw err;
  }
}

/** Cache-first while the entry is fresh; otherwise network + refresh. */
export async function cachedFresh<T>(
  key: string,
  maxAgeMs: number,
  fetcher: () => Promise<T>,
): Promise<CachedResult<T>> {
  const envelope = await readEnvelope<T>(key);
  if (envelope && Date.now() - envelope.at < maxAgeMs) {
    return { data: envelope.value, stale: false, fetchedAt: envelope.at };
  }
  return cached(key, fetcher);
}
