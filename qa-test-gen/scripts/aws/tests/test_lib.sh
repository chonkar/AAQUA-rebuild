#!/usr/bin/env bash
. "$(dirname "$0")/harness.sh"

test_defaults() {
  . "$AWS_DIR/lib.sh"
  assert_eq "$AWS_REGION" "ap-southeast-2"
  assert_eq "$INSTANCE_TYPE" "m7i-flex.large"
  assert_eq "$AWS_PROFILE" "aaqua-deploy"
}

test_aws_env_file_overrides_defaults() {
  printf 'INSTANCE_TYPE=t3.large\n' > "$SANDBOX/aws.env"
  AAQUA_AWS_ENV="$SANDBOX/aws.env" . "$AWS_DIR/lib.sh"
  assert_eq "$INSTANCE_TYPE" "t3.large"
}

test_aws_env_with_crlf_is_tolerated() {
  printf 'INSTANCE_TYPE=t3.large\r\n' > "$SANDBOX/aws.env"
  AAQUA_AWS_ENV="$SANDBOX/aws.env" . "$AWS_DIR/lib.sh"
  assert_eq "$INSTANCE_TYPE" "t3.large"
}

test_find_instance_id_returns_empty_when_absent() {
  install_fake aws
  . "$AWS_DIR/lib.sh"
  assert_eq "$(find_instance_id)" ""
}

test_find_instance_id_filters_by_name_tag() {
  install_fake aws
  respond aws <<'EOF'
describe-instances --filters|0|i-abc
EOF
  . "$AWS_DIR/lib.sh"
  assert_eq "$(find_instance_id)" "i-abc"
  assert_contains "$(cat "$SANDBOX/calls.log")" "Name=tag:Name,Values=aaqua-host"
}

test_remote_uses_key_and_ubuntu_user() {
  install_fake ssh
  . "$AWS_DIR/lib.sh"
  remote 198.51.100.1 true
  assert_contains "$(cat "$SANDBOX/calls.log")" "-i $KEY_FILE"
  assert_contains "$(cat "$SANDBOX/calls.log")" "ubuntu@198.51.100.1 true"
}

run_tests
