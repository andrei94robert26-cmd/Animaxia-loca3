# Animaxia — Web App (Next.js)

**One platform for anime, movies, TV, sports and news.** This is the web
console of the Animaxia ecosystem — accounts, premium, AI companion, player,
social feed, admin, and the Edge console.

<!-- FAZA 9 (ops): status badges — workflows ship inside the packages
     (animaxia-ops/.github/workflows/ops-ci.yml, animaxia-edge/…/edge-deploy.yml,
     animaxia-desktop/…/desktop-ci.yml); copy them to the repo root
     .github/workflows/ on the real Git host and adjust the org/repo prefix. -->
![Ops CI](https://github.com/animaxia/animaxia/actions/workflows/ops-ci.yml/badge.svg)
![Edge Deploy](https://github.com/animaxia/animaxia/actions/workflows/edge-deploy.yml/badge.svg)
![desktop-ci](https://github.com/animaxia/animaxia/actions/workflows/desktop-ci.yml/badge.svg)

## Run

```bash
bun run dev            # Next.js :3000 (the API is the monolith on :4000)
bun run lint           # ESLint
bun run ops:synthetics # FAZA 9 synthetic checks (35 — incl. FAZA 12 miner) against the live stack
```

## Platform map

| Piece | Location | Port | Delivered in |
|---|---|---|---|
| Web console (this app) | `/` · `src/` | :3000 | Phase 1–5 |
| Backend monolith | `mini-services/animaxia-backend/` | :4000 | Phase 1–4 (Neon PostgreSQL + AI Cloud) |
| Cloud microservices + gateway | `animaxia-cloud/` | :4001-4009, :8080 | Phase 3 |
| Mobile app (Expo/RN) | `animaxia-mobile/` | — | FAZA 6 |
| Desktop app (Electron) | `animaxia-desktop/` | — | FAZA 7 |
| Edge layer (Cloudflare Workers) | `animaxia-edge/` | — | FAZA 8 |
| Ops & observability | `animaxia-ops/` | — | FAZA 9 |
| Social & real-time | `mini-services/animaxia-realtime/` + `animaxia-social/` | :4010 | FAZA 10 |
| Multi-tenant & billing | `mini-services/animaxia-backend/modules/tenant/` + `animaxia-tenant/` | :4000 | FAZA 11 |
| Miner (ingest + indexing) | `mini-services/animaxia-backend/modules/miner/` + `animaxia-miner/` | :4000 | FAZA 12 |

FAZA 9 observability quicklinks:

- **Metrics contract** — `animaxia-ops/metrics/METRICS.md`
- **Live metrics** — `http://localhost:4000/api/metrics` (Prometheus) · `?format=json`
- **Synthetic checks** — `animaxia-ops/synthetics/` (29 checks, CI-gated)
- **Dashboards** — `animaxia-ops/dashboards/` (AI Cloud, Edge Gateway, User Experience)
- **Alerts & SLOs** — `animaxia-ops/alerts/` (99.5% availability, p95 < 1500 ms AI)
- **Runbooks** — `animaxia-ops/runbooks/` (Neon outage, AI provider, edge WAF)

FAZA 10 social & real-time quicklinks:

- **Social hub** — `#/social` in this app (Feed · People · Reviews · Parties · AI tabs, live activity ticker, watch-party rooms with synced playback + chat)
- **Service** — `mini-services/animaxia-realtime/` (socket.io on :4010, `io('/?XTransformPort=4010')`)
- **Docs & runbook** — `animaxia-social/README.md` · `animaxia-ops/runbooks/social-realtime-degraded.md`
- **Smoke** — `cd animaxia-social && bun tests/smoke-social.mjs` (83 checks: REST + sockets + E2E webhook)

FAZA 11 multi-tenant quicklinks:

- **Tenant console** — `#/admin/tenants` (registry, limits, members, metered billing, per-tenant AI)
- **Modules** — `mini-services/animaxia-backend/modules/tenant/` (model · per-tenant JWT · AI quotas · billing)
- **Docs** — `animaxia-tenant/README.md` · smoke `cd animaxia-tenant && bun tests/smoke-tenant.mjs` (55 checks)

FAZA 12 — Miner (ingest + indexing) quicklinks:

- **Ingest console** — `#/admin/ingest` (job queue with Run now, per-tenant sync state, counters)
- **Service** — `mini-services/animaxia-backend/modules/miner/` (TMDB/Jikan providers, persistent Neon job
  queue, tenant-scoped vector indexing, search catalog push, HLS manifest sweep)
- **Edge** — cron job `miner-sync` (04:30 UTC, one daily-sync per active tenant) + `GET /edge/miner/status`
- **Docs & QA** — `animaxia-miner/README.md` · `cd animaxia-miner && bun install && bun run smoke`
  (40 checks) · `bun run e2e` (15 checks) — live TMDB + Jikan, tenant-scoped vectors, teardown

The full delivery archive lives at `public/animaxia-cloud.zip`
(FAZA 8: 562 files; FAZA 9 adds `animaxia-ops/`; FAZA 10 adds `animaxia-social/` — 612;
FAZA 11 adds `animaxia-tenant/` — 629; FAZA 12 adds `animaxia-miner/` — 646 files).
