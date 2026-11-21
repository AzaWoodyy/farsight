# db:load guards and how migrations are applied

`scripts/db/load.ts` replaces the live schema with freshly derived rows, and `scripts/db/migrations.ts` builds the schema. A few of their choices protect complete data from a partial ingestion and keep the same migration files usable for the live schema and for a staged one.

## Rules

- A partial ingestion must not replace complete data: unless `--allow-shrink` is passed, the load is refused when a live league would lose tournaments, games, player lines, in-game games or standings, or when too many players with a photo are gone (`photoLoss`). With a swap the staged schema is compared with the live one and dropped on a loss. In place, the live schema is dropped before the load, so the derived rows are compared with it first, league by league, before anything is written.
- The per-league counts (`schemaCounts`) start from `leagues`, not from the games, so that a league with standings and no game is counted too.
- In place is chosen automatically when two copies of about the live size would not fit under `DATABASE_SIZE_LIMIT_MB` with a tenth to spare (`2 * live > 0.9 * limit`).
- Each load inserts an `ingest_runs` row of kind `build`. That kind is a contract: the day of this run is the data's day, read back with `kind = 'build'` (`next.config.ts`, `src/lib/db/release.ts` for the day). Do not rename it.
- A migration file names no schema: it applies to the schema on the search path, which is the live one for `db:migrate` and the one a load builds from scratch for `db:load`. An applied file that changed afterwards is refused by its checksum: a change is a new file.
- `grantReaders` grants to `farsight_app` and `farsight_sql` only when those roles exist: a bare local Postgres server has none, and the load must still work there.
