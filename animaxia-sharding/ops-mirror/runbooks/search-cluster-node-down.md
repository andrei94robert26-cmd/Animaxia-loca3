# Runbook — Search cluster node down (FTS fan-out lost a shard node, FAZA 13)

**Service:** monolith backend `mini-services/animaxia-backend/` — search
cluster `services/search-cluster/index.js` (one node per shard, FTS fan-out
over `searchdocs` with merge/dedupe + FAZA 17 offset-cap mirror) on **:4000**.
**Alert:** `AnimaxiaSearchClusterNodeDown` —
`animaxia_search_cluster_enabled == 1 and animaxia_search_cluster_nodes_healthy < animaxia_search_cluster_nodes_total`
for 5m (warning), group `animaxia-sharding-alerts` in
[`../alerts/alerts.yaml`](../alerts/alerts.yaml).
**Architecture recap (FAZA 13 / Task 13-3):** `/api/search/advanced` fans out
the query to one node per shard (`SHARDCOUNT`, default 4; per node
`AND s.shardid = $n` over `searchdocs` via `queryOnShard`), merges + dedupes by
contentid and re-sorts exactly like the legacy single-node path. `nodes_healthy`
is read **live from the shard pool registry** — the same pools
`AnimaxiaShardDown` watches. A query only fails when **all** nodes fail (503);
one dead node = degraded coverage + latency, not an outage.

## Symptoms

```text
alert: AnimaxiaSearchClusterNodeDown
expr:  animaxia_search_cluster_enabled == 1
       and animaxia_search_cluster_nodes_healthy < animaxia_search_cluster_nodes_total  (for 5m)
```

- Search still returns results (fan-out completes over surviving nodes), but
  `cluster.nodes` in the `/api/search/advanced` response shows an error entry
  for the dead shard, and `/api/search/status` may show `cluster.healthy:false`.
- If the underlying shard pool is also down, `AnimaxiaShardDown` fires
  alongside (critical) — that runbook covers the pool-level recovery.

Metrics:

```bash
curl -s http://localhost:4000/api/metrics | grep animaxia_search_cluster
# animaxia_search_cluster_enabled 1
# animaxia_search_cluster_nodes_healthy 3      <- the incident (4 expected)
# animaxia_search_cluster_nodes_total 4
# animaxia_search_cluster_node_healthy{shard="2"} 0   <- which node
# animaxia_search_cluster_node_docs{shard="2"} 0      <- count query failing
# animaxia_search_cluster_node_latency_ms{shard="2"} 1204  <- slow/timing-out ping
```

## Impact

**Still works:**

- `/api/search/advanced` — results from the surviving shards are merged,
  deduped and served (engine label `animaxia-neon-fts` preserved); a query
  only 503s when **every** node fails.
- Cursor/keyset pagination — always served by the legacy single-node path by
  design (cursoare routează mereu legacy), unaffected.
- Autocomplete, filters, `/api/search/index` (admin reindex) — legacy paths.

**Degraded:**

- **Coverage:** documents whose `searchdocs.shardid` lives on the dead node are
  missing from `/api/search/advanced` results while it is down (in logical mode
  a "dead" node usually means the shared main pool is failing — then *all*
  nodes go unhealthy and the alert is moot because search 503s → that is the
  `AnimaxiaShardDown` / [neon-outage.md](neon-outage.md) path).
- **Latency p50/p95:** `animaxia_search_cluster_latency_p50_ms / _p95_ms`
  climb if the node is timing out rather than failing fast.
- Single-flight coalescing (`animaxia_search_cluster_coalesced_total`) hides
  repeated identical queries but does not heal a dead node.

## Diagnosis

```bash
# 1. Which node is unhealthy, and why (lastError is the ping/count error)?
curl -s http://localhost:4000/api/shards | python3 -c "
import json,sys
d = json.load(sys.stdin)
sc = d.get('searchCluster') or {}
for n in sc.get('nodes') or []:
    print(n.get('shardid'), n.get('branch'), n.get('mode'), 'healthy=' + str(n.get('healthy')),
          'docs=' + str(n.get('docs')), 'latencyMs=' + str(n.get('latencyMs')),
          'err=' + str(n.get('lastError')))
print('ops:', json.dumps(d.get('ops', {}).get('search', {})))
"

# 2. Is the shard pool itself down (branch pool / main pool)?
curl -s http://localhost:4000/api/shards/health
# a shard with status "down" → the pool is the root cause: see shard-down.md
# status "degraded" → the pool connects, but a node query errored recently

# 3. Cluster ops counters — errors climbing? lastError set?
curl -s http://localhost:4000/api/metrics | grep animaxia_search_cluster_errors_total
# animaxia_search_cluster_errors_total 12   <- growing = live failures on queries

# 4. Does a real search still work, and what does the per-node report say?
curl -s "http://localhost:4000/api/search/advanced?q=the&limit=3" | python3 -c "
import json,sys
d = json.load(sys.stdin)
print('total:', d.get('total'), '| engine:', d.get('engine'))
c = d.get('cluster') or {}
print('cluster mode:', c.get('mode'), '| fanout:', c.get('fanout'))
for n in c.get('nodes') or []: print(' node', n)
"

# 5. Backend log — node errors / fallback warnings
rg -n "\[sharding\]|search cluster|falling back to main pool" mini-services/animaxia-backend/log | tail -10
```

## Recovery

The search cluster owns no state — node health is derived from the shard pools
(`SELECT 1` + `COUNT(*) WHERE shardid = $n` per node). There is nothing to
"restart" in the cluster itself: **fix the underlying shard pool.**

### Case 1 — the shard pool is down (AnimaxiaShardDown co-firing)

Follow [shard-down.md](shard-down.md): logical mode → the main pool / Neon is
degraded (likely [neon-outage.md](neon-outage.md), env wipe); physical mode →
the branch pool's `SHARD{N}URL` is dead/rotated. Once
`animaxia_db_shard_connected{shard="N"} == 1` again, the node's next health
ping passes and `nodes_healthy` recovers automatically.

### Case 2 — the pool connects but the node keeps erroring (status "degraded")

- Read the node's `lastError` from the diagnosis block — a `column "shardid"
  does not exist` error means the sharding migration
  (`ensureShardingSchema`) did not apply on that shard's database (physical
  mode: the **branch** database is missing the FAZA 13 columns). Re-run the
  boot migration against that branch or re-create the branch from main.
- A timeout (`statement timeout` / `connection terminated`) on the COUNT ping
  usually means the branch compute is suspended/cold or the pool is saturated
  — check `animaxia_db_shard_pool_waiting{shard="N"}` on the
  *Animaxia — DB Shards* dashboard and the Neon console for the branch state.
- After fixing, force a fresh health pass: any `/api/shards` or
  `/api/metrics` scrape re-runs the node pings (they are computed at read
  time — no cache to clear).

### Case 3 — cluster-level misbehavior (all nodes "unhealthy" but search fine)

Verify the toggle and registry: `SEARCHCLUSTENABLED` must be `true`
(`animaxia_search_cluster_enabled 1`) and `SHARDCOUNT` consistent between
`.env` and the deployed gateway. If the registry itself throws,
`/api/shards` `ops.search` shows the error and the alert's
`nodes_healthy` reads from the registry fallback (0) — treat as a code-level
regression: re-run `bun run ops:synthetics --only shards` and check the
backend log before restarting the monolith with the safe kill + setsid pattern
(see [neon-outage.md](neon-outage.md) Option B).

### Emergency fallback — serve search without the cluster

`SEARCHCLUSTENABLED=false` (empty in `.env`) puts `/api/search/advanced` back
on the legacy single-node path (byte-identical behavior, verified in 13-3).
Safe kill + setsid restart afterwards. Re-enable once the node's pool is
healthy.

## Verification

```bash
# 1. All nodes healthy again
curl -s http://localhost:4000/api/metrics | grep animaxia_search_cluster_nodes
# animaxia_search_cluster_nodes_healthy 4
# animaxia_search_cluster_nodes_total 4

# 2. Per-node docs restored (matches the pre-incident distribution, e.g. 97/0/0/0)
curl -s http://localhost:4000/api/metrics | grep animaxia_search_cluster_node_docs

# 3. Search quality parity — total must match the legacy count for a query
curl -s "http://localhost:4000/api/search/advanced?q=big" | grep -o '"total":[0-9]*'
# 1 (Big Buck Bunny) — and no error entries in cluster.nodes

# 4. Synthetics shards suite green
cd /home/z/my-project/animaxia-ops && bun run ops:synthetics --only shards

# 5. Full gate
bun run ops:synthetics
```

## Prevention

- **The nodes are the pools:** every real cause of this alert is a shard pool
  problem — keep `SHARD{N}URL` credentials fresh in the `.env` + ZIP recovery
  loop (golden rule in [README.md](README.md)), and treat
  `AnimaxiaShardDown` as the leading indicator.
- **Watch the latency, not just the binary health:** a node at
  `animaxia_search_cluster_node_latency_ms` far above its siblings (visible on
  the *Animaxia — DB Shards* "Latency per shard" panel) is a cold/saturated
  branch about to start failing — wake the branch compute or rebalance before
  it flips to unhealthy.
- **Keep the offset-cap + keyset contract intact:** the degraded path must
  never be "fixed" by bypassing the cluster merge logic — if equivalence with
  the legacy path breaks (compare a query with `SEARCHCLUSTENABLED=` off), that
  is a code regression in `services/search-cluster/index.js`, not an ops issue.
- **Physical branches need the FAZA 13 schema too:** when creating a new Neon
  branch for `SHARD{N}URL`, boot the monolith against it once so
  `ensureShardingSchema` applies the `shardid` columns + indexes there as
  well (logical mode does this for free on main).
