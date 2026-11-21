# Console and chat engine: who holds the question and the state

`Console` (`src/app/agent-console.tsx`) is on the page before the chat engine is loaded, and the engine (`ChatEngine`) is mounted only while a question is shown. The console therefore keeps its own copy of the question (`first`) and of the chat's state (`chatState`), and a few assignments that look redundant are what keep the two in step.

`ChatEngine` (`src/app/chat-engine.tsx`) wraps the AI SDK's `useChat` without any markup. The console loads it apart from the home page, which then ships about half its JavaScript; the question typed before the engine was there is handed to it as `first`, with its answer when the console already has it (back to a question of this visit). Several of its lines exist because of how `useChat` and React behave when a page is left and shown again.

## Rules

- `first` is the latest question asked, not only the first one. The chat reads `first` only when it mounts (and then sends it); for a later question the console calls `chat.current.ask` itself. `setFirst` is still called on every question because `first.text` is also the question shown on screen until the chat has taken it in.
- The console reads `chatState` only while `first` is set (`first ? chatState : IDLE`). A page shown again after another one runs the chat's effects again, and they report its last state once more: without the guard, the home screen would show the previous answer.
- When a question is asked and no chat is mounted yet (the first question, or one asked after going back to the home screen), `ask` resets `chatState` to `IDLE`: the new run starts from nothing, not from what was last shown.
- `restart` resets `chatState` to `IDLE` as well as clearing `first`: the chat unmounts with `first`, so it can no longer report an empty state and its last one would otherwise stay on screen.
- The agent does not use the chat history: `ask` empties the messages (`setMessages([])`) before each question. Do not send earlier messages.
- The transport's `fetch` is `askFetchIn(locale)`: a non-2xx answer (a 429 from the firewall rate limit, a 403 from BotID…) becomes a readable error in the language of the page, instead of the raw response body the transport would show.
- There is one `DefaultChatTransport` per language, built once at module load (`transports`): `useChat` keeps the transport it was first given, so one built during render would be ignored after the first.
- The transport's option is typed `typeof fetch`, which also carries `preconnect`; the wrapper is given that property with `Object.assign` only to satisfy the type.
- The first question is sent once per mount, guarded by the `mounted` ref and not by the effect's dependency list: a page left for another one keeps its state and runs its effects again when it is shown again, so "once per run of the effect" would ask twice.
- When the page is left, `useChat` stops the request that was running, and nothing says so when the page comes back. The effect's cleanup sets the `left` ref, and `current` keeps the question the chat is on; when the page is shown again, a question left without its `data-answer` part and without an error is asked again, instead of a trace that stays unfinished on screen.
