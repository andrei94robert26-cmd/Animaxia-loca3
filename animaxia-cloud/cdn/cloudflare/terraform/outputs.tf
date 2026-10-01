# animaxia-edge — outputs
#
# After `terraform apply`:
#   - kv_namespace_id → paste into ../wrangler.toml (kv_namespaces.id)
#   - r2_*            → bucket names (must match ../wrangler.toml r2_buckets.bucket_name)
#   - worker_url      → smoke-test target for scripts/deploy-worker.sh

output "zone_id" {
  description = "Cloudflare zone id for the animaxia zone."
  value       = data.cloudflare_zone.animaxia.id
}

output "kv_namespace_id" {
  description = "Workers KV namespace id for animaxia-config — paste into ../wrangler.toml (REPLACE_WITH_KV_ID)."
  value       = cloudflare_workers_kv_namespace.config.id
}

output "kv_namespace_title" {
  description = "Workers KV namespace title (animaxia-config)."
  value       = cloudflare_workers_kv_namespace.config.title
}

output "r2_media_bucket" {
  description = "Private R2 bucket bound to the worker (serves /media/*)."
  value       = cloudflare_r2_bucket.media.name
}

output "r2_media_public_bucket" {
  description = "Public-access R2 bucket for direct media delivery."
  value       = cloudflare_r2_bucket.media_public.name
}

output "worker_url" {
  description = "workers.dev URL of the edge worker (requires var.workers_dev_subdomain to be set — find yours with `wrangler whoami`)."
  value       = "https://${var.worker_name}.${var.workers_dev_subdomain}.workers.dev"
}

output "api_hostname" {
  description = "Proxied API hostname that fronts the gateway origin."
  value       = "api.${var.zone_name}"
}
