# How the typed tools build and run their SQL

Each typed tool has one plan query and, while formatting, a few helper queries. Only the plan query is checked by the schema guard; the helpers are written by hand, parameterized, and trusted.

## Rules

- The SQL returned by a tool's `plan` goes through `guardQuery` in `src/lib/agent/run.ts` before it runs. Queries issued from `format` and its helpers with `selectAll` / `selectOne` (for example `rosterTournaments`, `teamSeries`, `championProfile` in `src/lib/agent/tools.ts`) do not: they are trusted helper queries and may read base tables such as `games`, `leagues` or `game_riot`. They must stay fully parameterized and never embed text from the question.
- `inList` returns the literal `NULL` for an empty list of values, so the clause reads `x IN (NULL)`, which matches nothing. An empty `IN ()` is a syntax error in Postgres, and dropping the clause would match everything.
