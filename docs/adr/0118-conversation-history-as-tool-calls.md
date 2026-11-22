# Earlier turns reach the model as real tool calls

The server keeps nothing between two turns of a conversation: the browser sends the messages back with each request, and `modelHistory` in `src/lib/agent/chat.ts` rebuilds what the model reads from them. An earlier result is rebuilt as a tool call followed by its tool result. Written as text between brackets in the assistant's message, it was copied by the model, which then wrote "results" of its own in the same form instead of calling a tool.

## Rules

- The digest of a result travels with its data part (`data-answer`, field `digest`): the browser stores it with the message and sends it back. It is what the model read the first time, so the rebuilt turn says the same thing.
- A `data-answer` part with a digest becomes a call to `ask_data` with the question asked, or to `run_sql` when the result came from a query (`via: "sql"`, which also covers `league_paths`), followed by a tool result holding the digest. A `data-html` part becomes a call to `render_html` and "The view is displayed to the visitor."
- The rebuilt calls carry placeholders for what the model does not need again (`SELECT 1` for the query, `<p>…</p>` for the view): the query is not run again and the view is not drawn again.
- A digest is cut to `HISTORY_DIGEST_MAX_LENGTH` (6000) in the history, half of what the turn that produced it read.
- A result without a digest (still pending, or removed from the screen) is not rebuilt.
- Only the last `CHAT_HISTORY_MESSAGES` (12) messages are sent to the model, starting at the first message of the visitor among them: a history never opens on a tool result or on a reply without its question.
- What comes back from the browser is the visitor's own input and is bounded like one (`ChatMessages`): 200 messages, 40 parts per message, the question and the digest capped in length. Anything else in a part is ignored.
- The text of an assistant message comes after its tool calls, as in the turn it retells.
