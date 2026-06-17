#!/usr/bin/env bash
# AAQUA — install + register the GitLab Runner that auto-deploys on push to main.
#
# Runs ONCE as root on the GCP VM. Idempotent — safe to re-run; every step
# checks current state first.
#
# Responsibilities (no secrets in this file, no PAT-on-disk):
#   - Install the gitlab-runner package from GitLab's apt repo
#   - Add the gitlab-runner system user to the docker group (so it can use
#     /var/run/docker.sock without sudo)
#   - chown the two paths the runner writes to during a deploy:
#       /opt/aaqua                              (git fetch + reset --hard target)
#       /opt/shared-infra/nginx/sites/aaqua/   (publish-spa.sh extract target)
#   - Register the runner with the project (tag aaqua-deploy, shell executor)
#   - Pin concurrent = 1 (serial deploys; no race on the SPA target dir)
#   - Enable + start the gitlab-runner systemd service
#
# Usage:
#   sudo bash install-gitlab-runner.sh <REGISTRATION_TOKEN>
#   sudo REGISTRATION_TOKEN=glrt-... bash install-gitlab-runner.sh
#
# Generate the registration token in GitLab:
#   Project → Settings → CI/CD → Runners → "New project runner" → copy token
#
# Environment overrides (optional):
#   GITLAB_URL          default: https://git.lab.aaseya.com
#   RUNNER_TAG          default: aaqua-deploy
#   RUNNER_DESCRIPTION  default: aaqua-host shell deploy
#
# See qa-test-gen/CLAUDE.md gotcha #24 for the design rationale.

set -euo pipefail
exec > >(tee -a /var/log/aaqua-runner-install.log) 2>&1

echo "==> AAQUA GitLab Runner install: $(date -u)"

# ─── 0. Preflight ────────────────────────────────────────────────────────────
if [ "$(id -u)" -ne 0 ]; then
  echo "FATAL: must run as root (try: sudo bash $0 ...)" >&2
  exit 1
fi

REGISTRATION_TOKEN="${1:-${REGISTRATION_TOKEN:-}}"
if [ -z "$REGISTRATION_TOKEN" ]; then
  echo "FATAL: REGISTRATION_TOKEN required as first arg or env var" >&2
  echo "Generate one at: <GITLAB_URL>/camunda/aaqua/-/settings/ci_cd → Runners" >&2
  exit 1
fi

GITLAB_URL="${GITLAB_URL:-https://git.lab.aaseya.com}"
RUNNER_TAG="${RUNNER_TAG:-aaqua-deploy}"
RUNNER_DESCRIPTION="${RUNNER_DESCRIPTION:-aaqua-host shell deploy}"

echo "    GitLab URL:  $GITLAB_URL"
echo "    Runner tag:  $RUNNER_TAG"
echo "    Description: $RUNNER_DESCRIPTION"

# ─── 1. Install the gitlab-runner package ────────────────────────────────────
if ! command -v gitlab-runner >/dev/null 2>&1; then
  echo "==> Installing gitlab-runner from GitLab apt repo"
  export DEBIAN_FRONTEND=noninteractive
  curl -fsSL https://packages.gitlab.com/install/repositories/runner/gitlab-runner/script.deb.sh \
    | bash
  apt-get install -y gitlab-runner
else
  echo "==> gitlab-runner already installed: $(gitlab-runner --version | head -1)"
fi

# ─── 2. docker group membership for gitlab-runner user ───────────────────────
# The installer creates the gitlab-runner user; verify and add to docker group.
if ! id gitlab-runner >/dev/null 2>&1; then
  echo "FATAL: gitlab-runner user not present after install — package layout changed?" >&2
  exit 1
fi
if id -nG gitlab-runner | tr ' ' '\n' | grep -qx docker; then
  echo "==> gitlab-runner already in docker group"
else
  echo "==> Adding gitlab-runner to docker group"
  usermod -aG docker gitlab-runner
fi

# ─── 3. chown the paths the runner writes to ─────────────────────────────────
# Per qa-test-gen/CLAUDE.md gotcha #24: runner needs write access to the repo
# clone and the SPA publish target. The rest of /opt/shared-infra/ stays
# root-owned (privileged ops go through docker containers).
echo "==> Chowning deploy paths to gitlab-runner"
if [ -d /opt/aaqua ]; then
  chown -R gitlab-runner:gitlab-runner /opt/aaqua
else
  echo "WARN: /opt/aaqua does not exist — gcp-vm-startup.sh has not run, or repo path differs" >&2
fi

# /opt/shared-infra/nginx/sites/aaqua/ is created by gcp-vm-startup.sh's
# cp -an of scripts/shared-infra-template/. — verify before chowning.
SPA_TARGET=/opt/shared-infra/nginx/sites/aaqua
if [ -d "$SPA_TARGET" ]; then
  chown -R gitlab-runner:gitlab-runner "$SPA_TARGET"
else
  echo "==> Creating $SPA_TARGET (gcp-vm-startup.sh seed missed it)"
  mkdir -p "$SPA_TARGET"
  chown -R gitlab-runner:gitlab-runner "$SPA_TARGET"
fi

# ─── 4. Register the runner ──────────────────────────────────────────────────
# Idempotency: query the runner's own list rather than grep'ing config.toml
# (the file can contain partial/commented entries that a regex would either
# false-positive or miss). `gitlab-runner list` writes to stderr — capture both.
if gitlab-runner list 2>&1 | grep -qF "$RUNNER_DESCRIPTION"; then
  echo "==> Runner '$RUNNER_DESCRIPTION' already registered — skipping"
  echo "    (To re-register: sudo gitlab-runner unregister --name \"$RUNNER_DESCRIPTION\")"
else
  echo "==> Registering runner with GitLab"
  # Pick the right CLI flag based on the token's PREFIX, not on the runner
  # binary's --help output. Why prefix-detection: on GitLab Runner 19.0.1
  # `register --help` advertises BOTH --token and --registration-token, so
  # an unconditional `grep --token` match would always succeed — but if the
  # user pasted a new-style `glrt-...` auth token via the legacy flag, GitLab
  # silently downgrades to "legacy-compatible mode" and IGNORES --tag-list,
  # --locked, --run-untagged, --access-level. Symptom: runner registers,
  # appears online, but stays idle because tags fall back to whatever was
  # set in the UI form (often empty).
  #
  # Token formats:
  #   - glrt-...           — GitLab 16+ authentication token (from UI form) → --token
  #   - anything else      — legacy registration token (GitLab <16)          → --registration-token
  case "$REGISTRATION_TOKEN" in
    glrt-*) AUTH_FLAG=--token ;;
    *)      AUTH_FLAG=--registration-token ;;
  esac
  echo "    Auth flag: $AUTH_FLAG (detected from token prefix)"
  gitlab-runner register \
    --non-interactive \
    --url "$GITLAB_URL" \
    "$AUTH_FLAG" "$REGISTRATION_TOKEN" \
    --executor shell \
    --description "$RUNNER_DESCRIPTION" \
    --tag-list "$RUNNER_TAG" \
    --run-untagged=false \
    --locked=true \
    --access-level=not_protected
fi

# ─── 5. Pin concurrent = 1 ───────────────────────────────────────────────────
# Default is 1 already, but we make it explicit so a future operator who bumps
# it for unrelated reasons sees why we cared. Serial deploys eliminate the race
# on the SPA target dir (publish-spa.sh does rm -rf then docker cp — two
# concurrent jobs would corrupt each other).
if grep -qE '^concurrent\s*=' /etc/gitlab-runner/config.toml; then
  sed -i 's/^concurrent\s*=.*/concurrent = 1/' /etc/gitlab-runner/config.toml
else
  sed -i '1i concurrent = 1' /etc/gitlab-runner/config.toml
fi

# ─── 6. Enable + start the systemd service ───────────────────────────────────
echo "==> Enabling + starting gitlab-runner service"
systemctl enable gitlab-runner
systemctl restart gitlab-runner

# ─── 7. Print verification commands ──────────────────────────────────────────
cat <<EOF

============================================================================
  GitLab Runner install complete — $(date -u)
============================================================================

  GitLab URL:   $GITLAB_URL
  Runner tag:   $RUNNER_TAG
  Description:  $RUNNER_DESCRIPTION
  Config file:  /etc/gitlab-runner/config.toml
  Install log:  /var/log/aaqua-runner-install.log

  Verify (run these next, all should succeed):

    gitlab-runner --version
    sudo systemctl is-active gitlab-runner
    sudo gitlab-runner verify
    groups gitlab-runner | grep -q docker && echo "OK docker group"
    ls -ld /opt/aaqua /opt/shared-infra/nginx/sites/aaqua/
    sudo -u gitlab-runner docker ps
    sudo grep -E 'concurrent|executor|tags|url' /etc/gitlab-runner/config.toml

  Then open the GitLab project:
    $GITLAB_URL/camunda/aaqua/-/settings/ci_cd
  → Runners section → confirm the green online dot next to '$RUNNER_DESCRIPTION'.

  Smoke test: push any commit to main and watch the pipeline at:
    $GITLAB_URL/camunda/aaqua/-/pipelines
============================================================================
EOF
