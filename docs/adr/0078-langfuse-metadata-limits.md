# What Langfuse metadata can carry, and what is masked first

Trace metadata is what the Langfuse filters and `bun run eval:candidates` read back, and Langfuse silently loses values that do not fit its limits. `src/lib/agent/trace.ts` shapes the values so they survive, and masks personal data before anything derived from the question is sent.

## Rules

- Langfuse drops a propagated metadata value longer than 200 characters, so the question propagated to every observation is cut to `QUESTION_MAX` (200) in `traceQuestion`. Raising it loses the `question` metadata altogether on long questions.
- A metadata value that is a list of objects does not survive the Langfuse export. `stepLog` therefore writes the step as the UI showed it as one text, one line per entry (status, decision level and confidence, title, detail), not as an array of entries.
- `unconsumedWords` masks personal data (`maskPersonalData`) before it splits the question into words: once split, the pieces of an email no longer match the mask and would be sent as plain words.
- `unconsumedWords` (the words no entity, competition or year accounts for) is kept in the `understand-question` metadata because, on the rules path, an unknown player leaves no other sign than its word there: it is not in `unresolved`.
