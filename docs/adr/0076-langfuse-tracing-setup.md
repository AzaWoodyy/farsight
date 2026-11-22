# Langfuse tracing: where it is registered and how it is tested

Tracing is a process-wide singleton started from the route that runs the agent, not from Next's instrumentation hook, and its tests have to work around that singleton.

Tracing (`src/lib/tracing/langfuse.ts`) exports one trace per question to Langfuse through OpenTelemetry, and is off (every span a no-op) unless `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` and `LANGFUSE_BASE_URL` are all set; `LANGFUSE_SAMPLE_RATE` (0 to 1, default 1) is the share of questions traced. The promise that no IP, cookie or header reaches a trace rests on how the provider is wired, not on what the agent chooses to record.

## Rules

- `startTracing()` is called at module level in `src/app/api/ask/route.ts`. A registration made in `instrumentation.ts` did not reach the module instances the route runs the agent with (Next loads them separately), so no span was exported. Do not move the call back to an instrumentation file.
- The "tracing stays off without the three `LANGFUSE_*` variables" test in `scripts/tracing.test.ts` spawns a fresh process (`spawnSync`) instead of asserting in the test process: the other tests initialize the singleton, so only a new process proves the off state independently of it.
- The Langfuse SDK exports each metadata value JSON-encoded, as the span attribute `langfuse.observation.metadata.<key>`. A test (or any reader of exported spans) must `JSON.parse` the attribute to get the value Langfuse shows, as the `meta` helper of `scripts/tracing.test.ts` does.
- The tracer provider is not registered globally: it is handed to Langfuse alone (`setLangfuseTracerProvider`). Only the agent's spans and the AI SDK's model calls reach Langfuse, never Next.js' own request spans, which carry URLs and headers. Registering it as the global OpenTelemetry provider would export them.
- The context manager, in contrast, is global (`context.setGlobalContextManager` with `AsyncLocalStorageContextManager`): spans nest through the active context, and without a context manager every observation would be a root span instead of a child of its question's trace.
- Every text attribute of a span is masked by `MaskingSpanProcessor` before the Langfuse processor sees it. The Langfuse processor's own `mask` option is not enough: it only covers Langfuse inputs, outputs and metadata, and the prompt of an LLM call (`gen_ai.input.messages`) would go out as typed.
- `SEND_TIMEOUT_MS` (3 s) bounds a flush and a score request: Langfuse being slow never holds a function open. `flushTracing` races the flush against it and never throws.
- A thumbs up / down is a boolean score with a stable id, `<FEEDBACK_SCORE>-<traceId>` (`sendFeedback`): a second click on the same answer replaces the first score instead of adding one.
- `src/app/api/chat/route.ts` calls `startTracing()` at module level too, for the same reason: the conversation runs the agent from its own route ([0077](0077-langfuse-trace-structure.md)).
