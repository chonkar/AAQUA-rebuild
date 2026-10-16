#!/usr/bin/env bash
# Bulk-import Keycloak users from a CSV into the aaseya-platform realm.
#
# CSV format (header required — see users-template.csv):
#   username,email,fullName,temporaryPassword,realmRoles
#
#   fullName: `First Last` — split on first space into Keycloak's firstName+lastName.
#             Single-word names go entirely into firstName; multi-word surnames
#             (e.g. `John von Neumann`) keep `von Neumann` in lastName.
#   realmRoles: semicolon-separated (e.g. `admin;user`), empty for none.
#   Names with embedded commas WILL break parsing — avoid them.
#
# Passwords are set with --temporary, so Keycloak forces the user to change
# on first login. Distribute the temp password via an out-of-band channel.
#
# Usage:
#   export KC_ADMIN_PW='<superadmin-password-from-/opt/shared-infra/.env>'
#   ./import-users.sh /path/to/users.csv
#
# Optional env overrides (defaults shown):
#   KC_ADMIN_USER=superadmin
#   KC_REALM=aaseya-platform
#   KC_CONTAINER=shared-keycloak

set -euo pipefail

CSV="${1:?usage: $0 <csv-file>}"
KC_ADMIN_USER="${KC_ADMIN_USER:-superadmin}"
KC_ADMIN_PW="${KC_ADMIN_PW:?export KC_ADMIN_PW=<superadmin-password> before running}"
KC_REALM="${KC_REALM:-aaseya-platform}"
KC_CONTAINER="${KC_CONTAINER:-shared-keycloak}"

if [ ! -f "$CSV" ]; then
  echo "ERROR: CSV file not found: $CSV" >&2
  exit 1
fi

kcadm() { sudo docker exec "$KC_CONTAINER" /opt/keycloak/bin/kcadm.sh "$@"; }

echo "→ Authenticating as $KC_ADMIN_USER on realm master ..."
kcadm config credentials \
  --server http://localhost:8080/auth \
  --realm master \
  --user "$KC_ADMIN_USER" \
  --password "$KC_ADMIN_PW" >/dev/null

created=0
updated=0
failed=0

# Skip header row; iterate CSV lines
tail -n +2 "$CSV" | while IFS=',' read -r username email fullName password roles; do
  # Strip Windows CR endings that Excel adds when saving as CSV on Windows
  username="${username//$'\r'/}"
  email="${email//$'\r'/}"
  fullName="${fullName//$'\r'/}"
  password="${password//$'\r'/}"
  roles="${roles//$'\r'/}"

  [ -z "$username" ] && continue

  # Split fullName on first space → firstName + lastName.
  # `${var%% *}` = everything before the first space (or whole string if no space).
  # `${var#* }` = everything after the first space (or whole string if no space).
  firstName="${fullName%% *}"
  lastName="${fullName#* }"
  # If fullName had no space, both expansions return the same thing — clear lastName.
  if [ "$firstName" = "$lastName" ]; then
    lastName=""
  fi

  echo ""
  echo "→ $username <$email> ($firstName / $lastName)"

  # Create user; if it already exists, kcadm prints "User exists with same username"
  create_output=$(kcadm create users \
    -r "$KC_REALM" \
    -s "username=$username" \
    -s "email=$email" \
    -s "firstName=$firstName" \
    -s "lastName=$lastName" \
    -s "enabled=true" \
    -s "emailVerified=true" 2>&1 || true)

  if echo "$create_output" | grep -qi "User exists"; then
    echo "  (already exists — updating password and roles)"
    updated=$((updated + 1))
  elif echo "$create_output" | grep -qi "error\|failed"; then
    echo "  ERROR creating user: $create_output"
    failed=$((failed + 1))
    continue
  else
    echo "  created"
    created=$((created + 1))
  fi

  # Set temporary password (user must change on first login)
  if ! kcadm set-password \
    -r "$KC_REALM" \
    --username "$username" \
    --new-password "$password" \
    --temporary 2>&1; then
    echo "  WARNING: failed to set password for $username"
    failed=$((failed + 1))
  else
    echo "  password set (temporary — user will be prompted to change)"
  fi

  # Assign roles (semicolon-separated)
  if [ -n "$roles" ]; then
    IFS=';' read -ra role_list <<< "$roles"
    for role in "${role_list[@]}"; do
      role="${role// /}"  # strip spaces
      [ -z "$role" ] && continue
      if kcadm add-roles \
          -r "$KC_REALM" \
          --uusername "$username" \
          --rolename "$role" 2>/dev/null; then
        echo "  granted role: $role"
      else
        echo "  WARNING: could not grant role '$role' (does it exist in realm?)"
      fi
    done
  fi
done

echo ""
echo "═══════════════════════════════════════════════════════"
echo "Import complete."
echo "  Created: $created"
echo "  Updated: $updated"
echo "  Failed:  $failed"
echo "═══════════════════════════════════════════════════════"
echo ""
echo "All users have TEMPORARY passwords — they'll be prompted"
echo "to set a new one on first login. Share the temp passwords"
echo "via an out-of-band channel (secure chat, sealed envelope)."
