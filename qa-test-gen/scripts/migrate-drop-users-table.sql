-- One-shot cutover after switching to Keycloak.
-- Drops the legacy `users` table and the FK constraints that referenced it.
-- After this, `projects.owner_id` and `scans.initiated_by` store Keycloak `sub` UUIDs.
--
-- Usage:
--   docker exec -i aaqua-postgres psql -U aaqua -d aaqua_security \
--     < scripts/migrate-drop-users-table.sql
--
-- Wrapped in a transaction so a partial failure leaves the schema intact.

BEGIN;

-- Detach FKs without assuming the constraint name. Sequelize's auto-generated
-- names follow `<table>_<column>_fkey` but can vary across versions.
DO $$
DECLARE
    cons_name text;
BEGIN
    FOR cons_name IN
        SELECT conname
        FROM pg_constraint
        WHERE contype = 'f'
          AND conrelid = 'public.projects'::regclass
          AND conname ILIKE '%owner_id%'
    LOOP
        EXECUTE format('ALTER TABLE public.projects DROP CONSTRAINT IF EXISTS %I', cons_name);
    END LOOP;

    FOR cons_name IN
        SELECT conname
        FROM pg_constraint
        WHERE contype = 'f'
          AND conrelid = 'public.scans'::regclass
          AND conname ILIKE '%initiated_by%'
    LOOP
        EXECUTE format('ALTER TABLE public.scans DROP CONSTRAINT IF EXISTS %I', cons_name);
    END LOOP;
END $$;

-- Drop the legacy users table.
DROP TABLE IF EXISTS public.users CASCADE;

COMMIT;
