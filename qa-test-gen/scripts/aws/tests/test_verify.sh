#!/usr/bin/env bash
. "$(dirname "$0")/harness.sh"

setup() {
  install_fake curl openssl
  export PUBLIC_HOSTNAME=aaqua.example.com
  export FAKE_OPENSSL_X509="issuer=C = US, O = Let's Encrypt, CN = R11\nX509v3 Subject Alternative Name:\n    DNS:aaqua.example.com"
}

healthy_responses() {
  respond curl <<'EOF'
/healthz|0|ok
openid-configuration|0|{"issuer":"https://aaqua.example.com/auth/realms/aaseya-platform","authorization_endpoint":"x"}
/aaqua/api/runtime-info|0|{"hasDisplayServer":false,"isContainer":true,"platform":"linux"}
/aaqua/|0|<html><body><div id="root"></div></body></html>
EOF
}

test_all_checks_pass_on_healthy_deploy() {
  setup; healthy_responses
  out=$(bash "$AWS_DIR/verify.sh" 2>&1)
  assert_contains "$out" "All checks passed"
}

test_issuer_mismatch_fails() {
  setup
  respond curl <<'EOF'
/healthz|0|ok
openid-configuration|0|{"issuer":"https://8.231.124.161/auth/realms/aaseya-platform"}
EOF
  out=$(bash "$AWS_DIR/verify.sh" 2>&1) && fail "expected non-zero"
  assert_contains "$out" "issuer"
  assert_contains "$out" "8.231.124.161"
}

test_non_letsencrypt_cert_fails() {
  setup; healthy_responses
  export FAKE_OPENSSL_X509="issuer=CN = aaqua self-signed\nDNS:aaqua.example.com"
  out=$(bash "$AWS_DIR/verify.sh" 2>&1) && fail "expected non-zero"
  assert_contains "$out" "not Let's Encrypt"
}

run_tests
