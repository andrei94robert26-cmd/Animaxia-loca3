# animaxia-edge — WAF
#
# Two layers:
#   1) cloudflare_ruleset "managed_waf"  — phase http_request_firewall_managed:
#      deploys Cloudflare's Managed Ruleset + OWASP Core Ruleset onto the zone.
#   2) cloudflare_ruleset "custom_waf"   — phase http_request_firewall_custom:
#      Animaxia-specific rules (threat score, SQLi probe logging, XSS, bad
#      bots, geo example).
#
# Well-known managed ruleset IDs (stable, documented by Cloudflare):
#   efb7b8c949ac4650a09736fc376e9aee — Cloudflare Managed Ruleset
#   4814384a9e5d4991b9815dcfc25d2f1f — OWASP Core Ruleset
#   c2e184081120413c86c3e7ce74f8beb4 — Exposed Credential Checks (commented)

resource "cloudflare_ruleset" "managed_waf" {
  zone_id     = data.cloudflare_zone.animaxia.id
  name        = "animaxia-managed-waf"
  description = "Animaxia managed WAF — Cloudflare Managed + OWASP Core rulesets"
  kind        = "zone"
  phase       = "http_request_firewall_managed"

  rules {
    ref         = "execute_cloudflare_managed_ruleset"
    description = "Deploy Cloudflare Managed Ruleset on the zone"
    expression  = "true"
    action      = "execute"
    action_parameters {
      id = "efb7b8c949ac4650a09736fc376e9aee" # Cloudflare Managed Ruleset

      # Optional tag-based overrides — example (disabled): force the
      # WordPress/Joomla categories to block instead of their defaults:
      # overrides {
      #   categories {
      #     category = "wordpress"
      #     action   = "block"
      #     enabled  = true
      #   }
      #   categories {
      #     category = "joomla"
      #     action   = "block"
      #     enabled  = true
      #   }
      # }
    }
    enabled = true
  }

  rules {
    ref         = "execute_owasp_core_ruleset"
    description = "Deploy OWASP Core Ruleset at medium sensitivity"
    expression  = "true"
    action      = "execute"
    action_parameters {
      id = "4814384a9e5d4991b9815dcfc25d2f1f" # OWASP Core Ruleset
      overrides {
        # Sensitivity for the OWASP ruleset (valid: default | low | medium | eoff).
        sensitivity_level = "medium"

        # Single-rule opt-out example (disabled) — use when a legitimate client
        # trips a specific OWASP rule (find the id in Security → Events):
        # rules {
        #   id      = "612b4464a0e849a1b0aa6e8a62586581" # example rule id
        #   enabled = false
        # }
      }
    }
    enabled = true
  }

  # Exposed Credential Checks — worth enabling after the basics are tuned
  # (blocks login attempts that carry known-breached credential pairs):
  # rules {
  #   ref         = "execute_exposed_credentials"
  #   description = "Deploy Cloudflare Exposed Credential Checks"
  #   expression  = "true"
  #   action      = "execute"
  #   action_parameters {
  #     id = "c2e184081120413c86c3e7ce74f8beb4"
  #   }
  #   enabled = true
  # }
}

resource "cloudflare_ruleset" "custom_waf" {
  zone_id     = data.cloudflare_zone.animaxia.id
  name        = "animaxia-custom-waf"
  description = "Animaxia custom firewall rules — threat score, SQLi/XSS probes, bad bots, geo example"
  kind        = "zone"
  phase       = "http_request_firewall_custom"

  # 1) Block clients Cloudflare already considers hostile.
  rules {
    ref         = "block_high_threat_score"
    description = "Block requests with Cloudflare threat score above 30"
    expression  = "(cf.threat_score gt 30)"
    action      = "block"
    enabled     = true
  }

  # 2) SQLi probes on /api/* — starts in LOG mode. Watch Security → Events for
  #    a few days; once you're sure no legitimate traffic matches, flip the
  #    action to "block". The patterns below are deliberately conservative.
  rules {
    ref         = "log_sqli_probes_on_api"
    description = "LOG-ONLY (tune first): classic SQLi payloads in /api/* query strings"
    expression  = "(http.request.uri.path contains \"/api/\" and (http.request.uri.qs contains \"' OR '1'='1\" or http.request.uri.qs contains \"union select\" or http.request.uri.qs contains \"waitfor delay\" or http.request.uri.qs contains \"1=1\"))"
    action      = "log"
    enabled     = true
  }

  # 3) Obvious XSS payloads in API query strings.
  rules {
    ref         = "block_xss_probes_on_api"
    description = "Block obvious XSS payloads in /api/* query strings"
    expression  = "(http.request.uri.path contains \"/api/\" and (http.request.uri.qs contains \"<script\" or http.request.uri.qs contains \"javascript:\" or http.request.uri.qs contains \"onerror=\"))"
    action      = "block"
    enabled     = true
  }

  # 4) Known attack tooling + empty user agents.
  #    (curl/wrangler are intentionally NOT listed — deploy scripts use them.)
  rules {
    ref         = "block_bad_bots"
    description = "Block empty and known attack-tool user agents"
    expression  = "(http.user_agent eq \"\" or lower(http.user_agent) in {\"sqlmap\" \"nikto\" \"masscan\" \"zgrab\" \"dirbuster\" \"gobuster\" \"wpscan\"})"
    action      = "block"
    enabled     = true
  }

  # 5) EXAMPLE (disabled) — geo-fence the admin surface. Set
  #    var.admin_geo_allow_countries and flip `enabled` to use it.
  rules {
    ref         = "geo_restriction_admin_example"
    description = "EXAMPLE (disabled): managed challenge outside allow-listed countries on /api/admin"
    expression  = "(http.request.uri.path contains \"/api/admin\" and not ip.geoip.country in {${join(" ", formatlist("\"%s\"", var.admin_geo_allow_countries))}})"
    action      = "managed_challenge"
    enabled     = false
  }
}
