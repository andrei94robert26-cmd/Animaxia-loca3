/**
 * modules/tenant/billing.js — FAZA 11 metered billing per tenant (additive).
 *
 * Mounted by server.js at /api/tenants (tenantBillingRouter, AFTER
 * tenantAdminRouter — all billing paths are ≥2 segments so the admin
 * router's /:slug routes never shadow them).
 *
 * Model — Stripe metered semantics, sandbox-first:
 *   • Usage events (tenantusageevents, written by the AI quota layer and
 *     this router) are the meter: ai_call | vector_index | storage_gb |
 *     api_request.
 *   • Invoice generation sums events in a [periodstart, periodend) window,
 *     applies the plan's metered unit prices (TENANT_METERED_PRICES) on the
 *     portion ABOVE the plan's included allowance, adds the plan base price.
 *   • Plan upgrades change tenants.plan + reset tenantlimits to the new
 *     plan's defaults (limits stay editable afterwards via /:slug/limits).
 *   • Live Stripe (STRIPESECRETKEY sk_…): invoice generation also pushes an
 *     invoice item + invoice onto the tenant's Stripe customer when one is
 *     linked; any Stripe failure degrades to local-only (stripeinvoiceid
 *     stays null, error captured in the lines meta). Sandbox default:
 *     everything is simulated, provider 'stripe-sandbox'.
 *
 * Routes (all requireAuth + requireAdmin):
 *   GET  /billing/summary                    — MRR estimate, open/drafted totals
 *   GET  /billing/invoices                   — all invoices (newest first)
 *   GET  /billing/invoices/:tenant           — invoices of one tenant
 *   POST /billing/invoices/:tenant/generate  — { periodStart?, periodEnd? } → invoice
 *   POST /billing/invoices/:id/void          — mark an invoice voided
 *   POST /billing/usage                      — { tenant, metric, quantity?, unit?, meta? }
 *   POST /billing/plan                       — { tenant, plan } upgrade/downgrade
 *   POST /billing/customer                   — { tenant, stripecustomerid } link
 */

import express from 'express';
import { one, rows, num, jsonb } from '../platform/sql.js';
import { requireAuth, requireAdmin } from '../users/auth.js';
import { auditLog, clientIpOf } from '../security/security.js';
import { logger } from '../../utils/logger.js';
import { getTenantBySlug, invalidateTenantCache, serializeTenant } from './core.js';
import { TENANT_PLAN_LIMITS, TENANT_METERED_PRICES } from './tenant-migrations.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const STRIPE_API = 'https://api.stripe.com/v1';
const METRICS = ['ai_call', 'vector_index', 'storage_gb', 'api_request'];

function stripeKey() {
  const key = process.env.STRIPESECRETKEY;
  return key && key.startsWith('sk_') ? key : null;
}

/** Included allowance per metric by plan (mirrors tenantlimits seeding). */
function includedAllowance(plan, metric) {
  const limits = TENANT_PLAN_LIMITS[plan] || TENANT_PLAN_LIMITS.free;
  if (metric === 'ai_call') return limits.aiperday * 30; // monthly view of the daily pool
  if (metric === 'vector_index') return limits.vectorcollections * 500;
  if (metric === 'storage_gb') return limits.storagegb;
  return 0; // api_request is pure overage metering
}

async function tenantOr404(req, res, slugParam) {
  const tenant = await getTenantBySlug(slugParam);
  if (!tenant || tenant.isfallback) {
    res.status(404).json({ error: `Tenant '${slugParam}' not found`, code: 'TENANT_NOT_FOUND' });
    return null;
  }
  return tenant;
}

async function stripeRequest(method, path, body) {
  const key = stripeKey();
  const res = await fetch(`${STRIPE_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(body || {}).toString(),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error?.message || `stripe ${res.status}`);
  return json;
}

export const tenantBillingRouter = express.Router();
tenantBillingRouter.use(requireAuth, requireAdmin);

/* --------------------------------- summary ---------------------------------- */

tenantBillingRouter.get('/billing/summary', wrap(async (req, res) => {
  const tenants = await rows(`SELECT id, slug, name, plan, status FROM tenants ORDER BY id ASC`);
  const openInv = await one(
    `SELECT COUNT(*)::int AS count, COALESCE(SUM(totalusd), 0)::real AS total
     FROM tenantinvoices WHERE status IN ('open', 'draft')`,
  );
  const paidInv = await one(
    `SELECT COUNT(*)::int AS count, COALESCE(SUM(totalusd), 0)::real AS total
     FROM tenantinvoices WHERE status = 'paid'`,
  );
  // MRR estimate: base price of every active tenant + last-30d usage run-rate.
  let mrr = 0;
  const perTenant = [];
  for (const t of tenants) {
    const prices = TENANT_METERED_PRICES[t.plan] || TENANT_METERED_PRICES.free;
    let usageUsd = 0;
    try {
      const ev = await rows(
        `SELECT metric, SUM(quantity)::real AS total FROM tenantusageevents
         WHERE tenantid = $1 AND createdat > datetime('now','-30 days') GROUP BY metric`,
        [t.id],
      );
      for (const e of ev) {
        const allowance = includedAllowance(t.plan, e.metric);
        const overage = Math.max(0, num(e.total) - allowance);
        const unit =
          e.metric === 'ai_call' ? prices.aiCallUsd :
          e.metric === 'vector_index' ? prices.vectorIndexUsd :
          e.metric === 'storage_gb' ? prices.storageGbUsd : 0.0001;
        usageUsd += overage * unit;
      }
    } catch { /* fallback driver */ }
    const monthly = (t.status === 'active' ? prices.baseusd : 0) + usageUsd;
    mrr += monthly;
    perTenant.push({ slug: t.slug, name: t.name, plan: t.plan, status: t.status, monthlyEstimateUsd: Number(monthly.toFixed(2)) });
  }
  res.json({
    ok: true,
    mode: stripeKey() ? 'stripe-live' : 'stripe-sandbox',
    mrrEstimateUsd: Number(mrr.toFixed(2)),
    tenants: perTenant,
    invoices: {
      open: { count: num(openInv?.count), totalUsd: num(openInv?.total) },
      paid: { count: num(paidInv?.count), totalUsd: num(paidInv?.total) },
    },
  });
}));

/* -------------------------------- invoices ---------------------------------- */

tenantBillingRouter.get('/billing/invoices', wrap(async (req, res) => {
  const list = await rows(
    `SELECT i.*, t.slug AS tenantslug, t.name AS tenantname
     FROM tenantinvoices i JOIN tenants t ON t.id = i.tenantid
     ORDER BY i.createdat DESC LIMIT 200`,
  );
  res.json({
    invoices: list.map((i) => ({
      id: i.id, tenant: i.tenantslug, tenantname: i.tenantname,
      periodstart: i.periodstart, periodend: i.periodend, status: i.status,
      baseusd: i.baseusd, usageusd: i.usageusd, totalusd: i.totalusd,
      lines: typeof i.lines === 'string' ? JSON.parse(i.lines || '[]') : i.lines || [],
      stripeinvoiceid: i.stripeinvoiceid, createdat: i.createdat,
    })),
  });
}));

tenantBillingRouter.get('/billing/invoices/:tenant', wrap(async (req, res) => {
  const tenant = await tenantOr404(req, res, req.params.tenant);
  if (!tenant) return;
  const list = await rows(
    `SELECT * FROM tenantinvoices WHERE tenantid = $1 ORDER BY createdat DESC LIMIT 100`,
    [tenant.id],
  );
  res.json({
    tenant: serializeTenant(tenant),
    invoices: list.map((i) => ({
      id: i.id, tenant: tenant.slug, periodstart: i.periodstart, periodend: i.periodend, status: i.status,
      baseusd: i.baseusd, usageusd: i.usageusd, totalusd: i.totalusd,
      lines: typeof i.lines === 'string' ? JSON.parse(i.lines || '[]') : i.lines || [],
      stripeinvoiceid: i.stripeinvoiceid, createdat: i.createdat,
    })),
  });
}));

/**
 * POST /billing/invoices/:tenant/generate — metered invoice for a window
 * (default: last calendar month). Sums usage events, applies the plan's
 * included allowance + unit prices, adds the base price.
 */
tenantBillingRouter.post('/billing/invoices/:tenant/generate', wrap(async (req, res) => {
  const tenant = await tenantOr404(req, res, req.params.tenant);
  if (!tenant) return;
  const { periodStart, periodEnd } = req.body || {};
  let start = periodStart ? new Date(periodStart) : new Date(Date.now() - 30 * 24 * 3600 * 1000);
  let end = periodEnd ? new Date(periodEnd) : new Date();
  if (isNaN(start.getTime()) || isNaN(end.getTime()) || start >= end) {
    return res.status(400).json({ error: 'periodStart must precede periodEnd (ISO strings)' });
  }

  const prices = TENANT_METERED_PRICES[tenant.plan] || TENANT_METERED_PRICES.free;
  const events = await rows(
    `SELECT metric, SUM(quantity)::real AS total, COUNT(*)::int AS events
     FROM tenantusageevents
     WHERE tenantid = $1 AND createdat >= $2 AND createdat < $3
     GROUP BY metric`,
    [tenant.id, start.toISOString(), end.toISOString()],
  );

  const lines = [{ kind: 'base', label: `${tenant.plan} plan base`, quantity: 1, unitusd: prices.baseusd, amountusd: prices.baseusd }];
  let usageUsd = 0;
  for (const e of events) {
    const total = num(e.total);
    const allowance = includedAllowance(tenant.plan, e.metric);
    const billable = Math.max(0, total - allowance);
    const unit = e.metric === 'ai_call' ? prices.aiCallUsd
      : e.metric === 'vector_index' ? prices.vectorIndexUsd
      : e.metric === 'storage_gb' ? prices.storageGbUsd
      : 0.0001;
    const amount = Number((billable * unit).toFixed(4));
    usageUsd += amount;
    lines.push({
      kind: 'usage', metric: e.metric, quantity: total, events: num(e.events),
      included: allowance, billable, unitusd: unit, amountusd: amount,
    });
  }
  const totalUsd = Number((prices.baseusd + usageUsd).toFixed(2));

  let stripeinvoiceid = null;
  let stripeError = null;
  if (stripeKey() && tenant.stripecustomerid) {
    try {
      // One invoice item per usage line with quantity, then a Stripe invoice.
      for (const line of lines.filter((l) => l.kind === 'usage' && l.billable > 0)) {
        await stripeRequest('POST', '/v1/invoiceitems', {
          customer: tenant.stripecustomerid,
          description: `${tenant.slug} ${line.metric} overage (${Math.round(line.billable)} units)`,
          quantity: String(Math.max(1, Math.round(line.billable))),
          unit_amount: String(Math.round(line.unitusd * 100)),
          currency: 'usd',
        });
      }
      const inv = await stripeRequest('POST', '/v1/invoices', {
        customer: tenant.stripecustomerid,
        auto_advance: 'false',
        description: `Animaxia ${tenant.plan} plan (${start.toISOString().slice(0, 10)} → ${end.toISOString().slice(0, 10)})`,
      });
      stripeinvoiceid = inv?.id || null;
    } catch (err) {
      stripeError = err.message;
      logger.warn(`[tenant-billing] stripe push failed for '${tenant.slug}': ${err.message}`);
    }
  }

  const inserted = await one(
    `INSERT INTO tenantinvoices (tenantid, periodstart, periodend, status, baseusd, usageusd, totalusd, lines, stripeinvoiceid)
     VALUES ($1, $2, $3, 'open', $4, $5, $6, $7::jsonb, $8) RETURNING id`,
    [tenant.id, start.toISOString(), end.toISOString(), prices.baseusd, Number(usageUsd.toFixed(4)), totalUsd,
      jsonb({ lines, stripe: stripeinvoiceid ? 'pushed' : stripeError ? `error: ${stripeError}` : 'local-only' }), stripeinvoiceid],
  );
  await auditLog({ userid: req.user.id, action: 'tenant.billing.invoice.generate', ip: clientIpOf(req), meta: { tenant: tenant.slug, totalUsd, stripeinvoiceid } });
  return res.status(201).json({
    ok: true,
    invoice: {
      id: num(inserted?.id), tenant: tenant.slug, plan: tenant.plan,
      periodstart: start.toISOString(), periodend: end.toISOString(), status: 'open',
      baseusd: prices.baseusd, usageusd: Number(usageUsd.toFixed(4)), totalusd: totalUsd,
      lines, stripeinvoiceid, stripeerror: stripeError,
    },
  });
}));

/** POST /billing/invoices/:id/void — hmm, :id vs :tenant above: this route is
 *  longer so Express matches it after the literal generate route; ids are
 *  numeric, tenant slugs cannot start with a digit-ONLY pattern conflict is
 *  avoided by requiring the segment to be numeric. */
tenantBillingRouter.post('/billing/invoices/:id/void', wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invoice id must be a positive integer' });
  }
  const updated = await one(
    `UPDATE tenantinvoices SET status = 'void' WHERE id = $1 AND status = 'open' RETURNING id, totalusd`,
    [id],
  );
  if (!updated) return res.status(404).json({ error: `No open invoice #${id}` });
  await auditLog({ userid: req.user.id, action: 'tenant.billing.invoice.void', ip: clientIpOf(req), meta: { invoiceid: id } });
  res.json({ ok: true, voided: id });
}));

/* --------------------------------- usage ------------------------------------ */

tenantBillingRouter.post('/billing/usage', wrap(async (req, res) => {
  const { tenant: slug, metric, quantity = 1, unit = 'count', meta = null } = req.body || {};
  const tenant = await getTenantBySlug(slug);
  if (!tenant || tenant.isfallback) {
    return res.status(404).json({ error: `Tenant '${slug}' not found`, code: 'TENANT_NOT_FOUND' });
  }
  if (!METRICS.includes(metric)) {
    return res.status(400).json({ error: `metric must be one of: ${METRICS.join(', ')}` });
  }
  await rows(
    `INSERT INTO tenantusageevents (tenantid, userid, metric, quantity, unit, meta)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [tenant.id, req.user?.id ?? null, metric, Number(quantity) || 0, String(unit), jsonb(meta || {})],
  );
  res.status(201).json({ ok: true, tenant: tenant.slug, metric, quantity: Number(quantity) || 0 });
}));

/* ------------------------------ plan upgrades ------------------------------- */

tenantBillingRouter.post('/billing/plan', wrap(async (req, res) => {
  const { tenant: slug, plan } = req.body || {};
  const tenant = await tenantOr404(req, res, slug);
  if (!tenant) return;
  if (!TENANT_PLAN_LIMITS[plan]) {
    return res.status(400).json({ error: `Unknown plan '${plan}' — use one of: ${Object.keys(TENANT_PLAN_LIMITS).join(', ')}` });
  }
  if (tenant.slug === 'global' && plan !== tenant.plan) {
    return res.status(400).json({ error: "The 'global' tenant plan is fixed (platform default)" });
  }
  const direction = (TENANT_METERED_PRICES[plan] || TENANT_METERED_PRICES.free).baseusd >
    (TENANT_METERED_PRICES[tenant.plan] || TENANT_METERED_PRICES.free).baseusd ? 'upgrade' : 'change';
  const limits = TENANT_PLAN_LIMITS[plan];
  await rows(`UPDATE tenants SET plan = $2, updatedat = NOW() WHERE id = $1`, [tenant.id, plan]);
  await rows(
    `UPDATE tenantlimits SET maxusers=$2, aiperday=$3, ratelimitpermin=$4, vectorcollections=$5, storagegb=$6, updatedat=NOW()
     WHERE tenantid=$1`,
    [tenant.id, limits.maxusers, limits.aiperday, limits.ratelimitpermin, limits.vectorcollections, limits.storagegb],
  );
  invalidateTenantCache(tenant.slug);
  await auditLog({ userid: req.user.id, action: 'tenant.billing.plan', ip: clientIpOf(req), meta: { tenant: tenant.slug, from: tenant.plan, to: plan, direction } });
  logger.info(`[tenant-billing] ${direction} '${tenant.slug}': ${tenant.plan} → ${plan} by ${req.user.email}`);
  const fresh = await getTenantBySlug(tenant.slug);
  return res.json({ ok: true, direction, from: tenant.plan, to: plan, tenant: serializeTenant(fresh) });
}));

/* ---------------------------- stripe customer link --------------------------- */

tenantBillingRouter.post('/billing/customer', wrap(async (req, res) => {
  const { tenant: slug, stripecustomerid } = req.body || {};
  const tenant = await tenantOr404(req, res, slug);
  if (!tenant) return;
  if (!stripecustomerid || !String(stripecustomerid).startsWith('cus_')) {
    return res.status(400).json({ error: 'stripecustomerid must look like cus_…' });
  }
  await rows(`UPDATE tenants SET stripecustomerid = $2, updatedat = NOW() WHERE id = $1`, [tenant.id, String(stripecustomerid)]);
  invalidateTenantCache(tenant.slug);
  await auditLog({ userid: req.user.id, action: 'tenant.billing.customer.link', ip: clientIpOf(req), meta: { tenant: tenant.slug, stripecustomerid } });
  const fresh = await getTenantBySlug(tenant.slug);
  res.json({ ok: true, tenant: serializeTenant(fresh) });
}));

export default tenantBillingRouter;
