# Checks on what the LLM router and the SQL generator return

The LLM picks a tool or writes SQL when the rules are unsure (`llmRouter`, `textToSqlDecider`, `llmCorrector` in `src/lib/agent/query.ts`). Its output is checked against the data before it is used.

## Rules

- `groundLeague`: when the understand step read no competition and the question names a player or a team, the router sometimes fills the competition from what it remembers of them ("Rooster team 2026" → LCK, where he no longer plays), and the query returns nothing. Such a competition is kept only when one of the names has a game in it over the period asked; otherwise the call goes back to the rules' competition (same tool) or to every competition, and the one removed is reported. A tool that needs a competition and has none to go back to gives no call: the pick is declined. With nobody named, or no game at all over the period, the competition stays: the data does not contradict it.
- In `groundLeague`, a competition equal to the rules' own default (the Worlds for a player's history) is kept: the router did not add it, and the rules' note already says so.
- AI SDK marks unknown or unparsable tool calls as `dynamic`: they are treated as "no tool", which means text-to-SQL.
- When the LLM confirms the rules' tool, the rules' notes (a default competition…) still hold and are kept on the plan; they are dropped only when it picks another tool.
- `ALWAYS_FALSE` (`0 = 1`, `WHERE false`): a generated query with an always-false predicate states a figure without reading any data; `generatedGaps` treats it like an empty query, as missing data.
- A repair that comes back with `missing` or a query that reads nothing is no repair: `llmCorrector` returns null rather than turn a failing query into a "data absent" answer.
