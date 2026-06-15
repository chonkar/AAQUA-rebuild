#!/usr/bin/env bash
# AAQUA — GCP provisioning script
# Run this from your workstation (must have `gcloud` installed and authenticated).
# Provisions: enabled APIs, static external IP, firewall rules, single Compute Engine VM
# with a startup script that installs Docker and clones the AAQUA repo.
#
# Usage:
#   1. Edit the CONFIGURE ME block below.
#   2. gcloud auth login
#   3. ./scripts/gcp-provision.sh
#   4. After completion, SSH to the VM and follow the "Next steps" printed at the end.

set -euo pipefail

# =============================================================================
# CONFIGURE ME — edit these before running
# =============================================================================

# --- GCP project / region ---
PROJECT_ID="aaqua-qa"                            # gcloud project ID
REGION="asia-south1"                             # closest region to your users
ZONE="asia-south1-a"                             # any zone within REGION

# --- VM ---
VM_NAME="aaqua-host"
VM_MACHINE_TYPE="e2-standard-2"                  # 2 vCPU / 8 GB RAM (minimal viable for full AAQUA stack)
VM_DISK_GB=30                                    # OS + docker images + Postgres data + ZAP (3-6 months QA headroom)
VM_IMAGE_FAMILY="ubuntu-2204-lts"
VM_IMAGE_PROJECT="ubuntu-os-cloud"

# --- Networking / DNS ---
# This hostname must resolve to the static IP allocated below before TLS can be issued.
# You'll create the DNS A record manually (or via Cloud DNS) after this script reports the IP.
PUBLIC_HOSTNAME="aaqua.aaseya.com"
PUBLIC_PORT="8443"                               # 443 for standard HTTPS, 8443 to match QA box
STATIC_IP_NAME="aaqua-host-ip"

# Office CIDR for SSH access. SSH from anywhere (0.0.0.0/0) is a bad default.
# Get yours: curl ifconfig.me
SSH_SOURCE_CIDR="150.129.244.82/32"

# --- AAQUA repo to clone onto the VM ---
AAQUA_REPO_URL="https://github.com/chonkar/AAQUA-rebuild.git"
AAQUA_REPO_BRANCH="main"

# --- Tags (used by firewall rules to target this VM) ---
NETWORK_TAG_HTTPS="aaqua-https"
NETWORK_TAG_SSH="aaqua-ssh"

# =============================================================================
# End of CONFIGURE ME
# =============================================================================

# Sanity checks
command -v gcloud >/dev/null || { echo "gcloud CLI not found. Install from https://cloud.google.com/sdk/docs/install"; exit 1; }
[[ "$PROJECT_ID" == REPLACE-ME-* ]] && { echo "Edit PROJECT_ID in this script before running."; exit 1; }
[[ "$SSH_SOURCE_CIDR" == REPLACE-ME-* ]] && { echo "Edit SSH_SOURCE_CIDR (your office IP/CIDR) before running."; exit 1; }

STARTUP_SCRIPT_PATH="$(dirname "$0")/gcp-vm-startup.sh"
[[ -f "$STARTUP_SCRIPT_PATH" ]] || { echo "Missing $STARTUP_SCRIPT_PATH (companion file)"; exit 1; }

echo "==> Using project $PROJECT_ID in $REGION/$ZONE"
gcloud config set project "$PROJECT_ID" >/dev/null
gcloud config set compute/region "$REGION" >/dev/null
gcloud config set compute/zone "$ZONE" >/dev/null

echo "==> Enabling required APIs (idempotent)"
gcloud services enable compute.googleapis.com dns.googleapis.com --quiet

echo "==> Reserving static external IP: $STATIC_IP_NAME"
if ! gcloud compute addresses describe "$STATIC_IP_NAME" --region="$REGION" >/dev/null 2>&1; then
  gcloud compute addresses create "$STATIC_IP_NAME" --region="$REGION"
else
  echo "    already exists, reusing"
fi
STATIC_IP=$(gcloud compute addresses describe "$STATIC_IP_NAME" --region="$REGION" --format='value(address)')
echo "    IP = $STATIC_IP"

echo "==> Firewall rule: allow HTTPS on $PUBLIC_PORT and 80 (for Let's Encrypt HTTP-01)"
if ! gcloud compute firewall-rules describe aaqua-allow-https >/dev/null 2>&1; then
  gcloud compute firewall-rules create aaqua-allow-https \
    --direction=INGRESS --action=ALLOW \
    --rules="tcp:80,tcp:${PUBLIC_PORT}" \
    --source-ranges=0.0.0.0/0 \
    --target-tags="$NETWORK_TAG_HTTPS"
else
  echo "    already exists, reusing"
fi

echo "==> Firewall rule: allow SSH from $SSH_SOURCE_CIDR"
if ! gcloud compute firewall-rules describe aaqua-allow-ssh >/dev/null 2>&1; then
  gcloud compute firewall-rules create aaqua-allow-ssh \
    --direction=INGRESS --action=ALLOW \
    --rules=tcp:22 \
    --source-ranges="$SSH_SOURCE_CIDR" \
    --target-tags="$NETWORK_TAG_SSH"
else
  echo "    already exists, reusing"
fi

echo "==> Creating VM: $VM_NAME"
if ! gcloud compute instances describe "$VM_NAME" --zone="$ZONE" >/dev/null 2>&1; then
  gcloud compute instances create "$VM_NAME" \
    --zone="$ZONE" \
    --machine-type="$VM_MACHINE_TYPE" \
    --image-family="$VM_IMAGE_FAMILY" --image-project="$VM_IMAGE_PROJECT" \
    --boot-disk-size="${VM_DISK_GB}GB" --boot-disk-type=pd-balanced \
    --address="$STATIC_IP" \
    --tags="$NETWORK_TAG_HTTPS,$NETWORK_TAG_SSH" \
    --metadata="aaqua-repo-url=$AAQUA_REPO_URL,aaqua-repo-branch=$AAQUA_REPO_BRANCH,aaqua-public-hostname=$PUBLIC_HOSTNAME,aaqua-public-port=$PUBLIC_PORT" \
    --metadata-from-file="startup-script=$STARTUP_SCRIPT_PATH"
else
  echo "    VM already exists. To re-run startup script: gcloud compute instances reset $VM_NAME --zone $ZONE"
fi

cat <<EOF

============================================================================
  Provisioning complete
============================================================================

  Static IP:       $STATIC_IP
  VM:              $VM_NAME ($VM_MACHINE_TYPE) in $ZONE
  Public URL:      https://${PUBLIC_HOSTNAME}:${PUBLIC_PORT}/aaqua/

  Next steps:
    1. Create DNS A record:  $PUBLIC_HOSTNAME  ->  $STATIC_IP
       Wait for propagation: dig +short $PUBLIC_HOSTNAME

    2. SSH to the VM (startup script may still be installing Docker; give it ~3 min):
         gcloud compute ssh $VM_NAME --zone $ZONE

    3. On the VM, verify startup finished:
         sudo journalctl -u google-startup-scripts.service -n 50

    4. Run the on-host onboarding (it will prompt for your LLM API key):
         cd /opt/aaqua/qa-test-gen
         sudo AAQUA_DB_PASSWORD='<choose-strong>' \\
              PUBLIC_BASE_URL='https://${PUBLIC_HOSTNAME}:${PUBLIC_PORT}' \\
              bash scripts/shared-infra-template/scripts/onboard-aaqua.sh

    5. Bring up the platform tier (Postgres + Keycloak + nginx):
         cd /opt/shared-infra && sudo docker compose up -d

    6. Bring up the AAQUA tenant (app + ZAP):
         cd /opt/aaqua/qa-test-gen && sudo docker compose up -d --build

    7. Open https://${PUBLIC_HOSTNAME}:${PUBLIC_PORT}/aaqua/

  ROTATE your LLM API key before pasting it onto the VM — the previous one was
  shared in chat and should be considered compromised.
============================================================================
EOF
