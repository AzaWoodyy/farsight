-- Roles of the Farsight database, created once by the owner role (on Neon, the project's owner, e.g. neondb_owner).
-- The owner builds, loads and swaps the schema (scripts/db/load.ts); the app only ever connects as farsight_app.
--
--   psql "$DATABASE_OWNER_URL" -v app_password="'…'" -f db/roles.sql
--
-- The password is given on the command line, never written here. Run again: every statement is idempotent.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'farsight_app') THEN
    CREATE ROLE farsight_app LOGIN;
  END IF;

  -- Generated (text-to-SQL) queries run as this role, inside a read-only transaction: it reads the v_* views only.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'farsight_sql') THEN
    CREATE ROLE farsight_sql NOLOGIN;
  END IF;
END
$$;

ALTER ROLE farsight_app PASSWORD :app_password;
GRANT farsight_sql TO farsight_app;

-- Every session of the app is read-only and bounded; the schema is found without a qualified name, even through a
-- transaction-mode pooler (a role setting applies to every server connection).
ALTER ROLE farsight_app SET default_transaction_read_only = on;
ALTER ROLE farsight_app SET statement_timeout = '10s';
ALTER ROLE farsight_app SET idle_in_transaction_session_timeout = '15s';
ALTER ROLE farsight_app SET search_path = farsight;
ALTER ROLE farsight_sql SET search_path = farsight;

-- Nothing in the default schema for either role.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON SCHEMA public FROM farsight_app, farsight_sql;
