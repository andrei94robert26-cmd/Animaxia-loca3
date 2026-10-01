# Animaxia — Observability GLOBAL (FAZA 22 → artefacte FAZA 23 complete)

Stiva globală de observabilitate (agregare cross-region peste stivele
per-region din `observability/`): **federare Prometheus**, **Grafana
global**, **Alertmanager cu rutare pe regiuni**, **OTel Collector global**.

> **STARE: ARTEFACTE FAZA 23 COMPLETE, DOCKER-UL RĂMÂNE NEACTIVAT.**
> FAZA 22 a construit stack-ul sub profil `faza23`; FAZA 23 a completat
> artefactele (scrape jobs directe, provisioning dashboard-uri, verificarea
> rutelor severity) și a livrat **echivalentul local rulabil** —
> `mini-services/animaxia-observability` (:4050) — care rulează REAL în
> sandbox: aceleași familii de metrici, aceleași 10 reguli de alertare
> (`animaxia-ops/alerts/faza23-alerts.yaml`), aceleași 4 dashboard-uri.
> Containerul docker de aici pornește tot doar cu `--profile faza23` (zero
> cost de CPU/porturi cât timp nu e activat explicit).

## Activare (FAZA 23)

```bash
cd animaxia-cloud/observability/global

# pornire explicită (necesită rețeaua `animaxia` a stack-ului per-region):
docker compose --profile faza23 up -d

# oprire:
docker compose --profile faza23 down

# verificare: fără --profile faza23, compose IGNOREAZĂ toate serviciile
docker compose ps        # (gol — nimic nu rulează din acest fișier)
```

## Componente

| Serviciu | Imagine | Port host | Rol |
|----------|---------|-----------|-----|
| `prometheus` | prom/prometheus:v3.1.0 | **9095** | tier global de agregare — **federare** din Prometheus-ele regionale (`/federate`), `honor_labels: true`, retenție 30d |
| `grafana` | grafana/grafana:11.5.1 | **3002** | dashboard-uri pe Prometheus-ul global (3000 = frontend, 3001 = Grafana per-region) |
| `alertmanager` | prom/alertmanager:v0.27.0 | **9097** | arbore de rutare pe regiuni (eu/us/asia) × severitate (critical/warning) + inhibit_rules |
| `otel-collector` | otel/opentelemetry-collector-contrib:0.116.1 | **4327/4328** | pipeline OTLP global: gRPC 4317 + HTTP 4318 → memory_limiter / tail_sampling / batch → prometheusremotewrite + otlp/tempo |

Porturile sunt deplasate intenționat (9095/3002/9097/4327/4328) ca stiva
globală să poată coexista cu stivele per-region pe același host.

## Federare Prometheus (cum se strâng metricile)

`prometheus/prometheus-global.yml` NU scrape-uiește serviciile direct —
federază din Prometheus-ele regionale, câte un job per regiune:

| Job | Țintă | match[] |
|-----|-------|---------|
| `eu-prometheus` | `eu-prometheus.animaxia.internal:9090` | `{job=~"animaxia-.*"}`, `{job="prometheus"}`, `{job=~"node\|cadvisor"}` |
| `us-prometheus` | `us-prometheus.animaxia.internal:9090` | idem |
| `asia-prometheus` | `asia-prometheus.animaxia.internal:9090` | idem |

plus `alertmanager-global` și self-monitoring (`prometheus-global`).
`honor_labels: true` păstrează etichetele regiunii/job-ului din sursă.
Hostname-urile `*.animaxia.internal` se înlocuiesc cu adresele reale ale
rețelei private la activarea FAZA 23.

**FAZA 23 (additiv):** pe lângă federație, trei scrape jobs directe —
`animaxia-backend-faza23` (`/api/observability/metrics` pe :4000, metricile
OTel-native ale backend-ului), `animaxia-global-gateway` (`/metrics` pe :4040)
și `animaxia-observability` (`/metrics` pe :4050 — setul complet de familii
FAZA 23: `animaxia_up`, `animaxia_neon_*`, `animaxia_redis_*`,
`animaxia_gateway_*`, `animaxia_pipeline_*`, `animaxia_synthetic_*`,
`animaxia_alerts_*`, …). Rețeaua `animaxia` trebuie să conțină și serviciile
sursă (deploy/docker/). Echivalentul local rulabil al scraperului este chiar
`:4050` (mini-services/animaxia-observability).

## Alertmanager (arbore de rutare)

```
root
├── region=eu   → critical → alertmanager-eu-critical
│               → warning  → alertmanager-eu-warning
├── region=us   → critical / warning (idem)
└── region=asia → critical / warning (idem)
   (orice rută alimentează și sink-ul global de audit — continue: true)
```

`inhibit_rules`: un alert `critical` inhibă `warning`-ul echivalent
(regiune + alertname), iar un `AnimaxiaRegionPrometheusDown` inhibă
zgomotul de `AnimaxiaServiceDown`/`AnimaxiaHighLatency` din regiunea
respectivă.

**FAZA 23 — regulile de alertare:** cele 10 reguli (4 critical de
disponibilitate + 6 warning de performanță) stau ca `PrometheusRule` în
`animaxia-ops/alerts/faza23-alerts.yaml` (expr reale, identice cu cele
evaluate LIVE de echivalentul local `:4050 /api/alerts`); rutarea
severity critical/warning de aici le acoperă pe toate.

**ONEST — receiver-ele sunt PLACEHOLDER:** toate URL-urile sunt pe
domeniul rezervat `.invalid` intenționat — livrările eșuează vizibil până
când FAZA 23 le înlocuiește cu canale reale (PagerDuty/Slack/Opsgenie +
credențiale). Nimic nu „funcționează pe bune" înainte de asta și nu
pretindem contrariul.

## OTel Collector (pipeline global)

```
OTLP (gRPC 4317 / HTTP 4318)
  ├─ traces  → memory_limiter → tail_sampling → batch → otlp/tempo
  ├─ metrics → memory_limiter → batch → prometheusremotewrite → Prometheus global
  └─ logs    → memory_limiter → batch → otlp/tempo
```

**ONEST — tail_sampling:** decizia se ia după ce trace-ul e complet
(colectorul bufferează span-uri): `errors` + `latency > 1500ms` păstrate
100%, restul eșantionat 10%. Trade-ul e memorie vs completitudine, cu
`memory_limiter` (1 GiB) ca plafon; dacă volumul depășește un collector,
calea documentată e tier-ul de load-balancing al collector-ului
(trace-ID aware) — nu e provisionat aici.

## Grafana

`grafana/provisioning/datasources/datasource-global.yml` provisionează
datasource-ul **Prometheus (global)** (`http://prometheus:9090`,
`timeInterval: 30s`).

**FAZA 23:** `grafana/provisioning/dashboards/` provisionează cele 4
tablouri — `faza23-pipeline` (pipeline FAZA 18: anti-spam, rate-limit,
cooldown, queue, windowing/batching/dedup, cache, FTS), `faza23-huburi`
(huburi FAZA 20: browse/facets latency, stats, feed 3-surse, recomandări),
`faza23-player` (player FAZA 17/21: resume, subtitrări WebVTT, erori, fallback
chain) și `faza23-global` (platformă: uptime per serviciu, RAM, Neon, Redis,
AI usage, feed/search activity) — generate din sursa unică de adevăr
(`mini-services/animaxia-observability`, `bun scripts/gen-dashboards.ts`),
cu uid-ul datasource-ului global. Copiile per-region (datasource
`animaxia-prometheus`) stau în `animaxia-ops/dashboards/faza23-*.json`.

## Ce NU face acest stack

- Nu pornește fără `--profile faza23` (nicio excepție).
- Nu înlocuiește stivele per-region — le agregă.
- Nu are canale de notificare reale (placeholder-e oneste, `.invalid`).
- Nu modifică codul serviciilor (exporterele `/metrics` există deja în
  `common/metrics.js` și în edge `shared/metrics.ts`).
