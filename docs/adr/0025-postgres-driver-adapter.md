# What the Postgres adapter does on top of the driver

`src/lib/db/postgres.ts` puts node-postgres (or Neon's WebSocket driver) behind the `Db` interface. Three adjustments are not obvious from the driver's API and each fixes a failure seen with it.

## Rules

- Type parsers: COUNT and SUM come back as bigint (`INT8`) and AVG as `NUMERIC`, which node-postgres reads as strings. The pool parses both with `Number`, because the whole app reads numbers. This is safe only because every value of this database fits a double (counts, gold, seconds since 1970); a column that could exceed 2^53 must not be added without revisiting it.
- `createPool`: `schema` sets the search path through connection options, for tests and the loader only. The app passes none and relies on the role's own `search_path` (`db/roles.sql`), because a per-connection option does not hold behind a transaction-mode pooler (Neon's `-pooler` host) while the role's setting does.
- `createPool` always listens to the pool's `error` event: an idle connection the server or the network drops is emitted there (the pool removes the client itself). Unheard, Node treats it as an unhandled error and ends the instance, with every request it is serving.
- `typed()` in `numberParameters`: every number parameter carries an explicit cast (`::integer`, `::bigint`, `::double precision`). Postgres would otherwise infer a parameter's type from its first use, and one read in the select list (`:minPicks AS min_picks`) would be text everywhere else in the statement. Text and NULL parameters keep the type of their context.
