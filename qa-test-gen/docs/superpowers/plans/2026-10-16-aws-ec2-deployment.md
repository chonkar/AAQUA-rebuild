# AWS EC2 Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bash scripts that provision (create-if-missing) an AWS EC2 host in `ap-southeast-2`, bootstrap it without leaking secrets, issue a Let's Encrypt certificate, and deploy AAQUA via a dedicated GitLab runner — alongside the existing GCP deployment.

**Architecture:** Workstation scripts (`aws-provision.sh`, `aws-bootstrap.sh`, `verify.sh`) share `lib.sh` + a gitignored `aws.env`. Host-side scripts (`aws-ec2-userdata.sh`, `issue-cert.sh`, `remote/*.sh`) run as root on the instance. The existing shared-infra Docker stack is reused with two additive template changes; CI gets a second job with its own runner tag.

**Tech Stack:** Bash 5, AWS CLI v2, OpenSSH, certbot, Docker Compose v2, nginx 1.27, GitLab CI. Tests: plain bash with PATH-injected test doubles; Python 3 + PyYAML for YAML assertions; shellcheck via Docker.

**Spec:** `qa-test-gen/docs/superpowers/specs/2026-10-16-aws-ec2-deployment-design.md`

## Global Constraints

- Region default `ap-southeast-2`; instance type default `m7i-flex.large`; 30 GB gp3; Ubuntu 24.04 via SSM parameter `/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id`.
- Resource identifiers: instance tag `Name=aaqua-host`; Elastic IP tag `Name=aaqua-host-eip`; security group `aaqua-host-sg`; key pair `aaqua-host`, private key `~/.ssh/aaqua-host.pem`.
- AWS CLI profile default `aaqua-deploy`. No AWS credentials on the instance.
- Secrets (GitLab deploy token, runner token) travel only over SSH stdin. Never in user-data, tags, argv, or `.git/config`.
- Runner tag on AWS: `aaqua-deploy-aws`; GCP keeps `aaqua-deploy`. GitLab environments `gcp-qa` / `aws-qa`.
- Certificate files consumed by nginx: `/opt/shared-infra/secrets/tls/aaqua.crt` and `aaqua.key`. ACME webroot on host: `/opt/shared-infra/nginx/acme`, mounted in nginx at `/var/lib/acme`.
- Every shell script: `#!/usr/bin/env bash`, `set -euo pipefail`, LF endings (enforced by `qa-test-gen/.gitattributes`), executable bit in the git index (`git update-index --chmod=+x`).
- Changes to shared files must keep the GCP deployment working.
- Work on branch `feature/aws-ec2-deploy`. Never push to `main` from this plan (push to `main` deploys).

## File Map

| Path (relative to `aaqua/`) | Responsibility |
|---|---|
| `.gitignore` | Ignore access-key CSVs, `*.pem`, `aws.env` |
| `qa-test-gen/scripts/aws/lib.sh` | Defaults, `aws.env` loading, logging, instance lookup, SSH/SCP wrappers, path conversion |
| `qa-test-gen/scripts/aws/aws.env.example` | Template for operator-specific values |
| `qa-test-gen/scripts/aws/aws-provision.sh` | Create-if-missing: key pair, SG + rules, instance, Elastic IP |
| `qa-test-gen/scripts/aws/aws-ec2-userdata.sh` | First boot: packages, Docker, directories, network, done-marker |
| `qa-test-gen/scripts/aws/remote/clone-repo.sh` | On host: clone with token from stdin, seed `/opt/shared-infra` |
| `qa-test-gen/scripts/aws/remote/install-runner.sh` | On host: run `install-gitlab-runner.sh` with token from stdin |
| `qa-test-gen/scripts/aws/aws-bootstrap.sh` | Workstation: wait for host, ship helpers, pipe secrets |
| `qa-test-gen/scripts/aws/issue-cert.sh` | On host: DNS check, certbot standalone, webroot renewal, deploy hook |
| `qa-test-gen/scripts/aws/verify.sh` | Workstation: HTTPS / cert / issuer / SPA / API smoke checks |
| `qa-test-gen/scripts/aws/tests/harness.sh` | Assertions, sandbox, test-double installation, runner |
| `qa-test-gen/scripts/aws/tests/fakes/fake-cmd` | Generic recording test double |
| `qa-test-gen/scripts/aws/tests/fakes/openssl` | `openssl` test double |
| `qa-test-gen/scripts/aws/tests/run.sh` | Runs every `test_*.sh` |
| `qa-test-gen/scripts/aws/tests/test_*.sh` | One file per component |
| `qa-test-gen/scripts/shared-infra-template/nginx/conf.d/10-shared-edge.conf` | + ACME location on :80 |
| `qa-test-gen/scripts/shared-infra-template/docker-compose.yml` | + acme mount; network `external: true` |
| `qa-test-gen/scripts/shared-infra-template/nginx/acme/.gitkeep` | Ensure webroot dir exists |
| `.gitlab-ci.yml` | `.deploy` template + `deploy:gcp` / `deploy:aws` |
| `qa-test-gen/CLAUDE.md`, `qa-test-gen/README.md` | AWS deployment docs |

All commands below assume the working directory is `aaqua/` (the git repo root) in Git Bash, unless stated otherwise.

---

### Task 0: Branch and ignore secrets

**Files:**
- Modify: `.gitignore`

- [ ] **Step 1: Create the branch**

```bash
git checkout -b feature/aws-ec2-deploy
```

- [ ] **Step 2: Verify the CSV is currently NOT ignored (the failing check)**

Run: `git check-ignore -v docs/svc-appserver-deploy_accessKeys.csv || echo NOT-IGNORED`
Expected: `NOT-IGNORED`

- [ ] **Step 3: Append ignore rules to `.gitignore`**

```gitignore

# AWS deployment — never commit credentials or operator config
*accessKeys*.csv
*.pem
qa-test-gen/scripts/aws/aws.env
```

- [ ] **Step 4: Verify**

Run:
```bash
git check-ignore -v docs/svc-appserver-deploy_accessKeys.csv
git check-ignore -v qa-test-gen/scripts/aws/aws.env
git check-ignore -v foo.pem
```
Expected: each prints a `.gitignore:<line>:<pattern>` match.

- [ ] **Step 5: Commit**

```bash
git add .gitignore
git commit -m "chore: ignore AWS access-key CSVs, pem files and aws.env"
```

---

### Task 1: Test harness and test doubles

**Files:**
- Create: `qa-test-gen/scripts/aws/tests/harness.sh`
- Create: `qa-test-gen/scripts/aws/tests/fakes/fake-cmd`
- Create: `qa-test-gen/scripts/aws/tests/fakes/openssl`
- Create: `qa-test-gen/scripts/aws/tests/run.sh`
- Test: `qa-test-gen/scripts/aws/tests/test_harness.sh`

**Interfaces:**
- Produces (used by every later test file):
  - `AWS_DIR` — absolute path of `scripts/aws`
  - `SANDBOX` — per-test temp dir (exported); `$SANDBOX/calls.log` holds one line per fake invocation: `<name> <argv...>`
  - `install_fake NAME...` — installs the generic double under each NAME (or the dedicated `openssl` double)
  - `respond NAME` — reads response lines from stdin into `$SANDBOX/responses/NAME`. Line format: `<argv substring>|<exit code>|<stdout>` (stdout is passed through `printf %b`; first matching line wins; no match → prints `None`, exit 0)
  - `stdin_of NAME` — prints everything piped into fake NAME
  - `assert_contains HAY NEEDLE`, `assert_not_contains HAY NEEDLE`, `assert_eq ACTUAL EXPECTED`, `assert_fails CMD...`
  - `run_tests` — runs every `test_*` function in its own subshell with a fresh sandbox

- [ ] **Step 1: Write the failing self-test** — `qa-test-gen/scripts/aws/tests/test_harness.sh`

```bash
#!/usr/bin/env bash
. "$(dirname "$0")/harness.sh"

test_fake_records_calls_and_answers_from_responses() {
  install_fake aws
  respond aws <<'EOF'
describe-instances|0|i-123
--dry-run|254|DryRunOperation
EOF
  out=$(aws ec2 describe-instances --filters x)
  assert_eq "$out" "i-123"
  assert_fails aws ec2 run-instances --dry-run
  assert_contains "$(cat "$SANDBOX/calls.log")" "aws ec2 describe-instances --filters x"
}

test_fake_defaults_to_None() {
  install_fake aws
  assert_eq "$(aws anything)" "None"
}

test_fake_captures_stdin() {
  install_fake ssh
  printf 'secret\n' | ssh host cmd
  assert_contains "$(stdin_of ssh)" "secret"
  assert_not_contains "$(cat "$SANDBOX/calls.log")" "secret"
}

run_tests
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bash qa-test-gen/scripts/aws/tests/test_harness.sh < /dev/null`
Expected: FAIL — `harness.sh: No such file or directory`

- [ ] **Step 3: Write `qa-test-gen/scripts/aws/tests/harness.sh`**

```bash
# shellcheck shell=bash
# Minimal test harness for the AWS deploy scripts. Source it from a test_*.sh
# file, define test_* functions, then call run_tests. Each test runs in its own
# subshell with `set -e` and a fresh sandbox whose bin/ is first on PATH, so
# test doubles shadow the real aws/ssh/curl/etc.
set -uo pipefail

HARNESS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AWS_DIR="$(cd "$HARNESS_DIR/.." && pwd)"
export AWS_DIR

fail() { printf '    assertion failed: %s\n' "$*" >&2; return 1; }

assert_contains()     { [[ "$1" == *"$2"* ]] || fail "expected to contain [$2] in: $1"; }
assert_not_contains() { [[ "$1" != *"$2"* ]] || fail "expected NOT to contain [$2]"; }
assert_eq()           { [[ "$1" == "$2" ]]   || fail "expected [$2], got [$1]"; }
assert_fails()        { if "$@" >/dev/null 2>&1; then fail "expected failure: $*"; fi; }

new_sandbox() {
  SANDBOX="$(mktemp -d)"
  export SANDBOX
  mkdir -p "$SANDBOX/bin" "$SANDBOX/responses"
  : > "$SANDBOX/calls.log"
  export PATH="$SANDBOX/bin:$PATH"
  # Never read the operator's real aws.env during tests.
  export AAQUA_AWS_ENV=/dev/null
}

install_fake() {
  local name
  for name in "$@"; do
    if [ -f "$HARNESS_DIR/fakes/$name" ]; then
      cp "$HARNESS_DIR/fakes/$name" "$SANDBOX/bin/$name"
    else
      cp "$HARNESS_DIR/fakes/fake-cmd" "$SANDBOX/bin/$name"
    fi
    chmod +x "$SANDBOX/bin/$name"
  done
}

respond()  { cat > "$SANDBOX/responses/$1"; }
stdin_of() { cat "$SANDBOX/stdin.$1.log" 2>/dev/null || true; }

run_tests() {
  local t passes=0 fails=0
  for t in $(declare -F | awk '{print $3}' | grep '^test_'); do
    if ( set -e; new_sandbox; "$t" ); then
      printf 'ok    %s\n' "$t"; passes=$((passes + 1))
    else
      printf 'FAIL  %s\n' "$t"; fails=$((fails + 1))
    fi
  done
  printf '%d passed, %d failed\n' "$passes" "$fails"
  [ "$fails" -eq 0 ]
}
```

- [ ] **Step 4: Write `qa-test-gen/scripts/aws/tests/fakes/fake-cmd`**

```bash
#!/usr/bin/env bash
# Generic test double. Logs argv to $SANDBOX/calls.log, captures piped stdin to
# $SANDBOX/stdin.<name>.log, and answers from $SANDBOX/responses/<name>.
# Response lines: <argv substring>|<exit code>|<stdout (printf %b)>. First match wins.
name="$(basename "$0")"
printf '%s %s\n' "$name" "$*" >> "$SANDBOX/calls.log"
if [ ! -t 0 ]; then cat >> "$SANDBOX/stdin.$name.log"; fi
resp="$SANDBOX/responses/$name"
if [ -f "$resp" ]; then
  while IFS='|' read -r pat code out; do
    [ -n "$pat" ] || continue
    case "$*" in
      *"$pat"*) printf '%b\n' "$out"; exit "$code" ;;
    esac
  done < "$resp"
fi
echo "None"
```

- [ ] **Step 5: Write `qa-test-gen/scripts/aws/tests/fakes/openssl`**

```bash
#!/usr/bin/env bash
# openssl test double: `s_client` emits a dummy cert blob; `x509` prints $FAKE_OPENSSL_X509.
printf 'openssl %s\n' "$*" >> "$SANDBOX/calls.log"
cat > /dev/null
case "$*" in
  *s_client*) echo "-----BEGIN CERTIFICATE-----" ;;
  *x509*)     printf '%b\n' "${FAKE_OPENSSL_X509:-}" ;;
esac
```

- [ ] **Step 6: Write `qa-test-gen/scripts/aws/tests/run.sh`**

```bash
#!/usr/bin/env bash
# Runs every test_*.sh in this directory. stdin is /dev/null so test doubles
# that capture stdin never block on a terminal.
set -uo pipefail
cd "$(dirname "$0")"
status=0
for f in test_*.sh; do
  printf '\n== %s\n' "$f"
  bash "$f" < /dev/null || status=1
done
exit "$status"
```

- [ ] **Step 7: Run the self-test**

Run: `bash qa-test-gen/scripts/aws/tests/run.sh`
Expected: `3 passed, 0 failed`, exit 0.

- [ ] **Step 8: Commit**

```bash
git add qa-test-gen/scripts/aws/tests
git update-index --chmod=+x qa-test-gen/scripts/aws/tests/run.sh qa-test-gen/scripts/aws/tests/fakes/fake-cmd qa-test-gen/scripts/aws/tests/fakes/openssl
git commit -m "test(aws): add bash test harness with recording test doubles"
```

---

### Task 2: Shared library and config template

**Files:**
- Create: `qa-test-gen/scripts/aws/lib.sh`
- Create: `qa-test-gen/scripts/aws/aws.env.example`
- Test: `qa-test-gen/scripts/aws/tests/test_lib.sh`

**Interfaces:**
- Consumes: harness (Task 1).
- Produces (sourced by `aws-provision.sh`, `aws-bootstrap.sh`):
  - Variables: `AWS_PROFILE`, `AWS_REGION` (both exported), `INSTANCE_NAME`, `INSTANCE_TYPE`, `DISK_GB`, `SG_NAME`, `KEY_NAME`, `KEY_FILE`, `EIP_NAME`, `SSH_SOURCE_CIDR`, `PUBLIC_HOSTNAME`, `AAQUA_REPO_URL`, `AAQUA_REPO_BRANCH`, `UBUNTU_AMI_PARAM`, `AWS_LIB_DIR`
  - `log MSG`, `die MSG` (exit 1)
  - `find_instance_id` → prints instance id or empty string
  - `instance_state ID` → prints state name
  - `instance_public_ip ID` → prints IPv4 or empty string
  - `native_path PATH` → Windows-style path under Git Bash (`cygpath -m`), unchanged elsewhere
  - `remote HOST CMD...` → ssh as `ubuntu@HOST` with `KEY_FILE`
  - `remote_copy HOST SRC... DEST` → scp files to `ubuntu@HOST:DEST`

- [ ] **Step 1: Write the failing test** — `qa-test-gen/scripts/aws/tests/test_lib.sh`

```bash
#!/usr/bin/env bash
. "$(dirname "$0")/harness.sh"

test_defaults() {
  . "$AWS_DIR/lib.sh"
  assert_eq "$AWS_REGION" "ap-southeast-2"
  assert_eq "$INSTANCE_TYPE" "m7i-flex.large"
  assert_eq "$AWS_PROFILE" "aaqua-deploy"
}

test_aws_env_file_overrides_defaults() {
  printf 'INSTANCE_TYPE=t3.large\n' > "$SANDBOX/aws.env"
  AAQUA_AWS_ENV="$SANDBOX/aws.env" . "$AWS_DIR/lib.sh"
  assert_eq "$INSTANCE_TYPE" "t3.large"
}

test_find_instance_id_returns_empty_when_absent() {
  install_fake aws
  . "$AWS_DIR/lib.sh"
  assert_eq "$(find_instance_id)" ""
}

test_find_instance_id_filters_by_name_tag() {
  install_fake aws
  respond aws <<'EOF'
describe-instances --filters|0|i-abc
EOF
  . "$AWS_DIR/lib.sh"
  assert_eq "$(find_instance_id)" "i-abc"
  assert_contains "$(cat "$SANDBOX/calls.log")" "Name=tag:Name,Values=aaqua-host"
}

test_remote_uses_key_and_ubuntu_user() {
  install_fake ssh
  . "$AWS_DIR/lib.sh"
  remote 198.51.100.1 true
  assert_contains "$(cat "$SANDBOX/calls.log")" "-i $KEY_FILE"
  assert_contains "$(cat "$SANDBOX/calls.log")" "ubuntu@198.51.100.1 true"
}

run_tests
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bash qa-test-gen/scripts/aws/tests/test_lib.sh < /dev/null`
Expected: FAIL — `lib.sh: No such file or directory`

- [ ] **Step 3: Write `qa-test-gen/scripts/aws/lib.sh`**

```bash
# shellcheck shell=bash
# Shared defaults + helpers for the AAQUA AWS workstation scripts.
# Operator-specific values live in scripts/aws/aws.env (gitignored; copy from
# aws.env.example). Values in aws.env win over the shell environment.

AWS_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AAQUA_AWS_ENV="${AAQUA_AWS_ENV:-$AWS_LIB_DIR/aws.env}"
if [ -f "$AAQUA_AWS_ENV" ]; then
  # shellcheck disable=SC1090
  . "$AAQUA_AWS_ENV"
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

log() { printf '==> %s\n' "$*"; }
die() { printf 'FATAL: %s\n' "$*" >&2; exit 1; }

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
```

- [ ] **Step 4: Write `qa-test-gen/scripts/aws/aws.env.example`**

```bash
# Copy to scripts/aws/aws.env (gitignored) and fill in. Sourced by lib.sh;
# values here override the shell environment and lib.sh defaults.

# Your office/VPN egress IP in CIDR form — SSH is only allowed from here.
# Find it with: curl -s https://ifconfig.me
SSH_SOURCE_CIDR=REPLACE-ME

# Public hostname whose DNS A record you will point at the Elastic IP.
PUBLIC_HOSTNAME=REPLACE-ME

# Contact address Let's Encrypt uses for expiry notices.
LETSENCRYPT_EMAIL=REPLACE-ME

# Optional overrides (defaults shown)
# AWS_PROFILE=aaqua-deploy
# AWS_REGION=ap-southeast-2
# INSTANCE_TYPE=m7i-flex.large
# DISK_GB=30
# KEY_FILE=$HOME/.ssh/aaqua-host.pem
```

- [ ] **Step 5: Run tests**

Run: `bash qa-test-gen/scripts/aws/tests/run.sh`
Expected: all tests pass (`test_harness.sh` 3, `test_lib.sh` 5).

- [ ] **Step 6: Commit**

```bash
git add qa-test-gen/scripts/aws/lib.sh qa-test-gen/scripts/aws/aws.env.example qa-test-gen/scripts/aws/tests/test_lib.sh
git commit -m "feat(aws): shared lib and aws.env template for deploy scripts"
```

---

### Task 3: `aws-provision.sh`

**Files:**
- Create: `qa-test-gen/scripts/aws/aws-provision.sh`
- Test: `qa-test-gen/scripts/aws/tests/test_provision.sh`

**Interfaces:**
- Consumes: everything `lib.sh` produces; `aws-ec2-userdata.sh` path (file created in Task 4 — the test only checks the path appears in argv, so order doesn't matter).
- Produces: on success prints `Elastic IP: <ip>` and the runbook pointer. Exit non-zero on any failed check.

- [ ] **Step 1: Write the failing tests** — `qa-test-gen/scripts/aws/tests/test_provision.sh`

```bash
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
ssm get-parameter|0|ami-123
describe-key-pairs|0|aaqua-host
describe-security-groups|0|sg-123
describe-security-group-rules|0|1
describe-instances --filters|0|i-123
State.Name|0|running
describe-addresses --filters|0|eipalloc-1\teipassoc-1
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
ssm get-parameter|0|ami-123
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
ssm get-parameter|0|ami-123
describe-security-groups|0|sg-123
describe-security-group-rules|0|1
describe-instances --filters|0|i-123
State.Name|0|stopped
describe-addresses --filters|0|eipalloc-1\teipassoc-1
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

test_stops_before_creating_anything_when_launch_not_permitted() {
  setup
  respond aws <<'EOF'
--dry-run|254|An error occurred (UnauthorizedOperation)
ssm get-parameter|0|ami-123
EOF
  out=$(bash "$AWS_DIR/aws-provision.sh" 2>&1) && fail "expected non-zero exit"
  assert_contains "$out" "launch permission check failed"
  assert_not_contains "$(cat "$SANDBOX/calls.log")" "create-"
}

run_tests
```

- [ ] **Step 2: Run to verify they fail**

Run: `bash qa-test-gen/scripts/aws/tests/test_provision.sh < /dev/null`
Expected: 5 × FAIL (`aws-provision.sh: No such file or directory`).

- [ ] **Step 3: Write `qa-test-gen/scripts/aws/aws-provision.sh`**

```bash
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
```

Note: `Elastic IP: ` has one space after the colon (tests match `Elastic IP: 198...`).

- [ ] **Step 4: Run tests**

Run: `bash qa-test-gen/scripts/aws/tests/run.sh`
Expected: all pass, including 5 in `test_provision.sh`.

- [ ] **Step 5: Commit**

```bash
git add qa-test-gen/scripts/aws/aws-provision.sh qa-test-gen/scripts/aws/tests/test_provision.sh
git update-index --chmod=+x qa-test-gen/scripts/aws/aws-provision.sh
git commit -m "feat(aws): idempotent EC2 provisioning script"
```

---

### Task 4: `aws-ec2-userdata.sh`

**Files:**
- Create: `qa-test-gen/scripts/aws/aws-ec2-userdata.sh`
- Test: `qa-test-gen/scripts/aws/tests/test_userdata.sh`

**Interfaces:**
- Produces on the host: Docker + Compose v2, `certbot`, `gettext-base`, git; dirs `/opt/aaqua`, `/opt/shared-infra/secrets/{aaqua,tls}`, `/opt/shared-infra/nginx/acme`; docker network `shared-infra_default`; marker `/var/lib/aaqua/userdata.done` (checked by Task 5).

- [ ] **Step 1: Write the failing test** — `qa-test-gen/scripts/aws/tests/test_userdata.sh`

```bash
#!/usr/bin/env bash
. "$(dirname "$0")/harness.sh"

UD="$AWS_DIR/aws-ec2-userdata.sh"

test_userdata_parses() {
  bash -n "$UD"
}

test_userdata_contains_no_secrets_or_clone() {
  body=$(cat "$UD")
  assert_not_contains "$body" "TOKEN"
  assert_not_contains "$body" "git clone"
}

test_userdata_writes_done_marker_last() {
  assert_eq "$(grep -v '^\s*$' "$UD" | grep -v '^\s*#' | tail -1)" "touch /var/lib/aaqua/userdata.done"
}

test_userdata_creates_required_dirs_and_network() {
  body=$(cat "$UD")
  assert_contains "$body" "/opt/shared-infra/nginx/acme"
  assert_contains "$body" "/opt/shared-infra/secrets/tls"
  assert_contains "$body" "docker network create shared-infra_default"
  assert_contains "$body" "gettext-base"
  assert_contains "$body" "certbot"
}

run_tests
```

- [ ] **Step 2: Run to verify it fails**

Run: `bash qa-test-gen/scripts/aws/tests/test_userdata.sh < /dev/null`
Expected: 4 × FAIL.

- [ ] **Step 3: Write `qa-test-gen/scripts/aws/aws-ec2-userdata.sh`**

```bash
#!/usr/bin/env bash
# AAQUA — EC2 first-boot user-data (runs once as root via cloud-init).
# Holds NO secrets: user-data is readable by anyone with ec2:DescribeInstanceAttribute.
# The repo clone and GitLab runner registration happen later in aws-bootstrap.sh,
# which pipes tokens over SSH. Log: /var/log/aaqua-userdata.log
set -euo pipefail
exec > >(tee -a /var/log/aaqua-userdata.log) 2>&1
echo "==> AAQUA EC2 user-data: $(date -u)"

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl gnupg git certbot gettext-base

if ! command -v docker >/dev/null 2>&1; then
  echo "==> Installing Docker Engine + Compose v2 (official repo)"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $VERSION_CODENAME stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
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
```

- [ ] **Step 4: Run tests**

Run: `bash qa-test-gen/scripts/aws/tests/run.sh`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add qa-test-gen/scripts/aws/aws-ec2-userdata.sh qa-test-gen/scripts/aws/tests/test_userdata.sh
git update-index --chmod=+x qa-test-gen/scripts/aws/aws-ec2-userdata.sh
git commit -m "feat(aws): secret-free EC2 first-boot user-data"
```

---

### Task 5: Remote helpers and `aws-bootstrap.sh`

**Files:**
- Create: `qa-test-gen/scripts/aws/remote/clone-repo.sh`
- Create: `qa-test-gen/scripts/aws/remote/install-runner.sh`
- Create: `qa-test-gen/scripts/aws/aws-bootstrap.sh`
- Test: `qa-test-gen/scripts/aws/tests/test_bootstrap.sh`

**Interfaces:**
- Consumes: `lib.sh` (`find_instance_id`, `instance_public_ip`, `remote`, `remote_copy`, `die`, `log`); marker from Task 4; existing `qa-test-gen/scripts/install-gitlab-runner.sh` (reads `REGISTRATION_TOKEN`, `RUNNER_TAG`, `RUNNER_DESCRIPTION` env, must run as root).
- Produces: `/opt/aaqua` clone and seeded `/opt/shared-infra` on the host; registered runner tagged `aaqua-deploy-aws`.
- Inputs: `GITLAB_DEPLOY_TOKEN_USER`, `GITLAB_DEPLOY_TOKEN` (required), `GITLAB_RUNNER_TOKEN` (optional).
- `clone-repo.sh` stdin contract: line 1 = deploy-token username, line 2 = token. Env: `REPO_URL`, `REPO_BRANCH`.
- `install-runner.sh` stdin contract: line 1 = runner token.

- [ ] **Step 1: Write the failing tests** — `qa-test-gen/scripts/aws/tests/test_bootstrap.sh`

```bash
#!/usr/bin/env bash
. "$(dirname "$0")/harness.sh"

setup() {
  install_fake aws ssh scp
  respond aws <<'EOF'
describe-instances --filters|0|i-123
PublicIpAddress|0|198.51.100.10
EOF
  export GITLAB_DEPLOY_TOKEN_USER=gitlab+deploy-token-7 GITLAB_DEPLOY_TOKEN=gldt-SECRETDEPLOY
}

test_secrets_only_travel_over_stdin() {
  setup
  export GITLAB_RUNNER_TOKEN=glrt-SECRETRUNNER
  bash "$AWS_DIR/aws-bootstrap.sh" >/dev/null 2>&1
  calls=$(cat "$SANDBOX/calls.log")
  assert_not_contains "$calls" "gldt-SECRETDEPLOY"
  assert_not_contains "$calls" "glrt-SECRETRUNNER"
  assert_contains "$(stdin_of ssh)" "gldt-SECRETDEPLOY"
  assert_contains "$(stdin_of ssh)" "glrt-SECRETRUNNER"
}

test_ships_helpers_and_runs_them() {
  setup
  export GITLAB_RUNNER_TOKEN=glrt-x
  bash "$AWS_DIR/aws-bootstrap.sh" >/dev/null 2>&1
  calls=$(cat "$SANDBOX/calls.log")
  assert_contains "$calls" "clone-repo.sh"
  assert_contains "$calls" "install-runner.sh"
  assert_contains "$calls" "ubuntu@198.51.100.10:/tmp/"
  assert_contains "$calls" "test -f /var/lib/aaqua/userdata.done"
}

test_skips_runner_without_token() {
  setup
  unset GITLAB_RUNNER_TOKEN
  bash "$AWS_DIR/aws-bootstrap.sh" >/dev/null 2>&1
  assert_not_contains "$(grep '^ssh' "$SANDBOX/calls.log")" "install-runner.sh"
}

test_requires_deploy_token() {
  setup
  unset GITLAB_DEPLOY_TOKEN
  assert_fails bash "$AWS_DIR/aws-bootstrap.sh"
}

test_fails_when_no_instance() {
  install_fake aws ssh scp
  export GITLAB_DEPLOY_TOKEN_USER=u GITLAB_DEPLOY_TOKEN=t
  out=$(bash "$AWS_DIR/aws-bootstrap.sh" 2>&1) && fail "expected non-zero exit"
  assert_contains "$out" "run aws-provision.sh first"
}

test_clone_helper_keeps_token_out_of_argv() {
  body=$(cat "$AWS_DIR/remote/clone-repo.sh")
  assert_contains "$body" "GIT_CONFIG_VALUE_0"
  assert_not_contains "$body" '@${REPO_URL'
  bash -n "$AWS_DIR/remote/clone-repo.sh"
  bash -n "$AWS_DIR/remote/install-runner.sh"
}

run_tests
```

- [ ] **Step 2: Run to verify they fail**

Run: `bash qa-test-gen/scripts/aws/tests/test_bootstrap.sh < /dev/null`
Expected: 6 × FAIL.

- [ ] **Step 3: Write `qa-test-gen/scripts/aws/remote/clone-repo.sh`**

```bash
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
```

- [ ] **Step 4: Write `qa-test-gen/scripts/aws/remote/install-runner.sh`**

```bash
#!/usr/bin/env bash
# Runs ON the EC2 host as root (shipped by aws-bootstrap.sh).
# stdin: line 1 = GitLab runner authentication token (glrt-...).
set -euo pipefail
IFS= read -r REGISTRATION_TOKEN
export REGISTRATION_TOKEN
export RUNNER_TAG=aaqua-deploy-aws
export RUNNER_DESCRIPTION="aaqua-aws shell deploy"
bash /opt/aaqua/qa-test-gen/scripts/install-gitlab-runner.sh
```

- [ ] **Step 5: Write `qa-test-gen/scripts/aws/aws-bootstrap.sh`**

```bash
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

log "Waiting for SSH on $HOST"
for _ in $(seq 1 30); do
  if remote "$HOST" true </dev/null; then break; fi
  sleep 10
done

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
```

- [ ] **Step 6: Run tests**

Run: `bash qa-test-gen/scripts/aws/tests/run.sh`
Expected: all pass, including 6 in `test_bootstrap.sh`.

- [ ] **Step 7: Commit**

```bash
git add qa-test-gen/scripts/aws/aws-bootstrap.sh qa-test-gen/scripts/aws/remote qa-test-gen/scripts/aws/tests/test_bootstrap.sh
git update-index --chmod=+x qa-test-gen/scripts/aws/aws-bootstrap.sh qa-test-gen/scripts/aws/remote/clone-repo.sh qa-test-gen/scripts/aws/remote/install-runner.sh
git commit -m "feat(aws): bootstrap host over SSH with stdin-only secrets"
```

---

### Task 6: `issue-cert.sh`

**Files:**
- Create: `qa-test-gen/scripts/aws/issue-cert.sh`
- Test: `qa-test-gen/scripts/aws/tests/test_issue_cert.sh`

**Interfaces:**
- Runs on the host as root; standalone (does not source `lib.sh`).
- Source-able for tests: `main` only runs when executed directly.
- Functions: `check_dns` (uses `PUBLIC_HOSTNAME`; returns non-zero on mismatch), `configure_webroot_renewal CONF_PATH`, `write_deploy_hook` (prints hook path).
- Env: `PUBLIC_HOSTNAME`, `LETSENCRYPT_EMAIL` (required); `SHARED_INFRA_DIR` (default `/opt/shared-infra`), `LE_DIR` (default `/etc/letsencrypt`), `IMDS` (default `http://169.254.169.254`).
- Produces: `$SHARED_INFRA_DIR/secrets/tls/aaqua.{crt,key}`; deploy hook `$LE_DIR/renewal-hooks/deploy/aaqua.sh`.

- [ ] **Step 1: Write the failing tests** — `qa-test-gen/scripts/aws/tests/test_issue_cert.sh`

```bash
#!/usr/bin/env bash
. "$(dirname "$0")/harness.sh"

load() {
  install_fake curl getent
  export PUBLIC_HOSTNAME=aaqua.example.com LETSENCRYPT_EMAIL=ops@example.com
  export SHARED_INFRA_DIR="$SANDBOX/shared" LE_DIR="$SANDBOX/le"
  . "$AWS_DIR/issue-cert.sh"
}

test_dns_mismatch_is_rejected() {
  load
  respond curl <<'EOF'
api/token|0|tok
public-ipv4|0|198.51.100.10
EOF
  respond getent <<'EOF'
ahostsv4|0|203.0.113.99    STREAM aaqua.example.com
EOF
  out=$(check_dns 2>&1) && fail "expected non-zero"
  assert_contains "$out" "resolves to '203.0.113.99'"
  assert_contains "$out" "198.51.100.10"
}

test_dns_match_passes() {
  load
  respond curl <<'EOF'
api/token|0|tok
public-ipv4|0|198.51.100.10
EOF
  respond getent <<'EOF'
ahostsv4|0|198.51.100.10   STREAM aaqua.example.com
EOF
  check_dns >/dev/null
}

test_renewal_config_switches_to_webroot() {
  load
  conf="$SANDBOX/aaqua.example.com.conf"
  cat > "$conf" <<'EOF'
version = 2.9.0
archive_dir = /etc/letsencrypt/archive/aaqua.example.com

# Options used in the renewal process
[renewalparams]
account = abc
authenticator = standalone
server = https://acme-v02.api.letsencrypt.org/directory
EOF
  configure_webroot_renewal "$conf"
  configure_webroot_renewal "$conf"   # idempotent
  body=$(cat "$conf")
  assert_contains "$body" "authenticator = webroot"
  assert_not_contains "$body" "authenticator = standalone"
  assert_eq "$(grep -c '^webroot_path = ' "$conf")" "1"
  assert_contains "$body" "webroot_path = $SANDBOX/shared/nginx/acme,"
  assert_eq "$(grep -c '^\[\[webroot_map\]\]' "$conf")" "1"
  assert_contains "$body" "aaqua.example.com = $SANDBOX/shared/nginx/acme"
}

test_deploy_hook_copies_cert_and_reloads_nginx() {
  load
  hook=$(write_deploy_hook)
  body=$(cat "$hook")
  assert_contains "$body" "$LE_DIR/live/aaqua.example.com/fullchain.pem"
  assert_contains "$body" "$SHARED_INFRA_DIR/secrets/tls/aaqua.crt"
  assert_contains "$body" "$SHARED_INFRA_DIR/secrets/tls/aaqua.key"
  assert_contains "$body" "docker exec shared-nginx nginx -s reload"
  bash -n "$hook"
}

run_tests
```

- [ ] **Step 2: Run to verify they fail**

Run: `bash qa-test-gen/scripts/aws/tests/test_issue_cert.sh < /dev/null`
Expected: 4 × FAIL.

- [ ] **Step 3: Write `qa-test-gen/scripts/aws/issue-cert.sh`**

```bash
#!/usr/bin/env bash
# AAQUA — Let's Encrypt certificate for shared-nginx. Runs ON the EC2 host as root.
#
# First run: certbot --standalone (port 80 must be free, so shared-nginx is
# stopped briefly if it is up). Afterwards renewals use the webroot that
# shared-nginx serves at /.well-known/acme-challenge/, and a deploy hook copies
# the renewed cert to secrets/tls/ and reloads nginx.
#
# Usage:
#   sudo PUBLIC_HOSTNAME=aaqua.example.com LETSENCRYPT_EMAIL=ops@example.com \
#        bash issue-cert.sh [--staging]
set -euo pipefail

SHARED="${SHARED_INFRA_DIR:-/opt/shared-infra}"
LE_DIR="${LE_DIR:-/etc/letsencrypt}"
IMDS="${IMDS:-http://169.254.169.254}"
WEBROOT="$SHARED/nginx/acme"

die() { printf 'FATAL: %s\n' "$*" >&2; exit 1; }

public_ip() {
  local token
  token=$(curl -fsS -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' "$IMDS/latest/api/token")
  curl -fsS -H "X-aws-ec2-metadata-token: $token" "$IMDS/latest/meta-data/public-ipv4"
}

resolved_ip() { getent ahostsv4 "$1" | awk 'NR==1 {print $1}'; }

check_dns() {
  local want got
  want=$(public_ip)
  got=$(resolved_ip "$PUBLIC_HOSTNAME" || true)
  if [ "$got" != "$want" ]; then
    printf "FATAL: %s resolves to '%s', but this instance's public IP is %s.\n" \
      "$PUBLIC_HOSTNAME" "${got:-nothing}" "$want" >&2
    printf 'Fix the DNS A record and wait for propagation before requesting a certificate.\n' >&2
    return 1
  fi
  echo "==> DNS ok: $PUBLIC_HOSTNAME -> $got"
}

configure_webroot_renewal() {
  local conf="$1"
  [ -f "$conf" ] || die "renewal config $conf not found"
  # Drop any previous webroot settings so re-runs stay idempotent.
  sed -i -e '/^webroot_path = /d' -e '/^\[\[webroot_map\]\]/,$d' "$conf"
  sed -i -e 's/^authenticator = .*/authenticator = webroot/' "$conf"
  sed -i -e "/^authenticator = webroot/a webroot_path = $WEBROOT," "$conf"
  printf '[[webroot_map]]\n%s = %s\n' "$PUBLIC_HOSTNAME" "$WEBROOT" >> "$conf"
}

write_deploy_hook() {
  local hook="$LE_DIR/renewal-hooks/deploy/aaqua.sh"
  mkdir -p "$(dirname "$hook")"
  cat > "$hook" <<EOF
#!/usr/bin/env bash
# Installed by issue-cert.sh: copy the (re)issued cert to where shared-nginx reads it.
set -euo pipefail
mkdir -p "$SHARED/secrets/tls"
install -m 644 "$LE_DIR/live/$PUBLIC_HOSTNAME/fullchain.pem" "$SHARED/secrets/tls/aaqua.crt"
install -m 600 "$LE_DIR/live/$PUBLIC_HOSTNAME/privkey.pem"   "$SHARED/secrets/tls/aaqua.key"
docker exec shared-nginx nginx -s reload 2>/dev/null || true
EOF
  chmod 755 "$hook"
  printf '%s\n' "$hook"
}

is_staging_cert() {
  openssl x509 -in "$LE_DIR/live/$PUBLIC_HOSTNAME/fullchain.pem" -noout -issuer 2>/dev/null | grep -q STAGING
}

main() {
  local staging=()
  if [ "${1:-}" = "--staging" ]; then staging=(--staging); fi
  : "${PUBLIC_HOSTNAME:?set PUBLIC_HOSTNAME}"
  : "${LETSENCRYPT_EMAIL:?set LETSENCRYPT_EMAIL}"
  [ "$(id -u)" -eq 0 ] || die "run as root (sudo)"

  check_dns
  mkdir -p "$WEBROOT" "$SHARED/secrets/tls"

  # A staging cert is not trusted by browsers; replace it on a non-staging run.
  if [ ${#staging[@]} -eq 0 ] && [ -d "$LE_DIR/live/$PUBLIC_HOSTNAME" ] && is_staging_cert; then
    echo "==> Replacing staging certificate with a production one"
    certbot delete --non-interactive --cert-name "$PUBLIC_HOSTNAME"
  fi

  if [ ! -d "$LE_DIR/live/$PUBLIC_HOSTNAME" ]; then
    local nginx_was_up=""
    if docker ps --format '{{.Names}}' | grep -qx shared-nginx; then
      nginx_was_up=1
      echo "==> Stopping shared-nginx to free port 80 for the first issuance"
      docker stop shared-nginx >/dev/null
    fi
    certbot certonly --standalone --non-interactive --agree-tos \
      -m "$LETSENCRYPT_EMAIL" -d "$PUBLIC_HOSTNAME" "${staging[@]}" \
      || { [ -n "$nginx_was_up" ] && docker start shared-nginx >/dev/null; die "certbot failed"; }
    if [ -n "$nginx_was_up" ]; then docker start shared-nginx >/dev/null; fi
  else
    echo "==> Certificate for $PUBLIC_HOSTNAME already present"
  fi

  configure_webroot_renewal "$LE_DIR/renewal/$PUBLIC_HOSTNAME.conf"
  bash "$(write_deploy_hook)"
  echo "==> Certificate installed at $SHARED/secrets/tls/aaqua.{crt,key}; renewals via webroot $WEBROOT"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
```

- [ ] **Step 4: Run tests**

Run: `bash qa-test-gen/scripts/aws/tests/run.sh`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add qa-test-gen/scripts/aws/issue-cert.sh qa-test-gen/scripts/aws/tests/test_issue_cert.sh
git update-index --chmod=+x qa-test-gen/scripts/aws/issue-cert.sh
git commit -m "feat(aws): Let's Encrypt issuance with webroot renewal and nginx reload hook"
```

---

### Task 7: Shared-infra template changes

**Files:**
- Modify: `qa-test-gen/scripts/shared-infra-template/nginx/conf.d/10-shared-edge.conf` (port-80 server block)
- Modify: `qa-test-gen/scripts/shared-infra-template/docker-compose.yml` (`nginx.volumes`, `networks`)
- Create: `qa-test-gen/scripts/shared-infra-template/nginx/acme/.gitkeep`
- Test: `qa-test-gen/scripts/aws/tests/test_template.sh`

**Interfaces:**
- Produces: nginx serves `http://<host>/.well-known/acme-challenge/<token>` from `/var/lib/acme` (= host `/opt/shared-infra/nginx/acme`, the `WEBROOT` in Task 6).

- [ ] **Step 1: Write the failing test** — `qa-test-gen/scripts/aws/tests/test_template.sh`

```bash
#!/usr/bin/env bash
. "$(dirname "$0")/harness.sh"

TPL="$AWS_DIR/../shared-infra-template"

test_compose_mounts_acme_outside_var_www_and_uses_external_network() {
  python - "$TPL/docker-compose.yml" <<'EOF'
import sys, yaml
c = yaml.safe_load(open(sys.argv[1]))
vols = c["services"]["nginx"]["volumes"]
assert "./nginx/acme:/var/lib/acme:ro" in vols, vols
targets = [v.split(":")[1] for v in vols]
assert not any(t.startswith("/var/www/") for t in targets), "no mount may nest under the read-only /var/www"
net = c["networks"]["default"]
assert net == {"name": "shared-infra_default", "external": True}, net
EOF
}

test_acme_location_is_in_port_80_block_before_redirect() {
  conf="$TPL/nginx/conf.d/10-shared-edge.conf"
  acme=$(grep -n 'location \^~ /.well-known/acme-challenge/' "$conf" | cut -d: -f1)
  redirect=$(grep -n 'return 301 https' "$conf" | cut -d: -f1)
  tls=$(grep -n 'listen 443' "$conf" | cut -d: -f1)
  [ -n "$acme" ] || fail "acme location missing"
  [ "$acme" -lt "$redirect" ] || fail "acme location must precede the redirect"
  [ "$acme" -lt "$tls" ] || fail "acme location must be in the port-80 block"
  assert_contains "$(sed -n "${acme},$((acme + 3))p" "$conf")" "root /var/lib/acme;"
}

test_acme_dir_is_tracked() {
  [ -f "$TPL/nginx/acme/.gitkeep" ] || fail "nginx/acme/.gitkeep missing"
}

run_tests
```

- [ ] **Step 2: Run to verify it fails**

Run: `bash qa-test-gen/scripts/aws/tests/test_template.sh < /dev/null`
Expected: 3 × FAIL.

- [ ] **Step 3: Edit `10-shared-edge.conf`** — in the `listen 80` server block, insert between the `/healthz` location and `location / {`:

```nginx
    # ACME HTTP-01 challenges (Let's Encrypt). certbot writes tokens into the
    # host's /opt/shared-infra/nginx/acme, mounted here at /var/lib/acme.
    location ^~ /.well-known/acme-challenge/ {
        root /var/lib/acme;
        default_type text/plain;
    }

```

Also update the comment above that server block from "kept alive ONLY for the container healthcheck and the HTTP→HTTPS redirect" to "kept alive for the container healthcheck, ACME challenges, and the HTTP→HTTPS redirect".

- [ ] **Step 4: Edit `docker-compose.yml`**

In `services.nginx.volumes`, add after the `./nginx/sites:/var/www:ro` line:

```yaml
      - ./nginx/acme:/var/lib/acme:ro          # Let's Encrypt HTTP-01 webroot (outside the ro /var/www mount)
```

Replace the `networks:` block:

```yaml
networks:
  default:
    name: shared-infra_default
    driver: bridge
```

with:

```yaml
networks:
  default:
    # Pre-created by the host bootstrap (aws-ec2-userdata.sh / gcp-vm-startup.sh).
    # `external: true` stops Compose refusing an unlabelled network (CLAUDE.md gotcha #15).
    name: shared-infra_default
    external: true
```

- [ ] **Step 5: Create the webroot placeholder**

```bash
mkdir -p qa-test-gen/scripts/shared-infra-template/nginx/acme
: > qa-test-gen/scripts/shared-infra-template/nginx/acme/.gitkeep
```

- [ ] **Step 6: Run tests**

Run: `bash qa-test-gen/scripts/aws/tests/run.sh`
Expected: all pass.

- [ ] **Step 7: Validate with real tools (requires Docker Desktop running)**

Run:
```bash
cd qa-test-gen/scripts/shared-infra-template
docker run --rm --add-host shared-keycloak:127.0.0.1 -v "$(pwd -W):/t" -w /t nginx:1.27-alpine sh -c \
  'mkdir -p /run/shared-secrets/tls /etc/nginx/tenants.d &&
   apk add --no-cache openssl >/dev/null &&
   openssl req -x509 -nodes -newkey rsa:2048 -subj /CN=t -keyout /run/shared-secrets/tls/aaqua.key -out /run/shared-secrets/tls/aaqua.crt 2>/dev/null &&
   cp nginx/conf.d/*.conf /etc/nginx/conf.d/ && nginx -t'
cd -
```
Expected: `nginx: configuration file /etc/nginx/nginx.conf test is successful`. (`--add-host` is required: nginx resolves `shared-keycloak` at config load — gotcha #17. `pwd -W` is Git Bash; on Linux use `pwd`.) The compose change is covered by the Python structural test; `docker compose config` is not used because it trips over the template's absent secret file.

- [ ] **Step 8: Commit**

```bash
git add qa-test-gen/scripts/shared-infra-template qa-test-gen/scripts/aws/tests/test_template.sh
git commit -m "feat(shared-infra): serve ACME challenges on :80 and treat network as external"
```

---

### Task 8: `verify.sh`

**Files:**
- Create: `qa-test-gen/scripts/aws/verify.sh`
- Test: `qa-test-gen/scripts/aws/tests/test_verify.sh`

**Interfaces:**
- Input: `PUBLIC_HOSTNAME` (env or `aws.env` via `lib.sh`).
- Output: one `ok` line per check; exits 1 with `FAIL ...` on the first failing check.

- [ ] **Step 1: Write the failing tests** — `qa-test-gen/scripts/aws/tests/test_verify.sh`

```bash
#!/usr/bin/env bash
. "$(dirname "$0")/harness.sh"

setup() {
  install_fake curl openssl
  export PUBLIC_HOSTNAME=aaqua.example.com
  export FAKE_OPENSSL_X509="issuer=C = US, O = Let's Encrypt, CN = R11\nX509v3 Subject Alternative Name:\n    DNS:aaqua.example.com"
}

healthy_responses() {
  respond curl <<'EOF'
/healthz|0|ok
openid-configuration|0|{"issuer":"https://aaqua.example.com/auth/realms/aaseya-platform","authorization_endpoint":"x"}
/aaqua/api/runtime-info|0|{"hasDisplayServer":false,"isContainer":true,"platform":"linux"}
/aaqua/|0|<html><body><div id="root"></div></body></html>
EOF
}

test_all_checks_pass_on_healthy_deploy() {
  setup; healthy_responses
  out=$(bash "$AWS_DIR/verify.sh" 2>&1)
  assert_contains "$out" "All checks passed"
}

test_issuer_mismatch_fails() {
  setup
  respond curl <<'EOF'
/healthz|0|ok
openid-configuration|0|{"issuer":"https://8.231.124.161/auth/realms/aaseya-platform"}
EOF
  out=$(bash "$AWS_DIR/verify.sh" 2>&1) && fail "expected non-zero"
  assert_contains "$out" "issuer"
  assert_contains "$out" "8.231.124.161"
}

test_non_letsencrypt_cert_fails() {
  setup; healthy_responses
  export FAKE_OPENSSL_X509="issuer=CN = aaqua self-signed\nDNS:aaqua.example.com"
  out=$(bash "$AWS_DIR/verify.sh" 2>&1) && fail "expected non-zero"
  assert_contains "$out" "not Let's Encrypt"
}

run_tests
```

- [ ] **Step 2: Run to verify they fail**

Run: `bash qa-test-gen/scripts/aws/tests/test_verify.sh < /dev/null`
Expected: 3 × FAIL.

- [ ] **Step 3: Write `qa-test-gen/scripts/aws/verify.sh`**

```bash
#!/usr/bin/env bash
# AAQUA — post-deploy smoke checks (run from your workstation).
# Usage: scripts/aws/verify.sh            (PUBLIC_HOSTNAME from aws.env or env)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$HERE/lib.sh"
if [[ "$PUBLIC_HOSTNAME" == REPLACE-ME* ]]; then die "set PUBLIC_HOSTNAME"; fi

BASE="https://$PUBLIC_HOSTNAME"
ok()    { printf '  ok    %s\n' "$*"; }
check_fail() { printf '  FAIL  %s\n' "$*" >&2; exit 1; }
fetch() { curl -fsS --max-time 20 "$BASE$1" || check_fail "GET $1 failed"; }

body=$(fetch /healthz)
[[ "$body" == ok* ]] || check_fail "/healthz returned: $body"
ok "/healthz over HTTPS"

cert=$(echo | openssl s_client -connect "$PUBLIC_HOSTNAME:443" -servername "$PUBLIC_HOSTNAME" 2>/dev/null \
       | openssl x509 -noout -issuer -ext subjectAltName 2>/dev/null) || check_fail "could not read certificate"
[[ "$cert" == *"Let's Encrypt"* ]] || check_fail "certificate issuer is not Let's Encrypt: $cert"
[[ "$cert" == *"DNS:$PUBLIC_HOSTNAME"* ]] || check_fail "certificate SAN does not include $PUBLIC_HOSTNAME"
ok "certificate: Let's Encrypt, SAN matches"

want="$BASE/auth/realms/aaseya-platform"
oidc=$(fetch /auth/realms/aaseya-platform/.well-known/openid-configuration)
got=$(sed -n 's/.*"issuer":"\([^"]*\)".*/\1/p' <<<"$oidc")
[ "$got" = "$want" ] || check_fail "Keycloak issuer is '$got', expected '$want' (check KC_HOSTNAME / GitLab variable scoping)"
ok "Keycloak issuer = $want"

spa=$(fetch /aaqua/)
[[ "$spa" == *'id="root"'* ]] || check_fail "/aaqua/ did not return the SPA shell"
ok "/aaqua/ serves the SPA"

api=$(fetch /aaqua/api/runtime-info)
[[ "$api" == *hasDisplayServer* ]] || check_fail "/aaqua/api/runtime-info unexpected body: $api"
ok "/aaqua/api/runtime-info reaches the backend"

echo "All checks passed for $BASE"
```

Note: the `/aaqua/api/runtime-info` line must precede `/aaqua/` in test response files because the fake matches substrings in order (already arranged in `healthy_responses`).

- [ ] **Step 4: Run tests**

Run: `bash qa-test-gen/scripts/aws/tests/run.sh`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add qa-test-gen/scripts/aws/verify.sh qa-test-gen/scripts/aws/tests/test_verify.sh
git update-index --chmod=+x qa-test-gen/scripts/aws/verify.sh
git commit -m "feat(aws): post-deploy verification script"
```

---

### Task 9: Split CI into per-environment deploy jobs

**Files:**
- Modify: `.gitlab-ci.yml` (repo root)
- Test: `qa-test-gen/scripts/aws/tests/test_gitlab_ci.sh`

**Interfaces:**
- Produces: jobs `deploy:gcp` (tag `aaqua-deploy`, env `gcp-qa`) and `deploy:aws` (tag `aaqua-deploy-aws`, env `aws-qa`), both from hidden `.deploy`.

- [ ] **Step 1: Write the failing test** — `qa-test-gen/scripts/aws/tests/test_gitlab_ci.sh`

```bash
#!/usr/bin/env bash
. "$(dirname "$0")/harness.sh"

CI_FILE="$AWS_DIR/../../../.gitlab-ci.yml"

test_two_deploy_jobs_with_distinct_tags_and_environments() {
  python - "$CI_FILE" <<'EOF'
import sys, yaml
c = yaml.safe_load(open(sys.argv[1]))
base = c[".deploy"]
assert base["stage"] == "deploy"
assert any("publish-spa.sh" in line for line in base["script"])
assert base["rules"] == [{"if": '$CI_COMMIT_BRANCH == "main"'}]
for job, tag, env in [("deploy:gcp", "aaqua-deploy", "gcp-qa"), ("deploy:aws", "aaqua-deploy-aws", "aws-qa")]:
    j = c[job]
    assert j["extends"] == ".deploy", job
    assert j["tags"] == [tag], (job, j["tags"])
    assert j["environment"]["name"] == env, job
assert "deploy" not in c, "old single job must be removed"
EOF
}

run_tests
```

- [ ] **Step 2: Run to verify it fails**

Run: `bash qa-test-gen/scripts/aws/tests/test_gitlab_ci.sh < /dev/null`
Expected: FAIL (`KeyError: '.deploy'`).

- [ ] **Step 3: Edit `.gitlab-ci.yml`**

Rename the `deploy:` key to `.deploy:` and delete its `tags:` block (the two lines `tags:` and `- aaqua-deploy`). Leave `stage`, `rules`, `variables` and the whole `script` list unchanged. Then append at the end of the file:

```yaml

# One job per host. GitLab hands each job to exactly one runner, so each host's
# runner needs its own tag — a shared tag would deploy to whichever runner grabs
# the job first. Scope host-specific CI/CD variables to the matching environment.
deploy:gcp:
  extends: .deploy
  tags:
    - aaqua-deploy
  environment:
    name: gcp-qa

deploy:aws:
  extends: .deploy
  tags:
    - aaqua-deploy-aws
  environment:
    name: aws-qa
```

- [ ] **Step 4: Run tests**

Run: `bash qa-test-gen/scripts/aws/tests/run.sh`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add .gitlab-ci.yml qa-test-gen/scripts/aws/tests/test_gitlab_ci.sh
git commit -m "ci: split deploy into deploy:gcp and deploy:aws with per-host runner tags"
```

---

### Task 10: Lint and documentation

**Files:**
- Modify: `qa-test-gen/CLAUDE.md` (new subsection after "### `docker-compose.security.yml` is local-dev only")
- Modify: `qa-test-gen/README.md` (Quick links table, Compose file map row for shared-infra)

- [ ] **Step 1: shellcheck everything new (requires Docker Desktop running)**

Run:
```bash
cd qa-test-gen
docker run --rm -v "$(pwd -W):/mnt" -w /mnt koalaman/shellcheck:stable -x \
  scripts/aws/*.sh scripts/aws/remote/*.sh scripts/aws/tests/*.sh \
  scripts/aws/tests/fakes/fake-cmd scripts/aws/tests/fakes/openssl
cd -
```
Expected: no output, exit 0. Fix any finding in the offending script, re-run `bash qa-test-gen/scripts/aws/tests/run.sh`, and amend nothing — commit fixes as `fix(aws): shellcheck findings`.

- [ ] **Step 2: Add to `qa-test-gen/CLAUDE.md`** — insert this subsection immediately before `## Conventions worth noting`:

````markdown
### AWS EC2 deployment (alongside GCP, as of 2026-10-16)
Spec: `docs/superpowers/specs/2026-10-16-aws-ec2-deployment-design.md`. Scripts in `scripts/aws/`, configured by a gitignored `scripts/aws/aws.env` (copy `aws.env.example`). Region `ap-southeast-2`, `m7i-flex.large` (free-plan eligible; 1 GB micro sizes cannot run the stack). Tests: `bash scripts/aws/tests/run.sh` (plain bash, PATH-injected doubles for aws/ssh/scp/curl/getent/openssl — no AWS calls).

- **Secrets never go in user-data or tags.** Both are readable with `ec2:Describe*`. `aws-bootstrap.sh` pipes the GitLab deploy token and runner token over SSH stdin to `remote/clone-repo.sh` / `remote/install-runner.sh`; the clone authenticates via `GIT_CONFIG_*` env vars, so the token is neither in argv nor `.git/config`.
- **One runner tag per host.** GCP runner = `aaqua-deploy`, AWS runner = `aaqua-deploy-aws`; `.gitlab-ci.yml` has `deploy:gcp` and `deploy:aws` extending `.deploy`. A shared tag would deploy each push to whichever runner grabbed it.
- **Scope host-specific GitLab CI/CD variables** (`KEYCLOAK_REALM_URL`, `VITE_KEYCLOAK_URL`, …) to environment `gcp-qa` or `aws-qa`. Unscoped variables are exported into both jobs and override `.env` (gotcha #25) — the AWS box would build against GCP's Keycloak.
- **TLS** is Let's Encrypt via `scripts/aws/issue-cert.sh` on the host: first issuance with `certbot --standalone` (stops shared-nginx briefly), renewals through the `/.well-known/acme-challenge/` location on :80 (webroot `/opt/shared-infra/nginx/acme` ↔ `/var/lib/acme` in nginx), deploy hook copies to `secrets/tls/aaqua.{crt,key}` and reloads nginx. It refuses to run until DNS points at the instance.

Runbook (each script is idempotent):
1. Install AWS CLI v2; `aws configure --profile aaqua-deploy` with the IAM user's key; delete the key CSV.
2. `cp scripts/aws/aws.env.example scripts/aws/aws.env`; fill `SSH_SOURCE_CIDR`, `PUBLIC_HOSTNAME`, `LETSENCRYPT_EMAIL`; run `scripts/aws/aws-provision.sh`.
3. DNS A record → printed Elastic IP. Ask owners of `git.lab.aaseya.com` / `llm.lab.aaseya.com` to allowlist it.
4. GitLab: Settings → Repository → Deploy tokens (`read_repository`); Settings → CI/CD → Runners → new project runner with Tags `aaqua-deploy-aws` (gotcha #24).
5. `GITLAB_DEPLOY_TOKEN_USER=… GITLAB_DEPLOY_TOKEN=… GITLAB_RUNNER_TOKEN=… scripts/aws/aws-bootstrap.sh`
6. `ssh -t -i ~/.ssh/aaqua-host.pem ubuntu@<ip>`, then, in this order:
   1. Populate `/opt/shared-infra/.env` from `.env.example` (`KC_HOSTNAME=<domain>`, `KC_PUBLIC_BASE_URL=https://<domain>`, passwords from `openssl rand -base64 32`) and `secrets/postgres_super_password.txt` (gotcha #16).
   2. Write the tenant `.env` **as `gitlab-runner`** (CI reads it) and **before onboarding** (onboarding builds the SPA from it): `printf 'VITE_KEYCLOAK_URL=https://<domain>/auth
KEYCLOAK_REALM_URL=https://<domain>/auth/realms/aaseya-platform
' | sudo -u gitlab-runner tee /opt/aaqua/qa-test-gen/.env`
   3. `sudo AAQUA_REPO=/opt/aaqua/qa-test-gen PUBLIC_BASE_URL=https://<domain> AAQUA_DB_PASSWORD=<same as .env> bash /opt/shared-infra/scripts/onboard-aaqua.sh` (prompts for the LLM key).
   4. `sudo chown -R gitlab-runner:gitlab-runner /opt/shared-infra/nginx/sites/aaqua` — onboarding publishes the SPA as root (gotcha #27).
7. `sudo PUBLIC_HOSTNAME=<domain> LETSENCRYPT_EMAIL=<email> bash /opt/aaqua/qa-test-gen/scripts/aws/issue-cert.sh --staging`, then again without `--staging`.
8. Start in dependency order (gotcha #17): `cd /opt/shared-infra && docker compose up -d postgres keycloak`; `cd /opt/aaqua/qa-test-gen && sudo -u gitlab-runner docker compose up -d --build app`; `cd /opt/shared-infra && docker compose up -d nginx`.
9. `scripts/import-users.sh` with the user CSV.
10. Scope GitLab variables to `gcp-qa`; push to `main`; confirm `deploy:aws` is green.
11. `scripts/aws/verify.sh` from the workstation; log in through the browser.
````

- [ ] **Step 3: Update `qa-test-gen/README.md`**

Add a row to the Quick links table, directly after the "Provision a fresh GCP VM" row:

```markdown
| **Provision / deploy on AWS EC2** (Sydney, alongside GCP) | [`scripts/aws/`](scripts/aws/) — copy `aws.env.example` to `aws.env`, run `aws-provision.sh`, then follow [`CLAUDE.md` § AWS EC2 deployment](CLAUDE.md). |
```

In the Compose file map, change the `scripts/shared-infra-template/docker-compose.yml` row's last cell to: `One per host (GCP QA box and AWS EC2 box). Expects the shared-infra_default network to exist (created by the host bootstrap).`

- [ ] **Step 4: Run the full test suite one last time**

Run: `bash qa-test-gen/scripts/aws/tests/run.sh`
Expected: every file reports `0 failed`; exit 0.

- [ ] **Step 5: Commit**

```bash
git add qa-test-gen/CLAUDE.md qa-test-gen/README.md
git commit -m "docs: AWS EC2 deployment runbook and quick links"
```

---

## Live rollout (operator, after merge review)

Not automated by this plan — these steps touch real AWS, DNS and GitLab and follow the runbook in Task 10 Step 2.

- **The branch must be merged to `main` before runbook step 5.** `aws-bootstrap.sh` clones `AAQUA_REPO_BRANCH` (default `main`), and the host-side scripts (`issue-cert.sh`, the ACME location, the external network) must be in that clone.
- **What merging does to GCP:** the push runs `deploy:gcp`, which copies the template's `nginx/` directory to the GCP host. The new ACME location points at `/var/lib/acme`, which is not mounted there, so ACME paths 404 — harmless. The GCP host's `docker-compose.yml` is not touched by CI, so the `external: true` change does not reach it.
- **What merging does to AWS:** `deploy:aws` stays *pending* until the AWS runner is registered (runbook step 5). That is expected; it runs once the runner comes online. Scope host-specific GitLab variables to `gcp-qa` (runbook step 10) **before** the AWS runner registers, or the pending job will build with GCP's values.
