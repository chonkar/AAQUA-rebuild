#!/usr/bin/env bash
# Build the SPA inside a temp container, extract dist/ to /opt/shared-infra/nginx/sites/aaqua/.
# Run after every `git pull` on the QA host. Idempotent.
set -euo pipefail

TARGET="${SHARED_INFRA_DIR:-/opt/shared-infra}/nginx/sites/aaqua"
mkdir -p "$TARGET"

docker build \
  --target frontend-build \
  --build-arg VITE_BASE_PATH=/aaqua/ \
  --build-arg VITE_KEYCLOAK_URL="${VITE_KEYCLOAK_URL:-http://10.13.1.182/auth}" \
  --build-arg VITE_KEYCLOAK_REALM=aaseya-platform \
  --build-arg VITE_KEYCLOAK_CLIENT_ID=aaqua-frontend \
  -t aaqua-spa-build:latest \
  .

TMP=$(docker create aaqua-spa-build:latest)
trap 'docker rm -f "$TMP" >/dev/null 2>&1 || true' EXIT
docker cp "$TMP:/app/dist/." "$TARGET/"

echo "Published SPA -> $TARGET"
ls -la "$TARGET" | head -20
