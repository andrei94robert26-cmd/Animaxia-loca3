#!/usr/bin/env bash
# upload-media.sh — upload a poster/thumbnail to the Animaxia media R2 bucket.
#
# Usage:
#   ./scripts/upload-media.sh posters/death-note.svg
#   ./scripts/upload-media.sh local-file.png r2/key.png      # custom R2 key
#   PUB=1 ./scripts/upload-media.sh local-file.svg           # upload to the
#                                        # public bucket (animaxia-media-public)
#                                        # instead of the worker bucket
#
# After the upload the script prints the URL the object will be served at:
#   • worker bucket  → https://<zone>/media/<key>   (edge worker + cache, R2
#                       hit is flagged with the X-Edge: r2 response header)
#   • public bucket  → https://<r2-dev-host>/<key>  (direct public access,
#                       requires Public Access enabled on the bucket)
#
# Env overrides:
#   EDGE_BASE   base URL of the edge worker (default https://animaxia.com)
#   R2_PUB_BASE public base URL of the public bucket (default shown below)
set -euo pipefail

cd "$(dirname "$0")/.."

FILE="${1:-}"
[ -n "$FILE" ] && [ -f "$FILE" ] || {
  echo "usage: $0 <local-file> [r2-key]   (PUB=1 to target the public bucket)" >&2
  exit 1
}

KEY="${2:-$(basename "$FILE")}"
BUCKET="animaxia-media"            # must match wrangler.toml r2_buckets.bucket_name
[ "${PUB:-0}" = "1" ] && BUCKET="animaxia-media-public"

# Content type from the extension (posters from content-service are SVGs).
EXT="${FILE##*.}"; EXT="${EXT,,}"
case "$EXT" in
  svg)            CT="image/svg+xml" ;;
  png)            CT="image/png" ;;
  jpg|jpeg)       CT="image/jpeg" ;;
  webp)           CT="image/webp" ;;
  gif)            CT="image/gif" ;;
  avif)           CT="image/avif" ;;
  *)              CT="application/octet-stream" ;;
esac

echo "▶ uploading $FILE → r2://$BUCKET/$KEY ($CT)"
wrangler r2 object put "$BUCKET/$KEY" --file "$FILE" --content-type "$CT"

echo
if [ "$BUCKET" = "animaxia-media" ]; then
  echo "✔ served by the edge worker at:"
  echo "    ${EDGE_BASE:-https://animaxia.com}/media/$KEY"
  echo "  (response header X-Edge: r2 confirms the R2 hit)"
else
  echo "✔ served directly from the public bucket at:"
  echo "    ${R2_PUB_BASE:-https://pub-REPLACE-WITH-R2-PUBLIC-HOSTNAME.r2.dev}/$KEY"
  echo "  (or wire the media.<zone> CNAME — see terraform/r2.tf)"
fi
