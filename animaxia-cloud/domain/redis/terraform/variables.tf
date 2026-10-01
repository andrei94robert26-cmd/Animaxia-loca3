# animaxia-redis-global — input variables
#
# Secrets are marked sensitive — they never end up in state logs or output.
# Copy terraform.tfvars.example (or use -var / TF_VAR_* env vars) and fill in
# your own values from the Upstash console.

variable "upstash_api_key" {
  description = "Upstash management API key (console → Team → API Keys, type Management). SENSITIVE — pass via TF_VAR_upstash_api_key or a git-ignored tfvars file."
  type        = string
  sensitive   = true
}

variable "team_id" {
  description = "Upstash team id (console → Team → Settings). Databases are provisioned under this team. SENSITIVE — teams are account-scoped identifiers."
  type        = string
  sensitive   = true
}
