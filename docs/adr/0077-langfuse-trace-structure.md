# How a question becomes one Langfuse trace

Each question is one Langfuse trace whose shape is built by hand in `src/lib/agent/trace.ts`: a root observation, one observation per step, one generation per LLM call. The module never checks whether tracing is on, and several of its choices exist only because of how OpenTelemetry, the Langfuse SDK and the AI SDK behave.

## Rules

- `src/lib/agent/trace.ts` does not know whether tracing is on: without a provider registered by `src/lib/tracing/langfuse.ts`, every observation is a no-op. Do not add an "is tracing enabled" branch there.
- `traceStep` runs the step bare when there is no question scope (`scope.getStore()` is empty). The card of a link preview runs the same steps outside a question's trace; opening an observation there would start a trace of its own for every crawler hit.
- `traceQuestion` starts the root observation inside `context.with(ROOT_CONTEXT, …)`: the trace must never hang under a span of the web framework, or the question would stop being a root observation and its name, tags and filters would no longer apply.
- Tags are an attribute of the trace, not of an observation: `setTags` writes `LangfuseOtelSpanAttributes.TRACE_TAGS` on the root span, and it has to happen before that span ends. Every write includes the language tag (`localeTag`), because each write replaces the list.
- `traceQuestion` sets the tags once at the start, with the language alone, so a question that fails before `recordOutcome` still says which language it was asked in.
- In the `finally` of `traceQuestion`, every generation still in `Scope.calls` is ended as failed (`failGeneration`): a call the AI SDK never closed (aborted, timed out) gets no end event, and a generation left open would be lost or end outside its trace.
- `llmTelemetry` maps one AI SDK model call to one generation, named by its `functionId` and nested under the step that made it. The SDK's own retry of a call stays inside that generation; a query repair is a separate call with its own name (`repair-sql`). Calls made outside a question are not traced.
- `assistantMessage` writes the model's answer as a single assistant message with `tool_calls` in the OpenAI shape: that is the shape Langfuse renders as a conversation; raw AI SDK content parts are shown as JSON.
