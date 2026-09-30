/**
 * modules/tenant/ai-quota.js — FAZA 11 tenant-level AI quota + rate limiting
 * (additive wrapper OVER llm-core; llm-core itself is untouched).
 *
 * Two layers stack (enterprise model):
 *   1. TENANT pool — tenantlimits.aiperday per calendar day + ratelimitpermin
 *      per minute, counted across every member of the tenant.
 *   2. USER/PLAN pool — the pre-FAZA-11 consumeAiQuota (per-user daily +
 *      per-minute by plan), applied unchanged.
 *
 * Order of operations keeps metering honest: the tenant pool is PEEKED
 * first; the user pool is consumed; only then is the tenant pool incremented
 * (so a user-quota rejection does not bill the tenant pool) and a metered
 * `ai_call` usage event is recorded for billing.
 *
 * The implicit 'global' tenant (and the DB-unreachable fallback descriptor)
 * delegates straight to consumeAiQuota — byte-identical behavior for
 * anonymous + legacy traffic.
 */

import { consumeAiQuota } from '../aicloud/llm-core.js';
import { recordTenantUsage, GLOBAL_TENANT_SLUG } from './core.js';

const tenantDaily = new Map(); // tenantId → { date, count }
const tenantMinute = new Map(); // tenantId → { windowStart, count }

function dayKey(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function peekTenantPool(tenant, { now = Date.now() } = {}) {
  const tid = Number(tenant.id);
  const day = tenantDaily.get(tid);
  const minute = tenantMinute.get(tid);
  return {
    dailyUsed: day && day.date === dayKey() ? day.count : 0,
    minuteUsed: minute && now - minute.windowStart < 60000 ? minute.count : 0,
  };
}

function incrementTenantPool(tenant, { now = Date.now() } = {}) {
  const tid = Number(tenant.id);
  const today = dayKey();
  const day = tenantDaily.get(tid);
  if (day && day.date === today) day.count += 1;
  else tenantDaily.set(tid, { date: today, count: 1 });
  const minute = tenantMinute.get(tid);
  if (minute && now - minute.windowStart < 60000) minute.count += 1;
  else tenantMinute.set(tid, { windowStart: now, count: 1 });
}

/** Hourly sweep so pools for deleted/idle tenants do not accumulate. */
let sweep = setInterval(() => {
  const today = dayKey();
  for (const [tid, day] of tenantDaily) if (day.date !== today) tenantDaily.delete(tid);
  const now = Date.now();
  for (const [tid, minute] of tenantMinute) if (now - minute.windowStart >= 60000) tenantMinute.delete(tid);
}, 60 * 60 * 1000);
if (typeof sweep.unref === 'function') sweep.unref();

/**
 * Consume one AI call against the tenant pool + the user/plan pool.
 * @returns {{ allowed: true, tenant, plan, tenantUsed, tenantLimit } |
 *           { allowed: false, status: 402|429, error, code, tenant, tenantUsed, tenantLimit }}
 */
export function consumeTenantAiQuota({ user = null, ip = 'unknown', tenant = null } = {}) {
  // Implicit tenant or DB fallback → exactly the pre-FAZA-11 path.
  if (!tenant || tenant.isfallback || tenant.slug === GLOBAL_TENANT_SLUG) {
    const base = consumeAiQuota({ user, ip });
    return { ...base, tenant: GLOBAL_TENANT_SLUG, tenantUsed: null, tenantLimit: null };
  }

  // 1. Peek the tenant pool.
  const { dailyUsed, minuteUsed } = peekTenantPool(tenant);
  const dailyLimit = Number(tenant.limits?.aiperday) || 0;
  const perMinLimit = Number(tenant.limits?.ratelimitpermin) || 0;
  if (dailyLimit > 0 && dailyUsed >= dailyLimit) {
    return {
      allowed: false,
      status: 402,
      code: 'TENANT_AI_QUOTA',
      error: `Tenant '${tenant.slug}' reached its daily AI quota (${dailyLimit}) — raise the limit or upgrade the plan`,
      tenant: tenant.slug,
      tenantUsed: dailyUsed,
      tenantLimit: dailyLimit,
    };
  }
  if (perMinLimit > 0 && minuteUsed >= perMinLimit) {
    return {
      allowed: false,
      status: 429,
      code: 'TENANT_AI_RATE',
      error: `Tenant '${tenant.slug}' AI rate limit — max ${perMinLimit} requests/min`,
      tenant: tenant.slug,
      tenantUsed: dailyUsed,
      tenantLimit: dailyLimit,
    };
  }

  // 2. Consume the user/plan pool (anonymous callers included).
  const base = consumeAiQuota({ user, ip });
  if (!base.allowed) return { ...base, tenant: tenant.slug, tenantUsed: dailyUsed, tenantLimit: dailyLimit };

  // 3. Bill the tenant pool + record the metered usage event.
  incrementTenantPool(tenant);
  void recordTenantUsage(tenant, { metric: 'ai_call', quantity: 1, unit: 'call', userid: user?.id ?? null });
  return {
    allowed: true,
    plan: base.plan,
    used: base.used,
    limit: base.limit,
    tenant: tenant.slug,
    tenantUsed: dailyUsed + 1,
    tenantLimit: dailyLimit,
  };
}

/** Read-only status (no consumption) for GET /api/ai/tenant/status. */
export function tenantAiQuotaStatus(tenant) {
  if (!tenant || tenant.isfallback || tenant.slug === GLOBAL_TENANT_SLUG) {
    return { tenant: GLOBAL_TENANT_SLUG, scoped: false, used: null, limit: null, perMinute: null };
  }
  const { dailyUsed, minuteUsed } = peekTenantPool(tenant);
  return {
    tenant: tenant.slug,
    scoped: true,
    used: dailyUsed,
    limit: Number(tenant.limits?.aiperday) || 0,
    perMinute: Number(tenant.limits?.ratelimitpermin) || 0,
    minuteUsed,
  };
}

/** Test hook — reset pools (used by the smoke suite on a fresh tenant). */
export function resetTenantQuotaPoolsForTest() {
  tenantDaily.clear();
  tenantMinute.clear();
}
