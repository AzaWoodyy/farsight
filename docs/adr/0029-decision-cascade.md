# Decision cascade: rules first, the LLM only when they are not confident

Each of the four steps of the agent takes its decisions through one mechanism, `decide()` in `src/lib/agent/decide.ts`. A decision point lists its deciders from cheapest to most expensive: `rules` (regex, alias table, typed query templates: free, about 1 ms), then `llm` (OpenRouter), called only when the cheaper level is not confident enough. This keeps most questions free and deterministic, and lets the agent work without a key.

## Rules

- `decide()` runs the deciders in order and stops at the first result whose self-reported confidence reaches the threshold (0.75 by default). When nobody reaches it, the most confident result wins: a low-confidence rule still beats no answer.
- A decider that is unavailable (no key, no model) returns null, and one that throws is recorded as a failed attempt; in both cases the cascade moves on to the next decider.
- A cancelled request is not a failed decider: when `requestAborted()` is true the error is rethrown, which stops the cascade and the whole pipeline instead of falling through to the next decider.
- `requestAborted()` (`src/lib/agent/llm.ts`) is true only once the request itself was cancelled (client gone or stop pressed). It is not a per-call LLM timeout: a call that times out (`LLM_CALL.timeoutMs`) is an ordinary failed decider and the cascade continues.
