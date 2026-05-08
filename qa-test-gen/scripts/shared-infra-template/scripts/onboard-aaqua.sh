#!/usr/bin/env bash
# Onboards AAQUA onto the shared-infra stack on this host. Run once.
# Re-runs are safe — secret files are preserved if present.
set -euo pipefail

SHARED=/opt/shared-infra
AAQUA=${AAQUA_REPO:-/opt/aaqua}
PUBLIC_BASE_URL=${PUBLIC_BASE_URL:-http://10.13.1.182}

echo "==> Creating tenant directory layout"
mkdir -p "$SHARED"/{secrets/aaqua,nginx/sites/aaqua,keycloak/realms}
chmod 700 "$SHARED/secrets" "$SHARED/secrets/aaqua"

gen_or_keep() {
  local path="$1" generator="$2"
  if [ -s "$path" ]; then
    echo "  keep    $path (already exists)"
  else
    eval "$generator" > "$path"
    chmod 600 "$path"
    echo "  create  $path"
  fi
}

echo "==> Tenant secrets at $SHARED/secrets/aaqua/"
gen_or_keep "$SHARED/secrets/aaqua/db_password.txt"  "echo \"\$AAQUA_DB_PASSWORD\""
if [ ! -s "$SHARED/secrets/aaqua/llm_api_key.txt" ]; then
  read -rsp "Paste VITE_LLM_API_KEY (input hidden): " KEY; echo
  printf '%s' "$KEY" > "$SHARED/secrets/aaqua/llm_api_key.txt"
  chmod 600 "$SHARED/secrets/aaqua/llm_api_key.txt"
fi

echo "==> Rendering Keycloak realm template"
PUBLIC_BASE_URL="$PUBLIC_BASE_URL" AAQUA_REPO="$AAQUA" \
  bash "$SHARED/scripts/render-realm.sh"

echo "==> Publishing AAQUA SPA bundle"
( cd "$AAQUA" && bash scripts/publish-spa.sh )

echo
echo "Next steps:"
echo "  1. cd $SHARED && docker compose up -d           # brings up postgres + keycloak + nginx"
echo "  2. cd $AAQUA  && docker compose up -d --build   # brings up aaqua-app + aaqua-zap"
echo "  3. open $PUBLIC_BASE_URL/aaqua/"
