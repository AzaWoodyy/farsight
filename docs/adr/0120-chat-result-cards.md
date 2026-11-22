# Result cards of the conversation are built on the server, apart from the answer views

A result in the conversation is a compact card: a title, one or two subjects, a few key figures, then bars or a short table. It is built on the server by `chatCard` in `src/lib/agent/chat-card.ts` from the pipeline's `Answer`, and it is not one of the answer views of the question page (`src/app/answer-view.tsx`): those views fill a screen, and a thread of messages needs something that reads in a few lines.

## Rules

- The card is plain data (`ChatCard`, `src/lib/agent/chat-types.ts`): the browser draws what it is given and decides nothing about the answer. The answer views and their modules are not loaded by `/chat`.
- The card travels in the `data-answer` part and is stored with the conversation, so a saved conversation is drawn again without asking the agent.
- `plainCard` picks the card from the shape of the answer, in a fixed order (results by edition, champion pool, head-to-head, player comparison, roster, champion, runes, series, scoreboard, timeline), and falls back to the answer's table. An answer with none of them has no card: the visitor then reads the agent's sentence alone.
- A card holds bars or a table, not both. Bars are capped at `CARD_BARS` (8); a table at `CARD_ROWS` (40) rows and `CARD_COLUMNS` (6) columns, with `total` keeping the real number of rows so the page can say how many it shows.
- A column is numeric when every cell of it reads as a number (`NUMERIC`); the page aligns it and writes its figures in the language of the page.
- Texts of a card are written in the language of the page with `say(fr, en)`, under `withLocale`: the card is built on the server, where the language is the request's.
- Subjects are the players of the answer when there are at most `CARD_SUBJECTS` (2), the two teams of a head-to-head, the team of a roster, or the champion.
- `icons` holds only the images of names the card shows (a cell of its table, a label of its bars): the answer knows every image of the question, and sending them all would weigh on each stored conversation.
- Images follow the rule of the rest of the site: the card carries the URL the answer already had (Fandom's CDN, Data Dragon) and the browser loads it. Nothing is copied.
- A `run_sql` or `league_paths` result is a table card (`tableCard`) under the title the tool gave, with Leaguepedia as its source. A pipeline result lists at most 8 of the answer's sources.
