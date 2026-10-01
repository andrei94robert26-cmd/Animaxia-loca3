#!/usr/bin/env bash
# deploy-worker.sh — full deploy flow for the animaxia-edge worker.
#
#   1. checks wrangler is installed and authenticated
#   2. creates the ANIMAXIA_CONFIG KV namespace if it's missing
#      (and makes sure wrangler.toml no longer carries the placeholder id)
#   3. seeds the "config" key from kv/config.example.json
#   4. deploys the worker (src/worker.js)
#   5. smoke-tests GET /api/health on the workers.dev URL
#
# Usage:
#   ./scripts/deploy-worker.sh
#
# Env overrides:
#   ANIMAXIA_SKIP_SMOKE=1   skip the final curl smoke test
#   WORKERS_URL=https://... force the smoke-test base URL
set -euo pipefail

cd "$(dirname "$0")/.."   # → cdn/cloudflare/ (where wrangler.toml lives)

say()  { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✔ %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m✘ %s\033[0m\n' "$*" >&2; exit 1; }

# --- 1. wrangler present + authenticated ------------------------------------
say "Checking wrangler"
command -v wrangler >/dev/null 2>&1 \
  || die "wrangler not found — install with: npm i -g wrangler  (or bunx wrangler)"
wrangler whoami >/dev/null 2>&1 \
  || die "not logged in — run: wrangler login   (or set CLOUDFLARE_API_TOKEN)"
ok "wrangler authenticated as $(wrangler whoami 2>/dev/null | sed -n 's/.*@/  /p' | head -1)"

# --- 2. KV namespace ---------------------------------------------------------
say "Ensuring KV namespace ANIMAXIA_CONFIG exists"
if wrangler kv namespace list 2>/dev/null | grep -q '"title": *"animaxia-edge-ANIMAXIA_CONFIG"'; then
  ok "KV namespace already exists"
else
  wrangler kv namespace create ANIMAXIA_CONFIG
  ok "KV namespace created — the command above printed its id"
fi

grep -q 'REPLACE_WITH_KV_ID' wrangler.toml \
  && die "wrangler.toml still has the KV id placeholder. Paste the namespace id
         (from the create output above, or \`wrangler kv namespace list\`) into
         wrangler.toml → [[kv_namespaces]] → id, then re-run this script."
ok "wrangler.toml has a concrete KV id"

# --- 3. seed the edge config --------------------------------------------------
say "Seeding KV key 'config' from kv/config.example.json"
wrangler kv key put config --binding ANIMAXIA_CONFIG --path kv/config.example.json
ok "edge config stored (worker picks it up within ~60s)"

# --- 4. deploy ----------------------------------------------------------------
say "Deploying animaxia-edge"
wrangler deploy 2>&1 | tee /tmp/animaxia-edge-deploy.log

# --- 5. smoke test ------------------------------------------------------------
if [ "${ANIMAXIA_SKIP_SMOKE:-0}" != "1" ]; then
  say "Smoke test: GET /api/health"
  BASE_URL="${WORKERS_URL:-}"
  if [ -z "$BASE_URL" ]; then
    # wrangler prints the deployed workers.dev URL — grab it from the log
    BASE_URL="$(grep -Eo 'https://animaxia-edge[0-9a-zA-Z.-]*\.workers\.dev' \
      /tmp/animaxia-edge-deploy.log | head -1 || true)"
  fi
  if [ -n "$BASE_URL" ]; then
    echo "  curl -s $BASE_URL/api/health"
    curl -fsS --max-time 15 "$BASE_URL/api/health" | head -c 400; echo
    ok "health endpoint answered (200) — edge is live at $BASE_URL"
  else
    echo "  Could not detect the workers.dev URL — smoke test manually:"
    echo "    curl -s https://animaxia-edge.<your-subdomain>.workers.dev/api/health | head -c 400"
  fi
fi

printf '\nDone. Next steps:\n'
echo '  • ORIGIN_URL in wrangler.toml still defaults to https://gateway.animaxia.internal —'
echo '    point it at your real gateway (e.g. https://api.animaxia.com) and redeploy.'
echo '  • Uncomment the routes in wrangler.toml once the zone is on your account.'
echo '  • Rate limiting / WAF / cache rules / KV / R2 live in terraform/ (see README.md).'
