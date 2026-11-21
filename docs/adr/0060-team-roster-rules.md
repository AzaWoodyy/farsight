# Which season a roster shows and who counts as a starter

The database only knows players who appeared in a game, with no roster table. The `team_roster` tool derives the roster and its starters from the games, with two rules a reader would not guess.

## Rules

- Without a period, `rosterSeason` in `src/lib/agent/tools.ts` picks the team's latest season within the scope asked (competition and split included), read from the database rather than from the current date, so a team that stopped playing gets its last season. A period given by the question is kept as is. The answer says which season was chosen.
- The starters of a role are its players with the most games; two players are both starters when they split the games evenly (`p.games === top.get(p.role)`).
