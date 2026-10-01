# Animaxia Ops & Observability (FAZA 9)

Everything needed to **operate** the Animaxia platform at SRE level: unified
metrics, health endpoints, synthetic checks, dashboards, alerts with SLOs,
incident runbooks and CI. Additive layer — no existing API contract was
changed (see the worklog, Task 1–7).

```
animaxia-ops/
├── metrics/
│   ├── METRICS.md             ← canonical metric contract (all layers)
│   └── monolith-metrics.js    ← canonical copy of modules/ops/metrics.js
│                                 (live in mini-services/animaxia-backend/)
├── synthetics/
│   ├── run.mjs                ← 29 live checks: web/api/auth/ai/player/edge
│   └── README.md
├── dashboards/                ← Grafana JSON + import/wiring guide
│   ├── ai-cloud.json          ← LLM latency · tokens · errors · RAG/quota · pgvector
│   ├── edge-gateway.json      ← WAF blocks · 429s · cache hit ratio · HLS traffic
│   ├── user-experience.json   ← login success · AI quota · player errors · SLOs
│   └── README.md
├── alerts/
│   ├── slo.yaml               ← 10 recording rules (99.5% availability · p95 < 1500ms)
│   ├── alerts.yaml            ← 8 alerts (error rate, Neon down, quota spike, WAF spike…)
│   ├── cloudflare-alerts.md   ← edge-side alerting via CF Analytics (in README)
│   └── README.md              ← Prometheus / Grafana / Cloudflare wiring
├── runbooks/
│   ├── neon-outage.md         ← the .env-wipe / Neon recovery procedure (restore-env.sh)
│   ├── ai-provider-degraded.md← AI_PROVIDER switch + llm-core fallback verification
│   ├── edge-waf-misconfig.md  ← WAF tuning + smoke guards + redeploy
│   └── README.md              ← index: runbook → alert → MTTR
└── .github/workflows/
    └── ops-ci.yml             ← daily synthetics + edge/desktop test jobs
```

## What FAZA 9 added to the running platform

| Layer | Addition | Where |
|---|---|---|
| Monolith (:4000) | `modules/ops/metrics.js` registry + express middleware (request/latency/error/quota counters), pull collectors (db pool, cache, provider circuits, llm-core usage, vector backend), `GET /api/metrics` (Prometheus + JSON), `ai` section in `/api/health`, `poolStats()` in db.js | `mini-services/animaxia-backend/` |
| Edge (7 workers) | `shared/metrics.ts` registry + `withMetrics` wrapper, `GET /metrics` per module worker, `GET /edge/metrics` (admin) on the gateway, WAF-block + cache-tag + cron-run counters, smoke suite 13 | `animaxia-edge/` |
| Cloud (:4001-4009, :8080) | unchanged — existing `/metrics` (Phase 3) feeds the new dashboards/alerts | `animaxia-cloud/` |

## Quickstart

```bash
# 1. Synthetic checks against the live stack (29 checks)
bun run ops:synthetics            # from the repo root (delegates here)

# 2. Metrics — live
curl -s http://localhost:4000/api/metrics | head -30          # Prometheus
curl -s "http://localhost:4000/api/metrics?format=json" | head # JSON snapshot
curl -s http://localhost:4000/api/health | jq .ai              # provider + quota

# 3. Edge metrics — hermetic (production scrape: see dashboards/README.md §edge)
cd animaxia-edge && bun run test  # smoke 159 (incl. suite 13 metrics) + e2e 35

# 4. Dashboards / alerts / runbooks
#    see dashboards/README.md, alerts/README.md, runbooks/README.md
```

## SLOs (mandate)

| SLO | Target |
|---|---|
| Availability `/api/mobile/home` | ≥ 99.5% (28d) |
| Availability `/api/ai/personal/home` | ≥ 99.5% (28d) |
| Availability edge gateway | ≥ 99.5% (28d) |
| AI endpoint latency | p95 < 1500 ms |
| Error budget | 0.5% ≈ 3h22m downtime / 28d |

## Verification (this session)

- Monolith: live-checked — Prometheus render (db pool, 7 provider circuits,
  ai/vector gauges), counters increment per route (`:id`-normalized), health
  `ai` section, JSON snapshot.
- Edge: `bun run test` green — typecheck 0 errors, **smoke 159/159**
  (146 + 13 new metrics checks), **e2e 35/35** (real edge → cloud → Neon),
  guard lint PASS.
- Synthetics: **29/29 passed** (web, Neon health, real register→login→me,
  authenticated AI home, live HLS manifest, offline assets, edge probe).
- Dashboards: 3× valid Grafana JSON (34 panels), every PromQL expression
  cross-checked against METRICS.md; alerts + SLO YAML parse clean.
- CI: `ops-ci.yml` — daily synthetics job + edge/desktop jobs on push
  (documented secrets: DATABASEURL, TMDBAPIKEY, AUTHSECRET).
- Web app regression: home, `#/ai` hub, `#/edge` console verified in the
  browser — 0 console errors (see worklog, Task 7).
