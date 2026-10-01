# animaxia-observability — FAZA 23 (port FIX 4050)

Stack de observabilitate enterprise **RUNNABLE LOCAL** pentru platforma Animaxia:
echivalentul local, rulabil real, al stack-ului de producție din
`animaxia-cloud/observability/global/` (profil docker `faza23`).

```
OTel Collector (OTLP/HTTP-JSON)  ·  Prometheus (scrape 10s + /metrics)
Alertmanager (10 reguli, eval 15s)  ·  Grafana-compatible (4 dashboards + live data)
Synthetics globale (EXACT 46 checks, 60s)  ·  Summary API (contract fix pentru UI)
```

- **ZERO dependențe externe** — doar `node:http`, `node:net`, `node:crypto` + built-ins Bun.
- **Port hardcodat 4050** (`config.ts` — fără env; contractul platformei FAZA 22/23).
- TypeScript strict (`bun x tsc --noEmit` = 0 erori), `bun --hot index.ts` la dev.

```bash
bun run dev            # pornire dezvoltare (hot reload)
# pornire fundal cu log (cum rulează acum în sandbox):
mkdir -p log && nohup bun run start >> log/run.log 2>&1 &
curl -s localhost:4050/health
```

---

## Maparea ONESTĂ local (rulează real) ↔ producție

| Componentă | Local `:4050` (acest serviciu) | Producție (`animaxia-cloud/observability/global/`, profil `faza23`) |
|---|---|---|
| OTel Collector | `POST /v1/traces` + `POST /v1/metrics` (OTLP/HTTP-JSON canonic + format simplu browser); ring buffer LRU 5000 traces | `otel/otel-collector-global.yaml` — otel-collector-contrib: otlp grpc 4317/http 4318 → tail_sampling (errors/slow 100%) → prometheusremotewrite + otlp/tempo |
| Prometheus | scraper 10s tolerant (eroare → `animaxia_scrape_errors_total{job}`, niciodată crash) + `GET /metrics` text Prometheus complet | `prometheus/prometheus-global.yml` — federație 3 regiuni + scrape direct `animaxia-backend-faza23` (`/api/observability/metrics` :4000), `animaxia-global-gateway` (`/metrics` :4040), `animaxia-observability` (:4050); retenție `--storage.tsdb.retention.time=30d` |
| Alertmanager | 10 reguli în `modules/alerts.ts` (eval 15s, inactive→pending→firing→resolved, log 200 notificări, description RO + runbook) | `animaxia-ops/alerts/faza23-alerts.yaml` (PrometheusRule, aceleași 10 cu `expr` reale) + `alertmanager/alertmanager-global.yml` (rute regiuni × severități) |
| Grafana | 4 dashboards `GET /api/dashboards/:uid` (JSON Grafana valid, datasource `animaxia-prometheus`) + `GET /api/dashboards/:uid/data` (serii LIVE din store, 60 puncte) | `animaxia-ops/dashboards/faza23-{pipeline,huburi,player,global}.json` + provisioning în `global/grafana/provisioning/dashboards/` |
| Synthetics | EXACT 46 checks GET, runner 60s staggered (max 4 simultan), timeout 8s, istoric 50/check | în producție: exterior (regional checkers); aici regăsești definiția canonică a celor 46 |
| Retenție | 30 zile pe seriile istorice (`RETENTION_DAYS`, sweep orar) | 30 zile TSDB Prometheus global |

**Ce NU e local:** evaluarea reală PromQL pe TSDB pe disc (store-ul local e in-memory cu
istoric limitat), tail-sampling-ul real al collectorului și canalele de notificare
(receiverele Alertmanager din cloud sunt webhook-uri `.invalid` — onest, se activează
cu credențiale reale). Tot restul (scrape, evaluare alerte, synthetics, ingest OTLP,
dashboard-uri live) rulează REAL.

---

## Surse scrape-uite (10s, TOLERANT — 404/eroare nu omoară serviciul)

| Sursă | URL | Rol |
|---|---|---|
| Backend FAZA 9 | `:4000/api/metrics` | Prometheus text — re-expus cu label `job` |
| Backend FAZA 23 (23-b) | `:4000/api/observability/metrics` | metrici OTel-native (AI usage, player, auth…) |
| Gateway FAZA 23 (23-b) | `:4040/metrics` | self-metrics gateway (regiuni, failover, cache) |
| Backend health | `:4000/api/health` | `animaxia_neon_connected/_latency_ms/_docs` |
| Search status FAZA 18 | `:4000/api/search/status` | `pipelineIntegrated` + cele 10 straturi → `animaxia_pipeline_*` |
| Hub stats FAZA 20 | `:4000/api/hub/stats` | itemi total; rute hub din FAZA 9 re-expuse |
| Hub feed | `:4000/api/hub/feed?limit=1` | feed 3-surse (personal/global/ai) |
| Gateway health/status | `:4040/api/infra/{health,status}` | `animaxia_gateway_*` (regiuni, failover, cache, redisMode) |
| Redis global | RESP pe TCP `:4030` (client propriu `node:net`) | PING + DBSIZE → `animaxia_redis_*` |
| Watchdog / Realtime / Frontend | `:4020/health`, `:4010/` (orice HTTP = UP), `:3000/` | `animaxia_up{service}` |

Sursa lipsește → familia e omisă onest sau rămâne la 0 (fără date inventate).

## Familii Prometheus proprii (peste cele re-expuse)

`animaxia_up{service}` · `animaxia_uptime_seconds{service}` · `animaxia_scrape_errors_total{job}` ·
`animaxia_otel_spans_received_total{service}` · `animaxia_otel_traces_active` ·
`animaxia_otel_metrics_received_total{service}` · `animaxia_neon_connected/_latency_ms/_docs` ·
`animaxia_redis_connected/_keys` · `animaxia_gateway_up/_region_healthy{region}/_region_latency_ms{region}/_failovers_total/_cache_hits_total/_requests_total{region}` ·
`animaxia_pipeline_antisam_hits_total/_ratelimit_hits_total/_cooldown_served_total/_cooldown_deprioritized_total/_queue_length/_queue_inflight/_windowing_rate_per_sec/_dedup_coalesced_total/_batching_batches_total/_cache_hits_total/_cache_misses_total/_cache_hit_rate/_requests_total/_rejections_total` ·
`animaxia_hub_total_items/_requests_total{route}/_duration_ms{route}` · `animaxia_feed_activity_total{source}` ·
`animaxia_search_activity_total` · `animaxia_fts_latency_p95_ms/_p50_ms/_docs` ·
`animaxia_player_resume_events_total/_subtitle_requests_total/_playback_errors_total/_fallback_chain_total` (0 onest până sosește OTLP real) ·
`animaxia_ai_usage_calls_total{route}/_errors_total{route}` · `animaxia_auth_events_total` ·
`animaxia_synthetic_checks_total{check,region,result}/_duration_ms{check}/_pass_ratio` ·
`animaxia_alerts_firing{alert}/_pending{alert}` · `animaxia_backend_memory_rss_bytes` ·
+ toate familiile FAZA 9 re-expuse cu `job` (inclusiv histogramele `animaxia_http_request_latency_ms_*`).

---

## API

### Sănătate / info
- `GET /` — info serviciu + harta endpoint-urilor.
- `GET /health`, `GET /api/observability/health` — `{ok, uptimeSec, components:{collector,metrics,alerts,dashboards,synthetics}, retentionDays:30}`.

### OTel Collector
- `POST /v1/traces` — acceptă **(a)** OTLP/HTTP-JSON canonic
  `{resourceSpans:[{resource:{attributes:[{key:"service.name",value:{stringValue:…}}]},scopeSpans:[{spans:[{traceId,spanId,parentSpanId,name,kind,startTimeUnixNano,endTimeUnixNano,status:{code},attributes:[…]}]}]}]}`
  și **(b)** format simplu `{spans:[{traceId,spanId,parentSpanId,name,service,startMs,endMs,status,attributes:{…}}]}` → `{"acceptedSpans":N}`.
- `POST /v1/metrics` — `{metrics:[{name,kind:"counter|gauge|histogram",value,labels,tsMs}]}` → `{"accepted":N}`.
- `GET /api/traces?service=&limit=&error=` · `GET /api/traces/stats` `{services:[{name,spans,errors,errorRate,avgMs}],spansPerMin,tracesActive}` · `GET /api/traces/:traceId` (spans sortați pe startMs).

### Prometheus
- `GET /metrics` — text Prometheus complet (HELP+TYPE, familii proprii + re-expuse).
- `GET /api/metrics.json` — `{families:[{name,type,series:[{labels,value}]}], retentionDays:30}`.

### Alertmanager (EXACT 10 reguli)
`animaxia-neon-down` · `animaxia-redis-down` · `animaxia-gateway-down` · `animaxia-backend-down` ·
`animaxia-ai-timeout` · `animaxia-fts-latency-high` · `animaxia-queue-high` ·
`animaxia-cache-miss-high` · `animaxia-ratelimit-abuse` · `animaxia-cooldown-abuse`

- `GET /api/alerts` — `{rules:[…10], firing, pending, log}` (log = ultimele 200 tranziții).
- `GET /alertmanager/api/v2/alerts` — format compatibil Alertmanager v2.
- `POST /api/alerts/_simulate/:id` — DOAR QA: evaluează regula cu snapshot-ul sintetic din body,
  **nu alterează starea reală** (răspuns: `simulatedState` + `currentRealState`).

### Grafana-compatible
- `GET /api/dashboards` — lista (4).
- `GET /api/dashboards/:uid` — JSON Grafana complet (`faza23-pipeline`, `faza23-huburi`, `faza23-player`, `faza23-global`).
- `GET /api/dashboards/:uid/data` — `{panels:[{id,title,unit,series:[{name,labels,points:[[tsSec,value]…60]}]}]}` — serii LIVE din metrics store.

### Synthetics — EXACT 46 (toate GET, read-only)
| # | Categorie | Checks |
|---|---|---|
| 3 | homepage | eu/us/asia → `:3000/` direct |
| 4 | search | `/api/search/advanced?q=…` eu/us/asia + autocomplete eu (prin `:4040?region=`) |
| 3 | pipeline FAZA 18 | `/api/search/status` eu/us/asia → `pipelineIntegrated===true` |
| 7 | huburi FAZA 20 | browse eu/us/asia, facets eu (`browse?facets=1` — rută reală), stats us, scale eu, years eu |
| 1 | feed 3-surse | `/api/hub/feed` eu |
| 1 | recomandări | `/api/hub/recommendations` eu |
| 2 | history FAZA 21 | `/api/users/me/history` fără token → 401 (eu/us) |
| 2 | playlists FAZA 21 | `/api/playlists` → 401 (eu/asia) |
| 2 | stats FAZA 21 | `/api/users/me/stats` → 401 (eu/us) |
| 3 | player FAZA 17 | `/api/content/1907/player` eu/us/asia (id real din `/api/all?limit=5`) |
| 1 | subtitrări | `/api/player/subtitles/content/1907/subtitles` (rută reală FAZA 21) |
| 2 | AI Hub FAZA 16 | `/api/ai/hub/status` eu/us (rută reală) |
| 2 | AI Home FAZA 15 | `/api/ai/home/stats` eu/asia (rută reală) |
| 3 | AR10M | `/api/ar10m/stats` → `capacity.designed===10000000` (eu/us/asia; fost „30B logic” simulat — eliminat) |
| 3 | sharding FAZA 13 | `/api/shards` → cluster healthy (eu/us/asia) |
| 7 | uptime interne | backend health, redis RESP PING, gateway health, realtime (orice HTTP), watchdog, frontend, self `:4050/health` |

**Notă onestă:** specificația enumera categoriile însumând 44, cerând total 46 — cele 2
check-uri libere au fost alocate pe huburi (`hub-scale-eu`, `hub-years-eu`), rute reale
FAZA 20; `pipeline-status-us` acoperă cea de-a 3-a regiune pentru pipeline. Total = 46 exact.

- `GET /api/synthetics` — `{total:46, passing, failing, lastRunAt, byRegion, checks}`.
- `GET /api/synthetics/:id/history` — ultimele 50 rulări.
- `POST /api/synthetics/_run` — rulare imediată completă (QA), pacing sub rate-limit-ul platformei.

Pacing: rularea programată stagger 1150ms/check (46 pe fereastra de 60s) — good citizen
față de propriul rate-limit al platformei (FAZA 9/18: 120 req/min/IP); max 4 simultan;
`_run` folosește pacing mai alert (700ms, max 6).

### Summary (CONTRACT FIX — consumat de tabul #/admin/observability)
`GET /api/summary` → `{ok, service, generatedAt, gauges:[10 exact în ordinea
uptime, backend, neon, redis, gateway, ai_usage, search_activity, hub_activity,
pipeline_health, synthetics], pipeline:{layers:[10 live], requests5m, rejections5m,
queueLength, cacheHitRate}, hub:{routes, feed3, stats}, player, ai, neon, redis,
gateway, alerts:{firing, pending, totalRules:10}, synthetics:{total:46,…},
traces:{active, spansPerMin, services, recent:[8]}, metrics:{families, samples, retentionDays:30}}`.

### CORS
Allowlist `http://localhost:81` + `http://localhost:3000`, mirror dev pentru orice
`http://localhost:*`, fără `Origin` → OK; `OPTIONS` → 204. Browserul apelază prin
`:81` cu `?XTransformPort=4050` (gateway-ul Caddy face forward pe 4050).

---

## Structură

```
config.ts               — port 4050 fix, intervale, surse, CORS (zero env)
index.ts                — server HTTP + rutare
modules/collector.ts    — OTLP ingest (2 formate) + ring buffer 5000 + agregate
modules/metrics-store.ts— registru familii proprii + re-expuse + istoric + retention
modules/prometheus.ts   — parser/randare Prometheus text + histogram_quantile
modules/resp-client.ts  — client RESP minimal (node:net) pentru redis :4030
modules/scrape.ts       — scraper 10s tolerant + probe health + expunere familii
modules/alerts.ts       — cele 10 reguli + stări + log + simulate QA
modules/dashboards.ts   — definițiile celor 4 dashboard-uri + live data
modules/synthetics.ts   — cele 46 checks + runner staggered + istoric
modules/summary.ts      — contractul /api/summary
scripts/gen-dashboards.ts — scrie artefactele Grafana (animaxia-ops/ + cloud provisioning)
log/run.log             — log runtime
```

## Artefacte producție scrise de acest serviciu

- `animaxia-ops/dashboards/faza23-{pipeline,huburi,player,global}.json` — format Grafana, datasource `animaxia-prometheus`.
- `animaxia-ops/alerts/faza23-alerts.yaml` — PrometheusRule cu cele 10 reguli (expr reale).
- `animaxia-cloud/observability/global/prometheus/prometheus-global.yml` — scrape jobs noi (additiv).
- `animaxia-cloud/observability/global/alertmanager/alertmanager-global.yml` — verificare rute critical/warning (additiv).
- `animaxia-cloud/observability/global/otel/otel-collector-global.yaml` — verificare completă receivers/exporters/pipelines (additiv).
- `animaxia-cloud/observability/global/grafana/provisioning/dashboards/` — provider + cele 4 dashboards (uid datasource `animaxia-prometheus-global`).

Regenerare: `bun scripts/gen-dashboards.ts` (din acest folder).
