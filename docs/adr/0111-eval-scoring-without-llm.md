# The eval scores only what could run, and a gate that ran nothing fails

`bun run eval` (`scripts/eval.ts`) replays `eval/questions.json` with or without an OpenRouter key. Without a key the rules still route, but text-to-SQL and the LLM router cannot run, so the script separates what it can judge from what it cannot instead of counting unverified cases as passed.

## Rules

- The agent modules (`runAgent`, `getLlm`, `TOOLS`, `STEPS`) are loaded with dynamic `import()` after `--deterministic` has deleted `OPENROUTER_API_KEY` from the environment, so the LLM client never sees a key the run was told to ignore. Turning them into static imports would let the client read the key at module load.
- A case marked `llm` (its tool choice or entities need the model) cannot pass on the rules alone: without a key only what the rules decide is scored (entities, unread words), its route, input, notes and result checks are skipped (`noLlm` in `score`), and even when every scored check is right the case is listed as "needs the LLM" (`needLlm`, shown `~`) and left out of the score, never counted as passed.
- A case whose expected route is `sql` has no result without a key: its routing is still checked, its rows, totals, attempts and sources are skipped (`noResult`). Its summary checks (`summaryIncludes`, `summaryExcludes`) are skipped too, because a text-to-SQL summary only says what the query returned; for every other route the summary is checked as a routing check.
- A selection that keeps no case (`--only`, `--exclude-tags`, `--llm-only`) always exits 1, and `--strict` exits 1 when no case could be judged (all need the LLM): a gate that runs nothing must not pass. An unknown id in `--only` also exits 1.
- `--follow-ups` replays every follow-up question of the answers in deterministic mode only; with `--strict` it fails when one is not answered by a typed tool with every word read.
- `now` in `eval/questions.json` is the date relative seasons are resolved against ("l'an dernier"), so the expectations do not move with the calendar. It is passed to `runAgent` for every case and follow-up.
