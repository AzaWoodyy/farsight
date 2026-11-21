# What a ranking sorts by, and what it refuses

The ranking tools (`champion_ranking`, `player_leaderboard`, `team_leaderboard`) sort on one criterion read from the question (`src/lib/agent/query.ts`). When the question asks for something the tool cannot sort by, the router sends it to generated SQL rather than return a plausible ranking that answers another question.

## Rules

- The cue lists are ordered most specific first and the first match wins: `CHAMPION_SORT_CUES` ("meilleurs champions", "forts", "pires" mean the win rate, last in the list), `PLAYER_CRITERION_CUES` (KDA when the question names none, `playerCriterionOf`), `TEAM_CRITERION_CUES` (no default: without one of its words, "meilleures équipes" stays with the standings).
- The champion ranking and the player leaderboards only rank from the highest down. "champions les moins joués", "champions avec le pire winrate", "pires joueurs", "worst mids" go to generated SQL: the highest would be the opposite answer.
- `LOWEST` excludes "au moins" and "at least" by lookbehind: "au moins 10 picks" is a minimum, not a lowest figure.
- `WORST` ("pires", "worst") is kept apart from `LOWEST` for players: "le moins de morts" stays a criterion of the player leaderboard, only a bare superlative of the bottom is refused.
- A question that names a figure the champion ranking cannot sort by ("quel champion a le plus de pentakills" when no total applies) goes to generated SQL: a ranking by presence would answer another question.
- `CHAMPION_OTHER_FIGURES` (dragons, barons, towers, duration) are figures of a game, not of a champion's line: no per-game average or total of the ranking answers them, so they block the average, total and extra sorts.
- A total is asked by "le plus de morts" without "par partie", "le plus de pentakills", "le plus de solo kills" (`championTotalSortOf`). A first blood is a share of games unless the question says a total in so many words ("nombre de first bloods", `TOTAL`).
- The champion ranking holds the lane figures of the Riot data at 15 min only (`CHAMPION_INGAME_SORT`: `gold_diff_15`, `cs_diff_15`, `xp_diff_15`); a snapshot at another minute goes to generated SQL.
- The tools' minimum sample is inclusive, so `minimumOf` adds one for a strict wording (`STRICT`): "plus de 50 parties" is 51 or more.
- A champion's games are its picks: for `champion_ranking`, "plus de 4 parties" is a minimum of 5 picks (`minPicks` falls back on the games wording).
- "part des dégâts de leur équipe" names a criterion of the players (`dmg_share`, `gold_share`), not a ranking of teams: `withoutTeamShare` removes those phrases before `TEAM_WORDS` is tested.
- A worst-players question on a figure of the Riot data, in a scope that has none (the LPL), answers that the data is absent rather than falling to generated SQL for a ranking.
