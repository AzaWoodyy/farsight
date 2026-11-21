# The LLM's summary is checked against the facts it was given

The model only rephrases facts the tools computed. `claimsBeyondFacts` in `src/lib/agent/summary.ts` rejects a rephrasing that says more than those facts, and the template sentence is used instead. The check is deliberately strict where it cannot prove a claim.

## Rules

- A rephrasing may omit facts, but may not permute or invent their numbers: the numbers of the text must appear in the facts in the same order (a subsequence), with decimal commas and the typographic minus normalized.
- A free paraphrase cannot prove which metric owns a number. So as soon as the text contains a digit, its numeric wording must be found in the facts as written (only punctuation and decimal commas may change); otherwise it is rejected rather than guessed at. Loosening this to "the numbers match" lets the model attach a right number to the wrong statistic.
- Names and acronyms (any capitalized word) must already occur in the facts or in the question. Words a sentence starts with, in French and in English (`STARTERS`: "Le", "Les", "The", "Over"…), are capitalized by grammar, not names, and are exempt; a new common sentence opener belongs in that list rather than in a looser regex.
- Periods ("saison", "this year", "currently") and interpretations ("meilleur", "record", "majority", "dominates") are rejected when the facts do not contain them.
