#!/usr/bin/env bash
. "$(dirname "$0")/harness.sh"

test_defaults() {
  . "$AWS_DIR/lib.sh"
  assert_eq "$AWS_REGION" "ap-southeast-2"
  assert_eq "$INSTANCE_TYPE" "m7i-flex.large"
  assert_eq "$AWS_PROFILE" "aaqua-deploy"
  assert_eq "$UBUNTU_AMI_OWNER" "099720109477"
  assert_eq "$UBUNTU_AMI_NAME" "ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"
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

test_path_conversion_disabled() {
  . "$AWS_DIR/lib.sh"
  assert_eq "$MSYS_NO_PATHCONV" "1"
}

test_aws_output_crs_are_stripped() {
  install_fake aws
  respond aws <<'EOF'
describe-instances --filters|0|i-abc\r
x|0|foo\r
EOF
  . "$AWS_DIR/lib.sh"
  assert_eq "$(find_instance_id)" "i-abc"
  aws x > "$SANDBOX/out"
  assert_eq "$(tr -dc '\r' < "$SANDBOX/out" | wc -c)" "0"
}

test_aws_exit_status_propagates_under_pipefail() {
  install_fake aws
  respond aws <<'EOF'
boom|254|oops
EOF
  . "$AWS_DIR/lib.sh"
  set -o pipefail
  if aws boom >/dev/null; then fail "expected aws to return non-zero"; fi
}

run_tests
