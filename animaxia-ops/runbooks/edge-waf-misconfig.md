# Runbook — Edge WAF misconfiguration (false-positive blocks)

**Service:** the edge WAF in `animaxia-edge/` (Cloudflare Workers) — rules live in
`shared/config.ts` `DEFAULT_CONFIG.waf` (runtime-overridable via the `EDGE_CONFIG` KV namespace,
key `"config"`). The gateway worker (`worker/`) enforces them before routing.
**Failure mode:** a config change (code default or KV override) over-tightened a rule — most
commonly `blockBots` or the SQL fingerprints — and legitimate clients get blocked.

## Symptoms

- Legit clients receive **403** with body code `waf_blocked` and an `x-edge-waf` response header
  naming the matched rule: `bot` | `sqli` | `xss` | `traversal` | `query-size` | `null-byte`.
- Edge smoke suite fails — typically the 2 benign regression guards: queries containing
  **"O'Reilly"** and **"one or two"** are getting blocked by the `sql` rule (false positives).
- Alert: WAF block event rate spikes (every block is logged to KV and visible via the admin
  events endpoint).

## Diagnosis

```bash
# 1. Read recent WAF blocks (admin) — confirm the rule that is firing and on what traffic
curl -s "https://<edge-gateway-host>/edge/waf/events" \
  -H "x-internal-token: <EDGE_INTERNAL_TOKEN>"
# (equivalent: -H "authorization: Bearer <EDGE_ADMIN_JWT>")
# → recent block events with rule / path / user-agent — legit-looking UAs + ordinary search
#   queries means misconfig, not an attack wave.

# 2. Find where the bad setting lives — KV override first (wins over code), then code default:
#    a runtime override in the EDGE_CONFIG KV namespace (key "config", e.g.
#    {"waf":{"blockBots":false}} — or worse, an over-broad tightening) explains a behavior
#    change with NO deploy.
rg -n "waf" animaxia-edge/shared/config.ts
# DEFAULT_CONFIG.waf = { enabled, blockBots, sql, xss, traversal, maxQueryBytes, logTtlSec }
# shipped defaults: enabled:true, blockBots:true, sql:true, xss:true, traversal:true,
#                   maxQueryBytes:8192, logTtlSec:86400
```

Decision rule: a KV `"config"` override present → fix/clear the override (fastest). No override
→ the shipped `DEFAULT_CONFIG` itself is wrong → fix the code.

## Fix

Two options — pick the narrowest change that unblocks legit traffic.

### Option A — fix `DEFAULT_CONFIG` in code (permanent, reviewed)

Edit `animaxia-edge/shared/config.ts` — e.g. relax the over-firing rule:

```ts
// shared/config.ts — DEFAULT_CONFIG.waf
// example: stop blocking benign bot-ish user agents (keep everything else armed)
waf: { enabled: true, blockBots: false, sql: true, xss: true, traversal: true, /* … */ }
```

Then run the full verification + deploy below. This is the correct long-term fix when the
shipped default is wrong.

### Option B — KV runtime override (fast mitigation, no deploy)

Set the `"config"` key in the `EDGE_CONFIG` KV namespace to a JSON document overriding only the
WAF block in question, e.g.:

```json
{"waf":{"blockBots":false}}
```

Runtime overrides apply without a redeploy (by design) — use this to stop the bleeding, then
land the code fix via Option A.

**NEVER disable the whole WAF in production** (`{"waf":{"enabled":false}}`). The WAF is the
SQLi/XSS/traversal/bot front line — relax the specific over-firing rule instead.

## Verification

Any WAF config change must keep the full hermetic suite green **before** deploy:

```bash
cd animaxia-edge
bun run test
# typecheck + smoke (159 checks) + e2e (35 checks).
# The WAF suite enforces BOTH directions:
#   benign-pass guards: "O'Reilly" and "one or two" must NOT be blocked
#   attack-block guards: sqlmap/nikto/hydra user-agents, SQLi/XSS/traversal payloads MUST be blocked

bun run lint
./deploy/deploy-all.sh
# ordered deploy: sub-workers first (auth → search → ai → player → analytics → cron),
# gateway LAST (it binds the others)
```

## Rollback

- **Code change:** revert `shared/config.ts` and redeploy (`./deploy/deploy-all.sh`).
- **KV override:** clear it through the admin invalidation endpoint so `DEFAULT_CONFIG` applies
  again:

```bash
curl -s -X POST "https://<edge-gateway-host>/edge/cache/invalidate" \
  -H "x-internal-token: <EDGE_INTERNAL_TOKEN>" \
  -H "content-type: application/json" \
  -d '{"key":"config"}'
```

- Then redeploy if a code revert was involved, and re-run `bun run test` — the benign-pass
  guards ("O'Reilly" / "one or two") plus the attack-block guards must both be green.

## Escalation

If clients are blocked but the response has **no** `waf_blocked` body, **no** `x-edge-waf`
header, and `/edge/waf/events` shows nothing → the block is happening at the **Cloudflare
level** (dashboard WAF / firewall rules / bot management), not in the worker. Escalate to the
Cloudflare dashboard (Security → Events) — this runbook only covers worker-level WAF config.
