# Per-request state travels in AsyncLocalStorage

Three things belong to one question and must reach every step and every cascade of the pipeline: the language of the answer, the cancellation signal, and the "rules only" switch of a link preview. They are carried by `AsyncLocalStorage` rather than by a parameter on each function or by module-level variables.

## Rules

- `requestLocale` (`withLocale`, `answerLocale`, `say`, `tr`, `msg` in `src/lib/agent/messages.ts`): the language of the answer follows the request through every step without a `locale` parameter on each function. Outside a `withLocale` run it is the default language (French).
- `requestSignal` (`withLlmSignal`, `llmSignal`, `requestAborted` in `src/lib/agent/llm.ts`): request-local cancellation reaches every cascade without global mutable state. A module-level signal would be shared by concurrent requests on the same instance, and one visitor pressing stop would cancel another's question.
- Code that runs outside the request's async context (a detached callback, a timer created before `run`) does not see these stores: it gets French, no signal and the LLM allowed.
