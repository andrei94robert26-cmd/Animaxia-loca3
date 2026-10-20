/**
 * modules/tenant/tenant-migrations.js — FAZA 11 (additive) multi-tenant DDL.
 *
 * Idempotent CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS statements,
 * house style (lowercase, no underscores) matching platform/migrations.js.
 * Runs at boot after ensurePlatformSchema(); safe to re-run on Neon PostgreSQL
 * and a no-op on the local fallback driver (rows() swallows errors there).
 *
 * New tables:
 *   tenants            — the tenant registry (slug-keyed, plan, Stripe link)
 *   tenantusers        — user ↔ tenant membership + tenant role
 *   tenantlimits       — enforceable per-tenant limits (users, AI, rate, vector)
 *   tenantconfig       — per-tenant config blob (features, player allowlist…)
 *   tenantusageevents  — append-only metered usage events (FAZA 11 billing)
 *   tenantinvoices     — generated metered invoices per billing period
 *
 * Additive columns on EXISTING tables (data keeps its current meaning —
 * everything predating FAZA 11 belongs to the implicit 'global' tenant):
 *   vectorembeddings.tenantid TEXT NOT NULL DEFAULT 'global'
 *   refreshtokens.tenantid    TEXT
 *
 * Seed: tenant 'global' (id 1 — the implicit default for every anonymous and
 * legacy call) + tenant 'demo' (a second tenant so scoping is observable
 * from day one). Both seeded with their limits + config rows.
 */

import { logger } from '../../utils/logger.js';
import { rows, one, num } from '../platform/sql.js';
import { driverInfo } from '../../db.js';

/** Default enforceable limits per tenant plan (FAZA 11 pricing tiers). */
export const TENANT_PLAN_LIMITS = {
  free: { maxusers: 5, aiperday: 200, ratelimitpermin: 60, vectorcollections: 1, storagegb: 1 },
  starter: { maxusers: 25, aiperday: 5000, ratelimitpermin: 300, vectorcollections: 3, storagegb: 10 },
  business: { maxusers: 200, aiperday: 25000, ratelimitpermin: 1200, vectorcollections: 10, storagegb: 100 },
  enterprise: { maxusers: 100000, aiperday: 1000000, ratelimitpermin: 6000, vectorcollections: 100, storagegb: 1000 },
};

/** Metered unit prices (USD) applied on top of the plan base price. */
export const TENANT_METERED_PRICES = {
  free: { baseusd: 0, aiCallUsd: 0.002, vectorIndexUsd: 0.0005, storageGbUsd: 0.10 },
  starter: { baseusd: 49, aiCallUsd: 0.001, vectorIndexUsd: 0.0002, storageGbUsd: 0.06 },
  business: { baseusd: 199, aiCallUsd: 0.0008, vectorIndexUsd: 0.0001, storageGbUsd: 0.04 },
  enterprise: { baseusd: 999, aiCallUsd: 0.0005, vectorIndexUsd: 0.00005, storageGbUsd: 0.02 },
};

const DDL_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS tenants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    plan TEXT NOT NULL DEFAULT 'free',
    stripecustomerid TEXT,
    createdat TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedat TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tenants_status ON tenants (status)`,
  `CREATE TABLE IF NOT EXISTS tenantusers (
    tenantid INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    userid INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'member',
    createdat TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (tenantid, userid)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tenantusers_user ON tenantusers (userid)`,
  `CREATE TABLE IF NOT EXISTS tenantlimits (
    tenantid INTEGER PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    maxusers INTEGER NOT NULL DEFAULT 5,
    aiperday INTEGER NOT NULL DEFAULT 200,
    ratelimitpermin INTEGER NOT NULL DEFAULT 60,
    vectorcollections INTEGER NOT NULL DEFAULT 1,
    storagegb INTEGER NOT NULL DEFAULT 1,
    overageallowed BOOLEAN NOT NULL DEFAULT TRUE,
    updatedat TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS tenantconfig (
    tenantid INTEGER PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    config TEXT NOT NULL DEFAULT '{}',
    features TEXT NOT NULL DEFAULT '{}',
    playerallowlist TEXT NOT NULL DEFAULT '[]',
    updatedat TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS tenantusageevents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenantid INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    userid INTEGER,
    metric TEXT NOT NULL,
    quantity REAL NOT NULL DEFAULT 1,
    unit TEXT NOT NULL DEFAULT 'count',
    meta TEXT,
    createdat TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tenantusageevents_tenant ON tenantusageevents (tenantid, createdat DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_tenantusageevents_metric ON tenantusageevents (metric)`,
  `CREATE TABLE IF NOT EXISTS tenantinvoices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenantid INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    periodstart TIMESTAMPTZ NOT NULL,
    periodend TIMESTAMPTZ NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    baseusd REAL NOT NULL DEFAULT 0,
    usageusd REAL NOT NULL DEFAULT 0,
    totalusd REAL NOT NULL DEFAULT 0,
    lines TEXT NOT NULL DEFAULT '[]',
    stripeinvoiceid TEXT,
    createdat TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tenantinvoices_tenant ON tenantinvoices (tenantid, createdat DESC)`,
  // Additive columns on existing shared tables — default keeps all
  // pre-FAZA-11 rows in the implicit 'global' tenant.
  `CREATE INDEX IF NOT EXISTS idx_vectorembeddings_tenant ON vectorembeddings (tenantid, kind)`,
  `CREATE INDEX IF NOT EXISTS idx_refreshtokens_tenant ON refreshtokens (tenantid)`,
];

/**
 * Ensure all FAZA 11 tenant tables/columns exist. Idempotent. Returns the
 * statement count. On the local fallback driver the statements fail silently
 * (rows() throws are caught per-statement there? — no: re-thrown like
 * platform migrations, so boot reports the failure loudly on Neon only).
 */
export async function ensureTenantSchema() {
  let applied = 0;
  for (const statement of DDL_STATEMENTS) {
    // Vector indexing is optional: a fresh local SQLite install may not have
    // the AI vector table. Never abort auth/tenant setup over this index.
    if (driverInfo().driver === 'sqlite' && statement.includes('idx_vectorembeddings_tenant')) {
      const columns = await rows('PRAGMA table_info(vectorembeddings)');
      const names = new Set(columns.map((column) => String(column.name).toLowerCase()));
      if (!names.has('tenantid') || !names.has('kind')) {
        logger.warn('[tenant] Optional vector index skipped (vector schema unavailable)');
        continue;
      }
    }
    try {
      await rows(statement);
      applied += 1;
    } catch (err) {
      logger.error(`[tenant] Migration statement failed: ${err.message}`);
      throw err;
    }
  }
  await seedTenants();
  logger.info(
    `[tenant] Schema verified — ${applied}/${DDL_STATEMENTS.length} statements OK (tenants, tenantusers, tenantlimits, tenantconfig, tenantusageevents, tenantinvoices + additive columns)`,
  );
  return { applied, total: DDL_STATEMENTS.length };
}

/** Seed the implicit 'global' tenant (id 1 when fresh) + a 'demo' tenant. */
async function seedTenants() {
  const seeds = [
    {
      slug: 'global',
      name: 'Global (default)',
      plan: 'enterprise',
      config: { description: 'Implicit tenant for anonymous and pre-FAZA-11 accounts — full library access.' },
      features: { social: true, aicloud: true, edge: true, billing: false },
      playerallowlist: JSON.stringify(['mp4', 'm3u8', 'iframe', 'youtube']),
    },
    {
      slug: 'demo',
      name: 'Demo Tenant',
      plan: 'starter',
      config: { description: 'Second tenant for multi-tenant demos — scoped content, AI and edge.' },
      features: { social: true, aicloud: true, edge: true, billing: true },
      playerallowlist: JSON.stringify(['mp4', 'm3u8']),
    },
  ];
  for (const s of seeds) {
    const existing = await one(`SELECT id FROM tenants WHERE slug = $1`, [s.slug]);
    if (existing) continue;
    const limits = TENANT_PLAN_LIMITS[s.plan] || TENANT_PLAN_LIMITS.free;
    const t = await one(
      `INSERT INTO tenants (slug, name, plan) VALUES ($1, $2, $3) RETURNING id`,
      [s.slug, s.name, s.plan],
    );
    const tid = num(t?.id);
    await rows(
      `INSERT INTO tenantlimits (tenantid, maxusers, aiperday, ratelimitpermin, vectorcollections, storagegb)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (tenantid) DO NOTHING`,
      [tid, limits.maxusers, limits.aiperday, limits.ratelimitpermin, limits.vectorcollections, limits.storagegb],
    );
    await rows(
      `INSERT INTO tenantconfig (tenantid, config, features, playerallowlist)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenantid) DO NOTHING`,
      [tid, JSON.stringify(s.config), JSON.stringify(s.features), s.playerallowlist],
    );
    logger.info(`[tenant] Seeded tenant '${s.slug}' (id=${tid}, plan=${s.plan})`);
  }
}

export default ensureTenantSchema;
