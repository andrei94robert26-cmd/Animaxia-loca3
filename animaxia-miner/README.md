# animaxia-miner — FAZA 12 · Ingest + Indexing Service

The Animaxia Miner collects, normalizes and indexes external content into the
platform: TMDB movie pages and Jikan (MyAnimeList) anime pages become library
rows, per-tenant vector embeddings and search-catalog documents — through a
**persistent Neon-backed job queue** that survives restarts, runs on an edge
cron schedule and reports everything to the FAZA 9 ops stack.

```
                    ┌────────────────────────────────────────────────┐
  edge cron         │                ANIMAXIA MONOLITH               │
  miner-sync ──────►│  /api/miner/jobs {daily-sync, allTenants}      │
  (04:30 UTC)       │        │ per ACTIVE tenant                     │
                    │        ▼                                       │
  admin UI          │  miner_jobs (Neon, persistent queue)           │
  #/admin/ingest ──►│        │ claim (max 2 concurrent)               │
                    │        ▼                                       │
                    │  providers/tmdb.js ──► content (upsert)        │
                    │  providers/jikan.js ─┘    │                    │
                    │                            ├── miner_sources    │
                    │                            │   (provenance)    │
                    │                            ▼                   │
                    │  ai-index.js ──► vectorembeddings (tenantid,    │
                    │                  refkey t:<slug>:content:<id>)  │
                    │  search-index.js ──► OpenSearch bulk (optional) │
                    │                  └─► local catalog (advancedCache)│
                    │  manifest-sweep ──► miner_manifests (HLS)       │
                    │                            │                    │
                    │        metrics + usage events + audit trail     │
                    └────────────────────────────────────────────────┘
```

## Why a second job system?

`modules/workers` (Phase 4) is an in-memory worker-thread pool — fast, but
jobs vanish on restart. The miner needs **durable** ingest state (restart
recovery, incremental `lastSync` bookkeeping, per-tenant provenance), so it
keeps its own queue in Neon (`miner_jobs`) with an in-process runner. The
two systems are complementary; the workers pool is untouched (FAZA 1–11
contracts frozen).

## Module inventory (monolith-modules/miner/)

| File | Purpose |
|---|---|
| `miner-migrations.js` | Idempotent DDL: `miner_jobs`, `miner_sources`, `miner_logs`, `miner_manifests` (+ indexes). Runs at boot after the tenant schema. |
| `core.js` | Persistent queue: `scheduleJob`, `runJob` (manual/re-run with bounded wait), `recordSource`, `upsertManifest`, `listJobs`, `getJob`, `minerStats`, boot recovery (`interrupted by restart`), metrics hooks, workers.js-style side effects (cache clear + `content:changed` + audit). |
| `providers/tmdb.js` | `fetchMoviesPage(page, {mode})` (trending/discover) + `normalizeToContentRow` → `tmdb:movie:{id}` rows. |
| `providers/jikan.js` | `fetchAnimePage(page)` (top anime, ≤250 pages) + `normalizeToContentRow` → `jikan:anime:{mal_id}` rows. |
| `ai-index.js` | `indexContentForTenant(tenantid, contentIds[])`, `rebuildTenantIndex(tenantid, {limit})` — embeddings via vector-service primitives into the FAZA 11 per-tenant namespaces (`content:{id}:0` global / `t:<slug>:content:{id}:0`). |
| `search-index.js` | `pushToSearchIndex(rows, tenantid)` — real OpenSearch `_bulk` when `OPENSEARCHURL` is set (index `<name>-<tenantid>`), otherwise a local catalog under `advancedCache` (tag `miner`). |
| `routes.js` | HTTP surface (mounted at `/api/miner`, mutations admin-only). |

## HTTP API (monolith :4000)

| Route | Auth | Description |
|---|---|---|
| `GET /api/miner/status` | public | Pool + jobs byStatus/byType + last job + per-tenant sources/synced24h + manifests + search backend. |
| `GET /api/miner/jobs?status&tenant&type&limit` | public | Latest jobs (payloads stripped). |
| `GET /api/miner/jobs/:id` | public | Full job record incl. structured logs. |
| `POST /api/miner/jobs` | admin | Schedule `{ type, tenant?, page?, mode?, limit?, contentIds? }`. `allTenants:true` → one `daily-sync` per ACTIVE tenant (the cron's single call). |
| `POST /api/miner/run/:id` | admin | Manual run — queued jobs run now; done/failed jobs re-run; already-running jobs are awaited (bounded), never 409'd. |
| `POST /api/miner/search/push` | admin | Push library rows to the tenant search catalog. |

Job types: `daily-sync` (TMDB + Jikan, index + push), `tmdb-sync`, `jikan-sync`
(one provider page), `reindex` (tenant vector rebuild — bulk or specific
`contentIds`), `manifest-sweep` (scan `metadata.player.sources` m3u8 URLs into
`miner_manifests`).

## Edge integration

- **cron** — job `miner-sync` (04:30 UTC daily, `animaxia-edge/cron/src/miner.ts`):
  `POST /api/miner/jobs {type:'daily-sync', allTenants:true}` with
  `EDGE_ADMIN_JWT`; falls back to the public `GET /api/miner/status` when admin
  auth is unavailable (the tmdb/jikan refresh policy).
- **gateway** — `GET /edge/miner/status` proxies the monolith status (public,
  `no-store`) and counts `animaxia_edge_miner_status_checks_total`.

## Ops hooks

- `animaxia_miner_jobs_total{type,status,tenant}` — counter
- `animaxia_miner_job_duration_ms{type}` — bounded histogram
- `animaxia_miner_items_upserted_total{provider,tenant}` — counter
- `animaxia_miner_running` / `animaxia_miner_queue_depth` — gauges
- `collectors.miner` in `/api/metrics?format=json` (pull collector)
- synthetics: 6 `miner:` checks (`bun run ops:synthetics --only miner`)
- tenant usage events: `miner_sync` (quantity = upserted items) per tenant —
  feeds the FAZA 11 metered billing.

## Tenant isolation

All miner tables carry `tenantid` (default `'global'`). The shared `content`
library is NOT altered (FAZA 1 contract) — isolation lives in
`miner_sources` / `miner_manifests` / `vectorembeddings.tenantid`, mirroring
the FAZA 11 policy. A tenant's daily-sync writes its own provenance rows,
namespaced embeddings and usage events; the implicit `global` tenant keeps
the platform-wide behavior unchanged.

## Running

```bash
# the miner boots with the monolith (bun run dev in mini-services/animaxia-backend)
# — ensureMinerSchema() + minerBoot() run at startup, no extra step.

# QA (from animaxia-miner/):
bun install
bun run smoke     # 40 checks: infra, model, live TMDB+Jikan pipeline, indexing, metrics, manifests
bun run e2e       # 15 checks: create tenant → tenant-scoped sync → scoped vectors → teardown
bun run test      # both
```

Mirror install (into a monolith checkout): copy `monolith-modules/miner/` to
`modules/miner/`, then add the three additive integration points documented
in the FAZA 12 worklog (server.js import + mount + boot block).

## Config

See `.env.example` — provider keys reuse the monolith's existing
`TMDBAPIKEY` / `JIKANBASEURL` (no new required keys); `OPENSEARCHURL` is
optional (local catalog fallback otherwise).

## QA results (FAZA 12)

- `scripts/smoke-miner.mjs` — **40/40** (live TMDB + Jikan, Neon writes,
  pgvector indexing, metrics series, manifest sweep)
- `tests/e2e-miner.mjs` — **15/15** (tenant create → scoped ingest →
  namespaced embeddings → metered usage → discoverability → clean teardown)
- edge smoke regression — **162/162** (159 + 3 miner checks)
- synthetics — **35/35** (29 + 6 miner checks)
- `tsc --noEmit` (edge): clean · lint: 0 new problems
