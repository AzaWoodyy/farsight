# Two derivations of the same raw cache give the same rows

`deriveDataset` (`scripts/data/derive.ts`) computes every row in memory and writes nothing; `scripts/db/load.ts` copies the rows into Postgres. Loads are compared with the live data and with each other, so the same cache must always give the same database.

## Rules

- Integer ids (teams, champions, runes, spells, items, players, tournaments, games) are given in the order rows are first seen in the datasets. Do not iterate a source in an order that can change between runs (a `Set` built from parallel work, a directory listing) before ids are assigned.
- When a player has several undated headshots and no dated one, the file kept is the first by name (`files.toSorted()[0]`), so a rebuild picks the same one whatever the order Cargo returned them in.
- For the same reason the choice between two in-game summaries of one game never depends on the order of `ingame.jsonl` (`bestFirst`, recorded in `AGENTS.md`).
