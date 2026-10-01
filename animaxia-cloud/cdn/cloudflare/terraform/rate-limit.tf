# animaxia-edge — Cloudflare Rate Limiting rules
#
# Phase http_ratelimit, zone-scoped, keying on the client IP (characteristic
# "ip.src"; the colo id is always part of the key implicitly).
# These run BEFORE the edge worker and are the authoritative per-IP limits —
# the worker's in-memory Map (src/worker.js) is only a per-isolate backstop,
# and the gateway (services/gateway-service) adds a third layer per service.
#
# Rule order matters: the stricter /api/auth rule is evaluated first.

resource "cloudflare_ruleset" "rate_limiting" {
  zone_id     = data.cloudflare_zone.animaxia.id
  name        = "animaxia-rate-limiting"
  description = "Animaxia rate limiting — strict on auth, generous on the general API"
  kind        = "zone"
  phase       = "http_ratelimit"

  # Stricter bucket for authentication traffic (login/register/refresh are
  # cheap to call and expensive to brute-force).
  rules {
    ref         = "auth_endpoint_strict_limit"
    description = "/api/auth: ${var.auth_rate_limit_requests} req / ${var.auth_rate_limit_period}s per IP, block for ${var.auth_rate_limit_timeout}s"
    expression  = "(http.request.uri.path contains \"/api/auth\")"
    action      = "block"
    ratelimit {
      characteristics      = ["ip.src"]
      period               = var.auth_rate_limit_period     # 60s counting window
      requests_per_period  = var.auth_rate_limit_requests   # 10 requests
      mitigation_timeout   = var.auth_rate_limit_timeout    # 600s block
    }
    enabled = true
  }

  # General bucket for the rest of the API surface.
  rules {
    ref         = "api_general_limit"
    description = "/api/*: ${var.api_rate_limit_requests} req / ${var.api_rate_limit_period}s per IP, block for ${var.api_rate_limit_timeout}s"
    expression  = "(http.request.uri.path contains \"/api/\")"
    action      = "block"
    ratelimit {
      characteristics      = ["ip.src"]
      period               = var.api_rate_limit_period     # 60s counting window
      requests_per_period  = var.api_rate_limit_requests   # 600 requests
      mitigation_timeout   = var.api_rate_limit_timeout    # 60s block
    }
    enabled = true
  }
}
