#!/bin/bash
# Postgres init script: provisions the `keycloak` schema and `keycloak_user` role.
# Auto-run on a fresh `postgres_data` volume; for an existing volume:
#
#   docker exec -e KEYCLOAK_DB_PASSWORD="<pw>" aaqua-postgres \
#     bash /docker-entrypoint-initdb.d/01-keycloak-schema.sh
#
# Idempotent.
set -eu

if [ -z "${KEYCLOAK_DB_PASSWORD:-}" ]; then
  echo "[keycloak-init] ERROR: KEYCLOAK_DB_PASSWORD is not set." >&2
  exit 1
fi

# psql variable substitution `:'name'` does NOT work inside `DO $$ ... $$` blocks
# (dollar-quoted bodies are opaque to psql). Use `\gexec` instead — psql formats
# the SQL at the client layer, then the server executes the result.
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v ON_ERROR_STOP=1 \
  -v keycloak_password="$KEYCLOAK_DB_PASSWORD" \
  <<'SQL'
CREATE SCHEMA IF NOT EXISTS keycloak;

-- Create the role only if missing.
SELECT format('CREATE ROLE keycloak_user LOGIN PASSWORD %L', :'keycloak_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'keycloak_user') \gexec

-- Always ensure the password matches the env var (rotates on each run).
SELECT format('ALTER ROLE keycloak_user WITH PASSWORD %L', :'keycloak_password') \gexec

ALTER SCHEMA keycloak OWNER TO keycloak_user;
GRANT ALL ON SCHEMA keycloak TO keycloak_user;
ALTER ROLE keycloak_user SET search_path TO keycloak;
REVOKE ALL ON SCHEMA public FROM keycloak_user;
REVOKE ALL ON SCHEMA keycloak FROM PUBLIC;
SQL

echo "[keycloak-init] Schema and role provisioned."
