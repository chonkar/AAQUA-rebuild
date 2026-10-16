#!/usr/bin/env bash
# AAQUA — Let's Encrypt certificate for shared-nginx. Runs ON the EC2 host as root.
#
# First run: certbot --standalone (port 80 must be free, so shared-nginx is
# stopped briefly if it is up). Afterwards renewals use the webroot that
# shared-nginx serves at /.well-known/acme-challenge/, and a deploy hook copies
# the renewed cert to secrets/tls/ and reloads nginx.
#
# Usage:
#   sudo PUBLIC_HOSTNAME=aaqua.example.com LETSENCRYPT_EMAIL=ops@example.com \
#        bash issue-cert.sh [--staging]
set -euo pipefail

SHARED="${SHARED_INFRA_DIR:-/opt/shared-infra}"
LE_DIR="${LE_DIR:-/etc/letsencrypt}"
IMDS="${IMDS:-http://169.254.169.254}"
WEBROOT="$SHARED/nginx/acme"

die() { printf 'FATAL: %s\n' "$*" >&2; exit 1; }

public_ip() {
  local token
  token=$(curl -fsS -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' "$IMDS/latest/api/token")
  curl -fsS -H "X-aws-ec2-metadata-token: $token" "$IMDS/latest/meta-data/public-ipv4"
}

resolved_ip() { getent ahostsv4 "$1" | awk 'NR==1 {print $1}'; }

check_dns() {
  local want got
  want=$(public_ip)
  got=$(resolved_ip "$PUBLIC_HOSTNAME" || true)
  if [ "$got" != "$want" ]; then
    printf "FATAL: %s resolves to '%s', but this instance's public IP is %s.\n" \
      "$PUBLIC_HOSTNAME" "${got:-nothing}" "$want" >&2
    printf 'Fix the DNS A record and wait for propagation before requesting a certificate.\n' >&2
    return 1
  fi
  echo "==> DNS ok: $PUBLIC_HOSTNAME -> $got"
}

configure_webroot_renewal() {
  local conf="$1"
  [ -f "$conf" ] || die "renewal config $conf not found"
  # Drop any previous webroot settings so re-runs stay idempotent.
  sed -i -e '/^webroot_path = /d' -e '/^\[\[webroot_map\]\]/,$d' "$conf"
  sed -i -e 's/^authenticator = .*/authenticator = webroot/' "$conf"
  sed -i -e "/^authenticator = webroot/a webroot_path = $WEBROOT," "$conf"
  printf '[[webroot_map]]\n%s = %s\n' "$PUBLIC_HOSTNAME" "$WEBROOT" >> "$conf"
}

write_deploy_hook() {
  local hook="$LE_DIR/renewal-hooks/deploy/aaqua.sh"
  mkdir -p "$(dirname "$hook")"
  cat > "$hook" <<EOF
#!/usr/bin/env bash
# Installed by issue-cert.sh: copy the (re)issued cert to where shared-nginx reads it.
set -euo pipefail
mkdir -p "$SHARED/secrets/tls"
install -m 644 "$LE_DIR/live/$PUBLIC_HOSTNAME/fullchain.pem" "$SHARED/secrets/tls/aaqua.crt"
install -m 600 "$LE_DIR/live/$PUBLIC_HOSTNAME/privkey.pem"   "$SHARED/secrets/tls/aaqua.key"
docker exec shared-nginx nginx -s reload 2>/dev/null || true
EOF
  chmod 755 "$hook"
  printf '%s\n' "$hook"
}

is_staging_cert() {
  openssl x509 -in "$LE_DIR/live/$PUBLIC_HOSTNAME/fullchain.pem" -noout -issuer 2>/dev/null | grep -q STAGING
}

main() {
  local staging=()
  if [ "${1:-}" = "--staging" ]; then staging=(--staging); fi
  : "${PUBLIC_HOSTNAME:?set PUBLIC_HOSTNAME}"
  : "${LETSENCRYPT_EMAIL:?set LETSENCRYPT_EMAIL}"
  [ "$(id -u)" -eq 0 ] || die "run as root (sudo)"

  check_dns
  mkdir -p "$WEBROOT" "$SHARED/secrets/tls"

  # A staging cert is not trusted by browsers; replace it on a non-staging run.
  if [ ${#staging[@]} -eq 0 ] && [ -d "$LE_DIR/live/$PUBLIC_HOSTNAME" ] && is_staging_cert; then
    echo "==> Replacing staging certificate with a production one"
    certbot delete --non-interactive --cert-name "$PUBLIC_HOSTNAME"
  fi

  if [ ! -d "$LE_DIR/live/$PUBLIC_HOSTNAME" ]; then
    local nginx_was_up=""
    if docker ps --format '{{.Names}}' | grep -qx shared-nginx; then
      nginx_was_up=1
      echo "==> Stopping shared-nginx to free port 80 for the first issuance"
      docker stop shared-nginx >/dev/null
    fi
    if ! certbot certonly --standalone --non-interactive --agree-tos \
         -m "$LETSENCRYPT_EMAIL" -d "$PUBLIC_HOSTNAME" "${staging[@]}"; then
      if [ -n "$nginx_was_up" ]; then docker start shared-nginx >/dev/null || true; fi
      die "certbot failed"
    fi
    if [ -n "$nginx_was_up" ]; then docker start shared-nginx >/dev/null; fi
  else
    echo "==> Certificate for $PUBLIC_HOSTNAME already present"
  fi

  configure_webroot_renewal "$LE_DIR/renewal/$PUBLIC_HOSTNAME.conf"
  bash "$(write_deploy_hook)"
  echo "==> Certificate installed at $SHARED/secrets/tls/aaqua.{crt,key}; renewals via webroot $WEBROOT"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
