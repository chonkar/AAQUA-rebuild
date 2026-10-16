#!/usr/bin/env bash
. "$(dirname "$0")/harness.sh"

test_fake_records_calls_and_answers_from_responses() {
  install_fake aws
  respond aws <<'EOF'
describe-instances|0|i-123
--dry-run|254|DryRunOperation
EOF
  out=$(aws ec2 describe-instances --filters x)
  assert_eq "$out" "i-123"
  assert_fails aws ec2 run-instances --dry-run
  assert_contains "$(cat "$SANDBOX/calls.log")" "aws ec2 describe-instances --filters x"
}

test_fake_defaults_to_None() {
  install_fake aws
  assert_eq "$(aws anything)" "None"
}

test_fake_captures_stdin() {
  install_fake ssh
  printf 'secret\n' | ssh host cmd
  assert_contains "$(stdin_of ssh)" "secret"
  assert_not_contains "$(cat "$SANDBOX/calls.log")" "secret"
}

run_tests
