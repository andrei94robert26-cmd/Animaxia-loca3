'use client';

/**
 * tenant.ts — FAZA 11 Multi-Tenant API client (typed). All calls go through
 * platform.authRequest (relative URLs + XTransformPort, auto-refresh on 401)
 * against the monolith's tenant surface:
 *
 *   GET    /api/tenants                        — list + 30d usage rollups
 *   POST   /api/tenants                        — create { slug, name, plan }
 *   GET    /api/tenants/:slug                  — detail + members + usage
 *   PATCH  /api/tenants/:slug/limits           — edit enforceable limits
 *   PATCH  /api/tenants/:slug/config           — edit config/features/allowlist
 *   POST   /api/tenants/:slug/users            — add membership { email, role }
 *   DELETE /api/tenants/:slug/users/:userid    — remove membership
 *   GET    /api/tenants/:slug/usage?days=30    — usage rollup
 *   GET    /api/tenant/whoami                  — caller's tenant context
 *
 *   GET    /api/tenants/billing/summary        — MRR estimate + invoice totals
 *   GET    /api/tenants/billing/invoices       — all invoices
 *   GET    /api/tenants/billing/invoices/:t    — one tenant's invoices
 *   POST   /api/tenants/billing/invoices/:t/generate — metered invoice
 *   POST   /api/tenants/billing/plan           — upgrade/downgrade plan
 *   POST   /api/tenants/billing/usage          — record a usage event
 */

import { authRequest } from './platform';

/* --------------------------------- types ---------------------------------- */

export interface TenantLimits {
  maxusers: number;
  aiperday: number;
  ratelimitpermin: number;
  vectorcollections: number;
  storagegb: number;
  overageallowed: boolean;
}

export interface Tenant {
  id: number;
  slug: string;
  name: string;
  status: string;
  plan: string;
  stripecustomerid: string | null;
  limits: TenantLimits;
  config: Record<string, unknown>;
  features: Record<string, boolean>;
  playerallowlist: string[];
  createdat: string | null;
  updatedat: string | null;
  usercount?: number;
  usage?: TenantUsage;
}

export interface TenantUsage {
  windowdays: number;
  bymetric: Record<string, { total: number; events: number }>;
}

export interface TenantMember {
  userid: number;
  email: string;
  username: string;
  role: string;
  createdat: string | null;
}

export interface TenantWhoami {
  tenant: Tenant;
  role: string;
  memberships: { slug: string; name: string; role: string; joinedat: string | null }[];
}

export interface BillingInvoiceLine {
  kind: string;
  metric?: string;
  label?: string;
  quantity?: number;
  events?: number;
  included?: number;
  billable?: number;
  unitusd?: number;
  amountusd: number;
}

export interface BillingInvoice {
  id: number;
  tenant: string;
  tenantname?: string;
  periodstart: string;
  periodend: string;
  status: string;
  baseusd: number;
  usageusd: number;
  totalusd: number;
  lines: BillingInvoiceLine[];
  stripeinvoiceid: string | null;
  createdat: string | null;
}

export interface BillingSummary {
  ok: boolean;
  mode: string;
  mrrEstimateUsd: number;
  tenants: { slug: string; name: string; plan: string; status: string; monthlyEstimateUsd: number }[];
  invoices: {
    open: { count: number; totalUsd: number };
    paid: { count: number; totalUsd: number };
  };
}

export interface TenantAiStatus {
  ok: boolean;
  tenant: Tenant;
  quota: { tenant: string; scoped: boolean; used: number | null; limit: number | null; perMinute: number | null; minuteUsed?: number };
  vector: { tenant: string; scoped: boolean; counts: Record<string, number> };
  provider: { provider: string; model: string; available: boolean; fallback: string };
}

/* --------------------------------- client ---------------------------------- */

export const TENANT_PLANS = ['free', 'starter', 'business', 'enterprise'] as const;
export type TenantPlan = (typeof TENANT_PLANS)[number];

export const tenantApi = {
  list: () => authRequest<{ tenants: Tenant[]; total: number }>('/api/tenants'),

  create: (body: { slug: string; name: string; plan: TenantPlan }) =>
    authRequest<{ ok: true; tenant: Tenant }>('/api/tenants', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),

  detail: (slug: string) =>
    authRequest<{ tenant: Tenant; members: TenantMember[] }>(`/api/tenants/${encodeURIComponent(slug)}`),

  updateLimits: (slug: string, limits: Partial<TenantLimits>) =>
    authRequest<{ ok: true; tenant: Tenant }>(`/api/tenants/${encodeURIComponent(slug)}/limits`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(limits),
    }),

  updateConfig: (slug: string, config: { config?: Record<string, unknown>; features?: Record<string, boolean>; playerallowlist?: string[] }) =>
    authRequest<{ ok: true; tenant: Tenant }>(`/api/tenants/${encodeURIComponent(slug)}/config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    }),

  addMember: (slug: string, email: string, role: string) =>
    authRequest<{ ok: true; member: TenantMember }>(`/api/tenants/${encodeURIComponent(slug)}/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, role }),
    }),

  removeMember: (slug: string, userid: number) =>
    authRequest<{ ok: true; removed: number }>(`/api/tenants/${encodeURIComponent(slug)}/users/${userid}`, {
      method: 'DELETE',
    }),

  usage: (slug: string, days = 30) =>
    authRequest<{ tenant: string; usage: TenantUsage }>(
      `/api/tenants/${encodeURIComponent(slug)}/usage?days=${days}`,
    ),

  whoami: () => authRequest<TenantWhoami>('/api/tenant/whoami'),

  billingSummary: () => authRequest<BillingSummary>('/api/tenants/billing/summary'),

  billingInvoices: () => authRequest<{ invoices: BillingInvoice[] }>('/api/tenants/billing/invoices'),

  generateInvoice: (slug: string) =>
    authRequest<{ ok: true; invoice: BillingInvoice & { lines: BillingInvoiceLine[] } }>(
      `/api/tenants/billing/invoices/${encodeURIComponent(slug)}/generate`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
    ),

  setPlan: (slug: string, plan: TenantPlan) =>
    authRequest<{ ok: true; direction: string; from: string; to: string; tenant: Tenant }>(
      '/api/tenants/billing/plan',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenant: slug, plan }),
      },
    ),

  aiStatus: () => authRequest<TenantAiStatus>('/api/ai/tenant/status'),
};
