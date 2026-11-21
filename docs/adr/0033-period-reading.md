# The period of a question is read by the rules, not by the LLM

A question can date itself with written years or with a season relative to today. `detectPeriod` and `buildEntities` in `src/lib/agent/understand.ts` resolve both; the LLM's own years are only a fallback.

## Rules

- `RELATIVE_YEARS` turns "l'an dernier", "last season", "cette saison", "this year" into an offset in years from `now`: a League of Legends season is a calendar year, so a season and a year are the same thing here.
- In `buildEntities`, a period the rules read (written years, or a relative season resolved against `now`) always wins over the `yearFrom` / `yearTo` the LLM extracted: the model does not know today's date and would date "last year" from its training data. The LLM's years are used only when the rules found none.
