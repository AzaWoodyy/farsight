# Console and chat engine: who holds the question and the state

`Console` (`src/app/agent-console.tsx`) is on the page before the chat engine is loaded, and the engine (`ChatEngine`) is mounted only while a question is shown. The console therefore keeps the question and the chat's last reported state itself, in one reducer: `screenAfter` in `src/app/console-screen.ts`.

`ChatEngine` (`src/app/chat-engine.tsx`) wraps the AI SDK's `useChat` without any markup. The console loads it apart from the home page, which then ships about half its JavaScript; the question typed before the engine was there is handed to it as `first`, with its answer when the console already has it (back to a question of this visit). Several of its lines exist because of how `useChat` and React behave when a page is left and shown again.

## Rules

- The console's screen is in one of three states: `home`; `question`, the question asked with the last state its chat reported (`IDLE` until it reports); `load_failed`, when the chat and answer modules could not be loaded for that question (its retry button asks it again). Every change is an event of `screenAfter`: `asked`, `restored`, `chat_changed`, `modules_loaded`, `modules_failed`, `home`. `isRunning` says when the agent is working: a question whose chat is `submitted` or `streaming`, or has reported nothing yet (no message and no error).
- The question of `question` and `load_failed` is the latest one asked, not only the first one. The chat gets it as `first` and reads it only when it mounts (and then sends it); for a later question the console calls `chat.current.ask` itself. It is also the question shown on screen until the chat has taken it in.
- `chat_changed` changes nothing outside `question`. A page shown again after another one runs the chat's effects again, and they report its last state once more: on the home screen that would show the previous answer.
- `asked` starts from `IDLE` whether a chat is mounted or not: the new run starts from nothing, not from what was last shown, and the chat's next report replaces it.
- `home` drops the chat's state with the question: the chat unmounts with it, so it can no longer report an empty state, and its last one would otherwise stay on screen.
- `modules_failed` only matters while a question is shown, and `modules_loaded` takes a `load_failed` question up again: the chat, now mounted, sends it. A failure while on the home screen changes nothing; the next question loads the modules again.
- The agent does not use the chat history: `ask` empties the messages (`setMessages([])`) before each question. Do not send earlier messages.
- The transport's `fetch` is `askFetchIn(locale)`: a non-2xx answer (a 429 from the firewall rate limit, a 403 from BotID…) becomes a readable error in the language of the page, instead of the raw response body the transport would show.
- There is one `DefaultChatTransport` per language, built once at module load (`transports`): `useChat` keeps the transport it was first given, so one built during render would be ignored after the first.
- The transport's option is typed `typeof fetch`, which also carries `preconnect`; the wrapper is given that property with `Object.assign` only to satisfy the type.
- The engine's own lifecycle is one ref, `phase`: `new` until its first effect runs, `shown`, then `left` once that effect's cleanup ran because the page was left for another one. `ask`, `show` and `reset` set it back to `shown`.
- The first question is sent once per mount, when `phase` leaves `new`, and not once per run of the effect: a page left for another one keeps its state and runs its effects again when it is shown again, so "once per run of the effect" would ask twice.
- When the page is left, `useChat` stops the request that was running, and nothing says so when the page comes back. `current` keeps the question the chat is on; when the page is shown again (`left`, nothing running), a question left without its `data-answer` part and without an error is asked again, instead of a trace that stays unfinished on screen.
