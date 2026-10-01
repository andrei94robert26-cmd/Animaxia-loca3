# Animaxia — Alerts & SLOs (FAZA 9 — Ops & Observability)

| File | Contents |
|---|---|
| [`slo.yaml`](slo.yaml) | SLO definitions (metadata block + targets as comments) and the `animaxia_slo` recording-rule group: `slo:availability:ratio_5m` / `:ratio_1h` / `:error_ratio_1h` per SLO (`mobile_home`, `ai_personal_home`, `edge_gateway`) and `slo:ai_latency:p95_1h` |
| [`alerts.yaml`](alerts.yaml) | The `animaxia-ops-alerts` alert group — 8 alerts with severity (`critical`/`warning`/`info`), `for` durations, `summary`/`description`/`runbook_url` annotations — plus the FAZA 13 `animaxia-sharding-alerts` group (per-shard DB + search cluster, 2 alerts, same annotation style) |

**SLO targets** (per [`animaxia-ops/metrics/METRICS.md`](../metrics/METRICS.md) §4):
availability ≥ **99.5%** over a **28d** window for `/api/mobile/home`,
`/api/ai/personal/home` and the edge gateway (success = non-5xx); AI latency
**p95 < 1500 ms** on `/api/ai*`. Error budget: 0.5% ≈ **3.4 h** (3 h 22 min)
of downtime per 28d. Error-budget burn alert: error rate > 2% for 10m on any
SLO route (`AnimaxiaErrorRateHigh`).

## (a) Prometheus wiring

Both files are plain Prometheus rule files. The existing
`animaxia-cloud/observability/prometheus/prometheus.yml` mounts the rules dir
at `/etc/prometheus/rules/` with `rule_files: [/etc/prometheus/rules/*.yml]` —
note the glob only matches `*.yml`, while these files are `*.yaml`. Easiest
wiring (do **not** edit prometheus.yml from here — apply this in the
observability stack and commit there):

```bash
mkdir -p animaxia-cloud/observability/prometheus/rules/animaxia-ops
cp animaxia-ops/alerts/slo.yaml animaxia-ops/alerts/alerts.yaml \
   animaxia-cloud/observability/prometheus/rules/animaxia-ops/
```

then extend `rule_files` with one line:

```yaml
rule_files:
  - /etc/prometheus/rules/*.yml
  - /etc/prometheus/rules/animaxia-ops/*.yaml
```

(Alternative: point `rule_files` directly at the two absolute paths, or rename
the files to `.yml` on copy — the sub-dir + extra glob keeps the FAZA 9 rules
clearly separated.) Reload Prometheus (`docker compose restart prometheus` or
SIGHUP) and check `/rules`: the `animaxia_slo` and `animaxia-ops-alerts`
groups must appear, and `/alerts` shows the 8 FAZA 9 alerts plus the 2
FAZA 13 sharding alerts (`animaxia-sharding-alerts` group).

Also remember the monolith scrape job — without it the availability/latency
rules have no input (see [`dashboards/README.md`](../dashboards/README.md)):

```yaml
- job_name: animaxia-monolith
  metrics_path: /api/metrics
  static_configs: [{ targets: ["monolith:4000"] }]
```

## (b) Grafana

The rules live in Prometheus, so Grafana needs **no import**: open
**Alerting → Alert rules**, select the `animaxia-prom` datasource — the
`animaxia_slo` recording rules and the `animaxia-ops-alerts` alerts show up as
Prometheus-managed rules with live states (**Alerting → Alerts** for the
current firing view). The *Animaxia — User Experience* dashboard plots the
same availability ratios the alerts key off, and the *Animaxia — AI Cloud*
dashboard shows the latency/error series behind the AI alerts.

If you prefer Grafana-managed alerts (UI editing, contact points, silences):
**Alerting → Alert rules → New alert rule**, paste the `expr` from
`alerts.yaml`, keep the `for` duration and severity label, then wire a contact
point. Note there is no Alertmanager yet (see the comment in prometheus.yml) —
firing alerts currently surface in the Prometheus/Grafana UIs; wiring
notification channels is future work.

## (c) Cloudflare — edge-side alerting

Prometheus only sees the edge through the exporter path
([`dashboards/README.md`](../dashboards/README.md) §edge), and per-isolate
counters reset on eviction. For edge-side alerting **independent** of the
exporter, use **Cloudflare Analytics alerts** (GraphQL Analytics API). Keep
the policy names aligned with the Prometheus alerts so pages are greppable
across stacks:

| Policy name | Condition (GraphQL dataset) | Mirrors Prometheus alert |
|---|---|---|
| `animaxia-edge-waf-blocks-spike` | `firewallEventsAdaptive` — block actions > 50 / 15m | `AnimaxiaEdgeWafBlocksSpike` |
| `animaxia-edge-ratelimit-hits` | `rateLimitAnalytics` — 429s sustained > 5/min for 15m | edge-side abuse pattern (companion to `AnimaxiaAiQuotaSpike`) |
| `animaxia-edge-cache-hit-ratio-low` | `httpRequestsAdaptiveGroups` — cached HIT share < 30% / 30m | `AnimaxiaEdgeCacheHitRatioLow` |

Terraform-ish sketch (documented snippet, **not** a complete `.tf` — wire
providers/vars yourself; built-in notification policy types cover the
standard alerts, the custom thresholds above additionally need a scheduled
GraphQL check that flips a webhook, e.g. the same cron the curl-exporter in
`dashboards/README.md` §edge option 2 runs):

```hcl
# sketch — animaxia-edge-alerts.tf (excerpt)
variable "cloudflare_account_id" { type = string }
variable "oncall_webhook"        { type = string }

data "cloudflare_zone" "animaxia" {
  name = "animaxia.example.com"     # the zone the workers route on
}

resource "cloudflare_notification_policy" "waf_blocks_spike" {
  account_id = var.cloudflare_account_id
  name       = "animaxia-edge-waf-blocks-spike"
  alert_type = "firewall_alert"      # closest built-in; custom 50/15m threshold
  enabled    = true                  # via the scheduled GraphQL check below
  webhooks   = [var.oncall_webhook]
  filters = {
    zone_tag = [data.cloudflare_zone.animaxia.id]
  }
}

# Custom thresholds (WAF > 50/15m, rate-limit > 5/min/15m, cache HIT < 30%/30m):
# a cron job queries the GraphQL Analytics API with the zone tag + time window
#   viewer.zones(filter: {zoneTag: $zone}) {
#     firewallEventsAdaptive(filter: {datetime_geq: $since, action: "block"}, limit: 10000)
#     httpRequestsAdaptiveGroups(limit: 10000, filter: {datetime_geq: $since}) { sum { requests } cacheStatus }
#   }
# and posts to the same webhook the notification policy uses.
```

## Alert → runbook matrix

| Alert | Severity | `for` | Runbook (`animaxia-ops/runbooks/`) |
|---|---|---|---|
| `AnimaxiaErrorRateHigh` | critical | 10m | `error-budget-burn.md` |
| `AnimaxiaNeonDisconnected` | critical | 2m | `neon-outage.md` |
| `AnimaxiaServiceDown` | critical | 5m | `service-down.md` |
| `AnimaxiaAiQuotaSpike` | warning | 15m | `ai-quota-spike.md` |
| `AnimaxiaAiLatencySLOBurn` | warning | 15m | `ai-provider-degraded.md` |
| `AnimaxiaAiProviderDegraded` | warning | 0m | `ai-provider-degraded.md` |
| `AnimaxiaEdgeWafBlocksSpike` | warning | 5m | `edge-waf-misconfig.md` |
| `AnimaxiaEdgeCacheHitRatioLow` | info | 30m | `edge-cache-hit-ratio.md` |
| `AnimaxiaShardDown` | critical | 2m | `shard-down.md` |
| `AnimaxiaSearchClusterNodeDown` | warning | 5m | `search-cluster-node-down.md` |

The two FAZA 13 sharding alerts live in the `animaxia-sharding-alerts` group
(same file, appended below `animaxia-ops-alerts`): `AnimaxiaShardDown` fires
on `animaxia_db_shard_connected == 0` (logical mode = the whole SQL layer
degraded, physical mode = that shard's branch pool down, queries fall back to
main with a latency penalty) and `AnimaxiaSearchClusterNodeDown` on a degraded
search cluster (`nodes_healthy < nodes_total` while enabled). Their series
come from the monolith `shards` metrics collector (FAZA 13, Task 13-5) — see
[`../metrics/METRICS.md`](../metrics/METRICS.md) §FAZA 13 and the
*Animaxia — DB Shards* dashboard (`../dashboards/db-shards.json`).

The runbooks live in `animaxia-ops/runbooks/` (companion FAZA 9 deliverable —
the `runbook_url` annotation in `alerts.yaml` points at exactly these paths).
`neon-outage.md`, `ai-provider-degraded.md` and `edge-waf-misconfig.md` are
the canonical ones named by the alert specs; the rest follow the same
template.
