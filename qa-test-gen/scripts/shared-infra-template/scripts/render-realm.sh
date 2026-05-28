#!/usr/bin/env bash
# Renders AAQUA's templated Keycloak realm into the shared-infra import dir.
# Substitutes ${PUBLIC_BASE_URL}.
# Run once before the first `docker compose up` of shared-infra.
set -euo pipefail

: "${PUBLIC_BASE_URL:?set PUBLIC_BASE_URL, e.g. https://aaqua.aaseya.com:8443}"
: "${AAQUA_REPO:=/opt/aaqua}"
SRC="$AAQUA_REPO/keycloak/aaseya-platform-realm.template.json"
DST="/opt/shared-infra/keycloak/realms/aaseya-platform-realm.json"

[ -f "$SRC" ] || { echo "ERROR: $SRC not found"; exit 1; }
mkdir -p "$(dirname "$DST")"
PUBLIC_BASE_URL="$PUBLIC_BASE_URL" envsubst '${PUBLIC_BASE_URL}' < "$SRC" > "$DST"
echo "Rendered -> $DST"
