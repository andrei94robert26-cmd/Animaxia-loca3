# animaxia-edge — R2 object storage
#
# Two buckets:
#   - animaxia-media        (private)  — bound to the worker (binding
#     ANIMAXIA_MEDIA); serves GET /media/<key> straight from R2 with a 24h
#     browser cache. Upload via ../scripts/upload-media.sh.
#   - animaxia-media-public (public)   — optional direct-delivery bucket for
#     URLs that must work without the worker (e.g. emails, OG images).
#
# Bucket location: omitted on purpose → "auto" (apexus hint). Provider 4.x
# also accepts explicit hints: WNAM / ENAM / WEUR / EEUR / APAC / OC.

resource "cloudflare_r2_bucket" "media" {
  account_id = var.cloudflare_account_id
  name       = var.r2_bucket_name # animaxia-media
}

resource "cloudflare_r2_bucket" "media_public" {
  account_id = var.cloudflare_account_id
  name       = var.r2_public_bucket_name # animaxia-media-public
}

# --- Cold-storage lifecycle ---------------------------------------------------
# Goal: transition objects to Glacier-class storage after 90 days and abort
# incomplete multipart uploads after 7 days.
#
# VERIFIED against provider v4.49.1 (last 4.x release): `cloudflare_r2_bucket`
# in the 4.x provider only manages account_id / name / location — there is NO
# inline lifecycle_rule block, and the dedicated `cloudflare_r2_bucket_lifecycle`
# resource only exists in provider >= 5.x. Two supported ways to get the
# lifecycle policy applied:
#
# Option A — provider >= 5.x (declarative): bump `version` in versions.tf to
# "~> 5.0" (5.11+) and uncomment the block below (schema verified against the
# current provider docs):
#
# resource "cloudflare_r2_bucket_lifecycle" "media" {
#   account_id  = var.cloudflare_account_id
#   bucket_name = cloudflare_r2_bucket.media.name
#
#   rules = [{
#     id         = "animaxia-media-glacier-after-90d"
#     conditions = { prefix = "" } # all objects
#     enabled    = true
#     # Abort incomplete multipart uploads after 7 days.
#     abort_multipart_uploads_transition = {
#       condition = {
#         type    = "Age"
#         max_age = 7
#       }
#     }
#     # Transition to Glacier-class (cold) storage after 90 days.
#     storage_class_transitions = [{
#       condition = {
#         type    = "Age"
#         max_age = 90
#       }
#       storage_class = "Glacier"
#     }]
#   }]
# }
#
# Option B — works today on provider 4.x: apply the same policy once via the
# S3-compatible API (create an R2 API token in the dashboard first):
#
#   cat > /tmp/r2-lifecycle.json <<'EOF'
#   {
#     "Rules": [
#       {
#         "ID": "abort-incomplete-multipart-7d",
#         "Status": "Enabled",
#         "Filter": { "Prefix": "" },
#         "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 7 }
#       },
#       {
#         "ID": "glacier-after-90d",
#         "Status": "Enabled",
#         "Filter": { "Prefix": "" },
#         "Transitions": [ { "Days": 90, "StorageClass": "GLACIER" } ]
#       }
#     ]
#   }
#   EOF
#   aws s3api put-bucket-lifecycle-configuration \
#     --endpoint-url "https://${var.cloudflare_account_id}.r2.cloudflarestorage.com" \
#     --bucket "${var.r2_bucket_name}" \
#     --lifecycle-configuration file:///tmp/r2-lifecycle.json
#
# (Any S3 client works — `aws`, `rclone` with the S3 backend, boto3, ...)

# --- Public bucket custom domain ---------------------------------------------
# Provider 4.x has NO resource for R2 public access / bucket custom domains —
# enable it in the dashboard first (R2 → animaxia-media-public → Settings →
# Public Access → r2.dev) or via the R2 API, then point a proxied CNAME at the
# pub-<id>.r2.dev hostname. Uncomment and set var.r2_dev_public_hostname:
#
# resource "cloudflare_record" "media_public_domain" {
#   zone_id = data.cloudflare_zone.animaxia.id
#   name    = var.r2_public_domain # media.<zone> → media.animaxia.com
#   type    = "CNAME"
#   content = var.r2_dev_public_hostname # e.g. pub-<id>.r2.dev
#   ttl     = 1
#   proxied = true
# }
#
# Alternative that needs no extra domain: the private bucket is already served
# by the worker at https://<your-zone>/media/<key> (see src/worker.js), which
# adds caching + the WAF/rate-limit stack in front of it.
