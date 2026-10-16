#!/usr/bin/env bash
. "$(dirname "$0")/harness.sh"

load() {
  install_fake curl getent
  export PUBLIC_HOSTNAME=aaqua.example.com LETSENCRYPT_EMAIL=ops@example.com
  export SHARED_INFRA_DIR="$SANDBOX/shared" LE_DIR="$SANDBOX/le"
  . "$AWS_DIR/issue-cert.sh"
}

test_dns_mismatch_is_rejected() {
  load
  respond curl <<'EOF'
api/token|0|tok
public-ipv4|0|198.51.100.10
EOF
  respond getent <<'EOF'
ahostsv4|0|203.0.113.99    STREAM aaqua.example.com
EOF
  out=$(check_dns 2>&1) && fail "expected non-zero"
  assert_contains "$out" "resolves to '203.0.113.99'"
  assert_contains "$out" "198.51.100.10"
}

test_dns_match_passes() {
  load
  respond curl <<'EOF'
api/token|0|tok
public-ipv4|0|198.51.100.10
EOF
  respond getent <<'EOF'
ahostsv4|0|198.51.100.10   STREAM aaqua.example.com
EOF
  check_dns >/dev/null
}

test_renewal_config_switches_to_webroot() {
  load
  conf="$SANDBOX/aaqua.example.com.conf"
  cat > "$conf" <<'EOF'
version = 2.9.0
archive_dir = /etc/letsencrypt/archive/aaqua.example.com

# Options used in the renewal process
[renewalparams]
account = abc
authenticator = standalone
server = https://acme-v02.api.letsencrypt.org/directory
EOF
  configure_webroot_renewal "$conf"
  configure_webroot_renewal "$conf"   # idempotent
  body=$(cat "$conf")
  assert_contains "$body" "authenticator = webroot"
  assert_not_contains "$body" "authenticator = standalone"
  assert_eq "$(grep -c '^webroot_path = ' "$conf")" "1"
  assert_contains "$body" "webroot_path = $SANDBOX/shared/nginx/acme,"
  assert_eq "$(grep -c '^\[\[webroot_map\]\]' "$conf")" "1"
  assert_contains "$body" "aaqua.example.com = $SANDBOX/shared/nginx/acme"
}

test_deploy_hook_copies_cert_and_reloads_nginx() {
  load
  hook=$(write_deploy_hook)
  body=$(cat "$hook")
  assert_contains "$body" "$LE_DIR/live/aaqua.example.com/fullchain.pem"
  assert_contains "$body" "$SHARED_INFRA_DIR/secrets/tls/aaqua.crt"
  assert_contains "$body" "$SHARED_INFRA_DIR/secrets/tls/aaqua.key"
  assert_contains "$body" "docker exec shared-nginx nginx -s reload"
  bash -n "$hook"
}

run_tests
