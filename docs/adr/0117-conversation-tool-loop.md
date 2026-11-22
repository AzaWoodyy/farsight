# The conversation is a tool loop beside the four-step pipeline

`/chat` and `/en/chat` talk to `streamChat` in `src/lib/agent/chat.ts`: one AI SDK `streamText` call that keeps the thread of the conversation and reaches the data through four tools. The four-step pipeline of the question page (`runAgent`) is unchanged; the loop calls it as a tool instead of replacing it, so a conversation answers with the same typed tools, the same SQL guard and the same figures as a question.

A question such as "teams that went from a second division to the LEC" used to get an off-topic ranking from a typed tool, then "the data does not hold it". Most rules below exist so that the model checks what a tool returned and writes its own query before it gives up.

## Rules

- The loop has four tools: `ask_data` (one standalone question handed to `runAgent`, in the language of the page), `league_paths` (teams' paths between leagues, computed by the code, [0124](0124-league-paths-tool.md)), `run_sql` (the model's own query) and `render_html` (a composed view, [0119](0119-agent-html-views-sandboxed-frame.md)).
- The conversation needs the model: without it `/api/chat` answers 503, where `/api/ask` falls back to the rules. A turn runs at most `CHAT_STEPS` (6) model steps and `CHAT_OUTPUT_TOKENS` (4000) output tokens, and a message is at most `CHAT_MESSAGE_MAX_LENGTH` (500) characters.
- `run_sql` goes through the same two barriers as the pipeline's text-to-SQL: `guardQuery` on the `v_*` views, then `executeGeneratedQuery` as `farsight_sql`. A query the guard refuses comes back to the model as a refusal with its reasons, never as an error of the turn.
- The model does not get the answer the visitor sees but a digest of it (`digestAnswer`): the answer as JSON without what only the page draws (icons, photos, logos, URLs, sources, follow-ups), cut at `DIGEST_MAX_LENGTH`, with the tool the router picked (`route`) and the words of the question it did not read (`wordsNotRead`) first.
- The prompt asks the model to check every `ask_data` result against the question, from `route` and `wordsNotRead`: a result about something else did not answer, and the model then writes `run_sql` with `replacesEarlierResult` instead of presenting it.
- The model says that the data does not hold something only after a `run_sql` came back empty, or when no view has a column for it. A question the typed tools do not cover is a reason to write SQL.
- The same question asked twice in one turn runs once (`sameQuestion`): the second call gets the first digest and a reminder that the visitor already sees it.
- A turn shows one query result. A `run_sql` result removes the earlier query results of the turn, and with `replacesEarlierResult` the `ask_data` results too; a `league_paths` result removes every earlier result. Several `ask_data` cards of one turn stay together: that is how the model gathers a comparison.
- A result is removed by writing its data part again under the same id with no card and no sources (`removed`): the stream can only add or replace parts.
- A `run_sql` call marked `exploratory` (listing names, checking a value before the real query) comes back to the model and is not shown.
- The prompt lists the leagues of the scope with their tiers by region and the teams known under several names (`renamedTeams`), because the model's own queries otherwise miss a renamed team or search a league by its short name.
- The language of the reply is the page's (`locale` in the body, as for `/api/ask`). It is repeated as the last rule of the prompt: the instructions and the tool results are in English or in the other language, and the model followed them without that reminder.
- The model writes plain text without Markdown, nothing before or between tool calls, and one or two sentences after them: the visitor already sees the card.
- `/api/chat` applies the request policy and the per-instance counter of `/api/ask` (`requestPolicy(req, "ask")`), then the account check, then BotID, before any model call.
