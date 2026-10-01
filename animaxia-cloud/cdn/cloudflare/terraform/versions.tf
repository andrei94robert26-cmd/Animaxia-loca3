# animaxia-edge — Terraform bootstrap
#
# Managed resources: zone settings, DNS, WAF (managed + custom), rate limiting,
# cache rules, Workers KV namespace + seed keys, R2 buckets.
#
# Provider is pinned to 4.x (~> 4.0) per the project contract; everything in
# this directory is written against the verified 4.x schema (checked against
# v4.49.1, the last 4.x release). See r2.tf for the one feature R2 lifecycle)
# that needs provider >= 5.x — it ships as a documented, commented block.

terraform {
  required_version = ">= 1.5.0"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.0"
    }
  }
}

provider "cloudflare" {
  # Never hardcode tokens. Use TF_VAR_cloudflare_api_token / a .tfvars file
  # that is git-ignored, or your secret manager of choice.
  api_token = var.cloudflare_api_token
}
