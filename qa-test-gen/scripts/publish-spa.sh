#!/usr/bin/env bash
# Build the SPA inside a temp container, extract dist/ to /opt/shared-infra/nginx/sites/aaqua/.
# Run after every `git pull` on the QA host. Idempotent.
set -euo pipefail

# Pull tenant config out of .env if present. Bash doesn't read .env automatically,
# so without this VITE_KEYCLOAK_URL would silently fall back to the hardcoded
# default below, producing a stale bundle whenever the operator only updated .env.
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

TARGET="${SHARED_INFRA_DIR:-/opt/shared-infra}/nginx/sites/aaqua"
mkdir -p "$TARGET"

# Default to HTTPS — once TLS is terminated at shared-nginx, mixing in HTTP URLs
# triggers browser mixed-content blocks. Override via .env or shell env if needed.
VITE_KEYCLOAK_URL="${VITE_KEYCLOAK_URL:-https://aaqua.aaseya.com:8443/auth}"

echo "Building SPA with:"
echo "  VITE_KEYCLOAK_URL=$VITE_KEYCLOAK_URL"
echo "  VITE_KEYCLOAK_REALM=aaseya-platform"
echo "  VITE_KEYCLOAK_CLIENT_ID=aaqua-frontend"
echo "  VITE_BASE_PATH=/aaqua/"

docker build \
  --no-cache \
  --target frontend-build \
  --build-arg VITE_BASE_PATH=/aaqua/ \
  --build-arg VITE_KEYCLOAK_URL="$VITE_KEYCLOAK_URL" \
  --build-arg VITE_KEYCLOAK_REALM=aaseya-platform \
  --build-arg VITE_KEYCLOAK_CLIENT_ID=aaqua-frontend \
  -t aaqua-spa-build:latest \
  .

TMP=$(docker create aaqua-spa-build:latest)
trap 'docker rm -f "$TMP" >/dev/null 2>&1 || true' EXIT

# Clear out previous bundle files so stale content-hashed assets don't pile up.
# Vite emits new hashed filenames per build; without this clean step, every
# publish accumulates one orphan index-<hash>.js / .css alongside the live one.
# index.html only ever references the newest pair, but the leftovers waste disk
# and make diagnostics confusing.
echo "Clearing previous bundle in $TARGET ..."
rm -rf "$TARGET/assets" "$TARGET/index.html" "$TARGET/vite.svg"

docker cp "$TMP:/app/dist/." "$TARGET/"

echo "Published SPA -> $TARGET"
ls -la "$TARGET" | head -20
