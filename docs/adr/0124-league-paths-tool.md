# Paths of teams between leagues are computed by the code, not by the model

"Teams that went from a second division to the LEC" gave two tables and one team: the query the model wrote changed from one try to the next, and Karmine Corp was missing because it played the second division in 2020 as Kameto Corp. The conversation therefore has a tool for it, `league_paths`, whose answer is computed by `leaguePaths` in `src/lib/agent/chat-paths.ts`.

## Rules

- `LEAGUE_TIERS` is a hand-kept list, by top league, of the league names that are the top tier, the lower tier and the second divisions. It covers the LEC (with its former name, the EU LCS) and the LCK (with OGN Champions) and no other region: the tool's input accepts those two only, and the model writes `run_sql` for the others.
- The scope is `lower` (every league under the top one: national leagues, their second divisions, the Masters, challenger and academy leagues) or `second` (only the leagues named second division or challengers).
- A team is listed when it played a counted league in a year before its first year in the top league. Its row gives every lower league it played before that year, the year it arrived and its number of games in the top league.
- A team with few games in the top league only played one of its open tournaments: the prompt asks the model to say so instead of calling it a promotion, which is why the number of games is in the row.
- Teams that changed name are followed under their names: each name of a curated franchise is folded into its current name (`renamedTeams`, from `FRANCHISES` in `src/lib/agent/understand.ts`) before the years are compared. Kameto Corp and Karmine Corp are one team there, for the conversation and for the questions of the site alike ([0035](0035-team-alias-index.md)).
- The tool reads `v_games` with a parameterized query, as the typed tools do; it is not generated SQL and does not go through the guard.
- Its result is shown as a table card and replaces every earlier result of the turn. The digest the model reads names the leagues that were counted (`leaguesCounted`), so its sentence can name them.
- The list of teams known under several names is also given to the model in its prompt, for the queries it writes itself; a team renamed without being in `FRANCHISES` can still be missing, and the prompt asks the model to say so when an answer depends on a team's whole history.
