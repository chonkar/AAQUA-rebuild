#!/usr/bin/env bash
. "$(dirname "$0")/harness.sh"

setup() {
  install_fake aws
  export SSH_SOURCE_CIDR=203.0.113.7/32 PUBLIC_HOSTNAME=aaqua.example.com
  export KEY_FILE="$SANDBOX/aaqua-host.pem"
}

test_reuses_everything_when_infra_exists() {
  setup
  : > "$KEY_FILE"
  respond aws <<'EOF'
--dry-run|254|An error occurred (DryRunOperation) when calling the RunInstances operation
sts get-caller-identity|0|arn:aws:iam::111111111111:user/svc-appserver-deploy
describe-images|0|ami-123
describe-key-pairs|0|aaqua-host
describe-security-groups|0|sg-123
describe-security-group-rules|0|1
describe-instances --filters|0|i-123
State.Name|0|running
describe-addresses --filters|0|eipalloc-1	eipassoc-1
describe-addresses --allocation-ids|0|198.51.100.10
EOF
  out=$(bash "$AWS_DIR/aws-provision.sh" 2>&1)
  calls=$(cat "$SANDBOX/calls.log")
  assert_not_contains "$calls" "create-key-pair"
  assert_not_contains "$calls" "create-security-group"
  assert_not_contains "$calls" "authorize-security-group-ingress"
  assert_not_contains "$calls" "run-instances --image-id"
  assert_not_contains "$calls" "start-instances"
  assert_not_contains "$calls" "allocate-address"
  assert_not_contains "$calls" "associate-address"
  assert_contains "$out" "Elastic IP: 198.51.100.10"
}

test_creates_everything_when_absent() {
  setup
  respond aws <<'EOF'
--dry-run|254|An error occurred (DryRunOperation) when calling the RunInstances operation
sts get-caller-identity|0|arn:aws:iam::111111111111:user/svc-appserver-deploy
describe-images|0|ami-123
describe-key-pairs|254|An error occurred (InvalidKeyPair.NotFound)
create-key-pair|0|-----BEGIN OPENSSH PRIVATE KEY-----
describe-security-groups|0|None
create-security-group|0|sg-new
describe-security-group-rules|0|0
describe-instances --filters|0|None
run-instances --image-id|0|i-new
describe-addresses --filters|0|None
allocate-address|0|eipalloc-new
describe-addresses --allocation-ids|0|198.51.100.20
EOF
  out=$(bash "$AWS_DIR/aws-provision.sh" 2>&1)
  calls=$(cat "$SANDBOX/calls.log")
  assert_contains "$calls" "create-key-pair --key-name aaqua-host"
  assert_contains "$calls" "create-security-group --group-name aaqua-host-sg"
  assert_eq "$(grep -c authorize-security-group-ingress "$SANDBOX/calls.log")" "3"
  assert_contains "$calls" "--port 22 --cidr 203.0.113.7/32"
  assert_contains "$calls" "run-instances --image-id ami-123 --instance-type m7i-flex.large"
  assert_contains "$calls" "HttpTokens=required"
  assert_contains "$calls" "aws-ec2-userdata.sh"
  assert_contains "$calls" "VolumeSize=30,VolumeType=gp3"
  assert_contains "$calls" "associate-address --allocation-id eipalloc-new --instance-id i-new"
  assert_contains "$(cat "$KEY_FILE")" "BEGIN OPENSSH PRIVATE KEY"
  assert_contains "$out" "Elastic IP: 198.51.100.20"
}

test_starts_a_stopped_instance() {
  setup
  : > "$KEY_FILE"
  respond aws <<'EOF'
--dry-run|254|DryRunOperation
describe-images|0|ami-123
describe-security-groups|0|sg-123
describe-security-group-rules|0|1
describe-instances --filters|0|i-123
State.Name|0|stopped
describe-addresses --filters|0|eipalloc-1	eipassoc-1
describe-addresses --allocation-ids|0|198.51.100.10
EOF
  bash "$AWS_DIR/aws-provision.sh" >/dev/null 2>&1
  assert_contains "$(cat "$SANDBOX/calls.log")" "start-instances --instance-ids i-123"
}

test_refuses_placeholder_config() {
  setup
  export SSH_SOURCE_CIDR=REPLACE-ME
  assert_fails bash "$AWS_DIR/aws-provision.sh"
  assert_not_contains "$(cat "$SANDBOX/calls.log")" "create-"
}

test_crlf_none_is_normalised() {
  setup
  respond aws <<'EOF'
--dry-run|254|An error occurred (DryRunOperation) when calling the RunInstances operation
sts get-caller-identity|0|arn:aws:iam::111111111111:user/svc-appserver-deploy
describe-images|0|ami-123
describe-key-pairs|254|An error occurred (InvalidKeyPair.NotFound)
create-key-pair|0|-----BEGIN OPENSSH PRIVATE KEY-----
describe-security-groups|0|None\r
create-security-group|0|sg-new
describe-security-group-rules|0|0\r
describe-instances --filters|0|None\r
run-instances --image-id|0|i-new
describe-addresses --filters|0|None\r
allocate-address|0|eipalloc-new
describe-addresses --allocation-ids|0|198.51.100.20
EOF
  bash "$AWS_DIR/aws-provision.sh" >/dev/null 2>&1
  calls=$(cat "$SANDBOX/calls.log")
  assert_contains "$calls" "create-security-group --group-name aaqua-host-sg"
  assert_eq "$(grep -c authorize-security-group-ingress "$SANDBOX/calls.log")" "3"
  assert_contains "$calls" "run-instances --image-id"
  assert_contains "$calls" "associate-address --allocation-id eipalloc-new --instance-id i-new"
}

test_refuses_to_overwrite_local_key_when_aws_pair_missing() {
  setup
  : > "$KEY_FILE"
  respond aws <<'EOF'
--dry-run|254|An error occurred (DryRunOperation) when calling the RunInstances operation
sts get-caller-identity|0|arn:aws:iam::111111111111:user/svc-appserver-deploy
describe-images|0|ami-123
describe-key-pairs|254|An error occurred (InvalidKeyPair.NotFound)
EOF
  out=$(bash "$AWS_DIR/aws-provision.sh" 2>&1) && fail "expected non-zero exit"
  assert_contains "$out" "$KEY_FILE exists but key pair aaqua-host is missing in AWS"
  assert_not_contains "$(cat "$SANDBOX/calls.log")" "create-key-pair"
}

test_fails_fast_when_no_ami_found() {
  setup
  respond aws <<'EOF'
--dry-run|254|An error occurred (DryRunOperation) when calling the RunInstances operation
sts get-caller-identity|0|arn:aws:iam::111111111111:user/svc-appserver-deploy
describe-images|0|None
EOF
  out=$(bash "$AWS_DIR/aws-provision.sh" 2>&1) && fail "expected non-zero exit"
  assert_contains "$out" "no Ubuntu 24.04 AMI found"
  assert_not_contains "$(cat "$SANDBOX/calls.log")" "create-"
}

test_stops_before_creating_anything_when_launch_not_permitted() {
  setup
  respond aws <<'EOF'
--dry-run|254|An error occurred (UnauthorizedOperation)
describe-images|0|ami-123
EOF
  out=$(bash "$AWS_DIR/aws-provision.sh" 2>&1) && fail "expected non-zero exit"
  assert_contains "$out" "launch permission check failed"
  assert_not_contains "$(cat "$SANDBOX/calls.log")" "create-"
}

run_tests
