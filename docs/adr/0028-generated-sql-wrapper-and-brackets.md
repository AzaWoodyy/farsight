# Generated SQL runs inside a wrapper, and brackets are code

Two details of the guard on generated SQL (`src/lib/agent/guard.ts`, `src/lib/db/generated-query.ts`) complete what `docs/postgres.md` says about the static pass and the database roles.

## Rules

- `executeGeneratedQuery` wraps the statement as a subquery of a `SELECT` (that is where the server-side row cap comes from, even for SQL that did not go through the guard's forced `LIMIT`). A write therefore cannot even be parsed there: `DELETE FROM v_game_players RETURNING *` fails with a syntax error, before any permission check.
- In Postgres, square brackets are an array constructor or subscript, not a quoted identifier as in SQLite: what they hold is code. The static pass reads inside them, so `SELECT (ARRAY[pg_sleep(1)])[1]` and `SELECT (ARRAY[1, length(set_config('role', 'farsight_app', true))])[1]` are refused (`scripts/sql-guard.test.ts`).
