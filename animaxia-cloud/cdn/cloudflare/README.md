# Animaxia Cloud — CDN + Edge (Cloudflare)

Production edge layer for Animaxia Cloud: a Cloudflare Worker (**animaxia-edge**)
in front of the API gateway, plus the zone plumbing around it — WAF, rate
limiting, cache rules, Workers KV (runtime config) and R2 (media).

```
                                     Cloudflare edge (this directory)
 ┌──────────┐   ┌─────────────────────────────────────────────────────────────┐
 │  user /  │   │  WAF (managed + custom)  →  Rate Limiting  →  Cache Rules   │
 │  browser │──▶│        │ terraform/waf.tf       rate-limit.tf     cache-rules.tf
 └──────────┘   │        ▼                                                      │
                │  animaxia-edge Worker (src/worker.js, wrangler.toml)          │
                │   1 KV config (60s cache) ──► KV namespace "animaxia-config" │
                │   2 maintenance mode (503, /api/health bypass)               │
                │   3 /media/* ──► R2 bucket "animaxia-media"  (X-Edge: r2)    │
                │   4 public GETs ──► Cache API (X-Edge-Cache: HIT/MISS)       │
                │   5 origin failover (X-Edge-Fallback)                        │
                │   6 security headers · 7 per-IP backstop limit               │
                └───────────┬─────────────────────────────────────────────────┘
                            │  ORIGIN_URL (wrangler.toml [vars])
                            ▼
                   api.animaxia.com  (proxied A/AAAA → your origin)
                            │
                            ▼
                   gateway-service :8080  ──▶  auth :4001 · content :4002 · ai :4003
                                                analytics :4004 · search :4005
                                                premium :4006 · social :4007
                                                mobile :4008 · queue :4009
```

## What lives where

| Path | What it is |
|---|---|
| `src/worker.js` | The edge worker — Cache API caching, R2 media, KV config, maintenance mode, failover, security headers, backstop rate limit. Zero dependencies. |
| `wrangler.toml` | Worker config: name, routes, KV + R2 bindings, `ORIGIN_URL` var. |
| `terraform/` | Zone settings, DNS, WAF, rate limiting, cache rules, KV namespace + seed keys, R2 buckets (provider `cloudflare/cloudflare ~> 4.0`). |
| `kv/config.example.json` | Edge runtime config stored in KV — editable at runtime, no redeploy. |
| `scripts/deploy-worker.sh` | Auth check → KV create/seed → `wrangler deploy` → smoke curl. |
| `scripts/upload-media.sh` | Poster/thumbnail upload into R2 + prints the public URL. |

## Setup

### 0. Prerequisites

- The zone (`animaxia.com` by default — see `terraform/variables.tf`) is already
  added to your Cloudflare account.
- Tools: `terraform >= 1.5`, `wrangler` v3+ (`npm i -g wrangler`), `curl`.
- A Cloudflare **API token** (dashboard → My Profile → API Tokens → Create Token
  → "Edit Cloudflare Workers" template is a good start) with at least:

  | Scope | Permission |
  |---|---|
  | Zone → Zone | Read |
  | Zone → DNS | Edit |
  | Zone → Zone Settings | Edit |
  | Zone → WAF | Edit |
  | Zone → Cache Rules | Edit |
  | Zone → Rate Limiting | Edit |
  | Account → Workers KV Storage | Edit |
  | Account → Workers Scripts | Edit |
  | Account → Cloudflare R2 | Edit |

  The same token works for both Terraform and `wrangler`
  (`export CLOUDFLARE_API_TOKEN=...`) — or keep separate tokens; the worker
  itself needs **no** secrets (it's dependency-free).

### 1. Terraform (zone plumbing: DNS, WAF, limits, cache rules, KV, R2)

```bash
cd cdn/cloudflare/terraform

export TF_VAR_cloudflare_api_token="eyJ..."          # never hardcode it
export TF_VAR_cloudflare_account_id="<account id>"   # wrangler whoami / dashboard
export TF_VAR_origin_ip="<public IP of your gateway origin>"

terraform init
terraform plan            # review: zone settings, 3-4 DNS records, 3 rulesets,
                          # KV namespace + 2 keys, 2 R2 buckets
terraform apply
terraform output          # kv_namespace_id → paste into ../wrangler.toml
```

Notes:

- All account/zone-specific values are variables (`variables.tf`); secrets are
  `sensitive = true` (`cloudflare_api_token`). Nothing is hardcoded.
- Zone settings applied: HTTP/3 on, Brotli on, min TLS 1.2, **Full (strict)**,
  always-use-HTTPS, TLS 1.3, Early Hints, WebSockets, IPv6.
- DNS: proxied `A`/`AAAA` for `api` → your origin, plus example `www`/apex
  records for the frontend (edit `main.tf` if the frontend lives elsewhere).
- WAF (`waf.tf`): Cloudflare Managed Ruleset + OWASP Core (medium sensitivity)
  via the `http_request_firewall_managed` phase; custom rules (threat score > 30
  block, SQLi probe **log-first** rule, XSS block, bad-bot block, disabled geo
  example) via `http_request_firewall_custom`.
- Rate limiting (`rate-limit.tf`): `/api/auth` 10 req / 60s / 600s block;
  everything under `/api/*` 600 req / 60s / 60s block — keyed per client IP.
- Cache rules (`cache-rules.tf`): cache the 8 public catalog prefixes at the
  edge (60s edge TTL, browser TTL respects origin); bypass
  `auth/premium/social/users`.
- R2 (`r2.tf`): `animaxia-media` (private, worker-served) +
  `animaxia-media-public` (public access). The Glacier-class lifecycle policy
  (transition after 90 days, abort multipart after 7) needs provider ≥ 5.x as
  code — `r2.tf` documents the exact `cloudflare_r2_bucket_lifecycle` block to
  uncomment after bumping the provider, plus a provider-4.x-compatible
  S3-API one-liner that works today. Provider 4.x also can't attach R2 custom
  domains — the commented CNAME in `r2.tf` shows how to wire `media.<zone>`.

### 2. Worker

```bash
cd cdn/cloudflare
wrangler login                     # or export CLOUDFLARE_API_TOKEN=...
./scripts/deploy-worker.sh         # KV create/seed + wrangler deploy + smoke curl
```

The script aborts if `wrangler.toml` still has the `REPLACE_WITH_KV_ID`
placeholder — paste `terraform output -raw kv_namespace_id` first.

**Point the worker at your gateway** (the default `ORIGIN_URL`
`https://gateway.animaxia.internal` is a placeholder for the internal service
name): edit `[vars]` in `wrangler.toml` (e.g. `https://api.animaxia.com`) and
re-run the deploy script. Then uncomment the `routes` in `wrangler.toml` to run
the worker on the zone itself.

## Testing each layer

```bash
EDGE="https://animaxia-edge.<your-subdomain>.workers.dev"   # or https://api.animaxia.com
```

**Worker is alive + origin wired:**

```bash
curl -s "$EDGE/api/health" | head -c 300      # aggregated gateway health JSON
```

**Edge cache (HIT/MISS)** — `X-Edge-Cache` comes from the worker's Cache API
layer; `X-Cache` is the gateway's internal cache (both can hit):

```bash
curl -sI "$EDGE/api/anime" | grep -i "x-edge-cache\|x-cache"   # MISS (first call)
curl -sI "$EDGE/api/anime" | grep -i "x-edge-cache"            # HIT  (cached at edge)
curl -sI "$EDGE/api/auth/me"  | grep -i "x-edge-cache"         # (no header — bypassed)
```

**R2 media** — upload a poster, then fetch it (note `X-Edge: r2` and the 24h
`Cache-Control`):

```bash
./scripts/upload-media.sh posters/death-note.svg
curl -sI "$EDGE/media/posters/death-note.svg" | grep -i "x-edge\|cache-control"
```

**WAF** — the SQLi rule starts in *log* mode (watch Security → Events), but
the block rules answer immediately:

```bash
curl -s -o /dev/null -w "%{http_code}\n" "$EDGE/api/news?q=%27%20OR%201%3D1--"
# 403 once you flip the SQLi rule from "log" to "block" in waf.tf
curl -s -o /dev/null -w "%{http_code}\n" -A "sqlmap/1.7" "$EDGE/api/all"
# 403 — bad-bot user agent is blocked right away
```

**Rate limiting** — hammer the auth endpoint and watch the 429s (10/min →
blocked for 600s; the general /api/* limit is 600/min):

```bash
for i in $(seq 1 15); do
  curl -s -o /dev/null -w "$i %{http_code}\n" -X POST "$EDGE/api/auth/login" \
       -H 'content-type: application/json' -d '{"email":"x@x.io","password":"y"}'
done
```

**Maintenance mode** — flip the KV flag and the edge serves 503s within ~60s
(health stays up so you can monitor the outage):

```bash
cd cdn/cloudflare
wrangler kv key get config --binding ANIMAXIA_CONFIG > /tmp/cfg.json
python3 -c "import json;c=json.load(open('/tmp/cfg.json'));c['maintenance']=True;\
json.dump(c,open('/tmp/cfg.json'))"
wrangler kv key put config --binding ANIMAXIA_CONFIG --path /tmp/cfg.json
curl -s "$EDGE/api/anime"          # 503 {"error":"...maintenance mode"...}
curl -s "$EDGE/api/health"         # still 200
```

## Behavior notes

- **Failover** — if the primary origin throws a network error or answers
  502/503/504, the worker retries **once** against `fallbackOrigin` from the KV
  config (path + query preserved) and tags success with
  `X-Edge-Fallback: true`. If both origins fail you get a JSON 502 carrying the
  `cf-ray` and any `x-trace-id` for debugging. Set it in KV:

  ```bash
  wrangler kv key put config --binding ANIMAXIA_CONFIG \
    --path <(jq '.fallbackOrigin="https://backup.example.com"' kv/config.example.json)
  ```

- **Caching model** — the worker fetches the origin with `cache: 'no-store'`
  and manages the edge cache itself (single source of truth, no double-caching
  with Cloudflare's default CDN). Responses are stored only when they're `200`
  and not `private`/`no-store`; requests carrying an `Authorization` header are
  never edge-cached (the Cache API key ignores that header, so sharing entries
  across users would leak data). The terraform cache rules mirror the same
  path list for traffic that reaches the zone without the worker.
- **Rate limiting model** — three layers: Cloudflare Rate Limiting rules
  (global, per-IP — authoritative), the gateway's limiter
  (`services/gateway-service`), and the worker's per-isolate in-memory Map
  (last-resort backstop only; each edge machine counts separately).
- **Maintenance mode** — KV `config.maintenance: true` → 503 JSON
  `{"error","maintenance":true,"retryAfterSec":60}` + `Retry-After: 60` for
  everything except `/api/health`. Propagation ≤ 60s (KV read cache).

## Cost notes (Cloudflare, ballpark 2025)

- **Worker**: free tier = 100k requests/day; paid (Workers Paid $5/mo) =
  10M included then ~$0.30/M + CPU-time pricing. Animaxia's public catalog
  traffic fits comfortably in the paid tier's first million.
- **KV**: free = 100k reads/day, 1k writes/day; paid = $0.50/M reads,
  $5/M writes — our config key is read ~1/minute per isolate, so effectively
  free.
- **R2**: $0.015/GB-month storage (Glacier-class ~$0.0025 after the 90-day
  lifecycle transition), Class-A ops $4.50/M (uploads), Class-B (reads)
  $0.36/M, **egress free** (the reason media lives in R2 and not on the origin).
- **Rate Limiting** and **Cache Rules**: available on all paid plans (Pro $20/mo
  covers both; the strict auth rule needs a paid plan — on the free plan only
  one simplified rate-limit rule is available).
- **WAF managed rulesets** (OWASP + Cloudflare Managed): Pro plan and up.
- The DNS/zone/CDN basics (HTTP/3, Brotli, cache, unlimited DDoS) are free on
  every plan.

## Sandbox validation (what was checked without Cloudflare access)

- `bun build --no-bundle cdn/cloudflare/src/worker.js` → syntax OK (Workers
  runtime APIs — `caches.default`, KV/R2 bindings — aren't executed locally).
- `bash -n` on both scripts; `kv/config.example.json` and `wrangler.toml`
  parse as valid JSON/TOML.
- No `terraform` binary in the sandbox: HCL was hand-checked (balanced braces,
  quoted expressions) **and** the schema was verified against the published
  cloudflare provider 4.x docs (v4.49.1): `execute` action for managed
  rulesets, `sensitivity_level` override, `ratelimit` block with
  `ip.src` characteristic, `edge_ttl`/`browser_ttl` action parameters, R2
  bucket attribute surface. Run `terraform init && terraform validate` once
  in an environment with network access for the final gate.
