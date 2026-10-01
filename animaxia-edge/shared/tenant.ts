/**
 * shared/tenant.ts — FAZA 11 multi-tenant toolkit for the edge workers
 * (additive; used by the gateway, ai, search, auth and player workers).
 *
 * Resolution model (mirrors the monolith modules/tenant/core.js):
 *   1. X-Animaxia-Tenant header (trusted edge→origin signal; clients may
 *      send it too — the origin re-validates the tenant exists + is active)
 *   2. `tenant` claim of a verified access token (FAZA 11 tenant-aware JWTs)
 *   3. 'global' — the implicit tenant of every pre-FAZA-11 request
 *
 * Scoping helpers:
 *   • tenantKeyPrefix(slug)   — '' for global (all pre-FAZA-11 cache/rate
 *     keys stay byte-identical), 't:<slug>:' otherwise — per-tenant cache
 *     keys, answer caches, catalog snapshots and rate-limit buckets.
 *   • tenantPlayerAllowlist() — per-tenant HLS host allowlist from KV
 *     (t:<slug>:player:allowlist), falling back to the global config.
 *
 * Per-tenant AGGREGATE rate limiting lives at the origin
 * (tenantlimits.ratelimitpermin via the AI quota layer); the edge keeps its
 * global IP protection unchanged and only scopes the per-user buckets.
 */

import type { EdgeEnv, EdgeJwtPayload } from './types';
import { verifyEdgeJwt, bearerOf } from './jwt';

export const TENANT_HEADER = 'x-animaxia-tenant';
export const GLOBAL_TENANT = 'global';

/** Same slug grammar as the monolith (modules/tenant/tenant-routes.js). */
export function isValidTenantSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(slug);
}

/** Header → verified-JWT claim → 'global'. Never throws. */
export function resolveTenantSlug(request: Request, payload: EdgeJwtPayload | null): string {
  const header = (request.headers.get(TENANT_HEADER) || '').trim().toLowerCase();
  if (header && isValidTenantSlug(header)) return header;
  const claim = typeof payload?.tenant === 'string' ? payload.tenant.trim().toLowerCase() : '';
  if (claim && isValidTenantSlug(claim)) return claim;
  return GLOBAL_TENANT;
}

/** Full resolution incl. token verification (one call per request). */
export async function resolveTenantOf(request: Request, env: EdgeEnv): Promise<string> {
  let payload: EdgeJwtPayload | null = null;
  try {
    payload = await verifyEdgeJwt(bearerOf(request), env);
  } catch {
    payload = null;
  }
  return resolveTenantSlug(request, payload);
}

/** Cache/rate key prefix: '' for global (legacy keys unchanged). */
export function tenantKeyPrefix(slug: string): string {
  return slug && slug !== GLOBAL_TENANT ? `t:${slug}:` : '';
}

/** Per-user rate bucket scoped to a tenant (global → legacy key). */
export function tenantUserKey(slug: string, sub: string | number): string {
  return `${tenantKeyPrefix(slug)}user:${sub}`;
}

/** KV key for a tenant's HLS host allowlist (player worker). */
export function tenantPlayerAllowlistKey(slug: string): string {
  return `t:${slug}:player:allowlist`;
}

/** KV key for a tenant's catalog snapshot (search worker). */
export function tenantCatalogKey(slug: string, baseKey: string): string {
  return slug && slug !== GLOBAL_TENANT ? `t:${slug}:${baseKey}` : baseKey;
}

/** In-memory TTL cache for KV-fetched tenant allowlists (60s, per isolate). */
const allowlistCache = new Map<string, { hosts: string[] | null; at: number }>();
const ALLOWLIST_TTL_MS = 60_000;

/**
 * Resolve the HLS host allowlist for a tenant: KV list under
 * t:<slug>:player:allowlist wins, else the global config list. Global tenant
 * → always the global config (unchanged behavior). Best-effort: KV errors
 * fall back to the global list.
 */
export async function tenantPlayerAllowlist(
  env: EdgeEnv,
  slug: string,
  globalHosts: string[],
): Promise<string[]> {
  if (!slug || slug === GLOBAL_TENANT || !env.EDGE_CACHE) return globalHosts;
  const cached = allowlistCache.get(slug);
  if (cached && Date.now() - cached.at < ALLOWLIST_TTL_MS) {
    return cached.hosts ?? globalHosts;
  }
  let hosts: string[] | null = null;
  try {
    const raw = await env.EDGE_CACHE.get(tenantPlayerAllowlistKey(slug));
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.every((h) => typeof h === 'string')) {
        hosts = parsed.map((h) => h.toLowerCase());
      }
    }
  } catch {
    hosts = null;
  }
  allowlistCache.set(slug, { hosts, at: Date.now() });
  return hosts ?? globalHosts;
}

/** Test hook — drop cached allowlists. */
export function resetTenantAllowlistCache(): void {
  allowlistCache.clear();
}
