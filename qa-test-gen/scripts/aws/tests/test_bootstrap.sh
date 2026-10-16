#!/usr/bin/env bash
. "$(dirname "$0")/harness.sh"

setup() {
  install_fake aws ssh scp
  respond aws <<'EOF'
describe-instances --filters|0|i-123
PublicIpAddress|0|198.51.100.10
EOF
  export GITLAB_DEPLOY_TOKEN_USER=gitlab+deploy-token-7 GITLAB_DEPLOY_TOKEN=gldt-SECRETDEPLOY
}

test_secrets_only_travel_over_stdin() {
  setup
  export GITLAB_RUNNER_TOKEN=glrt-SECRETRUNNER
  bash "$AWS_DIR/aws-bootstrap.sh" >/dev/null 2>&1
  calls=$(cat "$SANDBOX/calls.log")
  assert_not_contains "$calls" "gldt-SECRETDEPLOY"
  assert_not_contains "$calls" "glrt-SECRETRUNNER"
  assert_contains "$(stdin_of ssh)" "gldt-SECRETDEPLOY"
  assert_contains "$(stdin_of ssh)" "glrt-SECRETRUNNER"
}

test_ships_helpers_and_runs_them() {
  setup
  export GITLAB_RUNNER_TOKEN=glrt-x
  bash "$AWS_DIR/aws-bootstrap.sh" >/dev/null 2>&1
  calls=$(cat "$SANDBOX/calls.log")
  assert_contains "$calls" "clone-repo.sh"
  assert_contains "$calls" "install-runner.sh"
  assert_contains "$calls" "ubuntu@198.51.100.10:/tmp/"
  assert_contains "$calls" "test -f /var/lib/aaqua/userdata.done"
}

test_skips_runner_without_token() {
  setup
  unset GITLAB_RUNNER_TOKEN
  bash "$AWS_DIR/aws-bootstrap.sh" >/dev/null 2>&1
  assert_not_contains "$(grep '^ssh' "$SANDBOX/calls.log")" "install-runner.sh"
}

test_requires_deploy_token() {
  setup
  unset GITLAB_DEPLOY_TOKEN
  assert_fails bash "$AWS_DIR/aws-bootstrap.sh"
}

test_reports_clear_error_when_ssh_never_succeeds() {
  setup
  respond ssh <<'EOF'
StrictHostKeyChecking|255|
EOF
  export SSH_WAIT_TRIES=2 SSH_WAIT_SECONDS=0
  out=$(bash "$AWS_DIR/aws-bootstrap.sh" 2>&1) && fail "expected non-zero exit"
  assert_contains "$out" "SSH to"
  assert_not_contains "$out" "user-data did not finish"
}

test_fails_when_no_instance() {
  install_fake aws ssh scp
  export GITLAB_DEPLOY_TOKEN_USER=u GITLAB_DEPLOY_TOKEN=t
  out=$(bash "$AWS_DIR/aws-bootstrap.sh" 2>&1) && fail "expected non-zero exit"
  assert_contains "$out" "run aws-provision.sh first"
}

test_clone_helper_keeps_token_out_of_argv() {
  body=$(cat "$AWS_DIR/remote/clone-repo.sh")
  assert_contains "$body" "GIT_CONFIG_VALUE_0"
  assert_not_contains "$body" '@${REPO_URL'
  bash -n "$AWS_DIR/remote/clone-repo.sh"
  bash -n "$AWS_DIR/remote/install-runner.sh"
}

run_tests
