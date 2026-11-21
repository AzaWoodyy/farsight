# In-game summaries: derive versions and what an older line may lack

Each line of `data/raw/ingame.jsonl` carries the `DERIVE_VERSION` that computed it (`scripts/data/ingame.ts`). A version bump makes `data:fetch` recompute the summaries from the cached raw JSON; `DERIVE_COMPATIBLE` names the oldest version whose existing numbers are still those of the current one.

## Rules

- A summary between `DERIVE_COMPATIBLE` and `DERIVE_VERSION` only lacks what later versions added. The derivation keeps it with those columns NULL, `data:fetch` recomputes it as soon as it can read the raw JSON, and `db:load` refuses it without `--allow-older-summaries`.
- History of the versions: derive 3 added the dragons and souls (`dragons`, `elder_dragons`, `dragon_soul`, `soul`); derive 4 added the Leaguepedia fallbacks (`damage`, `vision`, `runes`, `primary_tree`, `secondary_tree`, `heralds`, `gameVersion`); derive 5 changed existing numbers (the minute statistics of games that ended before the minute, the first-blood victim after an execution), so no older summary is compatible and `DERIVE_COMPATIBLE` is 5.
- The fields added in derive 3 and 4 are `.optional()` in the `PlayerSummary`, `TeamSummary` and `IngameLine` schemas because an older line does not have them. Keep them optional: a line that fails the schema is counted as unreadable instead of as an older summary.
- `PlayerSummary.name` (the Riot summoner name) is read by nothing downstream; it is kept in the summary to diagnose problems when mapping Riot participants to the scoreboard's players.
