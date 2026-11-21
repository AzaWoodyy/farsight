# Rankings only go from the highest down, and what their answers hand on must stay readable

The champion ranking and the player leaderboards sort in one direction, and their answers feed other parts of the app (follow-up questions, the views, the link preview). The router and the tools are written around those limits.

## Rules

- `champion_ranking` only ranks from the highest down. A question about the lowest ("champions les moins joués aux Worlds 2024", "least banned champions", "pires champions") is routed to generated SQL by `routeQuestion` (`src/lib/agent/query.ts`): sent to the typed tool, the least played would be answered by the most played. "au moins 10 picks" / "at least 10 picks" is a minimum (`minPicks`), not an order, and keeps the typed tool.
- `player_leaderboard` and `ingame_leaderboard` for players also only rank from the highest down: "worst players at Worlds 2024", "pire joueur de LEC 2025", "pires mids" go to generated SQL, or the worst players would be answered by the best. `team_leaderboard` is the exception, with an `order` input.
- The `focus` of a table (the ranked column) is read by name by the views and by the link preview, so it must be one of the table's columns in the language of the answer: an English table with a French focus has none. `team_leaderboard` on `winrate` has focus "win %" in English (`scripts/rankings.test.ts`).
- A follow-up question must only carry what the tool it leads to reads. `player_comparison` reads no split, so the follow-up of a Spring leaderboard is "Caps vs Humanoid en LEC en 2024", without the split.
- A follow-up that asks for a game recap from a series names both teams ("Récap de la game 5 de T1 vs KT Rolster, la finale des Worlds 2025"), so that `game_timeline` opens a game of that series and not another final.
