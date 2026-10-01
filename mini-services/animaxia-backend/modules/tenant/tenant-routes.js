/**
 * modules/tenant/tenant-routes.js — FAZA 11 tenant management API (additive).
 *
 * Two routers mounted by server.js:
 *   app.use('/api/tenants', tenantAdminRouter, tenantBillingRouter)
 *     — billing router is defined in billing.js and mounted AFTER the admin
 *       router's literal /billing/* paths but BEFORE /:slug (order handled in
 *       server.js: tenantAdminRouter defines literal paths only, the :slug
 *       catch-alls live in tenantSlugRouter mounted last).
 *   app.use('/api/tenant', tenantContextRouter) — whoami context (any user)
 *
 * tenantAdminRouter (all requireAuth + requireAdmin unless noted):
 *   GET    /                     — list tenants with 30d usage rollups
 *   POST   /                     — create tenant { slug, name, plan? }
 *   GET    /billing/summary      — (defined in billing.js)
 *   GET    /:slug                — tenant detail + usage
 *   PATCH  /:slug/limits         — edit enforceable limits
 *   PATCH  /:slug/config         — edit config/features/playerallowlist
 *   POST   /:slug/users          — add membership { email, role? }
 *   DELETE /:slug/users/:userid  — remove membership
 *   GET    /:slug/usage          — usage rollup ?days=30
 *
 * tenantContextRouter (requireAuth — the tenant of the caller):
 *   GET    /whoami               — caller's tenant + memberships + limits
 *
 * Every mutation writes an auditLog entry and invalidates the registry cache.
 * The 'global' tenant cannot be deleted or renamed (it is the platform
 * default); its limits stay editable.
 */

import express from 'express';
import { one, rows, num, jsonb } from '../platform/sql.js';
import { requireAuth, requireAdmin } from '../users/auth.js';
import { auditLog, clientIpOf } from '../security/security.js';
import { logger } from '../../utils/logger.js';
import {
  getTenantBySlug,
  resolveTenantOf,
  serializeTenant,
  invalidateTenantCache,
  tenantUsageRollup,
  tenantsOfUser,
  GLOBAL_TENANT_SLUG,
} from './core.js';
import { TENANT_PLAN_LIMITS } from './tenant-migrations.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

/* ------------------------------ admin router -------------------------------- */

export const tenantAdminRouter = express.Router();
tenantAdminRouter.use(requireAuth, requireAdmin);

/** GET /api/tenants — every tenant + user counts + usage rollup. */
tenantAdminRouter.get('/', wrap(async (req, res) => {
  const list = await rows(
    `SELECT t.*, l.maxusers, l.aiperday, l.ratelimitpermin, l.vectorcollections, l.storagegb, l.overageallowed,
            c.config, c.features, c.playerallowlist,
            (SELECT COUNT(*) FROM tenantusers tu WHERE tu.tenantid = t.id) AS usercount
     FROM tenants t
     LEFT JOIN tenantlimits l ON l.tenantid = t.id
     LEFT JOIN tenantconfig c ON c.tenantid = t.id
     ORDER BY t.id ASC`,
  );
  const tenants = [];
  for (const row of list) {
    const t = serializeTenant({
      ...row,
      limits: {
        maxusers: row.maxusers, aiperday: row.aiperday, ratelimitpermin: row.ratelimitpermin,
        vectorcollections: row.vectorcollections, storagegb: row.storagegb, overageallowed: row.overageallowed,
      },
    });
    t.usercount = num(row.usercount);
    t.usage = await tenantUsageRollup(t.id, 30);
    tenants.push(t);
  }
  res.json({ tenants, total: tenants.length });
}));

/** POST /api/tenants — create a tenant (plan-seeded limits + empty config). */
tenantAdminRouter.post('/', wrap(async (req, res) => {
  const { slug, name, plan = 'free' } = req.body || {};
  if (!slug || !SLUG_RE.test(String(slug))) {
    return res.status(400).json({ error: 'Tenant slug must be 3-40 chars: lowercase letters, digits, hyphens (no leading/trailing hyphen)' });
  }
  if (!name || String(name).length > 80) {
    return res.status(400).json({ error: 'Tenant name is required (max 80 chars)' });
  }
  if (!TENANT_PLAN_LIMITS[plan]) {
    return res.status(400).json({ error: `Unknown plan '${plan}' — use one of: ${Object.keys(TENANT_PLAN_LIMITS).join(', ')}` });
  }
  const existing = await one(`SELECT id FROM tenants WHERE slug = $1`, [String(slug)]);
  if (existing) {
    return res.status(409).json({ error: `Tenant '${slug}' already exists`, code: 'TENANT_EXISTS' });
  }
  const limits = TENANT_PLAN_LIMITS[plan];
  const t = await one(`INSERT INTO tenants (slug, name, plan) VALUES ($1, $2, $3) RETURNING id`, [String(slug), String(name), String(plan)]);
  const tid = num(t?.id);
  await rows(
    `INSERT INTO tenantlimits (tenantid, maxusers, aiperday, ratelimitpermin, vectorcollections, storagegb)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [tid, limits.maxusers, limits.aiperday, limits.ratelimitpermin, limits.vectorcollections, limits.storagegb],
  );
  await rows(
    `INSERT INTO tenantconfig (tenantid, config, features, playerallowlist)
     VALUES ($1, '{}', $2, '["mp4","m3u8"]')`,
    [tid, jsonb({ social: true, aicloud: true, edge: true, billing: plan !== 'free' })],
  );
  await auditLog({ userid: req.user.id, action: 'tenant.create', ip: clientIpOf(req), meta: { slug, plan, tenantid: tid } });
  invalidateTenantCache(slug);
  const tenant = await getTenantBySlug(slug);
  logger.info(`[tenant] Created tenant '${slug}' (plan=${plan}, id=${tid}) by ${req.user.email}`);
  return res.status(201).json({ ok: true, tenant: serializeTenant(tenant) });
}));

/** GET /api/tenants/:slug — detail + membership list + usage. */
tenantAdminRouter.get('/:slug', wrap(async (req, res) => {
  const tenant = await getTenantBySlug(req.params.slug);
  if (!tenant || tenant.isfallback) {
    return res.status(404).json({ error: `Tenant '${req.params.slug}' not found`, code: 'TENANT_NOT_FOUND' });
  }
  const members = await rows(
    `SELECT tu.userid, u.email, u.username, tu.role, tu.createdat
     FROM tenantusers tu JOIN users u ON u.id = tu.userid
     WHERE tu.tenantid = $1 ORDER BY tu.createdat ASC`,
    [tenant.id],
  );
  const usage = await tenantUsageRollup(tenant.id, 30);
  return res.json({ tenant: serializeTenant(tenant, usage), members });
}));

/** PATCH /api/tenants/:slug/limits — edit enforceable limits (partial). */
tenantAdminRouter.patch('/:slug/limits', wrap(async (req, res) => {
  const tenant = await getTenantBySlug(req.params.slug);
  if (!tenant || tenant.isfallback) {
    return res.status(404).json({ error: `Tenant '${req.params.slug}' not found`, code: 'TENANT_NOT_FOUND' });
  }
  const { maxusers, aiperday, ratelimitpermin, vectorcollections, storagegb, overageallowed } = req.body || {};
  const next = {
    maxusers: maxusers ?? tenant.limits.maxusers,
    aiperday: aiperday ?? tenant.limits.aiperday,
    ratelimitpermin: ratelimitpermin ?? tenant.limits.ratelimitpermin,
    vectorcollections: vectorcollections ?? tenant.limits.vectorcollections,
    storagegb: storagegb ?? tenant.limits.storagegb,
    overageallowed: overageallowed ?? tenant.limits.overageallowed,
  };
  for (const key of ['maxusers', 'aiperday', 'ratelimitpermin', 'vectorcollections', 'storagegb']) {
    const v = Number(next[key]);
    if (!Number.isFinite(v) || v < 0) return res.status(400).json({ error: `${key} must be a non-negative number` });
    next[key] = Math.floor(v);
  }
  await rows(
    `UPDATE tenantlimits SET maxusers=$2, aiperday=$3, ratelimitpermin=$4, vectorcollections=$5, storagegb=$6,
            overageallowed=$7, updatedat=CURRENT_TIMESTAMP
     WHERE tenantid=$1`,
    [tenant.id, next.maxusers, next.aiperday, next.ratelimitpermin, next.vectorcollections, next.storagegb, next.overageallowed !== false],
  );
  await auditLog({ userid: req.user.id, action: 'tenant.limits.update', ip: clientIpOf(req), meta: { slug: tenant.slug, ...next } });
  invalidateTenantCache(tenant.slug);
  const fresh = await getTenantBySlug(tenant.slug);
  return res.json({ ok: true, tenant: serializeTenant(fresh) });
}));

/** PATCH /api/tenants/:slug/config — edit config / features / player allowlist. */
tenantAdminRouter.patch('/:slug/config', wrap(async (req, res) => {
  const tenant = await getTenantBySlug(req.params.slug);
  if (!tenant || tenant.isfallback) {
    return res.status(404).json({ error: `Tenant '${req.params.slug}' not found`, code: 'TENANT_NOT_FOUND' });
  }
  const { config, features, playerallowlist } = req.body || {};
  if (config !== undefined && (typeof config !== 'object' || config === null || Array.isArray(config))) {
    return res.status(400).json({ error: 'config must be a JSON object' });
  }
  if (features !== undefined && (typeof features !== 'object' || features === null || Array.isArray(features))) {
    return res.status(400).json({ error: 'features must be a JSON object' });
  }
  if (playerallowlist !== undefined) {
    if (!Array.isArray(playerallowlist) || playerallowlist.some((t) => !['mp4', 'm3u8', 'iframe', 'youtube'].includes(t))) {
      return res.status(400).json({ error: 'playerallowlist must be an array drawn from: mp4, m3u8, iframe, youtube' });
    }
  }
  await rows(
    `UPDATE tenantconfig SET
       config = COALESCE($2, config),
       features = COALESCE($3, features),
       playerallowlist = COALESCE($4, playerallowlist),
       updatedat = CURRENT_TIMESTAMP
     WHERE tenantid = $1`,
    [tenant.id,
      config !== undefined ? jsonb(config) : null,
      features !== undefined ? jsonb(features) : null,
      playerallowlist !== undefined ? jsonb(playerallowlist) : null],
  );
  await auditLog({ userid: req.user.id, action: 'tenant.config.update', ip: clientIpOf(req), meta: { slug: tenant.slug } });
  invalidateTenantCache(tenant.slug);
  const fresh = await getTenantBySlug(tenant.slug);
  return res.json({ ok: true, tenant: serializeTenant(fresh) });
}));

/** POST /api/tenants/:slug/users — add a membership { email, role }. */
tenantAdminRouter.post('/:slug/users', wrap(async (req, res) => {
  const tenant = await getTenantBySlug(req.params.slug);
  if (!tenant || tenant.isfallback) {
    return res.status(404).json({ error: `Tenant '${req.params.slug}' not found`, code: 'TENANT_NOT_FOUND' });
  }
  const { email, role = 'member' } = req.body || {};
  if (!email) return res.status(400).json({ error: 'email is required' });
  if (!['owner', 'admin', 'member'].includes(role)) {
    return res.status(400).json({ error: "role must be one of: owner, admin, member" });
  }
  const user = await one(`SELECT id, email, username FROM users WHERE email = $1`, [String(email).toLowerCase()]);
  if (!user) return res.status(404).json({ error: `No account with email ${email}`, code: 'USER_NOT_FOUND' });
  const count = await one(`SELECT COUNT(*) AS c FROM tenantusers WHERE tenantid = $1`, [tenant.id]);
  if (num(count?.c) >= tenant.limits.maxusers) {
    return res.status(402).json({ error: `Tenant '${tenant.slug}' is at its maxusers limit (${tenant.limits.maxusers}) — raise the limit first`, code: 'TENANT_USER_LIMIT' });
  }
  const existing = await one(`SELECT userid FROM tenantusers WHERE tenantid = $1 AND userid = $2`, [tenant.id, user.id]);
  if (existing) return res.status(409).json({ error: `${email} is already a member of '${tenant.slug}'` });
  await rows(`INSERT INTO tenantusers (tenantid, userid, role) VALUES ($1, $2, $3)`, [tenant.id, user.id, role]);
  await auditLog({ userid: req.user.id, action: 'tenant.user.add', ip: clientIpOf(req), meta: { slug: tenant.slug, email: user.email, role } });
  return res.status(201).json({ ok: true, member: { userid: user.id, email: user.email, username: user.username, role } });
}));

/** DELETE /api/tenants/:slug/users/:userid — remove a membership. */
tenantAdminRouter.delete('/:slug/users/:userid', wrap(async (req, res) => {
  const tenant = await getTenantBySlug(req.params.slug);
  if (!tenant || tenant.isfallback) {
    return res.status(404).json({ error: `Tenant '${req.params.slug}' not found`, code: 'TENANT_NOT_FOUND' });
  }
  const userid = Number(req.params.userid);
  const removed = await one(`DELETE FROM tenantusers WHERE tenantid = $1 AND userid = $2 RETURNING userid`, [tenant.id, userid]);
  if (!removed) return res.status(404).json({ error: `User ${userid} is not a member of '${tenant.slug}'` });
  await auditLog({ userid: req.user.id, action: 'tenant.user.remove', ip: clientIpOf(req), meta: { slug: tenant.slug, removeduserid: userid } });
  return res.json({ ok: true, removed: userid });
}));

/** GET /api/tenants/:slug/usage?days=30 — usage rollup. */
tenantAdminRouter.get('/:slug/usage', wrap(async (req, res) => {
  const tenant = await getTenantBySlug(req.params.slug);
  if (!tenant || tenant.isfallback) {
    return res.status(404).json({ error: `Tenant '${req.params.slug}' not found`, code: 'TENANT_NOT_FOUND' });
  }
  const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
  res.json({ tenant: tenant.slug, usage: await tenantUsageRollup(tenant.id, days) });
}));

/* ----------------------------- context router -------------------------------- */

export const tenantContextRouter = express.Router();

/** GET /api/tenant/whoami — the caller's tenant context (any authenticated user). */
tenantContextRouter.get('/whoami', requireAuth, wrap(async (req, res) => {
  const tenant = await resolveTenantOf(req);
  const memberships = await tenantsOfUser(req.user.id);
  const member = memberships.find((m) => m.slug === tenant.slug);
  res.json({
    tenant: serializeTenant(tenant),
    role: member?.role || (tenant.slug === GLOBAL_TENANT_SLUG ? 'member' : 'none'),
    memberships: memberships.map((m) => ({ slug: m.slug, name: m.name, role: m.role, joinedat: m.createdat })),
  });
}));

export default tenantAdminRouter;
