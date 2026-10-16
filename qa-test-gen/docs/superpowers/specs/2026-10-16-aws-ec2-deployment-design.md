# AWS EC2 Deployment — Design

**Date:** 2026-10-16
**Status:** Draft — awaiting review
**Supersedes:** nothing. Runs alongside the GCP deployment (`2026-05-08-shared-infra-deployment-design.md`) until GCP is retired.

## Goal

Deploy AAQUA to a single AWS EC2 instance using the same shared-infra Docker model as the GCP QA box, served on a real domain with a Let's Encrypt certificate, and kept up to date by GitLab push-to-deploy.

The deploy scripts create AWS infrastructure only when it is missing; when it already exists they skip creation and go straight to deploying.

## Decisions

| Topic | Decision |
|---|---|
| Hosting model | Existing shared-infra stack (Postgres 17, Keycloak 24, nginx 1.27 in Docker) + AAQUA `app` container on one EC2 instance. No RDS, ALB, ECS. |
| Access / TLS | Domain name → Elastic IP. Let's Encrypt certificate issued and renewed on the host by certbot. |
| Data | Fresh start. Empty databases; users recreated with `scripts/import-users.sh`. No migration from GCP. |
| CI/CD | GitLab Runner on the EC2 instance, shell executor, push to `main` deploys. |
| Backups | Out of scope for this iteration (explicitly deferred). |
| Remote access | SSH with an EC2 key pair. No instance IAM role required. |
| GCP | Keeps running. All changes to shared files are additive. |

## AWS resources

All in one region, default VPC. Default region `ap-southeast-2` (Sydney) — where the account's free tier currently lives; configurable via `AWS_REGION`.

| Resource | Spec | Identified by |
|---|---|---|
| EC2 instance | `m7i-flex.large` (2 vCPU / 8 GB), Ubuntu 24.04 LTS (Canonical AMI via SSM public parameter), 30 GB gp3 root volume | Tag `Name=aaqua-host` |
| Elastic IP | Associated with the instance | Tag `Name=aaqua-host-eip` |
| Security group | Inbound 80/tcp + 443/tcp from `0.0.0.0/0`; 22/tcp from `SSH_SOURCE_CIDR` only. Nothing else (Postgres tooling port 5443 is published by the shared-infra compose but blocked here). | Group name `aaqua-host-sg` |
| Key pair | Created if absent; private key written to `~/.ssh/aaqua-host.pem` (chmod 600) on the workstation | Key name `aaqua-host` |

**Instance size and free tier.** The full stack (Keycloak, Postgres, Node backend, Chromium for Playwright, Docker builds of the SPA) needs about 8 GB RAM; the classic free-tier sizes `t2.micro` / `t3.micro` (1 GB) cannot run it. `m7i-flex.large` is eligible under AWS's credit-based free plan. If the account rejects it, the preflight `run-instances --dry-run` fails before anything is created; override `INSTANCE_TYPE` (e.g. `t3.large`, paid). The 30 GB gp3 volume fits within the free-tier EBS allowance. The Elastic IP's public IPv4 address is billed hourly unless covered by the account's free-tier allowance.

Port 80 must stay open: it serves the ACME HTTP-01 challenge and the nginx `/healthz` used by the container healthcheck (CLAUDE.md gotcha #21).

## Credentials

- The IAM user `svc-appserver-deploy` is used from the operator's workstation only, via an AWS CLI named profile (`AWS_PROFILE=aaqua-deploy`). The access-key CSV must be removed from the repository working tree; `*accessKeys*.csv` is added to `.gitignore`.
- No AWS credentials are placed on the instance.
- The GitLab deploy token (read-only repository) and the GitLab runner authentication token are supplied as environment variables in the operator's shell and sent to the instance over SSH. They are **never** put in EC2 user-data or tags (both are readable by any principal with `ec2:Describe*`).
- The deploy token is used only for the initial clone and is never stored on the instance. Subsequent fetches in CI use `CI_JOB_TOKEN`.

## Components

All new files live under `qa-test-gen/scripts/aws/`.

**Shared configuration.** `lib.sh` holds the defaults and helpers every workstation script uses (instance lookup, SSH, path conversion for Git Bash on Windows). Operator-specific values (`SSH_SOURCE_CIDR`, `PUBLIC_HOSTNAME`, `LETSENCRYPT_EMAIL`, overrides such as `INSTANCE_TYPE`) go in `scripts/aws/aws.env`, copied from the committed `aws.env.example` and gitignored. Values in `aws.env` take precedence over the shell environment.

**Tests.** `scripts/aws/tests/run.sh` runs plain-bash tests that put recording test doubles for `aws`, `ssh`, `scp`, `curl`, `getent` and `openssl` first on `PATH`; no AWS account is touched.

### `aws-provision.sh` — workstation

Inputs (from `aws.env` / `lib.sh` defaults): `AWS_PROFILE`, `AWS_REGION`, `INSTANCE_TYPE`, `DISK_GB`, `SSH_SOURCE_CIDR`, `PUBLIC_HOSTNAME`, `AAQUA_REPO_URL`, `AAQUA_REPO_BRANCH`.

Steps, each one look-up-then-create:
1. Preflight: `aws` CLI present; `aws sts get-caller-identity` succeeds; `SSH_SOURCE_CIDR` and `PUBLIC_HOSTNAME` are not placeholders; `aws ec2 run-instances --dry-run` returns `DryRunOperation` (proves launch permission before anything is created).
2. Key pair `aaqua-host`.
3. Security group `aaqua-host-sg` and its ingress rules (rules added only if missing).
4. Instance: find by tag `Name=aaqua-host` in state `pending|running|stopping|stopped`. If found and stopped, start it. If absent, launch with `aws-ec2-userdata.sh` as user-data and tags `Name`, `aaqua:repo-url`, `aaqua:repo-branch`, `aaqua:public-hostname`. IMDSv2 required (`HttpTokens=required`).
5. Wait for `instance-running` and `instance-status-ok`.
6. Elastic IP: allocate if no address tagged `aaqua-host-eip` exists; associate with the instance if not already.
7. Print the Elastic IP and the runbook's next steps.

Re-running against existing infrastructure performs no creates and prints the same summary.

### `aws-ec2-userdata.sh` — instance, first boot, as root

Port of `gcp-vm-startup.sh`, minus everything that needs a secret.

- Log to `/var/log/aaqua-userdata.log`.
- Install `ca-certificates curl gnupg git certbot`, Docker Engine + Compose v2 from Docker's apt repo; add `ubuntu` to the `docker` group.
- Create `/opt/aaqua`, `/opt/shared-infra/secrets/aaqua` (mode 700), `/opt/shared-infra/secrets/tls`, `/opt/shared-infra/nginx/acme`.
- Pre-create docker network `shared-infra_default` (the shared-infra compose declares it `external: true`, see below).
- Install `gettext-base` (provides `envsubst`, needed by `render-realm.sh`).
- Write `/var/lib/aaqua/userdata.done` as its last action. `aws-bootstrap.sh` checks this marker instead of `cloud-init status`'s exit code, which is 2 ("degraded") on harmless warnings.
- Does **not** clone the repo or install the runner.

Instance tags are not needed by user-data in this design; they exist for operator visibility and for `aws-bootstrap.sh` to read via `aws ec2 describe-tags` from the workstation.

### `aws-bootstrap.sh` — workstation, over SSH

Inputs: `GITLAB_DEPLOY_TOKEN_USER`, `GITLAB_DEPLOY_TOKEN`, `GITLAB_RUNNER_TOKEN` (optional — runner step skipped if empty), plus the instance address (looked up from the `aaqua-host` tag).

1. Retry SSH as `ubuntu` with `~/.ssh/aaqua-host.pem` until it answers (up to ~5 min); run `cloud-init status --wait`, then require `/var/lib/aaqua/userdata.done`.
2. Copy two secret-free helpers to `/tmp` on the host: `remote/clone-repo.sh` and `remote/install-runner.sh`.
3. Pipe the deploy-token username and token into `clone-repo.sh` over SSH stdin. It clones `AAQUA_REPO_URL` to `/opt/aaqua` (skipped if `/opt/aaqua/.git` exists), authenticating with an `Authorization: Basic` header supplied through `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_0`/`GIT_CONFIG_VALUE_0` environment variables — the token is never in argv and never written into `.git/config`, so there is nothing to strip. It then runs `cp -an /opt/aaqua/qa-test-gen/scripts/shared-infra-template/. /opt/shared-infra/`.
4. If `GITLAB_RUNNER_TOKEN` is set: pipe it into `install-runner.sh`, which runs `install-gitlab-runner.sh` with `RUNNER_TAG=aaqua-deploy-aws` and `RUNNER_DESCRIPTION="aaqua-aws shell deploy"`.

Secrets are piped over the SSH channel's stdin, never passed as command-line arguments (visible in `ps` on the host) and never written to disk on the instance except where the runner itself stores its token in `/etc/gitlab-runner/config.toml`.

### `issue-cert.sh` — instance, as root

Inputs: `PUBLIC_HOSTNAME`, `LETSENCRYPT_EMAIL`, optional `--staging`.

1. Resolve `PUBLIC_HOSTNAME` (`getent hosts`) and compare with the instance's public IP (IMDSv2 `public-ipv4`). Abort with a clear message on mismatch — protects against Let's Encrypt failed-validation rate limits.
2. **First issue** (no certificate under `/etc/letsencrypt/live/$PUBLIC_HOSTNAME`): `certbot certonly --standalone`. Requires port 80 free, so it runs before `shared-nginx` is started. If `shared-nginx` is running, the script stops it first and restarts it afterwards.
3. **Renewal config**: rewrite the certbot renewal config for the domain to `authenticator = webroot`, `webroot_path = /opt/shared-infra/nginx/acme`, so `certbot renew` (systemd timer shipped with the Ubuntu package) works while nginx owns port 80.
4. Install deploy hook `/etc/letsencrypt/renewal-hooks/deploy/aaqua.sh`: copy `fullchain.pem` → `/opt/shared-infra/secrets/tls/aaqua.crt`, `privkey.pem` → `aaqua.key` (mode 600), then `docker exec shared-nginx nginx -s reload` (ignore failure if nginx is down).
5. Run the deploy hook once to place the initial files.

### `verify.sh` — workstation

Input: `PUBLIC_HOSTNAME`. Exits non-zero on the first failure.

1. `https://$PUBLIC_HOSTNAME/healthz` → 200.
2. Certificate issuer contains `Let's Encrypt` and the SAN matches `PUBLIC_HOSTNAME`.
3. `https://$PUBLIC_HOSTNAME/auth/realms/aaseya-platform/.well-known/openid-configuration` → `issuer` equals exactly `https://$PUBLIC_HOSTNAME/auth/realms/aaseya-platform`.
4. `https://$PUBLIC_HOSTNAME/aaqua/` → 200 and HTML containing the SPA root.
5. `https://$PUBLIC_HOSTNAME/aaqua/api/runtime-info` → 200 JSON.

## Changes to existing files

### `scripts/shared-infra-template/nginx/conf.d/10-shared-edge.conf`

In the port-80 server block, before `location /`:

```nginx
location ^~ /.well-known/acme-challenge/ {
    root /var/lib/acme;
    default_type text/plain;
}
```

### `scripts/shared-infra-template/docker-compose.yml`

- Add to `nginx.volumes`: `./nginx/acme:/var/lib/acme:ro`. Deliberately **not** under `/var/www`, which is already a read-only bind mount (`./nginx/sites`); a nested mount point inside a read-only mount can fail to be created. Add `nginx/acme/.gitkeep` to the template so the directory exists on GCP too (the location is harmless there).
- Change the `networks.default` block to `name: shared-infra_default` + `external: true`. User-data pre-creates the network, and a Compose-managed declaration refuses to adopt a network without Compose's labels (gotcha #15). On GCP the network already exists, so `external: true` is safe there.

CI copies only `nginx/` from the template on each deploy (not `docker-compose.yml`), so the GCP host keeps its current compose file until someone re-seeds it; nothing there depends on these two changes.

### `.gitlab-ci.yml` (repo root)

Extract the current `deploy` job body into a hidden `.deploy` template and define:

```yaml
deploy:gcp:
  extends: .deploy
  tags: [aaqua-deploy]
  environment: { name: gcp-qa }

deploy:aws:
  extends: .deploy
  tags: [aaqua-deploy-aws]
  environment: { name: aws-qa }
```

Both keep `rules: if $CI_COMMIT_BRANCH == "main"`. Retiring GCP later = delete `deploy:gcp`.

### `.gitignore` (repo root)

Add `*accessKeys*.csv`, `*.pem` and `qa-test-gen/scripts/aws/aws.env`.

### Documentation

- `qa-test-gen/CLAUDE.md`: new "AWS EC2 deployment" subsection under Production deployment, pointing at this spec and the runbook; note the per-environment runner tags and the GitLab variable scoping rule.
- `qa-test-gen/README.md`: quick-link row for AWS provisioning.

## Per-host configuration

| File (on instance) | Keys set for AWS |
|---|---|
| `/opt/shared-infra/.env` | `KC_HOSTNAME=<domain>`, `KC_PUBLIC_BASE_URL=https://<domain>`, Keycloak/DB passwords (generated with `openssl rand -base64 32`) |
| `/opt/aaqua/qa-test-gen/.env` | `VITE_KEYCLOAK_URL=https://<domain>/auth`, `KEYCLOAK_REALM_URL=https://<domain>/auth/realms/aaseya-platform` |

`KC_HOSTNAME_PORT` stays unset (standard 443). `KC_HOSTNAME_STRICT=true` stays as in the template; with a real certificate no `KEYCLOAK_JWKS_URL` split is needed (gotcha #10), though it remains supported.

**GitLab variable scoping (gotcha #25):** GitLab CI/CD variables are exported into the job environment and take precedence over `.env` in Docker Compose interpolation. Any project variable such as `KEYCLOAK_REALM_URL` or `VITE_KEYCLOAK_URL` must be scoped to environment `gcp-qa` (or deleted), otherwise `deploy:aws` would build against GCP's Keycloak.

## Runbook

1. Install AWS CLI v2. `aws configure --profile aaqua-deploy` with the key from the CSV. Delete the CSV.
2. `cp scripts/aws/aws.env.example scripts/aws/aws.env`, fill it in; run `scripts/aws/aws-provision.sh`. Note the Elastic IP.
3. Create DNS A record `<domain>` → Elastic IP. Ask the owners of `git.lab.aaseya.com` and `llm.lab.aaseya.com` to allowlist the Elastic IP (if they filter by source IP).
4. Scope host-specific GitLab CI/CD variables (`KEYCLOAK_REALM_URL`, `VITE_KEYCLOAK_URL`, …) to environment `gcp-qa` — do this before creating the runner/deploy token so nothing is briefly unscoped.
5. In GitLab: create a project deploy token (`read_repository`); create a project runner with tag `aaqua-deploy-aws` (fill the Tags field in the UI — gotcha #24).
6. `GITLAB_DEPLOY_TOKEN_USER=… GITLAB_DEPLOY_TOKEN=… GITLAB_RUNNER_TOKEN=… scripts/aws/aws-bootstrap.sh`.
7. SSH in. Populate `/opt/shared-infra/.env` from `.env.example` and generate `secrets/postgres_super_password.txt` (gotcha #16). Run `onboard-aaqua.sh` (over `ssh -t` — it prompts for the LLM key) with `AAQUA_REPO=/opt/aaqua/qa-test-gen` and `PUBLIC_BASE_URL=https://<domain>` (gotcha #14). Write `/opt/aaqua/qa-test-gen/.env` as `gitlab-runner` **before** onboarding — onboarding builds the SPA from it, and CI reads it. Onboarding publishes the SPA as root, so afterwards `sudo chown -R gitlab-runner:gitlab-runner /opt/shared-infra/nginx/sites/aaqua` (gotcha #27).
8. `sudo PUBLIC_HOSTNAME=<domain> LETSENCRYPT_EMAIL=<email> bash /opt/aaqua/qa-test-gen/scripts/aws/issue-cert.sh` (try `--staging` first if unsure).
9. Start in dependency order — nginx resolves `aaqua-app` at config load and exits if it is missing (gotcha #17):
   1. `cd /opt/shared-infra && sudo docker compose up -d postgres keycloak`
   2. `cd /opt/aaqua/qa-test-gen && sudo -u gitlab-runner bash scripts/publish-spa.sh && docker compose up -d --build app` (gotcha #27)
   3. `cd /opt/shared-infra && sudo docker compose up -d nginx`
   4. `sudo certbot renew --dry-run` to confirm the renewal path works before relying on it.
10. `import-users.sh` with the user CSV.
11. `scripts/aws/verify.sh`; log in through the browser.
12. Only once the host is fully up and verified: set GitLab CI/CD variable `AWS_DEPLOY_ENABLED=true` (until then `deploy:aws` has no matching `rules` entry and is not even created in the pipeline). Push or re-run the pipeline and confirm `deploy:aws` is green.

## Error handling

- All scripts: `#!/usr/bin/env bash`, `set -euo pipefail`, required inputs validated up front with `: "${VAR:?message}"`, LF line endings and `+x` in the git index (gotchas #6, #7).
- `aws-provision.sh` never deletes or modifies existing resources beyond starting a stopped instance, adding missing SG rules and associating an unassociated Elastic IP.
- Long-running remote steps in `aws-bootstrap.sh` run under `nohup` with logs on the host when they can exceed an SSH session's lifetime (gotcha #19); the script polls the log.
- `issue-cert.sh` refuses to call Let's Encrypt when DNS does not point at the instance.
- Recovery: if first-boot user-data fails partway, re-run it on the host with `sudo bash /var/lib/cloud/instance/scripts/part-001` (log at `/var/log/aaqua-userdata.log`).

## Testing

- `shellcheck` on all new and modified shell scripts.
- `docker compose config` on the modified shared-infra compose file (validates syntax and the new mount).
- `nginx -t` against the modified edge config in a throwaway `nginx:1.27-alpine` container.
- First real run with `issue-cert.sh --staging`, then the production issuance.
- `verify.sh` as the acceptance check, followed by a manual Keycloak login and a green `deploy:aws` pipeline.

## Out of scope

- Database backups (pg_dump to S3, EBS snapshots).
- Instance IAM role / SSM Session Manager.
- RDS, ALB, ACM, autoscaling, multi-AZ.
- Migrating data or users from GCP.
- Decommissioning GCP.
- Terraform/CloudFormation (the scripts follow the existing bash + CLI pattern).
