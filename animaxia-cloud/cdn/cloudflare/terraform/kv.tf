# animaxia-edge — Workers KV
#
# Namespace "animaxia-config" holds the edge runtime config. The worker reads
# the "config" key (env.ANIMAXIA_CONFIG.get('config', 'json')) with a 60s
# in-memory cache — flip values with `wrangler kv key put` (or the dashboard)
# and the edge picks them up within ~a minute. No redeploy needed.
#
# The "config" value below is intentionally identical to ../kv/config.example.json
# (deployed by ../scripts/deploy-worker.sh). If you change one, change both.

resource "cloudflare_workers_kv_namespace" "config" {
  account_id = var.cloudflare_account_id
  title      = var.kv_namespace_name # animaxia-config
}

# Edge runtime config consumed by src/worker.js.
resource "cloudflare_workers_kv" "edge_config" {
  account_id   = var.cloudflare_account_id
  namespace_id = cloudflare_workers_kv_namespace.config.id
  key          = "config"
  value = jsonencode({
    maintenance        = false
    edgeRateLimitPerMin = 600
    cacheablePaths = [
      "/api/all",
      "/api/content",
      "/api/anime",
      "/api/movies",
      "/api/tv",
      "/api/sports",
      "/api/news",
      "/api/search",
    ]
    originHeaders  = {}
    fallbackOrigin = ""
  })
}

# Example feature-flag key — the worker doesn't read it (yet); it shows the
# pattern for shipping product flags to the edge without redeploying.
resource "cloudflare_workers_kv" "feature_flags" {
  account_id   = var.cloudflare_account_id
  namespace_id = cloudflare_workers_kv_namespace.config.id
  key          = "feature-flags"
  value = jsonencode({
    newHomeHero   = "off"
    aiAssistant   = "on"
    edgeCacheTweaks = "on"
  })
}

# NOTE: the worker's wrangler.toml binds the namespace by id
# (REPLACE_WITH_KV_ID placeholder). After `terraform apply`, run:
#   terraform output -raw kv_namespace_id
# and paste it into ../wrangler.toml, then `wrangler deploy`.
