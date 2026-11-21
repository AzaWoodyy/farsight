# Saying when a ranking covers an edition still being played

The database is refreshed daily, so a ranking can cover a tournament in progress. The tools then say their figures stop at the games played so far.

## Rules

- `inProgressNote` in `src/lib/agent/tools.ts` treats an edition as in progress when its standings have no champion yet (no `place_number = 1` in `v_tournament_results`) and its last game is within `IN_PROGRESS_DAYS` (30) of the newest game of the database. The reference is the newest game in the data, not the current date, so tests and a stale database behave the same; an old group stage that never got a winner on Leaguepedia is not reported as in progress.
