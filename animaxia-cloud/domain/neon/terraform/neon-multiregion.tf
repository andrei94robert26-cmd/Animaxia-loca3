# animaxia-neon-multiregion — read scaling IaC (FAZA 22)
#
# HONESTY NOTE (documented in ../README.md too): Neon does NOT offer native
# cross-region replication. What Neon DOES offer:
#   • branches — including read-only branches in the project's region
#   • read_only endpoints on any branch (a second compute serving reads)
# What it does NOT offer:
#   • a managed way to replicate the same Postgres into US/ASIA regions
#
# Strategy provisioned here (and in ../scripts/neon-multiregion.sh):
#   1. eu (primary region, writable)  — the existing Neon project + endpoint
#   2. eu read replica                 — a "read-replica-eu" BRANCH (child of
#      main) + a read_only endpoint on it: read scaling inside the primary
#      region, today, with plain Neon resources
#   3. us / asia                       — SEPARATE regional PostgreSQL
#      instances fed by Neon LOGICAL REPLICATION (pgoutput — the native
#      physical-replication protocol is not exposed cross-region). Those
#      targets are OUTSIDE this Terraform (different clouds/accounts) and are
#      documented as commented resources below.
#
# Integration point (documented, NOT wired into the protected backend):
#   DATABASE_READ_REPLICA_URLS — env var the future read-router consumes
#   (see ../read-router.config.json). No backend file reads it in FAZA 22.

terraform {
  required_version = ">= 1.5.0"

  required_providers {
    neon = {
      source  = "kislerdm/neon"
      version = "~> 0.5"
    }
  }
}

provider "neon" {
  # Never hardcode keys. Use TF_VAR_neon_api_key / a git-ignored tfvars file.
  # A second, explicit alias is used for the read-only branch so the provider
  # configuration stays identical (same account) — shown here for clarity.
  api_key = var.neon_api_key
}

# --- existing project (created outside Terraform — never imported here) -------

data "neon_project" "animaxia" {
  id = var.neon_project_id
}

# --- eu read replica: branch + read_only endpoint (real Neon resources) -------

resource "neon_branch" "read_replica" {
  project_id = data.neon_project.animaxia.id
  name       = "read-replica-eu"
  parent_id  = "main" # child of the main branch — inherits the schema + data

  # Read-only by convention: the router below only sends SELECTs here, and the
  # read_only endpoint enforces it at the compute level too.
}

resource "neon_endpoint" "read_eu" {
  project_id = data.neon_project.animaxia.id
  branch_id  = neon_branch.read_replica.id
  type       = "read_only" # enforces read-only at the endpoint level
}

# --- us / asia: logical-replication targets (documented, NOT provisioned) -----
# These are SEPARATE PostgreSQL instances in their own regions (RDS / Cloud SQL
# / self-hosted), fed from Neon via PUBLICATION + SUBSCRIPTION (logical
# replication, pgoutput protocol). They are intentionally NOT resources here:
#   • they live in different clouds/accounts than this Terraform state
#   • logical replication needs the publication created on the Neon side and
#     a SUBSCRIPTION created ON the target — cross-provider by design
#
# Sketch of the pieces (wal2json is NOT needed — pgoutput is built into
# Postgres 10+; wal2json only if you prefer JSON change events):
#
#   -- on the Neon primary (one-time):
#   CREATE PUBLICATION animaxia_read_pub FOR ALL TABLES;
#
#   -- on each regional target (one-time):
#   CREATE SUBSCRIPTION animaxia_us_sub
#     CONNECTION 'host=<neon-primary> dbname=neondb user=... password=... sslmode=require'
#     PUBLICATION animaxia_read_pub WITH (copy_data = true, create_slot = true);
#
# resource "aws_db_instance" "read_us" {
#   identifier     = "animaxia-read-us"
#   engine         = "postgres"
#   # ... fed by the SUBSCRIPTION above; the read-router points reads at it
# }
#
# resource "google_sql_database_instance" "read_asia" {
#   name             = "animaxia-read-asia"
#   database_version = "POSTGRES_16"
#   # ... same logical-replication pattern
# }

# --- outputs ------------------------------------------------------------------

output "read_eu_endpoint" {
  description = "read_only endpoint host for the eu read replica (DATABASE_READ_REPLICA_URLS entry)."
  value       = try(neon_endpoint.read_eu.host, "")
}
