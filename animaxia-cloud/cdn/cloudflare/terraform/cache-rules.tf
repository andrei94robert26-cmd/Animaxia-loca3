# animaxia-edge — Cache Rules (zone-level CDN caching)
#
# Phase http_request_cache_settings, expression-based:
#   1) eligible public catalog paths → cache at the edge (edge TTL 60s,
#      browser TTL respects the origin's Cache-Control)
#   2) auth/premium/social/users → never cached (private/user-specific)
#
# How this interacts with the edge worker (src/worker.js):
#   - When the worker runs on a route (wrangler.toml routes), it fetches the
#     origin with `cache: 'no-store'` and manages the edge cache itself via
#     the Cache API (X-Edge-Cache: HIT/MISS). The subrequest therefore skips
#     these Cache Rules on purpose — no double caching.
#   - These Cache Rules cover traffic that reaches the zone WITHOUT going
#     through the worker (e.g. the workers.dev URL is bypassed, or you deploy
#     the DNS records before enabling the worker route). Belt and braces:
#     whichever layer is in front, the same path list is cached.
#   - Keep this expression list in sync with `cacheablePaths` in
#     kv/config.example.json and terraform/kv.tf.

resource "cloudflare_ruleset" "cache_rules" {
  zone_id     = data.cloudflare_zone.animaxia.id
  name        = "animaxia-cache-rules"
  description = "Animaxia cache rules — cache public catalog endpoints, bypass private ones"
  kind        = "zone"
  phase       = "http_request_cache_settings"

  # 1) Public, cacheable catalog endpoints (GET only).
  rules {
    ref         = "cache_public_catalog_api"
    description = "Cache public catalog GETs at the edge for ${var.cache_ttl_seconds}s"
    expression  = "(http.request.method eq \"GET\" and (starts_with(http.request.uri.path, \"/api/all\") or starts_with(http.request.uri.path, \"/api/content\") or starts_with(http.request.uri.path, \"/api/anime\") or starts_with(http.request.uri.path, \"/api/movies\") or starts_with(http.request.uri.path, \"/api/tv\") or starts_with(http.request.uri.path, \"/api/sports\") or starts_with(http.request.uri.path, \"/api/news\") or starts_with(http.request.uri.path, \"/api/search\")))"
    action      = "set_cache_settings"
    action_parameters {
      cache = true
      edge_ttl {
        mode    = "override_origin"        # edge keeps a minimum ${var.cache_ttl_seconds}s copy ...
        default = var.cache_ttl_seconds    # ... even when the origin sends no Cache-Control
      }
      browser_ttl {
        mode = "respect_origin"            # browsers obey the origin's Cache-Control
      }
    }
    enabled = true
  }

  # 2) Private / user-specific endpoints — bypass the edge cache entirely.
  rules {
    ref         = "bypass_private_api"
    description = "Bypass cache for auth/premium/social/users endpoints"
    expression  = "(starts_with(http.request.uri.path, \"/api/auth\") or starts_with(http.request.uri.path, \"/api/premium\") or starts_with(http.request.uri.path, \"/api/social\") or starts_with(http.request.uri.path, \"/api/users\"))"
    action      = "set_cache_settings"
    action_parameters {
      cache = false
    }
    enabled = true
  }
}
