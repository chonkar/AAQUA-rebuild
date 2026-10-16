#!/usr/bin/env bash
# AAQUA — EC2 first-boot user-data (runs once as root via cloud-init).
# Holds NO secrets: user-data is readable by anyone with ec2:DescribeInstanceAttribute.
# The repo clone and GitLab runner registration happen later in aws-bootstrap.sh,
# which pipes tokens over SSH. Log: /var/log/aaqua-userdata.log
set -euo pipefail
exec > >(tee -a /var/log/aaqua-userdata.log) 2>&1
echo "==> AAQUA EC2 user-data: $(date -u)"

export DEBIAN_FRONTEND=noninteractive
# Another apt/dpkg holder (e.g. unattended-upgrades) can be holding the lock
# on first boot — wait it out instead of failing immediately, and -y answers
# any prompts so a re-run of this script is non-interactive too.
APT="apt-get -o DPkg::Lock::Timeout=600 -y"

apt_update_with_retry() {
  local attempt
  for attempt in 1 2 3; do
    if $APT update; then return 0; fi
    echo "==> apt-get update failed (attempt $attempt/3)"
    [ "$attempt" -eq 3 ] && return 1
    sleep 15
  done
}

apt_update_with_retry
$APT install ca-certificates curl gnupg git certbot gettext-base

if ! command -v docker >/dev/null 2>&1; then
  echo "==> Installing Docker Engine + Compose v2 (official repo)"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    | gpg --dearmor --yes -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $VERSION_CODENAME stable" \
    > /etc/apt/sources.list.d/docker.list
  $APT update
  $APT install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
fi

usermod -aG docker ubuntu || true

echo "==> Directory layout"
mkdir -p /opt/aaqua \
         /opt/shared-infra/secrets/aaqua \
         /opt/shared-infra/secrets/tls \
         /opt/shared-infra/nginx/acme \
         /var/lib/aaqua
chmod 700 /opt/shared-infra/secrets /opt/shared-infra/secrets/aaqua

# The shared-infra compose declares this network `external: true`.
if ! docker network inspect shared-infra_default >/dev/null 2>&1; then
  docker network create shared-infra_default
fi

echo "==> AAQUA user-data complete: $(date -u)"
touch /var/lib/aaqua/userdata.done
