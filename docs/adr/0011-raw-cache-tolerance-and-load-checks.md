# The derivation tolerates an older raw cache; the load refuses what it leaves empty

Datasets were added to `data:fetch` over time (team pages, team redirects, player images, the schedule, logo files, item recipe data). `deriveDataset` (`scripts/data/derive.ts`) still runs on a raw cache fetched before one of them existed and leaves the matching columns or tables empty, so local work and tests do not need a full refetch. `db:load` is where an incomplete cache is stopped (`scripts/data/checks.ts`).

## Rules

- Without `teams.json`, team names stay as the scoreboards write them (no case folding) and teams have no abbreviation; without `player_images.json`, players have no photo; without `schedule.json`, there is no series without a scoreboard; without `team_logo_files.json`, teams have no logo. Each case warns and continues.
- `legacyItems[].meta` is optional in the `ddragon` dataset: a cache fetched before items had a kind gives its retired items a NULL kind.
- An incremental `data:fetch` on a cache that has no `schedule.json` starts from an empty schedule: it then holds the refreshed pages only, until the next full fetch.
- `datasetProblems` reports each of those gaps through `FILLED` (a table without a row, or a column without a value). A column the derivation never wrote may be missing from the table it is given: it is read as empty, exactly like a column of NULLs, and must not throw the way a missing column of `PARENTS` does.
- `photoLoss` refuses a load when more than 2 % of the live players with a photo would lose it. The margin exists because a new load normally loses a few photos to wiki edits; the check exists because a partial `PlayerImages` fetch keeps every league's counts of tournaments, games and lines, so the per-league comparison of the load cannot see it.
