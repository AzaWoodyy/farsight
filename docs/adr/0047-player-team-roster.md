# Finding the team of a player for a roster question

"Rooster team 2026" or "coéquipiers de Faker en 2017" name one player and no team: the router looks up the team the player last played for in the scope (`coverageLookup().playerTeam`, `playerTeamRoute`, `src/lib/agent/query.ts`) and answers with its roster.

## Rules

- Without a competition asked, the lookup leaves out the competitions a roster leaves out (`ROSTER_EXCLUDED`): they do not name the player's team (a T1 Academy player at the KeSPA Cup).
- The lookup reads only the stages the roster counts (`main_event`, `play_in`, `season`, `playoffs`), latest team first, so the team found has a roster in the scope.
- The roster merges the names of one franchise (SK Telecom T1 → T1): those names are removed from the "other teams" of the player (`resolveTeam(...).members`).
- Without a period asked, the roster is the one of the season of the player's latest game: a player who left keeps the roster they were in.
- The roster words are read on the question without the player (`maskUnderstood(...).rest`): "Rooster" is not a roster word.
- A word about what the team did (`TEAM_RESULTS`: results, titles, placements) keeps the player's history: the question is about the player's team's record, not who was in it.
- "which team" is a membership question only with `PLAYS_FOR` ("dans quelle équipe", "which team did Faker play for", "quelle équipe était"); "which team beat Faker" and "which team did Faker play in the final" ask for an opponent.
- The route is taken only when the roster reads every word of the question (`unreadWords(...).words.length === 0`): "did Faker's team qualify" or "which team was Faker facing" ask something else about the team.
