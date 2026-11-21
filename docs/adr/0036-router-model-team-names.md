# Team names written by the router model are normalized, within limits

The LLM router writes tool inputs itself and does not always use the name the database holds. Each tool's `normalize` (`src/lib/agent/tools.ts`) resolves team names through `resolveTeam` before the tool is bound.

## Rules

- The model may write an old name of a franchise: the input then carries the current one. `team_roster` given "Samsung Ozone" runs on "Samsung White"; `head_to_head` given "MAD Lions KOI" and `team_history` given "MAD Lions" run on "Movistar KOI".
- The model may write only the end of a team's name: for a team with games, the end of exactly one team's name resolves it ("Blue Stars" is Karmine Corp Blue Stars), never a one-word or shared end ("Stars").
- A team known only from the schedule (`series_results`, no scoreboard game) is not resolved that way: "Gaming Youth" does not name Sandbox Gaming Youth, and an everyday word ("red" for the team Red) never does. Such a team is read by its full name alone (`scripts/schedule-series.test.ts`).
