#!/usr/bin/env bash
# AAQUA — AWS provisioning (run from your workstation).
# Creates whatever is missing and reuses whatever exists: key pair, security
# group + rules, EC2 instance, Elastic IP. Safe to re-run.
#
# Usage:
#   cp scripts/aws/aws.env.example scripts/aws/aws.env   # fill in
#   scripts/aws/aws-provision.sh
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$HERE/lib.sh"

preflight() {
  command -v aws >/dev/null || die "aws CLI not found — install AWS CLI v2"
  if [[ "$SSH_SOURCE_CIDR" == REPLACE-ME* ]]; then die "set SSH_SOURCE_CIDR in scripts/aws/aws.env"; fi
  if [[ "$PUBLIC_HOSTNAME" == REPLACE-ME* ]]; then die "set PUBLIC_HOSTNAME in scripts/aws/aws.env"; fi
  log "Profile $AWS_PROFILE, region $AWS_REGION"
  log "Caller: $(aws sts get-caller-identity --query Arn --output text)"
  AMI_ID=$(aws ssm get-parameter --name "$UBUNTU_AMI_PARAM" --query Parameter.Value --output text)
  log "Ubuntu 24.04 AMI: $AMI_ID"
  local out
  out=$(aws ec2 run-instances --dry-run --image-id "$AMI_ID" --instance-type "$INSTANCE_TYPE" 2>&1) || true
  if [[ "$out" != *DryRunOperation* ]]; then
    die "launch permission check failed for $INSTANCE_TYPE (set INSTANCE_TYPE in aws.env if your plan rejects it): $out"
  fi
}

ensure_key_pair() {
  if aws ec2 describe-key-pairs --key-names "$KEY_NAME" >/dev/null 2>&1; then
    log "Key pair $KEY_NAME exists"
    if [ ! -f "$KEY_FILE" ]; then log "WARN: $KEY_FILE not found locally — you need the original .pem to SSH in"; fi
  else
    log "Creating key pair $KEY_NAME -> $KEY_FILE"
    mkdir -p "$(dirname "$KEY_FILE")"
    ( umask 077
      aws ec2 create-key-pair --key-name "$KEY_NAME" --key-type ed25519 \
        --query KeyMaterial --output text > "$KEY_FILE" )
  fi
}

ensure_ingress() {
  local port="$1" cidr="$2" count
  count=$(aws ec2 describe-security-group-rules \
    --filters "Name=group-id,Values=$SG_ID" \
    --query "length(SecurityGroupRules[?IsEgress==\`false\` && FromPort==\`$port\` && CidrIpv4=='$cidr'])" \
    --output text)
  if [ "$count" = "0" ]; then
    log "  allow tcp/$port from $cidr"
    aws ec2 authorize-security-group-ingress --group-id "$SG_ID" \
      --protocol tcp --port "$port" --cidr "$cidr" >/dev/null
  fi
}

ensure_security_group() {
  SG_ID=$(none_to_empty "$(aws ec2 describe-security-groups \
    --filters "Name=group-name,Values=$SG_NAME" \
    --query 'SecurityGroups[0].GroupId' --output text)")
  if [ -z "$SG_ID" ]; then
    log "Creating security group $SG_NAME"
    SG_ID=$(aws ec2 create-security-group --group-name "$SG_NAME" \
      --description "AAQUA host: 80/443 public, 22 from office" \
      --query GroupId --output text)
  else
    log "Security group $SG_NAME exists ($SG_ID)"
  fi
  ensure_ingress 80 0.0.0.0/0
  ensure_ingress 443 0.0.0.0/0
  ensure_ingress 22 "$SSH_SOURCE_CIDR"
}

ensure_instance() {
  INSTANCE_ID=$(find_instance_id)
  if [ -z "$INSTANCE_ID" ]; then
    log "Launching $INSTANCE_NAME ($INSTANCE_TYPE)"
    INSTANCE_ID=$(aws ec2 run-instances \
      --image-id "$AMI_ID" --instance-type "$INSTANCE_TYPE" \
      --key-name "$KEY_NAME" --security-group-ids "$SG_ID" \
      --block-device-mappings "DeviceName=/dev/sda1,Ebs={VolumeSize=$DISK_GB,VolumeType=gp3,DeleteOnTermination=true}" \
      --metadata-options "HttpTokens=required,HttpEndpoint=enabled" \
      --user-data "file://$(native_path "$HERE/aws-ec2-userdata.sh")" \
      --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$INSTANCE_NAME},{Key=aaqua:repo-url,Value=$AAQUA_REPO_URL},{Key=aaqua:repo-branch,Value=$AAQUA_REPO_BRANCH},{Key=aaqua:public-hostname,Value=$PUBLIC_HOSTNAME}]" \
      --query 'Instances[0].InstanceId' --output text)
  else
    local state
    state=$(instance_state "$INSTANCE_ID")
    log "Instance $INSTANCE_NAME exists ($INSTANCE_ID, $state)"
    if [ "$state" = "stopping" ]; then
      aws ec2 wait instance-stopped --instance-ids "$INSTANCE_ID"
      state=stopped
    fi
    if [ "$state" = "stopped" ]; then
      log "Starting $INSTANCE_ID"
      aws ec2 start-instances --instance-ids "$INSTANCE_ID" >/dev/null
    fi
  fi
  log "Waiting for $INSTANCE_ID to be running and pass status checks (a few minutes on first launch)"
  aws ec2 wait instance-running --instance-ids "$INSTANCE_ID"
  aws ec2 wait instance-status-ok --instance-ids "$INSTANCE_ID"
}

ensure_elastic_ip() {
  local out alloc assoc
  out=$(aws ec2 describe-addresses --filters "Name=tag:Name,Values=$EIP_NAME" \
    --query 'Addresses[0].[AllocationId,AssociationId]' --output text)
  read -r alloc assoc <<<"$out"
  alloc=$(none_to_empty "${alloc:-None}")
  assoc=$(none_to_empty "${assoc:-None}")
  if [ -z "$alloc" ]; then
    log "Allocating Elastic IP $EIP_NAME"
    alloc=$(aws ec2 allocate-address --domain vpc \
      --tag-specifications "ResourceType=elastic-ip,Tags=[{Key=Name,Value=$EIP_NAME}]" \
      --query AllocationId --output text)
  fi
  if [ -z "$assoc" ]; then
    log "Associating $alloc with $INSTANCE_ID"
    aws ec2 associate-address --allocation-id "$alloc" --instance-id "$INSTANCE_ID" >/dev/null
  else
    log "Elastic IP $EIP_NAME already associated"
  fi
  PUBLIC_IP=$(aws ec2 describe-addresses --allocation-ids "$alloc" \
    --query 'Addresses[0].PublicIp' --output text)
}

print_summary() {
  cat <<EOF

============================================================================
  AWS infrastructure ready ($AWS_REGION)
============================================================================
  Instance:    $INSTANCE_ID ($INSTANCE_TYPE)
  Elastic IP: $PUBLIC_IP
  SSH:         ssh -i $KEY_FILE ubuntu@$PUBLIC_IP

  Next:
    1. DNS A record  $PUBLIC_HOSTNAME -> $PUBLIC_IP
    2. Ask git.lab.aaseya.com / llm.lab.aaseya.com owners to allowlist $PUBLIC_IP
    3. scripts/aws/aws-bootstrap.sh   (needs GitLab deploy + runner tokens)
  Full runbook: qa-test-gen/CLAUDE.md § "AWS EC2 deployment"
============================================================================
EOF
}

main() {
  preflight
  ensure_key_pair
  ensure_security_group
  ensure_instance
  ensure_elastic_ip
  print_summary
}

main "$@"
