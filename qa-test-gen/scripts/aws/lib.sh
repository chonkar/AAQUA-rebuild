# shellcheck shell=bash
# Shared defaults + helpers for the AAQUA AWS workstation scripts.
# Operator-specific values live in scripts/aws/aws.env (gitignored; copy from
# aws.env.example). Values in aws.env win over the shell environment.

AWS_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AAQUA_AWS_ENV="${AAQUA_AWS_ENV:-$AWS_LIB_DIR/aws.env}"
if [ -f "$AAQUA_AWS_ENV" ]; then
  # Strip CRs so an aws.env saved by a Windows editor still parses.
  # shellcheck disable=SC1090
  . <(tr -d '\r' < "$AAQUA_AWS_ENV")
fi

: "${AWS_PROFILE:=aaqua-deploy}"
: "${AWS_REGION:=ap-southeast-2}"
export AWS_PROFILE AWS_REGION

: "${INSTANCE_NAME:=aaqua-host}"
: "${INSTANCE_TYPE:=m7i-flex.large}"
: "${DISK_GB:=30}"
: "${SG_NAME:=aaqua-host-sg}"
: "${KEY_NAME:=aaqua-host}"
: "${KEY_FILE:=$HOME/.ssh/aaqua-host.pem}"
: "${EIP_NAME:=aaqua-host-eip}"
: "${SSH_SOURCE_CIDR:=REPLACE-ME}"
: "${PUBLIC_HOSTNAME:=REPLACE-ME}"
: "${AAQUA_REPO_URL:=https://git.lab.aaseya.com/camunda/aaqua.git}"
: "${AAQUA_REPO_BRANCH:=main}"
: "${UBUNTU_AMI_PARAM:=/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id}"

# Git Bash rewrites native-exe arguments that look like absolute POSIX paths
# (e.g. the SSM parameter name above, DeviceName=/dev/sda1) into Windows paths
# unless path conversion is disabled.
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'

log() { printf '==> %s\n' "$*"; }
die() { printf 'FATAL: %s\n' "$*" >&2; exit 1; }

# aws.exe on Windows emits CRLF line endings; $(...) strips a trailing \r but
# a redirect (create-key-pair > $KEY_FILE) or pipe keeps it. Callers run
# `set -euo pipefail`, so aws's exit status still propagates through tr.
aws() { command aws "$@" | tr -d '\r'; }

# aws --output text prints "None" for a null result; normalise that to "".
none_to_empty() { if [ "$1" = "None" ]; then printf ''; else printf '%s' "$1"; fi; }

find_instance_id() {
  none_to_empty "$(aws ec2 describe-instances \
    --filters "Name=tag:Name,Values=$INSTANCE_NAME" \
              "Name=instance-state-name,Values=pending,running,stopping,stopped" \
    --query 'Reservations[].Instances[].InstanceId | [0]' --output text)"
}

instance_state() {
  aws ec2 describe-instances --instance-ids "$1" \
    --query 'Reservations[0].Instances[0].State.Name' --output text
}

instance_public_ip() {
  none_to_empty "$(aws ec2 describe-instances --instance-ids "$1" \
    --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)"
}

# The Windows build of the AWS CLI can't read MSYS paths like /c/Office/...
native_path() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi
}

SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=10)

remote() {
  local host="$1"; shift
  ssh -i "$KEY_FILE" "${SSH_OPTS[@]}" "ubuntu@$host" "$@"
}

remote_copy() {
  local host="$1"; shift
  local dest="${*: -1}"
  local srcs=("${@:1:$#-1}")
  scp -i "$KEY_FILE" "${SSH_OPTS[@]}" "${srcs[@]}" "ubuntu@$host:$dest"
}
