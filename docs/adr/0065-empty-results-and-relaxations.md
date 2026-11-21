# What an empty result means, and which filters a tool may drop

The agent self-corrects when a tool's plan query returns no row, by trying the tool's `relaxations` in order. So the plan query is chosen for what its emptiness means, and a relaxation exists only when dropping the filter still answers the question asked.

## Rules

- `ToolDef.relaxations` in `src/lib/agent/tools.ts` returns the corrections most conservative first; the order is the order they are tried in.
- `playerComparison.plan` runs on every game of the scope, not on the games the two players met in: it decides whether there is anything to compare. Their meetings are read later in `format`.
- `playerRunes.plan` returns the player's games by champion, so the result is empty only when the player has no game in the scope. A scope without runes (before 2018) still answers, with its note, instead of being widened.
- `gameTimeline.plan` returns every game of the matching series, so the answer can say a series had no game 5 rather than fall back to another series.
- `championRanking.plan` keeps the rows of a Riot-data sort (`CHAMPION_INGAME_SORTS`) when the scope has no game with Riot data (`OR ingame_games = 0`), so the answer says the figure is absent rather than widen the scope. In `format`, a total with no champion above 0 is a true zero over the scope and is said as such, without an empty table.
- `gameTimeline.relaxations` drops nothing when no team is named: without a team, removing the phase or the year would show an unrelated game.
- `series.relaxations`: two teams that did not meet in the phase asked get their series of the period, only when a period is given (a year keeps the list short); one team that did not reach the phase gets the phase itself without the team.
- `gameRecords.relaxations` does not drop the league for a Riot-data metric: a competition without Riot data has no lane figure, and another competition's records would answer another question.
