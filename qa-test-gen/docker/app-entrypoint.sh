#!/bin/sh
# Bundled app entrypoint.
#  1. Reads Docker secrets from /run/secrets/* into env vars (consumed by Node).
#  2. Renders nginx.conf.template into /etc/nginx/conf.d/default.conf, replacing
#     ${LLM_API_KEY} only — nginx variables like $host stay untouched.
#  3. exec's whatever CMD was passed (normally supervisord).
set -e

read_secret() {
    file="/run/secrets/$1"
    [ -f "$file" ] && cat "$file"
}

# ─── Secrets → env vars (for the Node backend) ──────────────────────────
LLM_KEY="$(read_secret llm_api_key)"
[ -n "$LLM_KEY" ] && export VITE_LLM_API_KEY="$LLM_KEY"

# Authentication is delegated to Keycloak (see /api/security/* via OIDC); the
# Node backend verifies tokens against the realm's JWKS and stores no secret.

JIRA="$(read_secret jira_token)"
[ -n "$JIRA" ] && export JIRA_TOKEN="$JIRA"

# Postgres connection URL — assembled from the password secret + env defaults.
DB_PASSWORD="$(read_secret db_password)"
: "${DB_USER:=aaqua}"
: "${DB_HOST:=postgres}"
: "${DB_PORT:=5432}"
: "${DB_NAME:=aaqua_security}"
: "${DB_PASSWORD:=aaqua}"
export DATABASE_URL="postgresql://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}"

# ─── Render nginx config (only LLM_API_KEY is substituted) ──────────────
if [ -z "$LLM_KEY" ]; then
    echo "[entrypoint] WARNING: /run/secrets/llm_api_key missing — /llm-api will fail" >&2
fi
export LLM_API_KEY="$LLM_KEY"
envsubst '$LLM_API_KEY' \
    < /etc/nginx/templates/default.conf.template \
    > /etc/nginx/conf.d/default.conf

exec "$@"
