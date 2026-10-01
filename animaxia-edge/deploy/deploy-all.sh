#!/usr/bin/env bash
#
# deploy/deploy-all.sh — deploy the full Animaxia edge layer (FAZA 8).
#
# Usage:
#   ./deploy/deploy-all.sh                    # from animaxia-edge/
#   ./deploy/deploy-all.sh --allow-placeholder # skip the KV-id preflight
#   SMOKE=1 ./deploy/deploy-all.sh             # run the hermetic smoke suite first
#
# Deploy order matters: sub-workers first, the gateway LAST (its service
# bindings reference the sub-workers by name).
#
# ── One-time setup (per Cloudflare account) ─────────────────────────────────
#   wrangler kv namespace create EDGE_CONFIG        # paste the id into worker/wrangler.toml
#   wrangler kv namespace create EDGE_CACHE         # used by worker/, auth/, player/, cron/
#   wrangler kv namespace create EDGE_RATELIMIT     # worker/, cron/
#   wrangler kv namespace create EDGE_REPLAY        # auth/, cron/
#   wrangler kv namespace create SEARCH_CACHE       # search/
#   wrangler kv namespace create EMBEDDINGS_CACHE   # ai/
#   wrangler kv namespace create ANALYTICS_TREND    # analytics/
#   wrangler r2 bucket create animaxia-media
#   wrangler r2 object put animaxia-media/offline-test.mp4 \
#     --file ../animaxia-desktop/public/offline-test.mp4
#   wrangler queues create animaxia-edge-analytics
#
#   Secrets (per worker — see each wrangler.toml for the exact list):
#     auth/    : JWT_SECRET  (or AUTHSECRET + DATABASEURL)
#     worker/  : JWT_SECRET | AUTHSECRET + DATABASEURL (rate-limit identity),
#                EDGE_ADMIN_JWT, EDGE_INTERNAL_TOKEN
#     cron/    : EDGE_ADMIN_JWT, EDGE_INTERNAL_TOKEN
#   wrangler secret put <NAME> --config <module>/wrangler.toml
#
# ── Production vars ─────────────────────────────────────────────────────────
#   Each wrangler.toml defaults CLOUD_ORIGIN to http://127.0.0.1:4000 for local
#   dev — override per worker for production (dashboard or `wrangler deploy
#   --config <module>/wrangler.toml --var CLOUD_ORIGIN:https://api.animaxia.com`).

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
ALLOW_PLACEHOLDER="${1:-}"

echo "━ Animaxia Edge deploy-all — root: $ROOT"

# ── Preflight ────────────────────────────────────────────────────────────────
if [[ -n "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  echo "· CLOUDFLARE_API_TOKEN set — assuming CI, skipping whoami"
else
  if ! bunx wrangler whoami >/dev/null 2>&1; then
    echo "✗ Not authenticated with Cloudflare. Run: wrangler login" >&2
    exit 1
  fi
fi

if [[ "$ALLOW_PLACEHOLDER" != "--allow-placeholder" ]]; then
  PLACEHOLDERS="$(grep -l 'REPLACE_WITH_KV_ID' */wrangler.toml 2>/dev/null || true)"
  if [[ -n "$PLACEHOLDERS" ]]; then
    echo "✗ KV namespace ids are still placeholders in:" >&2
    echo "$PLACEHOLDERS" >&2
    echo "  Create the namespaces (see the header of this script) and paste the ids," >&2
    echo "  or re-run with --allow-placeholder to deploy anyway." >&2
    exit 1
  fi
fi

if [[ "${SMOKE:-0}" == "1" ]]; then
  echo "━ Pre-deploy hermetic smoke suite (local harness, no credentials)"
  bun tests/smoke-edge.mjs
fi

# ── Deploy: sub-workers first, gateway last ─────────────────────────────────
for module in auth search ai player analytics cron worker; do
  echo "━ Deploying animaxia-edge-$module"
  bunx wrangler deploy --config "$module/wrangler.toml"
done

echo "━ Edge layer deployed."
echo "  Gateway URL: https://animaxia-edge-gateway.<your-subdomain>.workers.dev"
echo "  Sanity:      curl <gateway-url>/edge/health"
