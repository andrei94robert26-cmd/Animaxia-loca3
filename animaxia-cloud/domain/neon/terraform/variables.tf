# animaxia-neon-multiregion — input variables
#
# Secrets are marked sensitive — they never end up in state logs or output.

variable "neon_api_key" {
  description = "Neon API key (console → Account → API keys). SENSITIVE — pass via TF_VAR_neon_api_key or a git-ignored tfvars file. The bash twin of this module (../scripts/neon-multiregion.sh) reads NEON_API_KEY from the environment instead."
  type        = string
  sensitive   = true
}

variable "neon_project_id" {
  description = "Neon project id hosting the Animaxia database (console → Project → Settings). The project is managed OUTSIDE Terraform — it is only read here (data source)."
  type        = string
}
