#!/usr/bin/env bash
# Runs ON the EC2 host as root. Repoints every hostname-bearing setting to NEW_HOST:
#   Let's Encrypt cert, KC_HOSTNAME, aaqua-frontend client URIs, VITE_KEYCLOAK_URL,
#   KEYCLOAK_REALM_URL — then rebuilds the SPA and app.
#
# Used to run on a temporary sslip.io name until the aaqua.aaseya.com A record exists,
# and again to switch back:
#   sudo NEW_HOST=13-239-104-177.sslip.io LETSENCRYPT_EMAIL=ops@example.com bash switch-hostname.sh
#   sudo NEW_HOST=aaqua.aaseya.com        LETSENCRYPT_EMAIL=ops@example.com bash switch-hostname.sh
# When switching back, also run `certbot delete --cert-name <old host>` so the old
# cert's renewal hook stops overwriting secrets/tls/aaqua.{crt,key}.
#
# ALSO_ALLOW (default aaqua.aaseya.com) stays in the client's redirect URIs, so both
# names are accepted by Keycloak and the switch back needs no realm change.
set -euo pipefail

: "${NEW_HOST:?set NEW_HOST (bare hostname)}"
: "${LETSENCRYPT_EMAIL:?set LETSENCRYPT_EMAIL}"
ALSO_ALLOW="${ALSO_ALLOW:-aaqua.aaseya.com}"
SHARED=/opt/shared-infra
APP=/opt/aaqua/qa-test-gen
REALM=aaseya-platform
[ "$(id -u)" -eq 0 ] || { echo "run as root (sudo)" >&2; exit 1; }

set_kv() {  # set_kv FILE KEY VALUE — replace the line or append it
  if grep -q "^$2=" "$1"; then sed -i "s|^$2=.*|$2=$3|" "$1"; else printf '%s=%s\n' "$2" "$3" >> "$1"; fi
}

echo "==> 1/5 Certificate for $NEW_HOST"
PUBLIC_HOSTNAME="$NEW_HOST" LETSENCRYPT_EMAIL="$LETSENCRYPT_EMAIL" bash "$APP/scripts/aws/issue-cert.sh"

echo "==> 2/5 .env files (backups: *.bak-$(date +%Y%m%d%H%M))"
stamp=$(date +%Y%m%d%H%M)
cp -p "$SHARED/.env" "$SHARED/.env.bak-$stamp"
cp -p "$APP/.env"    "$APP/.env.bak-$stamp"
set_kv "$SHARED/.env" KC_HOSTNAME "$NEW_HOST"
set_kv "$APP/.env" VITE_KEYCLOAK_URL  "https://$NEW_HOST/auth"
set_kv "$APP/.env" KEYCLOAK_REALM_URL "https://$NEW_HOST/auth/realms/$REALM"

echo "==> 3/5 Recreating Keycloak with KC_HOSTNAME=$NEW_HOST"
(cd "$SHARED" && docker compose up -d keycloak)
for i in $(seq 1 40); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' shared-keycloak)" = healthy ] && break
  [ "$i" -eq 40 ] && { echo "Keycloak not healthy after 10 min" >&2; exit 1; }
  sleep 15
done

echo "==> 4/5 aaqua-frontend client URIs"
KC_USER=$(sed -n 's/^KEYCLOAK_ADMIN_USER=//p' "$SHARED/.env"); KC_USER=${KC_USER:-superadmin}
KC_PW=$(sed -n 's/^KEYCLOAK_ADMIN_PASSWORD=//p' "$SHARED/.env")
# `docker exec -e NAME` copies NAME from this shell's environment, so all must be exported.
export KC_USER KC_PW NEW_HOST ALSO_ALLOW REALM
docker exec -e KC_USER -e KC_PW -e NEW_HOST -e ALSO_ALLOW -e REALM shared-keycloak bash -c '
  set -euo pipefail
  kc() { /opt/keycloak/bin/kcadm.sh "$@" --config /tmp/kcadm.config; }
  kc config credentials --server http://localhost:8080/auth --realm master --user "$KC_USER" --password "$KC_PW" >/dev/null
  id=$(kc get clients -r "$REALM" -q clientId=aaqua-frontend --fields id --format csv --noquotes)
  kc update "clients/$id" -r "$REALM" \
    -s "rootUrl=https://$NEW_HOST/aaqua" -s "baseUrl=https://$NEW_HOST/aaqua/" \
    -s "redirectUris=[\"https://$NEW_HOST/aaqua/*\",\"https://$ALSO_ALLOW/aaqua/*\"]" \
    -s "webOrigins=[\"https://$NEW_HOST\",\"https://$ALSO_ALLOW\",\"+\"]" \
    -s "attributes.\"post.logout.redirect.uris\"=+"
  rm -f /tmp/kcadm.config
  echo "    updated client $id"'
unset KC_PW

echo "==> 5/5 Rebuilding SPA and app"
docker builder prune -f >/dev/null
cd "$APP"
./scripts/publish-spa.sh
docker compose up -d --build app

echo "==> Done. From your workstation: PUBLIC_HOSTNAME=$NEW_HOST scripts/aws/verify.sh"
