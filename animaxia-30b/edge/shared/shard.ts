/**
 * shared/shard.ts — FAZA 13 shard-aware toolkit for the edge workers
 * (additive; used by the gateway, ai, search and player workers).
 *
 * Byte-compatible mirror of the monolith sharding core (FAZA 13, pinned spec
 * from worklog Task ID 13-0; FAZA 14 topology from Task ID 14-0/14-1) so the
 * edge and the origin always resolve the SAME shard id for the same request:
 *
 *   • fnv1a()                    — FNV-1a 32-bit (house hash, same shape as
 *                                  hashToken in the monolith vector-service).
 *   • shardCountOf(env)          — SHARDCOUNT var (FAZA 14 pinned topology:
 *                                  30 logical shards × 1 billion ids = the
 *                                  30B logical address space; default 30,
 *                                  NaN/<=0/garbage → 30).
 *   • computeShardIdFromContentId(id)  — catalog range shards of 1B ids:
 *                                  Math.floor(id / 1_000_000_000) % count
 *                                  (every current SERIAL id < 1B → shard 0,
 *                                  legacy compatible; with 30 shards,
 *                                  shard s covers EXACTLY [s×1B,(s+1)×1B−1]).
 *   • computeShardIdFromTenant(tenant) — fnv1a('tenant:' + slug) % count.
 *   • resolveShardFromTenantOrContent() — the edge resolution: tenant ≠
 *     'global' → tenant shard; else the first numeric path segment after
 *     'content' / 'player' / 'api/content' → content-id shard; else 0.
 *   • resolveShardOf()           — full policy with the trusted-client
 *     override: a valid X-Animaxia-Shard header (int 0..count-1) wins over
 *     recomputation (header > tenant > content path > 0). Used by every
 *     FAZA 13 worker so the gateway and sub-workers never disagree.
 *   • shardKeySegment(shard)     — 's<shard>:' cache-key segment, inserted
 *     immediately after the FAZA 11 tenant prefix:
 *       global legacy 'api:/api/all'      → 's0:api:/api/all'
 *       tenant       't:acme:api:/x'      → 't:acme:s1:api:/x' (FAZA 14, mod 30)
 *
 * The header name and every hash/segment below are frozen contracts
 * (X-Animaxia-Shard, decimal shard id) shared with the monolith gateway.
 *
 * Pure functions — no runtime imports beyond types; fully unit-testable.
 */

import type { EdgeEnv } from './types';

/** Upstream request + client response header carrying the resolved shard. */
export const SHARD_HEADER = 'x-animaxia-shard';

/**
 * FAZA 14: shard span in content ids — each logical shard covers exactly
 * SHARD_SPAN_IDS ids (1 billion). Pinned by the definitive FAZA 14 spec
 * (30 × 1B); mirrors SHARD_SPAN_IDS in the monolith modules/sharding/model.js.
 */
export const SHARD_SPAN_IDS = 1_000_000_000;

/**
 * FAZA 14: the logical (simulated) address space in content ids —
 * shardCountOf(env) × SHARD_SPAN_IDS (30 × 1B = 30B ids with the pinned
 * default topology; ids 0..29,999,999,999). The volume is logical/simulated —
 * real rows in Neon stay real. Mirrors logicalAddressSpace() in the monolith
 * modules/sharding/model.js.
 */
export function logicalAddressSpace(env?: EdgeEnv): number {
  return shardCountOf(env) * SHARD_SPAN_IDS;
}

/** FNV-1a 32-bit over char codes (unsigned, Math.imul-safe). */
export function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * SHARDCOUNT from the environment (wrangler [vars] / .dev.vars), default 30
 * (FAZA 14 pinned topology: 30 logical shards × 1B ids — 30B logical address
 * space). Guarded exactly like the monolith: NaN, <= 0 or garbage → 30.
 */
export function shardCountOf(env?: EdgeEnv): number {
  const raw = (env as { SHARDCOUNT?: unknown } | undefined)?.SHARDCOUNT;
  const parsed = parseInt(raw === undefined || raw === null || raw === '' ? '30' : String(raw), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 30;
  return parsed;
}

/**
 * Catalog shard for a content id — 1B-id range shards:
 * Math.floor(id / 1_000_000_000) % SHARDCOUNT (with the FAZA 14 default 30,
 * shard s covers exactly [s×1B, (s+1)×1B − 1] — no wrap below 30B).
 * Non-finite / negative → 0.
 */
export function computeShardIdFromContentId(id: string | number, env?: EdgeEnv): number {
  const n = Number(id);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n / 1_000_000_000) % shardCountOf(env);
}

/** Tenant shard: fnv1a('tenant:' + slug) % SHARDCOUNT (vector/tenant key space). */
export function computeShardIdFromTenant(tenantId: string, env?: EdgeEnv): number {
  return fnv1a(`tenant:${String(tenantId)}`) % shardCountOf(env);
}

/**
 * Tenant-only shard (no request/path context — KV peeks such as the search
 * worker's /search/health?tenant= view). '' / 'global' → 0, mirroring the
 * tenant branch of resolveShardFromTenantOrContent.
 */
export function shardOfTenantSlug(tenantSlug: string, env?: EdgeEnv): number {
  const slug = String(tenantSlug ?? '');
  if (slug === '' || slug === 'global') return 0;
  return computeShardIdFromTenant(slug, env);
}

/**
 * Edge resolution (FAZA 13 pinned spec):
 *   tenant ≠ '' and ≠ 'global'            → computeShardIdFromTenant(tenant)
 *   else first numeric path segment after 'content' / 'player' /
 *        'api/content' (e.g. /api/content/42, /content/42,
 *        /player/1500000000)              → computeShardIdFromContentId(id)
 *   else                                  → 0
 */
export function resolveShardFromTenantOrContent(request: Request, tenantSlug: string, env?: EdgeEnv): number {
  const tenant = String(tenantSlug ?? '');
  if (tenant !== '' && tenant !== 'global') {
    return computeShardIdFromTenant(tenant, env);
  }
  let pathname = '';
  try {
    pathname = new URL(request.url).pathname;
  } catch {
    return 0;
  }
  const segments = pathname.split('/');
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i];
    const next = segments[i + 1];
    if (/^\d+$/.test(next) && (segment === 'content' || segment === 'player')) {
      return computeShardIdFromContentId(next, env);
    }
    // /api/content/<id> — the tenant-style API surface of the monolith.
    if (segment === 'api' && next === 'content' && i + 2 < segments.length && /^\d+$/.test(segments[i + 2])) {
      return computeShardIdFromContentId(segments[i + 2], env);
    }
  }
  return 0;
}

/**
 * A client-provided X-Animaxia-Shard is honored when it is a valid decimal
 * int in 0..SHARDCOUNT-1 (trusted edge→origin signal, same trust model as
 * X-Animaxia-Tenant); anything else is ignored and recomputed.
 */
export function clientShardOf(request: Request, env?: EdgeEnv): number | null {
  const raw = (request.headers.get(SHARD_HEADER) || '').trim();
  if (raw === '' || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n >= shardCountOf(env)) return null;
  return n;
}

/**
 * Full FAZA 13 edge policy — resolution order:
 *   valid client X-Animaxia-Shard > tenant > content path > 0.
 * The gateway and the ai/search/player workers all resolve through this so
 * cache keys and upstream headers never disagree.
 */
export function resolveShardOf(request: Request, tenantSlug: string, env?: EdgeEnv): number {
  const fromHeader = clientShardOf(request, env);
  if (fromHeader !== null) return fromHeader;
  return resolveShardFromTenantOrContent(request, tenantSlug, env);
}

/** Cache-key segment for a shard: 0 → 's0:', 2 → 's2:' … */
export function shardKeySegment(shardId: number): string {
  return `s${shardId}:`;
}
