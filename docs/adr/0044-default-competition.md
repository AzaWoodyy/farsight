# The competition used when the question names none

A question without a competition does not always mean "everything". The router picks a default per tool (`src/lib/agent/query.ts`) and says so in a note.

## Rules

- Rankings (`player_leaderboard`, `champion_ranking`, `team_leaderboard`) default to the World Championship: the level of the field decides who is "best", and mixing leagues would rank players of weaker fields first.
- A champion matchup (`matchupRoute`) covers every competition unless the question names one: a matchup has few games.
- `tournament_standings` shows the full standings (`full`) only for one year of a competition with one edition a year: the international events (`LEAGUES[].international`) and the KeSPA Cup; another league needs a split as well.
