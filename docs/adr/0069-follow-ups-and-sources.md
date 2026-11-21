# How follow-up questions and source lists are chosen

A follow-up is a question the visitor can click, so it must route back to a typed tool with the scope the target tool understands. Source lists are capped, so the pages that justify a note must survive the cap.

## Rules

- `ingameFollowUp` in `src/lib/agent/tools.ts` always names a metric ("Solo kills de X", "First blood de X"): "stats in-game de X" alone was read by the router as a history of X.
- `ingameFollowUp.team` writes the team as the answers show it (`displayTeam`, no "(European Team)") with its punctuation removed ("KaBuM! Esports"), because that is the form the routing rules read.
- Follow-ups that lead to a history (`teamRoster.format`) or to a player comparison (`playerLeaderboard.format`) carry the competition and the period but no split: those tools read no split.
- `playerLeaderboard.format` proposes the gold difference at 15 min by role only when the scope has games with Riot data; in the LPL the follow-up would only say the data is absent.
- `series.format` asks a listed series again by its stage ("T1 vs Gen.G finale LCK 2024") so the follow-up routes back to the `series` tool.
- `playerRunes.format` puts the keystones in the first sentence of the facts: the first sentence is the description of a link to the answer.
- `eventSources` keeps the last `max` pages of its list. `lastPages` moves the pages that must be cited (the tournaments whose series are known only from the schedule) to the end so the cap does not drop them.
