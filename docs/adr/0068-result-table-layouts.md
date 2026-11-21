# When a result table is drawn as a champion ranking or a two-player comparison

`src/lib/champions.ts` and `src/lib/comparison.ts` recognise a layout from the columns of any result table, including tables from generated SQL whose column names the model chose. The checks are conservative so that a table about something else stays a plain table, and so that a comparison never declares a winner on figures that do not compare.

## Rules

- `metricOf` (`champions.ts`): a `total_` column is a count over the scope and never a percentage, whatever its base name says: `first_blood` is a rate, "total_first_blood" counts them. It takes the base figure's label with "(total)".
- `detectChampionRanking`: at least half of the names in the champion column must be known champions (have an icon); a column called "champion" holding something else is not a ranking.
- `detectChampionRanking`: any other text column (a player, a team…) means the table is about something else than champions alone, and the layout is refused.
- `MEANINGS` (`comparison.ts`) is ordered and the first match wins: `(kills|deaths|assists)_(\d+)` must stay before the plain `kills` / `deaths` patterns, and `gold_diff_N` before `gold_N` and `gold`.
- `Meaning.count` marks a figure that is a sum over the player's games when not averaged (wins, kills, solo kills, plates…). In `detectComparison` such totals are compared (`better` kept) only when both players played the same number of games; with different or unknown game counts the row is shown but nobody wins it.
- The derived KDA of `detectComparison` is computed only when kills, deaths and assists carry the same aggregate (all averages or all totals): the ratio is then the same KDA either way. Mixing an average with a total would give a meaningless figure, so nothing is derived.
