#!/usr/bin/env bash
# AAQUA — GCP VM startup script
# Runs ONCE as root on first boot via Compute Engine metadata `startup-script`.
# Idempotent — safe to re-run via `gcloud compute instances reset`.
#
# Responsibilities (no secrets, no human interaction):
#   - Install Docker Engine + Compose v2 + git
#   - Clone the AAQUA repo to /opt/aaqua
#   - Create /opt/shared-infra/secrets/aaqua/ with correct perms (empty — populated by onboard-aaqua.sh later)
#   - Copy scripts/shared-infra-template/* into /opt/shared-infra/
#
# Anything that requires a secret or human decision stays out of this file
# and lives in scripts/shared-infra-template/scripts/onboard-aaqua.sh instead.

set -euo pipefail
exec > >(tee -a /var/log/aaqua-startup.log) 2>&1
echo "==> AAQUA VM startup: $(date -u)"

META="http://metadata.google.internal/computeMetadata/v1/instance/attributes"
fetch_meta() {
  curl -fsSL -H 'Metadata-Flavor: Google' "$META/$1" || echo ""
}

REPO_URL=$(fetch_meta aaqua-repo-url)
REPO_BRANCH=$(fetch_meta aaqua-repo-branch)
PUBLIC_HOSTNAME=$(fetch_meta aaqua-public-hostname)
PUBLIC_PORT=$(fetch_meta aaqua-public-port)

: "${REPO_URL:?startup metadata aaqua-repo-url is missing}"
: "${REPO_BRANCH:=main}"
: "${PUBLIC_HOSTNAME:=aaqua.aaseya.com}"
: "${PUBLIC_PORT:=8443}"

echo "    repo:     $REPO_URL ($REPO_BRANCH)"
echo "    hostname: $PUBLIC_HOSTNAME:$PUBLIC_PORT"

echo "==> apt-get update + base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl gnupg git ufw

if ! command -v docker >/dev/null 2>&1; then
  echo "==> Installing Docker Engine + Compose v2 (official repo)"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
    https://download.docker.com/linux/ubuntu $VERSION_CODENAME stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
else
  echo "==> Docker already installed: $(docker --version)"
fi

# Reduce friction when an operator SSHes in later
if id -nG ubuntu 2>/dev/null | grep -qvw docker; then
  usermod -aG docker ubuntu || true
fi

echo "==> Cloning AAQUA repo to /opt/aaqua"
if [ ! -d /opt/aaqua/.git ]; then
  git clone --branch "$REPO_BRANCH" "$REPO_URL" /opt/aaqua
else
  ( cd /opt/aaqua && git fetch --all --prune && git checkout "$REPO_BRANCH" && git pull --ff-only )
fi

echo "==> Seeding /opt/shared-infra from template"
mkdir -p /opt/shared-infra
# Copy the shared-infra-template directory tree to /opt/shared-infra (preserve perms).
# Use rsync-style cp -a; -n avoids overwriting any in-place edits made by the operator.
cp -an /opt/aaqua/qa-test-gen/scripts/shared-infra-template/. /opt/shared-infra/

echo "==> Preparing secrets directory (empty — populated by onboard-aaqua.sh)"
mkdir -p /opt/shared-infra/secrets/aaqua
chmod 700 /opt/shared-infra/secrets /opt/shared-infra/secrets/aaqua

# Pre-create the external docker network the tenant compose joins.
# `docker compose up` in /opt/shared-infra would also create it, but doing it
# here means the tenant compose can come up first without erroring on
# `network shared-infra_default declared as external, but could not be found`.
if ! docker network inspect shared-infra_default >/dev/null 2>&1; then
  echo "==> Creating external docker network shared-infra_default"
  docker network create shared-infra_default
fi

# Optional: install + register the GitLab Runner if a registration token was
# supplied in the VM metadata (aaqua-gitlab-runner-token). Without the token
# this step is silently skipped — VM provisioning still completes, and the
# runner can be installed later by SSHing in and running install-gitlab-runner.sh
# manually. See qa-test-gen/CLAUDE.md gotcha #24.
RUNNER_TOKEN=$(fetch_meta aaqua-gitlab-runner-token)
if [ -n "$RUNNER_TOKEN" ]; then
  echo "==> Installing GitLab Runner (token from VM metadata)"
  # Tolerate a runner-install failure — VM up without a CI runner is recoverable
  # (operator can SSH in and re-run install-gitlab-runner.sh manually), but a
  # VM that didn't finish booting is not. `set -e` would otherwise abort here.
  REGISTRATION_TOKEN="$RUNNER_TOKEN" \
    bash /opt/aaqua/qa-test-gen/scripts/install-gitlab-runner.sh \
    || echo "WARN: GitLab Runner install failed — finish manually via install-gitlab-runner.sh after first boot"
else
  echo "==> Skipping GitLab Runner install (no aaqua-gitlab-runner-token metadata)"
fi

cat <<EOF

============================================================================
  VM startup complete — $(date -u)
============================================================================

  AAQUA repo:        /opt/aaqua  (branch: $REPO_BRANCH)
  Shared-infra dir:  /opt/shared-infra
  Secrets dir:       /opt/shared-infra/secrets/aaqua  (currently empty)
  Public URL:        https://${PUBLIC_HOSTNAME}:${PUBLIC_PORT}/aaqua/

  Next: operator SSH and run scripts/shared-infra-template/scripts/onboard-aaqua.sh
  (the docker compose up commands are in the gcp-provision.sh "Next steps" block).
============================================================================
EOF
