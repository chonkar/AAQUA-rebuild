#!/usr/bin/env bash
# Runs ON the EC2 host as root (shipped by aws-bootstrap.sh).
# stdin: line 1 = GitLab runner authentication token (glrt-...).
set -euo pipefail
IFS= read -r REGISTRATION_TOKEN
export REGISTRATION_TOKEN
export RUNNER_TAG=aaqua-deploy-aws
export RUNNER_DESCRIPTION="aaqua-aws shell deploy"
bash /opt/aaqua/qa-test-gen/scripts/install-gitlab-runner.sh
