# Animaxia — Autoscaling (HPA) — FAZA 22

Politicile de autoscaling pentru clusterul Kubernetes de producție:
**HPA (Horizontal Pod Autoscaler)** per serviciu + motorul de decizie
(`autoscale-sim.mjs`) care modelează aceleași politici pe semnale de
latență p95, nu doar CPU/memorie.

## Politici (rezumat)

| Serviciu | min | max | CPU | Mem | p95 țintă | Observații |
|----------|-----|-----|-----|-----|-----------|------------|
| `animaxia-backend` | 2 | 20 | 70% | 75% | 800 ms | scaleUp 60s, scaleDown 300s, PDB minAvailable 1 |
| `animaxia-realtime` | 2 | 10 | 70% | — | 200 ms | WebSocket — latență sensibilă, PDB 1 |
| `animaxia-ai` | 2 | 12 | 75% | — | 2500 ms | vezi nota latency-based de mai jos |
| `animaxia-frontend` | 2 | 16 | 65% | — | 500 ms | DOAR SSR — staticul e la CDN/edge anycast |
| `animaxia-global-gateway` | 2 | 10 | 60% | — | 150 ms | perimetru; state-ul partajat e în redis-global |

Sursa unică de adevăr: [`policies.json`](policies.json) (consumat și de
simulator). Reguli globale: `cooldownSec: 60`, `maxSurgePercent: 50`.

## Fișiere

| Fișier | Rol |
|--------|-----|
| `hpa-core-backend.yaml` | Namespace `animaxia-core` + Deployment `animaxia-backend` (probes `/api/health`) + HPA 2–20 + PDB |
| `hpa-realtime.yaml` | Deployment + HPA 2–10 CPU 70% + PDB |
| `hpa-ai.yaml` | Deployment + HPA 2–12 CPU 75% (nota latency-based) |
| `hpa-frontend.yaml` | Deployment + HPA 2–16 CPU 65% (nota CDN) + PDB |
| `hpa-global-perimeter.yaml` | Deployment `animaxia-global-gateway` + HPA 2–10 CPU 60% (nota redis-global) + PDB |
| `policies.json` | tabelul de politici (min/max/ținte CPU/mem/latență + ferestre) |
| `autoscale-sim.mjs` | motorul de decizie + CLI `--demo` (4 scenarii) |

## Cum se aplică

### kubectl (aplicare directă)

```bash
# tot setul:
kubectl apply -f deploy/autoscaling/

# sau individual:
kubectl apply -f deploy/autoscaling/hpa-core-backend.yaml
kubectl apply -f deploy/autoscaling/hpa-realtime.yaml

# verificare:
kubectl -n animaxia-core get hpa
kubectl -n animaxia-core describe hpa animaxia-backend
```

Cerințe pe cluster: **Metrics Server** (HPA pe CPU/memorie nu funcționează
fără el — `kubectl get --raw /apis/metrics.k8s.io/v1beta1` trebuie să
răspundă) și `autoscaling/v2` (Kubernetes ≥ 1.23).

### Helm (chart-ul existent)

Chart-ul `deploy/helm/animaxia-cloud` are deja un template `hpa.yaml`;
valorile de aici îi servesc drept referință de politici. Pentru deploy prin
Helm, setează echivalentele în `values-production.yaml`:

```yaml
backend:
  autoscaling:
    enabled: true
    minReplicas: 2
    maxReplicas: 20
    targetCPUUtilizationPercentage: 70
    targetMemoryUtilizationPercentage: 75
```

### Simulator (fără cluster)

```bash
bun deploy/autoscaling/autoscale-sim.mjs --demo
```

tipărește 4 scenarii cu deciziile (`scale-up` / `hold` / `scale-down` +
`targetReplicas` + motiv). Utilizare ca bibliotecă (fără efecte secundare la
import):

```js
import { decideAutoscale } from './autoscale-sim.mjs';
const decision = await decideAutoscale('global-gateway', [
  { cpuPct: 55, memPct: 50, p95Ms: 240 },
  { cpuPct: 58, memPct: 52, p95Ms: 280 },
], 2);
// → { action: 'scale-up', reason: 'latency above target …', targetReplicas: 4 }
```

## Note de design

- **AI — latency-based scaling:** CPU-ul e un proxy slab pentru inference
  (LLM-urile așteaptă după API-uri externe cu CPU mic). HPA rulează pe CPU
  75%, iar ținta reală (`latencyP95MsTarget: 2500`) e modelată de simulator
  și poate fi conectată ca metrică externă HPA (PodMonitor p95) după ce
  observabilitatea FAZA 23 pornește.
- **Frontend:** DOAR SSR. Asset-urile statice sunt servite de CDN/edge
  anycast (Cloudflare cache rules + R2) — de aici ținta CPU cea mai strictă:
  latența de randare SSR e vizibilă utilizatorului la fiecare navigare care
  ratează cache-ul de edge.
- **Global-gateway:** ținta CPU 60% (cea mai strictă) — perimetrul stă în
  fața tuturor. Scalarea pod-urilor e sigură la orice replici pentru că
  contoarele (rate-limit distribuit, cooldown, anti-spam) nu stau în
  memoria pod-ului, ci în **redis-global** (Upstash, `domain/redis/`) —
  vezi dublura locală de validare `mini-services/redis-global:4030`.

## Ce NU este acest modul

- **Nu se modifică codul backendului** (sau al oricărui serviciu): toate
  manifestele sunt infrastructură pură; probele folosesc rutele existente
  (`/api/health`, `/health`).
- Nu este „activat" nicăieri automat: apply-ul este manual (kubectl/helm),
  exact ca restul artefactelor de deploy din `animaxia-cloud`.
- `redis-global` NU are HPA în realitate (deploy gestionat Upstash) —
  intrarea din `policies.json` modelează onest doar podeaua de state
  partajat pentru simulator.
