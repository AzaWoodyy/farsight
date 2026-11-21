# Answer card: what it draws and how it is remembered

The card of a link preview (`src/lib/agent/share.ts`) is built from a finished answer by `cardOf` and remembered per question by `rememberCard`, so that the page's metadata, its image and every crawler opening the same link share one pipeline run.

## Rules

- `SENTENCE_END` finds the end of the first sentence of the summary: a period followed by a capital letter or a number, or by the end of the text, so "Gen.G" and "66.7 %" do not end it. Two periods are followed by such a character without ending anything and are excluded by lookbehinds: the rank of a list (": 1. PSG Talon, 2. T1"), which a ranking's summary writes after a separator, and an abbreviated French month ("9 nov. 2025").
- A single series that was a forfeit has no score to draw: the card keeps the series label as its heading (the title names the winner) and no `duel`.
- For a history answer the figures (tournaments, wins-losses) come from the tool's own totals (`meta.totals`), the ones its summary writes, and are never recounted from `answer.rows`: a tournament played for two teams is two rows, so counting rows gives a different number from the sentence beside it.
- `rememberCard` keeps the promise, so concurrent readers share one run. A computation that throws is forgotten (its entry is deleted, and only if it is still the current one) and reads null: the link falls back to the site's card and the next request tries again, instead of an error being served for five minutes.
- The table holds at most `MAX_CARDS` (500) entries and evicts by insertion order. An expired key is deleted before it is set again: `Map.set` on an existing key keeps its old position, so without the delete a freshly recomputed card would be the next one evicted.
