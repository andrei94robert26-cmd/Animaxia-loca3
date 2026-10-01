/**
 * search/src/catalog.ts — catalog snapshot pipeline for the edge search worker.
 *
 * The snapshot lives in three layers, strongest first:
 *   1. a module-level in-memory singleton (per isolate, zero-latency reads)
 *   2. the KV snapshot in SEARCH_CACHE (key cfg.search.catalogKey, default
 *      'catalog:v1'), shared across isolates and written with
 *      expirationTtl = max(60, cfg.search.catalogTtlSec * 2)
 *   3. a rebuild from the cloud: GET /api/all?limit=100&page=N →
 *      { data: [content rows], total, page, totalPages } → CatalogItem[]
 *      (mapCatalogRow). The endpoint caps limit at 100 and defaults to 20,
 *      so the rebuild pages through ALL content (up to MAX_PAGES pages;
 *      a partial fetch on later pages still yields a usable catalog) →
 *      CatalogSnapshot { v: 1, fetchedAt, source: 'cloud:/api/all', items }
 *
 * A snapshot older than cfg.search.catalogTtlSec is stale: loadCatalog() tries
 * a rebuild and, when the cloud is unreachable, serves the stale copy instead
 * of failing (stale-if-error, same philosophy as shared/cache.ts). null is
 * returned only when NO snapshot exists anywhere AND the rebuild failed —
 * callers then fall back to the cloud /api/search passthrough (index.ts).
 *
 * Concurrent rebuilds coalesce onto a single in-flight promise (thundering
 * herd guard, same idea as the cloud SearchIndex.rebuildPromise).
 */

import type { CatalogItem, CatalogSnapshot, EdgeEnv } from '../../shared/types';
import type { EdgeConfig } from '../../shared/config';
import { upstreamFetch } from '../../shared/upstream';
import { GLOBAL_TENANT, tenantKeyPrefix } from '../../shared/tenant'; // FAZA 11
import { shardKeySegment } from '../../shared/shard'; // FAZA 13

/** Upper bound on catalog size — /api/all is ~78 rows today; guards memory + KV. */
const MAX_ITEMS = 10_000;

/** /api/all caps `limit` at 100 (server.js listContent) and defaults to 20. */
const PAGE_SIZE = 100;

/** Page cap per rebuild — bounds subrequests (10 × 100 = 1,000 items). */
const MAX_PAGES = 10;

// FAZA 11: per-tenant memory singletons + in-flight rebuild guards
// ('global' keeps the exact pre-FAZA-11 semantics under its own map slot).
// FAZA 13: the slot is the (tenant, shard) key space — 'global' + shard 0
// slots keep their own entry, exactly like the KV keys below.
const memoryBySlot = new Map<string, CatalogSnapshot>();
const inFlightBySlot = new Map<string, Promise<CatalogSnapshot | null>>();

/** One slot per tenant+shard key space ('' + 's0:' for global shard 0). */
function cacheSlot(tenant: string, shard: number): string {
  return `${tenantKeyPrefix(tenant)}${shardKeySegment(shard)}`;
}

/** KV snapshot key: tenant prefix + shard segment + base key (FAZA 11 + 13). */
function catalogKeyOf(tenant: string, shard: number, baseKey: string): string {
  return `${tenantKeyPrefix(tenant)}${shardKeySegment(shard)}${baseKey}`;
}

function memOf(tenant: string, shard: number): CatalogSnapshot | null {
  return memoryBySlot.get(cacheSlot(tenant, shard)) ?? null;
}

/* ------------------------------------------------------------- parsing ----- */

/** Validate an unknown KV value as a CatalogSnapshot (defensive against junk). */
function parseSnapshot(raw: unknown): CatalogSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const snap = raw as Partial<CatalogSnapshot> & { items?: unknown };
  if (snap.v !== 1 || typeof snap.fetchedAt !== 'number' || typeof snap.source !== 'string') return null;
  if (!Array.isArray(snap.items)) return null;
  const items: CatalogItem[] = [];
  for (const entry of snap.items) {
    if (!entry || typeof entry !== 'object') continue;
    const it = entry as Partial<CatalogItem>;
    if (typeof it.id !== 'number' || typeof it.title !== 'string') continue;
    items.push({
      id: it.id,
      title: it.title,
      type: typeof it.type === 'string' ? it.type : '',
      thumbnail: typeof it.thumbnail === 'string' ? it.thumbnail : null,
      genres: Array.isArray(it.genres) ? it.genres.map((g) => String(g)) : [],
      year: typeof it.year === 'number' ? it.year : null,
      rating: typeof it.rating === 'number' ? it.rating : null,
    });
  }
  return { v: 1, fetchedAt: snap.fetchedAt, source: snap.source, items };
}

/**
 * Map one /api/all content row to the compact edge CatalogItem:
 *   { id, type, title, metadata: { year, genres, rating, ... }, thumbnail }
 *     → { id, title, type, thumbnail, genres, year, rating }
 * (year arrives as a string for TMDB rows — coerced with Number() || null.)
 */
function mapCatalogRow(row: unknown): CatalogItem | null {
  if (!row || typeof row !== 'object') return null;
  const r = row as Record<string, unknown>;
  const id = Number(r.id);
  if (!Number.isInteger(id) || id <= 0) return null;
  const meta = (r.metadata && typeof r.metadata === 'object' ? r.metadata : {}) as Record<string, unknown>;
  const rating = Number(meta.rating);
  return {
    id,
    title: String(r.title ?? ''),
    type: String(r.type ?? ''),
    thumbnail: typeof r.thumbnail === 'string' ? r.thumbnail : null,
    genres: Array.isArray(meta.genres) ? meta.genres.map((g) => String(g)) : [],
    year: Number(meta.year) || null,
    rating: meta.rating != null && Number.isFinite(rating) ? rating : null,
  };
}

/* ------------------------------------------------------------ rebuild ------ */

/** One /api/all page → mapped items + the advertised page count. */
async function fetchCatalogPage(
  env: EdgeEnv,
  page: number,
): Promise<{ items: CatalogItem[]; totalPages: number | null } | null> {
  const res = await upstreamFetch({
    env,
    kind: 'cloud',
    path: '/api/all',
    search: `?limit=${PAGE_SIZE}&page=${page}`,
    method: 'GET',
  });
  if (!res.ok) return null;

  let data: unknown = null;
  let totalPages: number | null = null;
  try {
    const parsed = await res.json() as { data?: unknown; totalPages?: unknown };
    data = parsed?.data;
    const tp = Number(parsed?.totalPages);
    if (Number.isFinite(tp) && tp >= 1) totalPages = Math.floor(tp);
  } catch {
    return null;
  }
  if (!Array.isArray(data)) return null;

  const items: CatalogItem[] = [];
  for (const row of data) {
    const item = mapCatalogRow(row);
    if (item) items.push(item);
  }
  return { items, totalPages };
}

/** Fetch /api/all from the cloud (all pages) and store the snapshot in KV.
 *  FAZA 11: the KV key is tenant-scoped (t:<slug>:…).
 *  FAZA 13: + the shard segment right after the tenant prefix
 *  (t:<slug>:s<N>:<catalogKey>, global → s0:<catalogKey>). */
async function rebuildCatalog(env: EdgeEnv, cfg: EdgeConfig, tenant: string, shard: number): Promise<CatalogSnapshot | null> {
  const items: CatalogItem[] = [];
  const seen = new Set<number>();

  for (let page = 1; page <= MAX_PAGES; page++) {
    const result = await fetchCatalogPage(env, page);
    if (!result) {
      if (page === 1) return null; // cloud down / bad shape → caller falls back
      break; // later-page hiccup → keep the partial catalog
    }
    for (const item of result.items) {
      if (seen.has(item.id)) continue; // defensive: pages must not overlap
      seen.add(item.id);
      items.push(item);
    }
    if (items.length >= MAX_ITEMS) break;
    if (result.items.length === 0 || result.totalPages === null || page >= result.totalPages) break;
  }
  if (items.length === 0) return null;

  const snapshot: CatalogSnapshot = { v: 1, fetchedAt: Date.now(), source: 'cloud:/api/all', items };
  if (env.SEARCH_CACHE) {
    await env.SEARCH_CACHE.put(catalogKeyOf(tenant, shard, cfg.search.catalogKey), JSON.stringify(snapshot), {
      expirationTtl: Math.max(60, cfg.search.catalogTtlSec * 2),
    }).catch(() => { /* KV write hiccup → snapshot still usable in-memory */ });
  }
  return snapshot;
}

/** Coalesce concurrent rebuilds onto one in-flight promise per (tenant, shard). */
function startRebuild(env: EdgeEnv, cfg: EdgeConfig, tenant: string, shard: number): Promise<CatalogSnapshot | null> {
  const slot = cacheSlot(tenant, shard);
  let flight = inFlightBySlot.get(slot);
  if (!flight) {
    flight = (async () => {
      try {
        const snap = await rebuildCatalog(env, cfg, tenant, shard);
        if (snap) memoryBySlot.set(slot, snap);
        return snap;
      } finally {
        inFlightBySlot.delete(slot);
      }
    })();
    inFlightBySlot.set(slot, flight);
  }
  return flight;
}

/* -------------------------------------------------------------- public ----- */

/**
 * Load the freshest usable snapshot.
 *   force = false (reads): memory → KV (fresh) → rebuild → stale-if-error.
 *   force = true  (POST /search/refresh): bypass memory + KV age, rebuild,
 *                and surface a rebuild failure as null (no stale masking).
 *  FAZA 11: `tenant` scopes the memory singleton + KV key ('global' default
 *  — pre-FAZA-11 callers keep their exact behavior).
 *  FAZA 13: `shard` adds the s<shard>: segment after the tenant prefix
 *  (global + 0 → 's0:<catalogKey>', the only observable change vs FAZA 11).
 */
export async function loadCatalog(
  env: EdgeEnv,
  cfg: EdgeConfig,
  force = false,
  tenant: string = GLOBAL_TENANT,
  shard = 0, // FAZA 13
): Promise<CatalogSnapshot | null> {
  const ttlMs = Math.max(1, cfg.search.catalogTtlSec) * 1000;
  const now = Date.now();
  const slot = cacheSlot(tenant, shard);
  const memory = memOf(tenant, shard);

  if (!force && memory && now - memory.fetchedAt <= ttlMs) return memory;

  if (!force && env.SEARCH_CACHE) {
    let stored: CatalogSnapshot | null = null;
    try {
      stored = parseSnapshot(await env.SEARCH_CACHE.get(catalogKeyOf(tenant, shard, cfg.search.catalogKey), 'json'));
    } catch {
      stored = null; // KV hiccup → fall through to the rebuild
    }
    if (stored) {
      if (now - stored.fetchedAt <= ttlMs) {
        memoryBySlot.set(slot, stored);
        return stored;
      }
      if (!memory || stored.fetchedAt > memory.fetchedAt) memoryBySlot.set(slot, stored); // freshest stale copy
    }
  }

  const rebuilt = await startRebuild(env, cfg, tenant, shard);
  if (rebuilt) return rebuilt;

  // Stale-if-error for reads; a forced refresh reports failures honestly.
  return force ? null : memOf(tenant, shard);
}

/**
 * Cheap snapshot peek for /search/health — memory first, then one KV read,
 * never a cloud call. FAZA 11: tenant-scoped ('global' default).
 * FAZA 13: + shard segment in the KV key (tenant hash when the caller has
 * no request context).
 */
export async function peekCatalog(
  env: EdgeEnv,
  cfg: EdgeConfig,
  tenant: string = GLOBAL_TENANT,
  shard = 0, // FAZA 13
): Promise<CatalogSnapshot | null> {
  const memory = memOf(tenant, shard);
  if (memory) return memory;
  if (!env.SEARCH_CACHE) return null;
  try {
    const stored = parseSnapshot(await env.SEARCH_CACHE.get(catalogKeyOf(tenant, shard, cfg.search.catalogKey), 'json'));
    if (stored) memoryBySlot.set(cacheSlot(tenant, shard), stored);
    return stored;
  } catch {
    return null;
  }
}
