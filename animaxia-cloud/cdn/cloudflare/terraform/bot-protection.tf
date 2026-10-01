# animaxia-edge — bot management (FAZA 22)
#
# Cloudflare Bot Management for the zone:
#   • ai_bots_protection      — blocks known AI crawler/scraper bots that
#     ignore robots.txt (content is licensed, not free training data).
#   • super_bot_fight_mode    — JavaScript detections for definitive bot
#     scoring (enable_javascript) without the paid Super Bot Fight Mode
#     optimize_supercache path (kept off — it can interfere with the edge
#     worker's own Cache API usage on /api/*).
#
# The free tier equivalent lives in waf.tf (custom_waf "block_bad_bots" for
# empty/attack-tool user agents); this resource adds the account-level AI-bot
# intelligence on top. Gated by var.bot_management_enabled because Bot
# Management entitlements vary per Cloudflare plan — set it to false when the
# zone is not entitled and the resource is skipped cleanly.

resource "cloudflare_bot_management" "animaxia" {
  count = var.bot_management_enabled ? 1 : 0

  zone_id = data.cloudflare_zone.animaxia.id

  # Block AI crawlers (GPTBot, CCBot, Google-Extended, …) platform-side.
  ai_bots_protection = "on"

  super_bot_fight_mode {
    # JavaScript detections feed the bot score used by firewall rules —
    # definitive identification of headless browsers and scrapers.
    enable_javascript = true

    # Off: lets the edge worker's Cache API (shared/cache.ts L1 tier) stay the
    # single caching authority on /api/* paths.
    optimize_supercache = false
  }
}
