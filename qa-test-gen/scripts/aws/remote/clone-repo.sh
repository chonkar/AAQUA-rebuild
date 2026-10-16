#!/usr/bin/env bash
# Runs ON the EC2 host as root (shipped by aws-bootstrap.sh).
# stdin: line 1 = GitLab deploy-token username, line 2 = token.
# The token reaches git through GIT_CONFIG_* environment variables, so it is
# never in argv (visible in `ps`) and never written to /opt/aaqua/.git/config.
set -euo pipefail
: "${REPO_URL:?REPO_URL required}"
: "${REPO_BRANCH:=main}"
TARGET=/opt/aaqua

IFS= read -r TOKEN_USER
IFS= read -r TOKEN

if [ -d "$TARGET/.git" ]; then
  echo "==> $TARGET already cloned — skipping clone"
else
  echo "==> Cloning $REPO_URL ($REPO_BRANCH) to $TARGET"
  AUTH=$(printf '%s:%s' "$TOKEN_USER" "$TOKEN" | base64 -w0)
  GIT_CONFIG_COUNT=1 \
  GIT_CONFIG_KEY_0=http.extraHeader \
  GIT_CONFIG_VALUE_0="Authorization: Basic $AUTH" \
    git clone --branch "$REPO_BRANCH" "$REPO_URL" "$TARGET"
fi
unset TOKEN AUTH

echo "==> Seeding /opt/shared-infra from template (existing files kept)"
mkdir -p /opt/shared-infra
cp -an "$TARGET/qa-test-gen/scripts/shared-infra-template/." /opt/shared-infra/
