# Animaxia — FAZA 24 — Stabilitate Globală (autoscaling + LB + failover)

Artefactele de producție ale FAZEI 24. **Sursa unică de adevăr pentru toate
valorile**: `mini-services/animaxia-stability/config.ts` — control plane-ul
rulabil local pe **:4060** (echivalentul exact al acestor manifește, cu
metrici REALE citite de pe platforma live). Suita
`animaxia-backend/tests/stability-faza24.mjs` afirmă consistența
artefact ↔ config ↔ comportament.

## Ce extinde FAZA 24 față de FAZA 22 (deploy/autoscaling/)

| Aspect | FAZA 22 (existent, neatins) | FAZA 24 (acest folder, aditiv) |
|---|---|---|
| Backend | HPA 2–20, CPU 70% / mem 75%, p95 800ms | **reguli exacte**: CPU>70% 5min · p95>500ms 5min · coadă>300 2min; scale-in CPU<40% / p95<200ms 10min |
| Gateway | HPA global 2–10 | **per regiune EU/US/ASIA 2–15**, metrici RPS/latență/error-rate |
| AI | HPA unic `animaxia-ai` 2–12 | **4 motoare separate**: ai-home, ai-hub, ai-personal, ai-rag (2–10, req/min + LLM latency + timeout rate) |
| Deploy | — | **rolling zero-downtime** (maxUnavailable 0, porți de health, rollback automat) |
| Rutare | gateway local + edge FAZA 22 | **geo-routing declarativ + fallback chains + 3 health-check-uri globale** |
| Overload | limite perimetru pe clase | **traffic shaping cu priorități** (critice garantate, non-critice respinse onest) |
| Neon | — | **failover Neon** (multi-host + read replica + sondă reconectare) |

## Fișiere

| Fișier | Rol |
|---|---|
| `hpa-backend-faza24.yaml` | HPA backend cu regulile EXACTE FAZA 24 (custom metrics: latență p95 + coadă pipeline) |
| `hpa-gateway-regions-faza24.yaml` | 3 HPA per regiune (eu/us/asia), 2–15 replici, RPS/latență/erori |
| `hpa-ai-engines-faza24.yaml` | 4 HPA pentru AI Home / AI Hub / Personal AI / RAG engine |
| `rollout-zero-downtime.yaml` | strategia de rolling deploy (surge + readiness înainte de trafic + PDB + rollback automat) |
| `global-lb-geo-faza24.yaml` | geo-routing EU/US/ASIA + lanțuri de fallback + health-check-uri globale |
| `traffic-shaping-faza24.yaml` | clase de prioritate + limite per regiune + praguri + mesajul onest „platformă ocupată" |
| `failover-neon-faza24.yaml` | failover Neon: connection multi-host, read replica, comportamentul driverului |

## Cum se aplică

```bash
kubectl apply -f deploy/stability-faza24/
kubectl -n animaxia-core get hpa
kubectl -n animaxia-core describe hpa animaxia-backend
kubectl -n animaxia-core rollout status deployment/animaxia-backend
```

Cerințe: Metrics Server (CPU/mem) + **Prometheus Adapter** cu custom metrics
`animaxia_http_latency_p95_ms`, `animaxia_pipeline_queue_length`,
`animaxia_gateway_rps`, `animaxia_ai_requests_per_min` (expuse deja de
:4000/api/metrics, :4040/metrics și :4000/api/observability/metrics —
FAZA 9/18/22/23, zero modificări pe platformă).

## Maparea local ↔ producție (onest)

| Local (:4060, rulabil) | Producție (acest folder) |
|---|---|
| `evaluateSeries()` — motor pur cu ferestre exacte (300s/120s/600s) | HPA `behavior.scaleUp/scaleDown.stabilizationWindowSeconds` + custom metrics |
| reader.ts: CPU din `/proc/<pid>`, p95 din `/api/search/status`, coada din stage 4 pipeline | Metrics Server + Prometheus Adapter |
| LB `route()` + fallback chains | GeoDNS / Cloudflare Workers geo-routing (FAZA 22) + acest plan declarativ |
| failover regiuni prin API-ul admin REAL al gateway-ului | kubectl drain + PDB + gateway health |
| deployer.ts: surge + poartă health REALĂ + rollback | `strategy: RollingUpdate` + `maxUnavailable: 0` + Argo Rollouts (rollback automat) |
| shaping `evaluate()` | Envoy/NGINX rate-limit pe clase + PriorityLevelConfiguration |
| Neon: driver local-fallback + sondă 60s (există în platformă) | connection multi-host pooler + read replica |

## Ce NU face FAZA 24 (protejat)

Pipeline-ul FAZA 18 (10 straturi), huburile FAZA 20, FAZA 21
(history/playlists/stats/admin-playerhub), FAZA 23 (observabilitate),
motorul real Neon FTS, logica 30B, sharding-ul FAZA 13, playerul FAZA 17,
AI Home/Hub (FAZA 15/16) — **niciodată modificate**; doar susținute
infrastructural. Gateway-ul FAZA 22 doar rutează (config, zero cod).
