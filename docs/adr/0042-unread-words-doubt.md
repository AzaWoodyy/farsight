# A tool is put in doubt by the words it did not read

The rules find entities easily and intent less so. `routeQuestion` (`src/lib/agent/query.ts`) measures how much of the question the routed tool read and, above a threshold, hands the decision to the LLM router with the unread words, instead of answering another question with confidence.

## Rules

- `TOOL_WORDS` lists, per tool, the words it answers beyond the entities: the cues that route to it and the vocabulary of what it returns. A word outside them was not understood ("toplaner" for a team history, "bannis" for standings). A new cue or a new column of a tool must be added there, or well-read questions fall into doubt.
- Patterns are taken in list order and each removes what it matched: for `player_leaderboard` the roles come first, so that "meilleur top" is read as a role, not "meilleur" then a stray "top".
- `UNREAD_THRESHOLD` is 0.25: one unread word out of four meaningful ones is enough. On the eval questions the well-understood ones stay at 0.20 or less ("spring" for a champion's stats) and the misread ones start at 0.25 ("compare Caps et Perkz en LEC"). Re-check both groups before moving it.
- `UNSURE` is 0.5, chosen to be under the LLM router's threshold (0.8 in `buildQuery`) and under the confidence of a generated query (0.6), so either can replace the tool in doubt.
- A `forced` route keeps its confidence: its cue is explicit enough. The unread words are still kept on the route for the trace, the rules' pick stands.
- With two players, every word that sets two sides against each other (`OPPOSE`: "compare", "vs", "h2h", "confrontations", "ou", "meilleur"…) gives the same answer, the comparison: their games against each other when there are some, their statistics in the scope, and the list of those games. Such a word settles the route (`forced`), so the LLM router is not asked again. The same holds for two teams and their head-to-head (`teamsRoute`).
