# Retry and resume code is checked against every fault schedule

Code that retries, resumes or merges state across runs (the Riot ingestion first) broke in ways no scenario test had written down: a game summarized although its upload failed, a count overwritten, a game omitted from a grouped answer and re-batched until it was given up. Each fix came with a test of the one sequence that had failed. A model checks the rules instead, on every sequence of faults up to a bound.

## Rules

- **The model runs the real code.** `explore` (`scripts/models/explore.ts`) runs a scenario again and again; at each point where the outside world could fail (a wiki request, an R2 read, write or list, the time budget), the scenario asks the schedule which outcome happens, and `explore` enumerates every combination, depth first, up to a fault budget. The faults are fakes of the outside world; the ingestion functions are the ones `data:fetch` runs.
- **Invariants are stated as sentences** (`holds(condition, sentence)`); a failure prints the schedule that breaks one, step by step, so the counterexample is the bug report.
- **Every model ends with a run without faults** and checks that the system converged: bounded faults must not leave work undone forever.
- **A model replaces the scenario tests it covers.** Tests that pinned the order of requests are gone; tests of what the model does not see (the HTTP of the R2 store, the 30-day recheck, the content of the merged summaries) stay.
- **Before a model is trusted, it must fail on the bugs of the past**: reverting a past fix (on the current code) must make it report the broken invariant. The pull request that adds or changes a model lists those replays.
- **Bounds stay small enough for every test run** (both orders, every push): three games, two faults, a few runs, a few seconds. A bound that makes `explore` pass its schedule limit fails the test instead of running for minutes.
