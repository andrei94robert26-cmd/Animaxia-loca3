# animaxia-sharding — FAZA 13 · Sharding & Multi-Node

Animaxia grows horizontally: the FAZA 13 layer adds a **shard model**
(FNV-1a hashes + 1-billion-id catalog ranges), a **per-shard Neon branch pool
registry**, **search + vector clusters** (fan-out → merge → rank), a
**shard-aware edge gateway** (`X-Animaxia-Shard` + shard-scoped cache keys) and
**per-shard ops** (metrics, dashboards, alerts, synthetics) — all strictly
additive, with the FAZA 1–11 contracts frozen.

```
                 tenant 'acme' (hash→3)      content id 1.5B (range→1)
                        │                           │
  edge gateway ────────►│ resolveShardFromTenantOrContent()
  X-Animaxia-Shard: 3   │                           │
  key t:acme:s3:api:…   ▼                           ▼
                 ┌───────────────────────────────────────────────┐
                 │            ANIMAXIA MONOLITH (:4000)          │
                 │                                               │
                 │  modules/sharding/model.js                    │
                 │    fnv1a · shardMap {0:neon-main,1:…}         │
                 │    computeShardIdFrom{ContentId,Tenant,       │
                 │                       VectorRef}              │
                 │  db.js registry: queryOnShard(n) ─────────┐   │
                 │    SHARD{n}URL empty → main pool          │   │
                 │    SHARD{n}URL set   → branch pool  ◄─────┘   │
                 │                                               │
                 │  services/search-cluster    services/vector-cluster
                 │    queryFTS (fan-out+merge)   query (affinity+fan-out)
                 │    indexBatch (per-shard)     upsertBatch (refkey rule)
                 │    health · ops counters      health · ops counters
                 │                                               │
                 │  content / searchdocs / vectorembeddings      │
                 │    + shardid INT NOT NULL DEFAULT 0           │
                 │                                               │
                 │  /api/shards · /api/shards/health             │
                 │  /api/metrics (+30 shard/cluster gauges)      │
                 └───────────────────────────────────────────────┘
                        │                           │
   ops: db-shards.json ►│ dashboard                 │◄ alerts:
   ShardDown (critical) │ per-shard pool/errors/    │  SearchClusterNodeDown
   synthetics suite     │ latency panels            │  (warning, 5m)
   "shards" (11 checks) └───────────────────────────┘
```

## Sharding model (pinned in worklog 13-0)

| Rule | Function | Shard |
|---|---|---|
| Catalog ranges (1B ids each) | `computeShardIdFromContentId(id)` = `floor(id / 1e9) % N` | ids 0–999,999,999 → 0; 1B–1.999B → 1; wraps modulo N. All current SERIAL ids → shard 0 (legacy-compatible). |
| Vector shards per tenant | `computeShardIdFromTenant(t)` = `fnv1a('tenant:'+t) % N` | query-side affinity (the row-placement rule stays the refkey hash — no split-brain). |
| Vector ref placement | `computeShardIdFromVectorRef(refkey)` = `fnv1a('vectorref:'+refkey) % N` | stamps `vectorembeddings.shardid` and routes cluster upserts — one rule everywhere. |
| Search shards per index | `searchdocs.shardid` = catalog range shard of `contentid` | per-node `AND shardid = $n` scoping, fan-out + merge. |

**Logical vs physical mode**: `SHARD{n}URL` empty (default) → every shard's
queries resolve to the main pool with `shardid` scoping — real fan-out code,
one physical Neon branch. Setting a branch URL activates physical isolation
for that shard with **zero code changes**; a down branch falls back to the
main pool (never a failed read).

## Module inventory

| File (this staging dir) | Live counterpart | Purpose |
|---|---|---|
| `monolith-modules/sharding/model.js` | `mini-services/animaxia-backend/modules/sharding/model.js` | Pure sharding model: hashes, shard map, `resolveShardFromRequest`, snapshot. |
| `monolith-modules/sharding/migrations.js` | same path in the monolith | Idempotent `shardid` columns + indexes on `content`, `searchdocs`, `vectorembeddings` (existing rows keep default 0 = legacy seed); `shardingSchemaStatus()`. |
| `monolith-modules/sharding/routes.js` | same path in the monolith | `GET /api/shards` (composite status), `GET /api/shards/health` (synthetics shape), `POST /api/shards/reindex` (admin). |
| `monolith-modules/ops/metrics.js` | `modules/ops/metrics.js` | FAZA 13 addition: `registerShardingCollectors` + 30 shard/cluster Prometheus gauges (FAZA 9 lines untouched). |
| `services/search-cluster/index.js` | `mini-services/animaxia-backend/services/search-cluster/` | FTS cluster: one node per shard, `queryFTS` (single-flight, fan-out/targeted, merge, offset-cap mirror), `indexBatch`, `health`, ops snapshot. |
| `services/vector-cluster/index.js` | `…/services/vector-cluster/` | pgvector cluster: tenant/shard affinity-first + completion fan-out, `upsertBatch` (refkey rule), `health`, ops snapshot. |
| `services/README.md` | same | The two cluster services documented. |
| `frontend/src/lib/animaxia/sharding.ts` | `src/lib/animaxia/sharding.ts` | Typed public client for `/api/shards(+/health)`. |
| `frontend/src/components/animaxia/admin/admin-shards-tab.tsx` | same | Shard Console: summary cards, per-shard table (pool/search/vector health), Healthy/Degraded/Down chips, 15s auto-refresh. |
| `frontend/src/components/animaxia/views/admin-view.tsx` | same | Tab wiring + `#/admin/shards` deep-link (controlled Tabs, FAZA 11 pattern). |
| `ops-mirror/*` | `animaxia-ops/*` | Refreshed ops entries: `dashboards/db-shards.json`, `alerts/alerts.yaml` (+2 rules), runbooks ×2, `synthetics/run.mjs` (+shards suite), `metrics/METRICS.md` + `monolith-metrics.js`, READMEs, `package.json` (ops:validate). |
| `tests/smoke-sharding.mjs` | `mini-services/animaxia-backend/tests/` (byte-identical) | 31-check live suite (A infra → F ops). |

### Monolith files edited (documented, precedent FAZA 9/11/12)

`db.js` (pool registry + `queryOnShard`/`getPoolForShard`/`createPoolForBranch`/
`listShardPools`/`closeShardPools`, shard stamp in `upsertContent`, hinted
`getContentById`), `modules/platform/sql.js` (`rowsOnShard`/`oneOnShard`),
`modules/search/search.js` (syncIndex stamps `shardid`; `/advanced` cluster
branch when enabled and no cursor; `/status` cluster field),
`modules/aicloud/vector-service.js` (pgvector upsert stamps shardid; `search`
shardHint with 0-rows fallback; `vectorSearch` cluster path with never-fail
fallback), `server.js` (boot migration mount, `registerShardingCollectors`,
`/api/shards` mount, shard-hint threading on content/player reads, shard pools
in shutdown), `modules/ops/metrics.js` (see above), `.env` (+8 FAZA 13 vars).

## HTTP API (monolith :4000)

| Route | Auth | Description |
|---|---|---|
| `GET /api/shards` | public | Composite: model (shardcount/mode/branches), schema columns, pool registry (pool stats + per-shard query/error counters), searchCluster + vectorCluster health, ops snapshots. |
| `GET /api/shards/health` | public | Lightweight: `{ ok, shards: [{ shardid, branch, mode, status: healthy\|degraded\|down }] }`. |
| `POST /api/shards/reindex` | admin | Re-stamp + re-upsert the search catalog per shard via the cluster (`{ indexed, byShard, tookMs }`). |
| `GET /api/search/advanced` | public | With `SEARCHCLUSTENABLED=true` and no `cursor`: cluster fan-out (response gains `cluster.nodes`; `x-animaxia-shard` header → targeted node). Keyset cursors keep routing to the legacy FAZA 17 path. |
| `POST /api/vector/search` | public | With `VECTORCLUSTENABLED=true` and pgvector: cluster query (affinity + fan-out), legacy fallback on any cluster error. |
| `GET /api/metrics` | public | + `animaxia_db_shard_*{shard}`, `animaxia_search_cluster_*`, `animaxia_vector_cluster_*` (30 new families; FAZA 9 lines intact). |

## Edge integration (animaxia-edge/, refreshed entries)

`shared/shard.ts` (new — TS mirror of the model: `resolveShardFromTenantOrContent`,
policy *valid client header > tenant > content path > 0*, `shardKeySegment`) ·
gateway `worker/src/index.ts` (`X-Animaxia-Shard` on upstream + client responses,
cache keys gain `s<n>:` after the tenant prefix: `t:acme:s3:api:…`,
`/edge/status` sharding block) · `ai/`, `search/`, `player/` workers (shard in
keys + forwarded header). Tests: `smoke-edge.mjs` 194 checks (+32 sharding),
`tenant-edge.mjs` 61 checks (+7 sharding), `e2e-edge.mjs` 35 — all green.

## Ops (animaxia-ops/, refreshed entries)

Dashboard `db-shards.json` (pool usage / errors / latency per shard, cluster
health) · alerts `AnimaxiaShardDown` (critical, `animaxia_db_shard_connected == 0`
2m) + `AnimaxiaSearchClusterNodeDown` (warning, 5m) with runbooks
`shard-down.md`, `search-cluster-node-down.md` · synthetics suite `shards`
(11 checks; total 46) · `METRICS.md` §6 (all 30 new families).

## Running

```bash
# monolith (already has SHARDCOUNT/SEARCHCLUSTENABLED/VECTORCLUSTENABLED in .env)
cd mini-services/animaxia-backend && bun run dev

# sharding smoke (31 checks, live :4000) — from the monolith or this staging dir
bun run test
API_ORIGIN=http://localhost:4000 bun tests/smoke-sharding.mjs

# edge pipeline (typecheck + smoke 194 + e2e 35)
cd ../animaxia-edge && bun run test

# ops synthetics (46 checks incl. the shards suite)
cd .. && bun run ops:synthetics
```

Physical mode: set `SHARD1URL=postgres://…branch1…` (etc.) in the monolith
`.env` and restart — `mode` flips to `physical` in `/api/shards`, branch pools
appear in the registry/dashboard, alerts cover them automatically.

## QA results (FAZA 13-7, final state)

| Gate | Result |
|---|---|
| Monolith `bun run test` (sharding suite) | **31/31 passed** |
| Edge `bun run test` | typecheck 0 · smoke **194/194** · e2e **35/35** · lint PASS |
| Edge tenant suite | **61/61** |
| `bun run ops:synthetics` | **46/46** (shards suite 11/11) |
| `bunx tsc --noEmit` | 0 errors in `src/` (baseline untouched outside) |
| `bun run lint` (root) | 0 problems in `src/` (baseline untouched outside) |
| Browser (gateway :81) | `/`, `#/ai`, `#/edge`, `#/admin/shards` — 0 console errors, 4 shards live in the console, mobile 390px 0px overflow |
| Cluster ↔ legacy equivalence | 11/11 query battery identical (13-3) |
