# animaxia-edge — zone, settings and DNS
#
# Zone lookup by name (the zone must already exist on the account; adding zones
# via Terraform is intentionally out of scope — do that once in the dashboard
# or with `cloudflare_zone` when you have Registrar access).

data "cloudflare_zone" "animaxia" {
  name = var.zone_name
}

# Modern TLS + HTTP/3 + Brotli for the whole zone.
# NOTE: Cloudflare's API value for "Full (strict)" is "strict".
resource "cloudflare_zone_settings_override" "animaxia" {
  zone_id = data.cloudflare_zone.animaxia.id

  settings {
    # --- required by the Animaxia edge contract ---
    http3           = "on"    # HTTP/3 (QUIC) — faster handshakes on mobile
    brotli          = "on"    # Brotli compression at the edge
    min_tls_version = "1.2"   # drop TLS 1.0/1.1 clients
    ssl             = "strict" # Full (strict) — origin must present a valid cert

    # --- sensible hardening defaults (tune to taste) ---
    always_use_https           = "on"
    automatic_https_rewrites   = "on"
    http2                      = "on"
    tls_1_3                    = "on"
    early_hints                = "on"
    websockets                 = "on"  # gateway may proxy websocket traffic
    ipv6                       = "on"
    opportunistic_encryption   = "on"

    # FAZA 22 — HSTS strict global: force HTTPS for one year, all subdomains,
    # preload-list eligible. The origin Caddyfile mirrors the same header for
    # direct (non-Cloudflare) hits.
    security_header {
      strict_transport_security = "max-age=31536000; includeSubDomains; preload"
    }
  }
}

# --- DNS ---------------------------------------------------------------------
# api.<zone> → origin (proxied through Cloudflare: WAF, rate limiting, cache
# rules and the edge worker all sit on this path).

resource "cloudflare_record" "api_v4" {
  zone_id = data.cloudflare_zone.animaxia.id
  name    = "api" # api.<zone>
  type    = "A"
  content = var.origin_ip
  ttl     = 1    # 1 = "auto" while proxied
  proxied = true
}

# Optional AAAA — set var.origin_ipv6 to create it.
resource "cloudflare_record" "api_v6" {
  count = var.origin_ipv6 != "" ? 1 : 0

  zone_id = data.cloudflare_zone.animaxia.id
  name    = "api" # api.<zone>
  type    = "AAAA"
  content = var.origin_ipv6
  ttl     = 1
  proxied = true
}

# EXAMPLE records for the Next.js frontend (www + apex).
# www.<zone> flattens onto the apex record below; if the frontend lives on
# Vercel/Netlify/another host, change `content` to the host they give you.

resource "cloudflare_record" "www" {
  zone_id = data.cloudflare_zone.animaxia.id
  name    = "www" # www.<zone>
  type    = "CNAME"
  content = var.zone_name
  ttl     = 1
  proxied = true
}

# Apex: CNAME flattening (Cloudflare flattens CNAMEs at the zone apex).
# Alternative: swap to an A record with content = var.origin_ip if the
# frontend is served from the same origin as the gateway.
resource "cloudflare_record" "root" {
  zone_id = data.cloudflare_zone.animaxia.id
  name    = var.zone_name
  type    = "CNAME"
  content = "www.${var.zone_name}"
  ttl     = 1
  proxied = true
}
