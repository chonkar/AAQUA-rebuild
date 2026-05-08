#!/bin/bash
# Provisions the shared-postgres cluster on first boot:
#   - DB `keycloak`        + role `keycloak_user`
#   - DB `aaqua_security`  + role `aaqua_app`
# To add a tenant later (cluster already initialized):
#   docker exec -e <TENANT>_DB_PASSWORD=... shared-postgres \
#     psql -U postgres -d postgres -f /docker-entrypoint-initdb.d/01-bootstrap-tenants.sh
# Idempotent.
set -eu

require() { [ -n "${!1:-}" ] || { echo "[bootstrap] ERROR: $1 not set" >&2; exit 1; }; }
require KEYCLOAK_DB_PASSWORD
require AAQUA_DB_PASSWORD

create_tenant() {
  local db="$1" role="$2" pw="$3"
  echo "[bootstrap] Provisioning DB=$db ROLE=$role"
  psql --username "$POSTGRES_USER" --dbname postgres -v ON_ERROR_STOP=1 \
    -v role="$role" -v pw="$pw" -v db="$db" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'role', :'pw')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'role') \gexec

SELECT format('ALTER ROLE %I WITH PASSWORD %L', :'role', :'pw') \gexec

SELECT format('CREATE DATABASE %I OWNER %I', :'db', :'role')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'db') \gexec
SQL

  psql --username "$POSTGRES_USER" --dbname "$db" -v ON_ERROR_STOP=1 \
    -v role="$role" <<'SQL'
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT  ALL ON SCHEMA public TO :"role";
SQL
}

create_tenant keycloak       keycloak_user "$KEYCLOAK_DB_PASSWORD"
create_tenant aaqua_security  aaqua_app     "$AAQUA_DB_PASSWORD"

echo "[bootstrap] Done."
