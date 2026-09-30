# services/ — FAZA 13 cluster services (Animaxia backend)

This directory holds the two **cluster services** introduced by FAZA 13
(Task 13-3, "Cluster de căutare FTS + vector"). They are plain ES modules —
no routers of their own — consumed additively by the existing monolith
modules and exposed to ops through `/api/shards` (modules/sharding/routes.js).

Both services share the same honest node model:

- **one node per shard** (`shardId` 0..`SHARDCOUNT`-1, see
  `modules/sharding/model.js`);
- **logical mode** (default, no `SHARD{N}URL`): every node query runs through
  `queryOnShard(shardId)` which lands on the MAIN pool with an
  `AND shardid = $n` scope — real fan-out code on a single physical database;
- **physical mode** (`SHARD{N}URL` configured): the identical code hits that
  shard's dedicated Neon branch pool (registered in `db.js`, 13-2);
- health checks, counters and per-node metrics are **real in both modes**;
  nothing is faked, and a failing node is reported per-node instead of
  failing the whole query (only an all-nodes failure fails the request).

## search-cluster/ — FTS over the sharded `searchdocs` index

`services/search-cluster/index.js`

- `searchCluster.queryFTS(params)` — the FAZA 16/17 advanced-search semantics
  (`animaxia-neon-fts`, websearch_to_tsquery + trigram fallback + SQL filters)
  executed per shard node, then merged (dedupe by contentid, re-sort, slice;
  `total` = Σ per-node `COUNT(*)`). Responses keep the legacy `/advanced`
  shape and add only a `cluster` field (per-node hits/latency/errors, mode,
  `fanout: 'targeted'|'all'`). A valid `shardHint` (gateway
  `X-Animaxia-Shard` header) runs the hinted node FIRST and the remaining
  nodes complete the result set — query-side affinity only, never blanks
  results. `page*limit > 10000` mirrors the FAZA 17 offset cap
  (`{ error, useCursor: true }`); keyset cursors always stay on the legacy
  single-index path in `modules/search/search.js`.
- `searchCluster.indexBatch(docs)` — routes each doc via
  `computeShardIdFromContentId(contentid)` to `queryOnShard` with the same
  12-param-per-row upsert SQL `search.js syncIndex` runs (chunks of 25).
- `searchCluster.health()` — per-node ping + `COUNT(*) WHERE shardid = $n`.
- `searchClusterOpsSnapshot()` — `{ enabled, queries, errors, coalesced,
  nodesHealthy, nodesTotal, latencyP50Ms, latencyP95Ms, byShard, lastError }`.
- Toggle: `SEARCHCLUSTENABLED` (default false when unset).

## vector-cluster/ — pgvector over the sharded `vectorembeddings` table

`services/vector-cluster/index.js`

- `vectorCluster.query({ vector, kind, topK, userId, tenant, shardHint })` —
  the same SQL as `PgVectorBackend.search` per shard node; **query-side tenant
  affinity**: the tenant's computed node (`computeShardIdFromTenant`) or the
  hinted node is queried FIRST, the remaining nodes complete the result set
  (merge → dedupe by refkey → top-K by score). Returns `{ hits, took,
  cluster }` with hits in the exact `PgVectorBackend.search` row shape.
  No split brain: upserts and queries both route on
  `computeShardIdFromVectorRef(refKey(item))` — the pinned 13-2 stamp rule.
- `vectorCluster.upsertBatch(items)` — per-item shard routing via the same
  rule (refKey logic replicated 1:1 from `vector-service.js`, which does not
  export it) with the same 9-column + shardid upsert SQL.
- `vectorCluster.health()` / `vectorClusterOpsSnapshot()` — same pattern as
  the search cluster (plus `upserts`).
- Toggle: `VECTORCLUSTENABLED` (default false when unset). The cluster is a
  pgvector-only fan-out: `vector-service.js` uses it only when the active
  backend is pgvector, and any cluster failure falls back to the legacy
  `backend.search` — a user query is never failed because the cluster failed.
