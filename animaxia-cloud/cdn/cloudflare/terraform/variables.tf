# animaxia-edge — input variables
#
# Every account/zone-specific value lives here. Copy terraform.tfvars.example
# (or use -var / TF_VAR_* env vars) and fill in your own values.
# Secrets are marked sensitive — they never end up in state logs or output.

# --- Account / auth ---------------------------------------------------------

variable "cloudflare_api_token" {
  description = "Cloudflare API token used by the provider. Required permissions: Zone > Zone > Read, Zone > DNS > Edit, Zone > Zone Settings > Edit, Zone > WAF > Edit, Zone > Cache Rules > Edit, Zone > Page Rules > Edit (for rate limiting), Account > Workers KV Storage > Edit, Account > Workers Scripts > Edit, Account > Cloudflare R2 > Edit. SENSITIVE — pass via TF_VAR_cloudflare_api_token or a git-ignored tfvars file."
  type        = string
  sensitive   = true
}

variable "cloudflare_account_id" {
  description = "Cloudflare account ID (Workers KV + R2 are account-scoped). Find it in the dashboard (right sidebar on the zone overview) or via `wrangler whoami`."
  type        = string
}

# --- Zone / DNS -------------------------------------------------------------

variable "zone_name" {
  description = "The zone (domain) managed here. Must already exist on the Cloudflare account."
  type        = string
  default     = "animaxia.com"
}

variable "origin_ip" {
  description = "Public IPv4 of the origin that fronts the API gateway (load balancer / ingress / tunnel endpoint). The proxied `api` DNS record points here."
  type        = string
  default     = "203.0.113.10" # documentation range — REPLACE for real deploys
}

variable "origin_ipv6" {
  description = "Public IPv6 of the origin. Leave empty (\"\") to skip the AAAA record."
  type        = string
  default     = ""
}

# --- Workers ----------------------------------------------------------------

variable "worker_name" {
  description = "Name of the edge worker deployed from ../ (wrangler.toml `name`)."
  type        = string
  default     = "animaxia-edge"
}

variable "workers_dev_subdomain" {
  description = "Your workers.dev subdomain (from `wrangler whoami`), used to build the worker URL output. Example: subdomain 'animaxia' → https://animaxia-edge.animaxia.workers.dev"
  type        = string
  default     = "REPLACE_WITH_YOUR_SUBDOMAIN"
}

# --- KV ----------------------------------------------------------------------

variable "kv_namespace_name" {
  description = "Workers KV namespace holding the edge runtime config ('config' key read by src/worker.js)."
  type        = string
  default     = "animaxia-config"
}

# --- R2 ----------------------------------------------------------------------

variable "r2_bucket_name" {
  description = "Private R2 bucket bound to the worker (binding ANIMAXIA_MEDIA) serving /media/*."
  type        = string
  default     = "animaxia-media"
}

variable "r2_public_bucket_name" {
  description = "R2 bucket with public access enabled for direct (worker-less) media delivery."
  type        = string
  default     = "animaxia-media-public"
}

variable "r2_public_domain" {
  description = "Custom domain for the public bucket (documented in r2.tf — provider 4.x has no resource for R2 domains; it's wired with a CNAME record)."
  type        = string
  default     = "media"
}

variable "r2_dev_public_hostname" {
  description = "The pub-<id>.r2.dev hostname of the public bucket (shown in dashboard → R2 → bucket → Settings → Public Access). Used by the commented CNAME in r2.tf."
  type        = string
  default     = "pub-REPLACE-WITH-R2-PUBLIC-HOSTNAME.r2.dev"
}

# --- Edge cache --------------------------------------------------------------

variable "cache_ttl_seconds" {
  description = "Edge TTL (seconds) for cacheable public API paths (cache-rules.tf). The worker's Cache API entries inherit the origin Cache-Control when present."
  type        = number
  default     = 60
}

# --- Rate limiting -----------------------------------------------------------

variable "auth_rate_limit_requests" {
  description = "Requests per period allowed per IP on /api/auth before the block kicks in."
  type        = number
  default     = 10
}

variable "auth_rate_limit_period" {
  description = "Counting window (seconds) for the /api/auth rate limit."
  type        = number
  default     = 60
}

variable "auth_rate_limit_timeout" {
  description = "Mitigation timeout (seconds) for the /api/auth rate limit — how long the block lasts after tripping."
  type        = number
  default     = 600
}

variable "api_rate_limit_requests" {
  description = "Requests per period allowed per IP across /api/* (general limit)."
  type        = number
  default     = 600
}

variable "api_rate_limit_period" {
  description = "Counting window (seconds) for the general /api/* rate limit."
  type        = number
  default     = 60
}

variable "api_rate_limit_timeout" {
  description = "Mitigation timeout (seconds) for the general /api/* rate limit."
  type        = number
  default     = 60
}

# --- WAF ---------------------------------------------------------------------

variable "admin_geo_allow_countries" {
  description = "EXAMPLE geo allow-list used by the (disabled) /api/admin geo-fence rule in waf.tf. ISO 3166-1 alpha-2 codes."
  type        = list(string)
  default     = ["US", "GB", "DE", "FR", "NL", "IN"]
}

# --- Bot management (FAZA 22) ------------------------------------------------

variable "bot_management_enabled" {
  description = "Provision cloudflare_bot_management for the zone (AI-bot blocking + Super Bot Fight Mode JavaScript detections, bot-protection.tf). Requires a Cloudflare plan entitled to Bot Management; set to false to skip the resource cleanly."
  type        = bool
  default     = true
}
