#!/usr/bin/env bash
. "$(dirname "$0")/harness.sh"

UD="$AWS_DIR/aws-ec2-userdata.sh"

test_userdata_parses() {
  bash -n "$UD"
}

test_userdata_contains_no_secrets_or_clone() {
  body=$(cat "$UD")
  assert_not_contains "$body" "TOKEN"
  assert_not_contains "$body" "git clone"
}

test_userdata_writes_done_marker_last() {
  assert_eq "$(grep -v '^\s*$' "$UD" | grep -v '^\s*#' | tail -1)" "touch /var/lib/aaqua/userdata.done"
}

test_userdata_creates_required_dirs_and_network() {
  body=$(cat "$UD")
  assert_contains "$body" "/opt/shared-infra/nginx/acme"
  assert_contains "$body" "/opt/shared-infra/secrets/tls"
  assert_contains "$body" "docker network create shared-infra_default"
  assert_contains "$body" "gettext-base"
  assert_contains "$body" "certbot"
}

test_userdata_survives_dpkg_lock_and_reruns() {
  body=$(cat "$UD")
  assert_contains "$body" "DPkg::Lock::Timeout"
  assert_contains "$body" "--yes"
  assert_contains "$body" "sleep 15"
}

run_tests
