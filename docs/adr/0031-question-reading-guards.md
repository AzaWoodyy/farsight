# Words of a question that are never read as a player, team or champion

Many player handles are everyday words, stat words or role words (Solo, Last, Mid, Life, Paris, Top). The rule-based detection in `src/lib/agent/understand.ts` therefore blanks out whole phrases before any alias lookup, and reads a doubtful handle only when the rest of the question is about esports. Removing one of these guards makes a normal question resolve to an obscure player.

## Rules

- `OUT_OF_SCOPE` names competitions and games outside the fixed scope (LLA, TCL, LMS, Valorant, TFT, Wild Rift…) explicitly, so the agent answers "not covered" instead of answering about something else it did recognize in the question.
- `TERM_PHRASES` (stat and game terms) are blanked by `maskTerms` before alias lookups: in "solo kills" the word "solo" is part of the term, not the player Solo. A handle used on its own ("Solo aux Worlds") is still resolved, which is why whole phrases are masked and not single words.
- `ROLE_PHRASES` are masked the same way: "adc" and "mid" are also player handles.
- `SUPERLATIVE_PHRASES` masks a superlative only right before what it ranks: "pires champions" is not the player Pires, while "Worst aux Worlds" still is the player Worst.
- The relative-season patterns of `RELATIVE_YEARS` are masked too: "last" (in "last season") is also a handle.
- The LLM level goes through the same guard (`onlyInTerms` in `llmDecider`): the model may still copy a term's word as a name ("solo" in "solo kills"), and such a mention is dropped.
- In `detectMentions`, a league written by its full name ("Liga Española de League of Legends") is blanked before mentions are read: its words are no player or team.
- Precedence on the same words in `detectMentions`: the longest n-gram wins; a champion wins over a player ("Ahri"); a team wins over a player when it is a curated shorthand or has at least as many games as the most played player of that alias.
- A handle that is also an everyday word ("Paris", "Life") or has three Latin characters or fewer ("Bin"), per `isCommonHandle`, names a player only in a question about esports (a team, a champion, another unambiguous player, a league, a term, a role, a metric, a word of `STAT_WORDS` as in "KDA de Life", or `LOL_DOMAIN`), or when the question says nothing else ("résultats de Knight"). It is not read in "la météo à Paris". A player written by their full Leaguepedia page is exempt.
- Next to a team, "top", "sup" or "jg" (`SHORT_ROLE_MENTION`) name the team's player at that role ("top fpx 2019"), not the handles Top or Sup.
- `detectMentions` returns players and teams in the order of the question, not of detection (longest n-gram first): the order decides the sides of a head-to-head.
- `maskUnderstood` rebuilds each mention as a pattern from its tokens, with any run of spaces or apostrophes between them, because "Kai Sa" was written "Kai'Sa" in the question; it matches whole words only, so that the team "TL" is not found inside "botlaner".
