# Rules of the execute and format steps

`src/lib/agent/run.ts` runs the plan, corrects it and writes the answer. A few of its lines look removable or simplifiable and are not.

## Rules

- An alias shared by several players is never a silent pick: `ambiguityNotes` writes a note naming the candidates and proposes the question again with the others as follow-ups.
- In `attempt`, the guard allows generated SQL the `v_*` views only (`VIEWS`), while typed tools also read small lookup tables (`ALLOWED_OBJECTS`).
- The bare `llmSignal()` call before the query in `attempt` is there for its throw: it throws when the request was cancelled, so no SQL runs for a visitor who left.
- In `execute`, an empty generated query whose scope explains it (`explainEmpty` conclusive) stops the loop: another query would come back empty too. A typed tool stops there only when its scope holds no game at all (`no_games`) and before any relaxation: its relaxations would answer for a period or a competition not asked. Otherwise a typed tool is explained once its relaxations are spent (`format`).
- An empty result after the last attempt is no failure of the query: the step ends as `warn`, not `error`, and the answer says what the scope holds.
- `llmSummary` sends only the tool's facts to the model, never the raw rows: the rows carry no scope (a 10-1 row is one Worlds edition, not "this season"), so the model could misread them.
- When the model's sentence claims more than the facts (`claimsBeyondFacts`), `llmSummary` throws instead of returning null, so that the trace shows why the template sentence was kept.
- `emptySummary` without a plan speaks in the visitor's words; which part of the agent gave up (no typed tool, no model for the generated query) is in the trace, for who opens it.
- Player profiles and team badges are computed on the scope the answer ran on, not the one asked: `answerProfiles` takes the bound call's input, and the period of the answer is the one the tool chose (`out.period`), else the one it ran on (a relaxation may have widened the one asked), else the question's.
