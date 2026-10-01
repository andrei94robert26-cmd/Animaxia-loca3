/**
 * modules/tenant/core.js — FAZA 11 tenant registry core:
 *   • In-memory tenant registry cache (60s TTL, event-invalidated)
 *   • resolveTenantOf(req)  — X-Tenant header → JWT claim → user membership → 'global'
 *   • tenantOfUser(userid)  — primary membership lookup (fallback 'global')
 *   • getTenantBySlug/getTenantById + limits/config accessors
 *   • serializeTenant()     — API shape used by /api/tenants + admin console
 *   • recordTenantUsage()   — append a metered usage event (billing feed)
 *
 * The implicit tenant 'global' always resolves even when the SQL layer is
 * unavailable (local fallback mode) — anonymous + legacy traffic keeps
 * working exactly as before FAZA 11.
 */

import { logger } from '../../utils/logger.js';
import { one, rows, num, parseJsonb, isoOrNull } from '../platform/sql.js';
import { TENANT_PLAN_LIMITS } from './tenant-migrations.js';

export const GLOBAL_TENANT_SLUG = 'global';
export const TENANT_HEADER = 'x-animaxia-tenant';

const CACHE_TTL_MS = 60 * 1000;

/** Fallback descriptor used when the DB is unreachable — never blocks boot. */
const GLOBAL_FALLBACK = {
  id: 1,
  slug: GLOBAL_TENANT_SLUG,
  name: 'Global (default)',
  status: 'active',
  plan: 'enterprise',
  stripecustomerid: null,
  limits: { ...TENANT_PLAN_LIMITS.enterprise, overageallowed: true },
  config: {},
  features: {},
  playerallowlist: ['mp4', 'm3u8', 'iframe', 'youtube'],
  isfallback: true,
};

/* ------------------------------- registry cache ------------------------------ */

const cache = new Map(); // slug → { tenant, cachedAt }
let cacheSweep = null;

function cacheSweepStart() {
  if (cacheSweep) return;
  cacheSweep = setInterval(() => {
    const cutoff = Date.now() - CACHE_TTL_MS * 5;
    for (const [key, entry] of cache) {
      if (entry.cachedAt < cutoff) cache.delete(key);
    }
  }, 5 * 60 * 1000);
  if (typeof cacheSweep.unref === 'function') cacheSweep.unref();
}

export function invalidateTenantCache(slug = null) {
  if (slug) cache.delete(slug);
  else cache.clear();
}

function toTenant(row) {
  return {
    id: num(row.id),
    slug: row.slug,
    name: row.name,
    status: row.status || 'active',
    plan: row.plan || 'free',
    stripecustomerid: row.stripecustomerid || null,
    limits: {
      maxusers: num(row.maxusers),
      aiperday: num(row.aiperday),
      ratelimitpermin: num(row.ratelimitpermin),
      vectorcollections: num(row.vectorcollections),
      storagegb: num(row.storagegb),
      overageallowed: row.overageallowed !== false,
    },
    config: parseJsonb(row.config, {}),
    features: parseJsonb(row.features, {}),
    playerallowlist: parseJsonb(row.playerallowlist, []),
    createdat: isoOrNull(row.createdat),
    updatedat: isoOrNull(row.updatedat),
  };
}

/** Get a tenant by slug (cached). Returns null when unknown; the implicit
 *  'global' tenant always resolves (DB fallback descriptor when needed). */
export async function getTenantBySlug(slug) {
  const key = String(slug || GLOBAL_TENANT_SLUG).toLowerCase().trim();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.cachedAt < CACHE_TTL_MS) return hit.tenant;
  cacheSweepStart();
  try {
    const row = await one(
      `SELECT t.*, l.maxusers, l.aiperday, l.ratelimitpermin, l.vectorcollections, l.storagegb, l.overageallowed,
              c.config, c.features, c.playerallowlist
       FROM tenants t
       LEFT JOIN tenantlimits l ON l.tenantid = t.id
       LEFT JOIN tenantconfig c ON c.tenantid = t.id
       WHERE t.slug = $1`,
      [key],
    );
    if (!row) return null;
    const tenant = toTenant(row);
    cache.set(key, { tenant, cachedAt: Date.now() });
    return tenant;
  } catch (err) {
    if (key === GLOBAL_TENANT_SLUG) return GLOBAL_FALLBACK;
    logger.debug(`[tenant] registry lookup failed for '${key}': ${err.message}`);
    return null;
  }
}

export async function getTenantById(id) {
  try {
    const row = await one(`SELECT slug FROM tenants WHERE id = $1`, [Number(id)]);
    return row ? getTenantBySlug(row.slug) : null;
  } catch {
    return null;
  }
}

/** Primary tenant of a user (first membership by tenant id); 'global' when
 *  the user has no membership — matches pre-FAZA-11 behavior. */
export async function tenantOfUser(userid) {
  if (!userid) return getTenantBySlug(GLOBAL_TENANT_SLUG);
  try {
    const row = await one(
      `SELECT t.slug FROM tenantusers tu JOIN tenants t ON t.id = tu.tenantid
       WHERE tu.userid = $1 ORDER BY tu.tenantid ASC LIMIT 1`,
      [Number(userid)],
    );
    if (row?.slug) return getTenantBySlug(row.slug);
  } catch {
    /* fallback driver → global */
  }
  return getTenantBySlug(GLOBAL_TENANT_SLUG);
}

/** Memberships of a user with tenant-role attached. */
export async function tenantsOfUser(userid) {
  try {
    return await rows(
      `SELECT t.slug, t.name, tu.role, tu.createdat
       FROM tenantusers tu JOIN tenants t ON t.id = tu.tenantid
       WHERE tu.userid = $1 ORDER BY tu.tenantid ASC`,
      [Number(userid)],
    );
  } catch {
    return [];
  }
}

/**
 * Resolve the tenant for an incoming request. Priority (strictly additive —
 * requests without any tenant signal resolve to 'global', exactly the
 * pre-FAZA-11 behavior):
 *   1. X-Animaxia-Tenant header (trusted internal signal — gateway/edge set it
 *      only after resolving the tenant themselves)
 *   2. JWT `tenant` claim (verified access token — set by req.user middleware)
 *   3. user membership (req.user.id → tenantusers)
 *   4. 'global'
 */
export async function resolveTenantOf(req) {
  const headerSlug = String(req?.headers?.[TENANT_HEADER] || '').trim().toLowerCase();
  if (headerSlug) {
    const t = await getTenantBySlug(headerSlug);
    if (t && t.status === 'active') return t;
    const err = new Error(`Unknown or inactive tenant '${headerSlug}'`);
    err.status = 404;
    err.code = 'TENANT_NOT_FOUND';
    throw err;
  }
  const claimSlug = String(req?.user?.tenant || '').trim().toLowerCase();
  if (claimSlug) {
    const t = await getTenantBySlug(claimSlug);
    if (t) return t;
  }
  if (req?.user?.id) {
    const t = await tenantOfUser(req.user.id);
    if (t) return t;
  }
  return getTenantBySlug(GLOBAL_TENANT_SLUG);
}

/* ------------------------------ serialization -------------------------------- */

export function serializeTenant(tenant, usage = null) {
  if (!tenant) return null;
  const out = {
    id: tenant.id,
    slug: tenant.slug,
    name: tenant.name,
    status: tenant.status,
    plan: tenant.plan,
    stripecustomerid: tenant.stripecustomerid,
    limits: tenant.limits,
    config: tenant.config,
    features: tenant.features,
    playerallowlist: tenant.playerallowlist,
    createdat: tenant.createdat,
    updatedat: tenant.updatedat,
  };
  if (usage) out.usage = usage;
  return out;
}

/* -------------------------------- usage events ------------------------------- */

/**
 * Append a metered usage event (fire-and-forget safe — billing feed, never
 * on the request critical path). metric ∈ ai_call | vector_index | api_request
 * | storage_gb. quantity is the metered amount.
 */
export async function recordTenantUsage(tenant, { metric, quantity = 1, unit = 'count', userid = null, meta = null } = {}) {
  if (!tenant || tenant.isfallback) return;
  try {
    await rows(
      `INSERT INTO tenantusageevents (tenantid, userid, metric, quantity, unit, meta)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [Number(tenant.id), userid ? Number(userid) : null, String(metric), Number(quantity) || 0, String(unit), JSON.stringify(meta ?? {})],
    );
  } catch (err) {
    logger.debug(`[tenant] usage event drop (${metric}): ${err.message}`);
  }
}

/** Rolled-up usage for a tenant over a window (default: last 30 days). */
export async function tenantUsageRollup(tenantid, days = 30) {
  try {
    const list = await rows(
      `SELECT metric, SUM(quantity)::real AS total, COUNT(*) AS events
       FROM tenantusageevents
       WHERE tenantid = $1 AND createdat > datetime('now','-' || $2)
       GROUP BY metric`,
      [Number(tenantid), `${Number(days) || 30} days`],
    );
    const byMetric = {};
    for (const r of list) byMetric[r.metric] = { total: num(r.total), events: num(r.events) };
    return { windowdays: Number(days) || 30, bymetric: byMetric };
  } catch {
    return { windowdays: Number(days) || 30, bymetric: {} };
  }
}

export { GLOBAL_FALLBACK };
