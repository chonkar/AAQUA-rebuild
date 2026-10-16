#!/usr/bin/env bash
# AAQUA — bootstrap the EC2 host over SSH (run from your workstation after
# aws-provision.sh). Clones the repo with a GitLab deploy token and, if given a
# runner token, registers the GitLab runner. Tokens are piped over SSH stdin
# only — never in argv, user-data, tags or .git/config. Safe to re-run.
#
# Usage:
#   GITLAB_DEPLOY_TOKEN_USER=gitlab+deploy-token-N GITLAB_DEPLOY_TOKEN=gldt-... \
#   GITLAB_RUNNER_TOKEN=glrt-... scripts/aws/aws-bootstrap.sh
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$HERE/lib.sh"

: "${GITLAB_DEPLOY_TOKEN_USER:?set GITLAB_DEPLOY_TOKEN_USER (GitLab → Settings → Repository → Deploy tokens)}"
: "${GITLAB_DEPLOY_TOKEN:?set GITLAB_DEPLOY_TOKEN}"

INSTANCE_ID=$(find_instance_id)
[ -n "$INSTANCE_ID" ] || die "no instance tagged Name=$INSTANCE_NAME — run aws-provision.sh first"
HOST=$(instance_public_ip "$INSTANCE_ID")
[ -n "$HOST" ] || die "$INSTANCE_ID has no public IP yet — re-run aws-provision.sh"

: "${SSH_WAIT_TRIES:=30}"
: "${SSH_WAIT_SECONDS:=10}"

log "Waiting for SSH on $HOST"
ssh_ok=""
for _ in $(seq 1 "$SSH_WAIT_TRIES"); do
  if remote "$HOST" true </dev/null; then ssh_ok=1; break; fi
  sleep "$SSH_WAIT_SECONDS"
done
[ -n "$ssh_ok" ] || die "SSH to $HOST failed after the wait — check KEY_FILE ($KEY_FILE), SSH_SOURCE_CIDR in the security group, and ~/.ssh/known_hosts (a reused Elastic IP changes the host key)"

log "Waiting for first-boot user-data to finish"
remote "$HOST" 'cloud-init status --wait >/dev/null || true; test -f /var/lib/aaqua/userdata.done' </dev/null \
  || die "user-data did not finish — inspect /var/log/aaqua-userdata.log on the host"

log "Shipping helper scripts"
remote_copy "$HOST" "$HERE/remote/clone-repo.sh" "$HERE/remote/install-runner.sh" /tmp/

log "Cloning repo and seeding /opt/shared-infra"
printf '%s\n%s\n' "$GITLAB_DEPLOY_TOKEN_USER" "$GITLAB_DEPLOY_TOKEN" \
  | remote "$HOST" "sudo REPO_URL='$AAQUA_REPO_URL' REPO_BRANCH='$AAQUA_REPO_BRANCH' bash /tmp/clone-repo.sh"

if [ -n "${GITLAB_RUNNER_TOKEN:-}" ]; then
  log "Registering GitLab runner (tag aaqua-deploy-aws)"
  printf '%s\n' "$GITLAB_RUNNER_TOKEN" | remote "$HOST" "sudo bash /tmp/install-runner.sh"
else
  log "GITLAB_RUNNER_TOKEN not set — skipping runner registration"
fi

cat <<EOF

Bootstrap complete on $HOST.
Next (on the host — see qa-test-gen/CLAUDE.md § "AWS EC2 deployment"):
  ssh -t -i $KEY_FILE ubuntu@$HOST
  # populate /opt/shared-infra/.env, run onboard-aaqua.sh, issue-cert.sh, compose up
EOF
