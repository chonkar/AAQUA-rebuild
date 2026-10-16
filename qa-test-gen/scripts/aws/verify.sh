#!/usr/bin/env bash
# AAQUA — post-deploy smoke checks (run from your workstation).
# Usage: scripts/aws/verify.sh            (PUBLIC_HOSTNAME from aws.env or env)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$HERE/lib.sh"
if [[ "$PUBLIC_HOSTNAME" == REPLACE-ME* ]]; then die "set PUBLIC_HOSTNAME"; fi

BASE="https://$PUBLIC_HOSTNAME"
ok()    { printf '  ok    %s\n' "$*"; }
check_fail() { printf '  FAIL  %s\n' "$*" >&2; exit 1; }
fetch() { curl -fsS --max-time 20 "$BASE$1" || check_fail "GET $1 failed"; }

body=$(fetch /healthz)
[[ "$body" == ok* ]] || check_fail "/healthz returned: $body"
ok "/healthz over HTTPS"

cert=$(echo | openssl s_client -connect "$PUBLIC_HOSTNAME:443" -servername "$PUBLIC_HOSTNAME" 2>/dev/null \
       | openssl x509 -noout -issuer -ext subjectAltName 2>/dev/null) || check_fail "could not read certificate"
[[ "$cert" == *"Let's Encrypt"* ]] || check_fail "certificate issuer is not Let's Encrypt: $cert"
[[ "$cert" == *"DNS:$PUBLIC_HOSTNAME"* ]] || check_fail "certificate SAN does not include $PUBLIC_HOSTNAME"
ok "certificate: Let's Encrypt, SAN matches"

want="$BASE/auth/realms/aaseya-platform"
oidc=$(fetch /auth/realms/aaseya-platform/.well-known/openid-configuration)
got=$(sed -n 's/.*"issuer":"\([^"]*\)".*/\1/p' <<<"$oidc")
[ "$got" = "$want" ] || check_fail "Keycloak issuer is '$got', expected '$want' (check KC_HOSTNAME / GitLab variable scoping)"
ok "Keycloak issuer = $want"

spa=$(fetch /aaqua/)
[[ "$spa" == *'id="root"'* ]] || check_fail "/aaqua/ did not return the SPA shell"
ok "/aaqua/ serves the SPA"

api=$(fetch /aaqua/api/runtime-info)
[[ "$api" == *hasDisplayServer* ]] || check_fail "/aaqua/api/runtime-info unexpected body: $api"
ok "/aaqua/api/runtime-info reaches the backend"

echo "All checks passed for $BASE"
