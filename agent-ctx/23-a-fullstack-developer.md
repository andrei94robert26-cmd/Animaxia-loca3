# Task 23-a — fullstack-developer — FAZA 23: animaxia-observability (:4050)

## Ce am livrat

**mini-services/animaxia-observability** — stack observabilitate enterprise RUNNABLE LOCAL, port FIX 4050, ZERO dependențe externe (node:http/net/crypto), `bun --hot index.ts`, TypeScript strict (tsc 0 erori), README românesc cu maparea onestă local↔producție.

Componente (toate live, validate cu curl):
1. **OTel Collector** — POST /v1/traces (OTLP/HTTP-JSON canonic + format simplu) → {acceptedSpans:N}; POST /v1/metrics → {accepted:N}; ring buffer LRU 5000 traces; GET /api/traces(+stats,/:id); retention 30d pe serii.
2. **Prometheus** — scraper 10s TOLERANT (eroare → animaxia_scrape_errors_total{job}, niciodată crash): backend FAZA 9 + 23-b (:4000/api/observability/metrics), gateway :4040/metrics, probe health (backend/gateway/search-status/hub-stats/hub-feed/watchdog/realtime/frontend), redis :4030 prin client RESP propriu (node:net, PING+DBSIZE). GET /metrics → **152 familii** (proprii + FAZA 9 re-expuse cu label job). GET /api/metrics.json {families, retentionDays:30}.
3. **Alertmanager** — EXACT 10 reguli (neon/redis/gateway/backend-down critical 60s; ai-timeout 120s, fts-latency 300s, queue-high 120s critical, cache-miss 600s, ratelimit-abuse 300s, cooldown-abuse 300s warning), evaluare 15s, stări inactive→pending→firing→resolved, log 200, description RO + runbook. GET /api/alerts, GET /alertmanager/api/v2/alerts (compat), POST /api/alerts/_simulate/:id (QA pur, nu alterează starea reală).
4. **Grafana-compatible** — 4 dashboard-uri (faza23-pipeline 8p, faza23-huburi 7p, faza23-player 4p, faza23-global 7p), GET /api/dashboards, /:uid (JSON Grafana valid, datasource animaxia-prometheus), /:uid/data (serii LIVE din store, 60 puncte).
5. **Synthetics** — EXACT 46 checks (doar GET): homepage ×3, search ×4, pipeline ×3, huburi ×7 (spec enumera 44 → 2 libere alocate pe huburi, onest documentat), feed ×1, recomandări ×1, history ×2 (401), playlists ×2 (401), stats ×2 (401), player ×3 (id real 1907 din /api/all?limit=5), subtitrări ×1, ai-hub ×2 (/api/ai/hub/status), ai-home ×2 (/api/ai/home/stats), 30B ×3 (addressSpace===30000000000), sharding ×3, uptime interne ×7. Runner 60s staggered 1150ms (sub rate-limit platformă), max 4 simultan, timeout 8s, istoric 50.
6. **Summary** — GET /api/summary CONTRACT FIX: 10 gauge-uri în ordinea exactă, pipeline/hub/player/ai/neon/redis/gateway/alerts/synthetics/traces/metrics.
7. **CORS** allowlist :81+:3000 + mirror localhost:*, OPTIONS 204; acces prin :81?XTransformPort=4050 verificat.

**Artefacte producție:** animaxia-ops/dashboards/faza23-{pipeline,huburi,player,global}.json · animaxia-ops/alerts/faza23-alerts.yaml (PrometheusRule, 10 reguli expr reale) · update aditiv animaxia-cloud/observability/global/{prometheus/prometheus-global.yml (+3 scrape jobs: animaxia-backend-faza23 /api/observability/metrics :4000, animaxia-global-gateway /metrics :4040, animaxia-observability :4050), alertmanager/alertmanager-global.yml (verificare rute severity), otel/otel-collector-global.yaml (verificare completă), grafana/provisioning/dashboards/ (provider + 4 dashboards cu uid animaxia-prometheus-global), README.md (stare FAZA 23)}. Generator: scripts/gen-dashboards.ts (sursă unică de adevăr).

## Integrare live cu 23-b (apărut în paralel)

- :4000/api/observability/metrics și :4040/metrics = 200 → scrape-uite (job animaxia-backend-faza23 / animaxia-global-gateway): ai_usage per rută, player_*, auth_events, pipeline_*, gateway failovers/cache.
- Producători OTLP reali: backend + gateway trimit traces → 3792 traces active, ~115 spans/min în collector (services: animaxia-backend, animaxia-gateway).
- Summary agregă onest ambele surse (FAZA 9 prioritate, fallback sume 23-b).

## Eveniment real detectat (demonstrație live a stack-ului)

Load test-urile agentului 23-b au saturat perimetrul (429 la gateway+backend, ~8 req/s): synthetics au picat onest la 14-21/46, animaxia_up{backend}=0, scrape_errors au urcat tolerant (fără crash), alertele animaxia-neon-down/backend-down au intrat în pending (flap → nu fire, corect), fts-latency-high a FOST firing real (p95 613ms > 500ms ținut 300s). Recuperare automată când load-ul a pauzat. Clean window: **46/46 synthetics trecute** (19:20:41).

## Protecție respectată

ZERO modificări în mini-services/animaxia-backend/**, animaxia-realtime/**, animaxia-watchdog/**, redis-global/**, global-gateway/**, src/**, prisma/** (citit doar READ-ONLY pentru validarea rutelor synthetics). Tot ce am scris e NOU sau aditiv în animaxia-ops/ + animaxia-cloud/observability/global/.

## Notă pentru următorii agenți

- Serviciul rulează PID 6392 `bun --hot index.ts`, log în log/run.log. `bun --hot` resetează starea in-memory la reload (traces/metrici istorice se golesc — comportament dev, nu bug).
- Summary contract e FIX — nu-l schimba (consumat de tabul admin/observability al lui 23-b).
- Synthetics pot flapa roșu cât timp 23-b face load test prin gateway — onest, se recuperează singur.
