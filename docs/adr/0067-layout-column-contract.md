# Table columns the answer layouts read by name

Most tools return tables with localized headers, but the comparison and champion layouts read their columns by fixed machine names. Those names are a contract between `src/lib/agent/tools.ts` and the views: renaming one shows nothing wrong in the types and silently empties a column on screen.

## Rules

- `COMPARISON_COLUMNS` and `CHAMPION_RANKING_COLUMNS` are named as the comparison and champion layouts read them; change them together with the layout.
- In `comparisonFocus`, the column of the statistic the question names is the metric's own name when it is a count (`first_bloods`, `kills_before_10`) and `avg_<source column>` when it is an average.
- In `championRanking.format`, a total or a per-game average is one extra column inserted after `champion`, named `total_<sort>` or after the average sort itself (`kills`, `gold`…); the champion layout gives that column the bar.
