# animaxia-tenant — FAZA 11: Multi-Tenant & Enterprise Scaling

FAZA 11 turns the Animaxia platform into a multi-tenant SaaS: tenant registry
with enforceable limits, tenant-aware JWT signing/verification, per-tenant AI
Cloud quotas and vector namespaces, per-tenant edge caches/rate buckets/
allowlists, a Tenant Admin Console (`#/admin/tenants`) and metered billing
(usage events → invoices → plan upgrades).

**Strictly additive** — every pre-FAZA-11 contract is frozen. Anonymous and
legacy traffic belongs to the implicit `global` tenant and behaves exactly as
before (byte-identical cache/rate keys, same token verification path).

## Contents

```
animaxia-tenant/
├── monolith-modules/tenant/     # mirrors of mini-services/animaxia-backend/modules/tenant/
│   ├── tenant-migrations.js     # idempotent DDL + seed (global + demo tenants)
│   ├── core.js                  # registry cache, resolveTenantOf, usage events
│   ├── jwt-tenant.js            # per-tenant derived secrets + dual-path verify
│   ├── tenant-routes.js         # admin CRUD + /api/tenant/whoami
│   ├── ai-quota.js              # tenant AI pool stacked over the user/plan pool
│   ├── tenant-vector.js         # per-tenant vector namespaces (pgvector + memory)
│   ├── tenant-ai.js             # /api/ai/tenant/* (status, rag/:mode, vector, usage)
│   └── billing.js               # metered billing (/api/tenants/billing/*)
├── tests/smoke-tenant.mjs       # 55-check live end-to-end suite (monolith :4000)
├── package.json
└── README.md
```

The **tenant-aware edge layer** lives in the `animaxia-edge/` ZIP prefix:
`shared/tenant.ts` (new) + tenant extensions in the gateway/ai/auth/search/
player workers and `shared/jwt.ts` (dual-path verify), tested hermetically by
`animaxia-edge/tests/tenant-edge.mjs` (54 checks; run from `animaxia-edge/`).

## Data model (Neon, additive)

| table | purpose |
|---|---|
| `tenants` | registry: slug, name, plan (free/starter/business/enterprise), Stripe customer |
| `tenantusers` | membership + tenant role (owner/admin/member), PK (tenantid, userid) |
| `tenantlimits` | enforceable limits: maxusers, aiperday, ratelimitpermin, vectorcollections, storagegb, overageallowed |
| `tenantconfig` | config + features + playerallowlist (media types) |
| `tenantusageevents` | append-only metered usage (ai_call / vector_index / storage_gb / api_request) |
| `tenantinvoices` | generated metered invoices (base + overage lines) |

Additive columns: `vectorembeddings.tenantid TEXT NOT NULL DEFAULT 'global'`
(per-tenant namespaces via namespaced refkeys `t:<slug>:<kind>:<refid>:0`) and
`refreshtokens.tenantid` (tenant-aware refresh rotation). Seed: `global`
(enterprise, the implicit default) + `demo` (starter).

## API surface (monolith :4000)

```
GET    /api/tenants                        admin — list + 30d usage rollups
POST   /api/tenants                        admin — create { slug, name, plan }
GET    /api/tenants/:slug                  admin — detail + members
PATCH  /api/tenants/:slug/limits           admin — edit enforceable limits
PATCH  /api/tenants/:slug/config           admin — config/features/allowlist
POST   /api/tenants/:slug/users            admin — add member (maxusers → 402)
DELETE /api/tenants/:slug/users/:userid    admin — remove member
GET    /api/tenants/:slug/usage?days=30    admin — usage rollup
GET    /api/tenant/whoami                  auth  — caller's tenant context

GET    /api/ai/tenant/status               tenant AI + quota + vector snapshot
POST   /api/ai/tenant/rag/:mode            tenant-scoped RAG (recommend|summarize|explain|chat)
POST   /api/ai/tenant/vector/search        tenant-scoped similarity search
POST   /api/ai/tenant/vector/index         admin — (re)index the tenant namespace
GET    /api/ai/tenant/usage                metered usage rollup + recent events

GET    /api/tenants/billing/summary        admin — MRR estimate + invoice totals
GET    /api/tenants/billing/invoices       admin — all invoices
GET    /api/tenants/billing/invoices/:t    admin — per-tenant invoices
POST   /api/tenants/billing/invoices/:t/generate  admin — metered invoice
POST   /api/tenants/billing/usage          admin — record a usage event
POST   /api/tenants/billing/plan           admin — upgrade/downgrade plan
POST   /api/tenants/billing/customer       admin — link Stripe customer
```

Tenant resolution (monolith + edge, same priority): `X-Animaxia-Tenant` header
→ verified JWT `tenant` claim → user membership → `global`.

## Tenant-aware JWT (strict policy)

- Tenant secret = `sha256(baseSecret + ':tenant:' + slug)`; `global` and every
  pre-FAZA-11 token keep the base secret.
- `verifyTenantJwt` dual-path: base secret first (hot path), then the
  tenant-derived secret selected via the still-untrusted claim — accepted only
  after a timing-safe signature match.
- **Strict rule**: a base-signed token carrying a NON-global `tenant` claim is
  rejected — tenant claims must be backed by the tenant secret.
- Refresh rotation keeps the tenant (`refreshtokens.tenantid`); the edge
  mirrors the exact derivation (`animaxia-edge/shared/jwt.ts`).

## Metered billing

Usage events (written by the AI quota layer + the usage API) are the meter.
Invoice generation sums events in a window, deducts the plan's included
allowance (`aiperday × 30` for AI calls, etc.), bills overage at plan unit
prices (`TENANT_METERED_PRICES`), adds the plan base. Sandbox mode by default;
with `STRIPESECRETKEY` (sk_…) invoice generation also pushes invoice items +
an invoice onto the linked Stripe customer (best-effort, failures degrade to
local-only). Plan upgrades reset limits to the new plan's defaults; the
`global` tenant plan is fixed.

## Running the tests

```bash
# live monolith smoke (needs :4000 up, Neon driver active)
cd animaxia-tenant && bun install && bun test

# hermetic edge tenant suite (no network)
cd ../animaxia-edge && bun tests/tenant-edge.mjs
```

Smoke results at delivery: **55/55** (monolith) + **54/54** (edge tenant
suite) + **159/159** (edge smoke regression).

## ZIP provenance (additive discipline)

New prefix `animaxia-tenant/` (this bundle). Documented UPDATED entries in the
existing `animaxia-edge/` prefix (FAZA 9 precedent — files legitimately
extended by the phase): `shared/jwt.ts`, `shared/types.ts`,
`worker/src/index.ts`, `ai/src/index.ts`, `auth/src/index.ts`,
`search/src/index.ts`, `search/src/catalog.ts`, `player/src/index.ts` + the
new `shared/tenant.ts` and `tests/tenant-edge.mjs`. Every other entry is
byte-identical to the FAZA 10 ZIP.
