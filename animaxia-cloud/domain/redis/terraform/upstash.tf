# animaxia-redis-global — Upstash Redis global IaC (FAZA 22)
#
# Two resources, two consumers:
#
#   1. upstash_redis_cloud "animaxia_global" — the GLOBAL replication group
#      (cloud_provider aws, region "global"): multi-region replicas with
#      lowest-latency reads in every region. Consumer: the FAZA 22
#      global-gateway PERIMETER layers that must be shared across regions —
#      distributed rate-limit counters, cooldown markers and anti-spam
#      fingerprints. NOTE: Upstash "global" databases are read-replica
#      deployments — writes still converge through the primary region, so
#      strongly-consistent counters keep living in the Durable Object tier
#      (shared/rate-limit.ts) while this Redis is the cross-region,
#      eventually-consistent perimeter.
#
#   2. upstash_redis_database "animaxia_gateway" — a single-region (eu-central-1)
#      database with eviction enabled: the cache tier for the global-gateway
#      /api/search + /api/hub response cache (PERIMETER ONLY — the FAZA 18
#      pipeline inside the protected backend stays untouched; this cache sits
#      in front of it, never inside it).
#
# PROTOCOL: standard RESP/RESP2 — identical to the local validation instance
# mini-services/redis-global:4030 (the RESP2 validation server used in the
# sandbox). Clients speaking RESP to :4030 speak RESP to these databases;
# only the endpoint URL + TLS flag change between environments.
#
# Apply:
#   terraform init && terraform plan -var="upstash_api_key=…" -var="team_id=…"
# Secrets are marked sensitive in variables.tf — never commit real values.

terraform {
  required_version = ">= 1.5.0"

  required_providers {
    upstash = {
      source  = "upstash/upstash"
      version = "~> 2.0"
    }
  }
}

provider "upstash" {
  # Management API key from https://console.upstash.com team settings.
  # Pass via TF_VAR_upstash_api_key or a git-ignored tfvars file.
  api_key = var.upstash_api_key
}

# --- global replication group (perimeter: rate-limit / cooldown / anti-spam) --

resource "upstash_redis_cloud" "animaxia_global" {
  name           = "animaxia-global"
  cloud_provider = "aws"
  region         = "global"

  # Multi-region read replicas: lowest-latency reads for the perimeter checks
  # in every region. Eviction stays off here — rate-limit counters and
  # anti-spam fingerprints must NEVER be silently evicted (dropping them
  # would reset attacker budgets). Bounded key space: counters carry their own
  # TTLs from the gateway layer.
  multi_region   = true
  eviction       = false

  # TLS only — the perimeter carries user fingerprints + IPs.
  tls            = true
}

# --- single-region cache (perimeter: /api/search + /api/hub response cache) ---

resource "upstash_redis_database" "animaxia_gateway" {
  name        = "animaxia-gateway"
  region      = "eu-central-1"
  team_id     = var.team_id

  # Cache tier: eviction ON so key growth is bounded by memory, not by TTL
  # discipline. Consumers expire entries with short TTLs (60-300s) anyway —
  # this is the safety valve, mirroring the KV edge-cache semantics.
  eviction    = true

  tls         = true
}

# Outputs are intentionally minimal — endpoint URLs are printed once at apply
# time; credentials live in the Upstash console / your secret manager and are
# wired to services via REDISURL-style env vars, never through Terraform state.
