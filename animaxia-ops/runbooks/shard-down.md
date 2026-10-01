# Runbook — DB shard down (per-shard pool disconnected, FAZA 13 sharding)

**Service:** monolith backend `mini-services/animaxia-backend/` (Express + Neon
PostgreSQL, per-shard pool registry in `db.js`) on **:4000**.
**Alert:** `AnimaxiaShardDown` — `animaxia_db_shard_connected == 0` for 2m
(critical), group `animaxia-sharding-alerts` in [`../alerts/alerts.yaml`](../alerts/alerts.yaml).
**Architecture recap (FAZA 13):** the monolith routes content/searchdocs per
content-id range (1 B blocks) and vectorembeddings per tenant/vectorref hash over
`SHARDCOUNT` (default 4) shards. Each shard resolves to a pg pool from the
registry (`listShardPools()`):

- **logical mode** (`SHARD{N}URL` empty, the default): every shard maps to the
  **shared main Neon pool** (`mode:"main"`). `animaxia_db_shard_connected == 0`
  on a main-mode shard means the **whole SQL layer** is degraded — the same
  signal class as `AnimaxiaNeonDisconnected` (local fallback store, 503s from
  the platform modules, pgvector/RAG degraded).
- **physical mode** (`SHARD{N}URL` set): shard N has a **dedicated Neon branch
  pool** (`mode:"branch"`). A branch pool down means `queryOnShard(N, …)` fails,
  logs `falling back to main pool`, and that shard's queries are served by the
  main pool with a **latency penalty per query** — reads never fail outright
  (resilient branch→main fallback), but the isolation/latency benefit of
  physical sharding is lost while it fires.

## Symptoms

```text
alert: AnimaxiaShardDown
expr:  animaxia_db_shard_connected == 0  (for 2m)
```

- The firing instance carries `shard` + `branch` labels, e.g.
  `shard="1", branch="neon-shard-1"` → the branch pool for shard 1 is down.
- Logical mode: **all** shards fire together (they share the main pool) and
  `/api/health` shows `"driver":"local-fallback"` — follow
  [neon-outage.md](neon-outage.md) instead (env wipe / Neon outage), this
  runbook's physical-mode sections do not apply.
- Physical mode: only the affected `shard` label fires; `/api/health` stays
  `postgres / connected:true` (main pool fine) — a single Neon branch is dead.

Metrics (FAZA 13 `shards` collector namespace):

```bash
curl -s http://localhost:4000/api/metrics | grep animaxia_db_shard
# animaxia_db_shard_connected{shard="1",branch="neon-shard-1"} 0     <- the incident
# animaxia_db_shard_connected{shard="0",branch="neon-main"} 1       <- main pool fine
# animaxia_db_shard_healthy{shard="1",branch="neon-shard-1"} 0
# animaxia_db_shard_errors_total{shard="1"} 17                      <- fallback counter climbing
# animaxia_db_shard_pool_total{shard="1",branch="neon-shard-1",mode="branch"} 0
```

Per-shard synthetics:

```bash
curl -s http://localhost:4000/api/shards/health
# {"ok":false,"shards":[{"shardid":0,...,"status":"healthy"},...,
#   {"shardid":1,"branch":"neon-shard-1","mode":"branch","status":"down"}]}
```

## Impact

**Still works** (the platform degrades, it does not die):

- Logical mode is untouched by this runbook (see neon-outage.md) — the local
  fallback JSON driver keeps :4000/:3000 alive.
- Physical mode, branch shard down: **all reads keep succeeding** —
  `queryOnShard(N, …)` falls back to the main pool (WARN
  `falling back to main pool` in the log, ~1 extra round-trip penalty per
  query on that shard). Search cluster fan-out still returns the full result
  set (the node for shard N completes via the fallback), vector cluster same.
- Writes: shardid stamping happens at write time; upserts route per the
  current `SHARD{N}URL` config, so no split-brain — the branch simply does not
  receive its share of the traffic while down.

**Degraded:**

- Per-query latency on the affected shard's routes (search fan-out node N,
  vector affinity N, content ids in the shard's 1 B range).
- Physical isolation: the whole dataset is now served by the main pool — the
  latency/throughput headroom that motivated physical sharding is gone.
- `animaxia_db_shard_errors_total{shard="N"}` keeps climbing while the branch
  is down (every first-attempt query on that shard counts one error before the
  fallback serves it).

## Diagnosis

```bash
# 1. Which shard + which mode?
curl -s http://localhost:4000/api/shards | python3 -m json.tool | sed -n '1,40p'
# model.mode tells logical vs physical; pools[] shows per-shard mode/connected/lastError
# e.g. "pools":[{"shardid":1,"mode":"branch","urlConfigured":true,"connected":false,
#                "lastError":"getaddrinfo ENOTFOUND ..."}]

# 2. Is the main pool healthy (physical-mode incident)?
curl -s http://localhost:4000/api/health | grep -o '"driver":"[^"]*"\|"connected":[a-z]*'
# "driver":"postgres" "connected":true  → main pool fine, single branch issue

# 3. What does the backend log say (fallback warnings + last error)?
rg -n "falling back to main pool|shard [0-9]+ .* query failed" mini-services/animaxia-backend/log | tail -5

# 4. Is the branch URL valid? (config check — env, no underscores in var names)
rg -n "^SHARD[0-9]+URL|^SHARDCOUNT|^DATABASEURL" mini-services/animaxia-backend/.env
# an empty SHARD1URL = logical mode (this alert cannot fire for it — the entry
# resolves to the main pool); a bad/garbage URL = physical mode with a dead branch

# 5. Can the branch host be reached at all from the sandbox?
#    (substitute the host from SHARD{N}URL)
curl -s -m 5 -o /dev/null -w "%{http_code}\n" https://<branch-host>  # or psql connect probe
```

Typical root causes: rotated/revoked Neon branch credentials in
`SHARD{N}URL`, the Neon branch was suspended/deleted from the Neon console, a
typo in the URL, or a transient network/DNS failure (ENOTFOUND/ECONNREFUSED).

## Recovery

### Option A — branch URL is wrong/revoked: fix the env + restart

```bash
# 1. Get the correct connection string from the Neon console (branch shard-N),
#    then update the variable in the backend .env (keep the no-underscore name):
#    SHARD1URL=postgresql://user:pass@ep-.../neondb?sslmode=require
nano mini-services/animaxia-backend/.env   # or your editor of choice

# 2. Safe restart — verify EACH pid's cwd before killing (never touch :3000)
for p in $(pgrep -f "bun --watch server.js"); do readlink /proc/$p/cwd; done
kill <backend-pid>   # only pids whose cwd is mini-services/animaxia-backend

# 3. Relaunch detached (survives the session)
cd mini-services/animaxia-backend && (setsid bun run dev > log 2>&1 < /dev/null &)

# 4. Watch the boot — [DB] Connected to PostgreSQL (Neon) + schema banners
tail -f log
```

### Option B — return to logical mode (shed the dead branch, keep serving)

If the branch cannot be restored quickly, empty its URL: the shard falls back
to the main pool by design (logical sharding), and the alert resolves.

```bash
# 1. Empty the branch URL in mini-services/animaxia-backend/.env
#    SHARD1URL=
# 2. Same safe kill + setsid restart as Option A steps 2-3.
# 3. Verify /api/shards → model.mode "logical", pools[1].mode "main".
```

### Option C — Neon-side incident (env intact, URL valid)

Check the Neon console for the branch state (suspended compute is normal for
idle branches — a connect wakes it; expect the first health ping to be slow,
not failed). If the credentials were rotated, update `SHARD{N}URL` (Option A)
and refresh the ZIP copy so `restore-env.sh` does not resurrect dead creds:

```bash
cd mini-services/animaxia-backend && zip -u ../../public/animaxia-cloud.zip .env
```

## Verification

```bash
# 1. The alert's series is back to 1 for every shard
curl -s http://localhost:4000/api/metrics | grep animaxia_db_shard_connected
# animaxia_db_shard_connected{shard="0",branch="neon-main"} 1
# animaxia_db_shard_connected{shard="1",branch="neon-shard-1"} 1 ...

# 2. Per-shard synthetics all healthy
curl -s http://localhost:4000/api/shards/health
# {"ok":true,"shards":[{"shardid":0,...,"status":"healthy"}, ... ]}

# 3. Search + vector cluster fan-out healthy with per-node docs
curl -s http://localhost:4000/api/shards | grep -o '"nodesHealthy":[0-9]*\|"healthy":[a-z]*' | head

# 4. Real traffic through the recovered shard
curl -s "http://localhost:4000/api/search/advanced?q=the&limit=3" | head -c 300
curl -s -X POST http://localhost:4000/api/vector/search -H 'content-type: application/json' \
  -d '{"query":"big buck bunny","kind":"content","topK":3}' | head -c 300

# 5. Full synthetics gate (includes the FAZA 13 'shards' suite)
cd /home/z/my-project/animaxia-ops && bun run ops:synthetics
```

## Prevention

- **Alert on the first fallback, not just the pool:** `AnimaxiaShardDown`
  (this runbook) catches a fully disconnected pool; a flapping branch also
  shows up as a climbing `animaxia_db_shard_errors_total{shard="N"}` on the
  *Animaxia — DB Shards* dashboard (Errors per shard panel) — investigate
  before the pool goes fully down.
- **Keep the branch URLs in the same recovery loop as `DATABASEURL`:** the
  `.env` (with `SHARD{N}URL`, `SHARDCOUNT`, `SEARCHCLUSTENABLED`,
  `VECTORCLUSTENABLED`) is restored from `public/animaxia-cloud.zip` by
  `restore-env.sh` — after any credential rotation, `zip -u` the refreshed
  `.env` back into the ZIP (see the golden rule in
  [README.md](README.md)).
- **Logical mode is a valid steady state:** an empty `SHARD{N}URL` is not a
  misconfiguration — routing, metrics and health stay real. Only set branch
  URLs when the branches actually exist and their credentials are current.
- **One shard's failure must never page silently as "the DB is down":** the
  `shard`/`branch`/`mode` labels on the alert instance are the first triage
  input — `mode:"main"` = platform-level SQL degradation, `mode:"branch"` =
  degraded-but-serving via fallback.
