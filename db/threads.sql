-- Conversations of signed-in visitors (the chat prototype), kept apart from the esports data.
-- The data load swaps the schema `farsight` (scripts/db/load.ts) and never touches this one.
-- The app writes it through its own role and its own connection string (THREADS_DATABASE_URL):
-- farsight_app stays read-only, and farsight_threads reads nothing of the esports data.
--
--   psql "$DATABASE_OWNER_URL" -v threads_password="'…'" -f db/threads.sql
--
-- The password is given on the command line, never written here. Run again: every statement is idempotent.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'farsight_threads') THEN
    CREATE ROLE farsight_threads LOGIN;
  END IF;
END
$$;

ALTER ROLE farsight_threads PASSWORD :threads_password;
ALTER ROLE farsight_threads SET statement_timeout = '5s';
ALTER ROLE farsight_threads SET idle_in_transaction_session_timeout = '10s';
ALTER ROLE farsight_threads SET search_path = farsight_users;

CREATE SCHEMA IF NOT EXISTS farsight_users;

CREATE TABLE IF NOT EXISTS farsight_users.threads (
  id uuid PRIMARY KEY,
  user_id text NOT NULL,
  title text NOT NULL,
  messages jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS threads_by_user ON farsight_users.threads (user_id, updated_at DESC);

REVOKE ALL ON SCHEMA farsight_users FROM PUBLIC;
GRANT USAGE ON SCHEMA farsight_users TO farsight_threads;
GRANT SELECT, INSERT, UPDATE, DELETE ON farsight_users.threads TO farsight_threads;
