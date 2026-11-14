import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { InMemorySpanExporter, type ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { generateText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import {
  executeReport,
  outcomeTags,
  recordOutcome,
  STEP_SPANS,
  TRACE_NAME,
  traceQuestion,
  traceStep,
  unconsumedWords,
  understandReport,
} from "../src/lib/agent/trace";
import type { Answer, Entities, QueryPlan, StepName, StepPart } from "../src/lib/agent/types";
import { FEEDBACK_SCORE, flushTracing, sampleRate, sendFeedback, shutdownTracing, startTracing } from "../src/lib/tracing/langfuse";

/** Conversation id as the browser makes it up. */
const SESSION = "2b6f0cff-4e0f-4e5c-9d2a-6a4b8f3c1d7e";

const QUESTION = "bilan de Chovy et Zzyzx aux Worlds, réponse à jean.dupont@example.com";

const entities: Entities = {
  players: [{ mention: "Chovy", player: "Chovy", matchedAlias: "Chovy", realName: null, nativeName: null, otherCandidates: [], ambiguity: null }],
  teams: [],
  champion: null,
  unresolved: ["Zzyzx"],
  league: "World Championship",
  leagueShort: "Worlds",
  leagueMention: "Worlds",
  yearFrom: null,
  yearTo: null,
  split: null,
  outOfScope: null,
};

const plan: QueryPlan = { intent: "sql", tool: null, sql: "SELECT 1", params: {}, attempt: 2, relaxed: [] };

function answer(meta: Partial<Answer["meta"]>): Answer {
  return {
    title: "Chovy — Worlds",
    summary: "Chovy a disputé 8 éditions des Worlds.",
    rows: [],
    table: null,
    timeline: null,
    scoreboard: null,
    versus: null,
    teams: null,
    champion: null,
    icons: {},
    profiles: [],
    sources: [],
    followUps: [],
    notes: [],
    meta: {
      route: "player_event_history",
      sqlAvailable: false,
      input: null,
      players: ["Chovy"],
      teams: [],
      champion: null,
      league: "World Championship",
      rowCount: 8,
      totals: {},
      ambiguities: [],
      attempts: 1,
      unread: [],
      ...meta,
    },
  };
}

function part(step: StepName, status: StepPart["status"], confidence?: number): StepPart {
  return {
    step,
    state: "done",
    status,
    title: `${step} terminé`,
    entries: [{ status, title: "décision", level: confidence == null ? undefined : "rules", confidence, at: "2026-11-14T00:00:00.000Z" }],
  };
}

const steps = (execute: StepPart["status"] = "ok", confidence = 0.9) =>
  new Map<StepName, StepPart>([
    ["understand", part("understand", "ok", confidence)],
    ["execute", part("execute", execute)],
  ]);

const noLlm = { calls: 0, errors: 0 };

/** Stands for the OpenRouter call: same model id, usage and billed cost as a real answer. */
const model = new MockLanguageModelV4({
  provider: "openrouter",
  modelId: "anthropic/claude-haiku-5.5",
  doGenerate: async () => ({
    content: [{ type: "text", text: '{"players":["Chovy"]}' }],
    finishReason: { unified: "stop", raw: "stop" },
    usage: { inputTokens: { total: 412, noCache: 412, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 38, text: 38, reasoning: 0 } },
    providerMetadata: { openrouter: { usage: { cost: 0.00061 } } },
    warnings: [],
  }),
});

/** The question as the route runs it, with one LLM call in the understand step. */
function runQuestion(outcome: Answer) {
  return traceQuestion(QUESTION, SESSION, async (traceId) => {
    const done = new Map<StepName, StepPart>();

    await traceStep(
      "understand",
      { question: QUESTION },
      async () => {
        await generateText({ model, prompt: QUESTION, telemetry: { functionId: "extract-entities" } });
        done.set("understand", part("understand", "warn", 0.7));

        return entities;
      },
      (e) => understandReport(QUESTION, e, done.get("understand")),
    );

    await traceStep(
      "execute",
      { sql: plan.sql, params: plan.params },
      async () => {
        done.set("execute", part("execute", "error"));

        return plan;
      },
      (p) => executeReport(p, 0, done.get("execute")),
    );

    recordOutcome(outcome, entities, done);

    return traceId;
  });
}

const attr = (span: ReadableSpan, key: string) => span.attributes[key];

/** A metadata value as Langfuse reads it back (the SDK exports each one JSON-encoded). */
const meta = (span: ReadableSpan, key: string) => JSON.parse(String(span.attributes[`langfuse.observation.metadata.${key}`]));

// Tracing off -------------------------------------------------------------------

test("without the three Langfuse variables tracing stays off", () => {
  // A fresh process proves the off state independently of the initialized singleton.
  const env = { ...process.env };

  for (const key of ["LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY", "LANGFUSE_BASE_URL"]) delete env[key];

  const result = spawnSync(process.execPath, ["-e", `
    import { langfuseConfig, startTracing, flushTracing } from "./src/lib/tracing/langfuse";
    import { traceQuestion } from "./src/lib/agent/trace";
    if (langfuseConfig() !== null || startTracing() !== false) process.exit(1);
    if (await traceQuestion("test", null, async id => id) !== null) process.exit(2);
    await flushTracing();
  `], { env, encoding: "utf8", timeout: 5000 });

  expect(result.status).toBe(0);
});

test("no score is sent while tracing is off", async () => {
  let called = false;

  const send = Object.assign(
    async () => {
      called = true;

      return new Response(null, { status: 200 });
    },
    { preconnect: fetch.preconnect },
  );

  delete process.env.LANGFUSE_BASE_URL;
  expect(await sendFeedback({ traceId: "a".repeat(32), value: 1 }, send)).toBe(false);
  expect(called).toBe(false);
});

// Signals ------------------------------------------------------------------------

test("sample rate: a ratio between 0 and 1, everything by default", () => {
  expect(sampleRate(undefined)).toBe(1);
  expect(sampleRate("")).toBe(1);
  expect(sampleRate("0.25")).toBe(0.25);
  expect(sampleRate("7")).toBe(1);
  expect(sampleRate("-1")).toBe(0);
  expect(sampleRate("abc")).toBe(1);
});

test("unconsumed words leave out entities, years and personal data", () => {
  expect(unconsumedWords(QUESTION, entities)).toEqual(["bilan", "aux", "réponse"]);
});

test("tags name what went wrong", () => {
  const none = { ...entities, unresolved: [] };

  expect(outcomeTags(answer({}), none, steps(), noLlm)).toEqual([]);
  expect(outcomeTags(answer({ route: "out_of_scope", attempts: 0, rowCount: 0 }), none, steps(), noLlm)).toEqual(["out-of-scope"]);
  expect(outcomeTags(answer({ route: "missing_data", attempts: 0, rowCount: 0 }), none, steps(), noLlm)).toEqual(["missing-data"]);
  expect(outcomeTags(answer({ route: "none", attempts: 0, rowCount: 0 }), none, steps(), noLlm)).toEqual(["no-query"]);
  expect(outcomeTags(answer({ attempts: 3, rowCount: 0 }), none, steps("error"), noLlm)).toEqual(["empty-result", "error", "self-corrected"]);
  expect(outcomeTags(answer({ route: "sql" }), entities, steps("ok", 0.6), { calls: 2, errors: 1 })).toEqual([
    "sql-fallback",
    "llm",
    "llm-error",
    "low-confidence",
    "unresolved-mention",
  ]);
});

// Exported spans -----------------------------------------------------------------

let exporter = new InMemorySpanExporter();
const originalExport = exporter.export;
const envKeys = ["LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY", "LANGFUSE_BASE_URL", "LANGFUSE_SAMPLE_RATE", "LANGFUSE_TRACING_ENVIRONMENT"] as const;
let savedEnv: Partial<Record<(typeof envKeys)[number], string>>;

beforeEach(async () => {
  await shutdownTracing();
  exporter = new InMemorySpanExporter();
  savedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  Object.assign(process.env, {
    LANGFUSE_PUBLIC_KEY: "pk-test", LANGFUSE_SECRET_KEY: "sk-test", LANGFUSE_BASE_URL: "https://langfuse.test",
    LANGFUSE_SAMPLE_RATE: "1", LANGFUSE_TRACING_ENVIRONMENT: "development",
  });
  exporter.export = originalExport;
  exporter.reset();
  startTracing(exporter);
});

afterEach(async () => {
  await flushTracing();
  exporter.export = originalExport;
  exporter.reset();

  for (const key of envKeys) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});


test("a question is one trace: root, step observations and the LLM generation", async () => {
  expect(startTracing(exporter)).toBe(true);

  const traceId = await runQuestion(answer({ route: "sql", attempts: 2, rowCount: 0 }));

  await flushTracing();
  const spans = exporter.getFinishedSpans();
  const named = (name: string) => spans.find((s) => s.name === name)!;
  const root = named(TRACE_NAME);
  const understand = named(STEP_SPANS.understand);
  const execute = named(STEP_SPANS.execute);
  const generation = named("extract-entities");

  // One trace, started from scratch, whose id is the one the UI scores.
  expect(traceId).toBe(root.spanContext().traceId);
  expect(new Set(spans.map((s) => s.spanContext().traceId)).size).toBe(1);
  expect(root.parentSpanContext).toBeUndefined();
  expect(understand.parentSpanContext?.spanId).toBe(root.spanContext().spanId);
  expect(execute.parentSpanContext?.spanId).toBe(root.spanContext().spanId);

  // Root: question in, summary out, tags and metadata to filter on.
  expect(attr(root, "langfuse.observation.type")).toBe("agent");
  expect(attr(root, "langfuse.observation.output")).toBe("Chovy a disputé 8 éditions des Worlds.");
  expect(attr(root, "langfuse.observation.level")).toBe("ERROR");
  expect(attr(root, "langfuse.trace.tags")).toEqual(["empty-result", "error", "self-corrected", "sql-fallback", "llm", "low-confidence", "unresolved-mention"]);
  expect(meta(root, "route")).toBe("sql");
  expect(meta(root, "llmCalls")).toBe(1);
  expect(meta(root, "llmInputTokens")).toBe(412);
  expect(meta(root, "llmCostUsd")).toBe(0.00061);

  // Personal data typed in the question never leaves the process.
  expect(attr(root, "langfuse.observation.input")).toBe("bilan de Chovy et Zzyzx aux Worlds, réponse à [masqué]");
  expect(JSON.stringify(spans.map((s) => s.attributes))).not.toContain("jean.dupont");
  expect(JSON.stringify(spans.map((s) => s.attributes))).not.toContain("example.com");

  // Steps: their level, decision and outputs.
  expect(attr(understand, "langfuse.observation.level")).toBe("WARNING");
  expect(meta(understand, "confidence")).toBe(0.7);
  expect(meta(understand, "unconsumed")).toEqual(["bilan", "aux", "réponse"]);
  expect(String(attr(understand, "langfuse.observation.output"))).toContain('"unresolved":["Zzyzx"]');
  expect(attr(execute, "langfuse.observation.type")).toBe("retriever");
  expect(attr(execute, "langfuse.observation.level")).toBe("ERROR");
  expect(attr(execute, "langfuse.observation.input")).toBe('{"sql":"SELECT 1","params":{}}');
  expect(String(attr(execute, "langfuse.observation.output"))).toContain('"rowCount":0,"attempts":2');
  expect(meta(execute, "retries")).toBe(1);

  // The LLM call: one generation, directly under its step, named after the call.
  expect(spans).toHaveLength(4);
  expect(generation.parentSpanContext?.spanId).toBe(understand.spanContext().spanId);
  expect(attr(generation, "langfuse.observation.type")).toBe("generation");
  expect(attr(generation, "langfuse.observation.model.name")).toBe("anthropic/claude-haiku-5.5");
  expect(JSON.parse(String(attr(generation, "langfuse.observation.usage_details")))).toEqual({ input: 412, output: 38 });
  expect(JSON.parse(String(attr(generation, "langfuse.observation.cost_details")))).toEqual({ total: 0.00061 });
  expect(String(attr(generation, "langfuse.observation.input"))).toContain('"role":"user"');
  expect(JSON.parse(String(attr(generation, "langfuse.observation.output")))).toEqual({ role: "assistant", content: '{"players":["Chovy"]}' });

  // The conversation and a readable name are on every observation of the trace.
  for (const span of spans) {
    expect(attr(span, "session.id")).toBe(SESSION);
    expect(attr(span, "langfuse.trace.name")).toBe("bilan de Chovy et Zzyzx aux Worlds, réponse à [masqué]");
  }

  expect(root.name).toBe(TRACE_NAME);

  // Every observation says which question it belongs to.
  for (const span of spans) expect(String(attr(span, "langfuse.trace.metadata.question"))).toContain("bilan de Chovy");
});

test("every LLM call of a question hangs in its tree, failures included", async () => {
  exporter.reset();

  /** Answers with a tool call, as the router does. */
  const router = new MockLanguageModelV4({
    provider: "openrouter",
    modelId: "anthropic/claude-haiku-5.5",
    doGenerate: async () => ({
      content: [{ type: "tool-call", toolCallId: "call_1", toolName: "team_history", input: '{"team":"T1"}' }],
      finishReason: { unified: "tool-calls", raw: "tool_calls" },
      usage: { inputTokens: { total: 900, noCache: 900, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 20, text: 20, reasoning: 0 } },
      warnings: [],
    }),
  });

  const broken = new MockLanguageModelV4({
    provider: "openrouter",
    modelId: "anthropic/claude-haiku-5.5",
    doGenerate: async () => {
      throw new Error("clé refusée");
    },
  });

  const traceId = await traceQuestion(QUESTION, null, async (id) => {
    await traceStep(
      "build",
      { question: QUESTION },
      async () => {
        await generateText({ model: router, prompt: QUESTION, telemetry: { functionId: "pick-tool" } });
        await generateText({ model, prompt: QUESTION, telemetry: { functionId: "generate-sql" } });

        return null;
      },
      () => ({ output: {}, metadata: {}, level: "DEFAULT" }),
    );

    await traceStep(
      "execute",
      { sql: plan.sql, params: plan.params },
      async () => {
        await generateText({ model: broken, prompt: QUESTION, maxRetries: 0, telemetry: { functionId: "repair-sql" } }).catch(() => null);

        return plan;
      },
      (p) => executeReport(p, 0, undefined),
    );

    return id;
  });

  await flushTracing();
  const spans = exporter.getFinishedSpans();
  const idOf = (name: string) => spans.find((s) => s.name === name)!.spanContext().spanId;
  const under = (parent: string) => spans.filter((s) => s.parentSpanContext?.spanId === idOf(parent)).map((s) => s.name);
  const levels = (name: string) => spans.filter((s) => s.name === name).map((s) => attr(s, "langfuse.observation.level") ?? "DEFAULT");

  // One trace, one root, nothing outside the tree.
  expect(new Set(spans.map((s) => s.spanContext().traceId))).toEqual(new Set([traceId!]));
  expect(spans.filter((s) => !s.parentSpanContext).map((s) => s.name)).toEqual([TRACE_NAME]);
  expect(under(TRACE_NAME).toSorted()).toEqual([STEP_SPANS.build, STEP_SPANS.execute]);

  // Two calls in the build step, then the failed repair under the execute step.
  expect(under(STEP_SPANS.build)).toEqual(["pick-tool", "generate-sql"]);
  expect(levels("pick-tool")).toEqual(["DEFAULT"]);
  expect(under(STEP_SPANS.execute)).toEqual(["repair-sql"]);
  expect(levels("repair-sql")).toEqual(["ERROR"]);
  expect(attr(spans.find((s) => s.name === "repair-sql")!, "langfuse.observation.status_message")).toContain("clé refusée");

  // A tool call is kept on the assistant message.
  const picked = spans.findLast((s) => s.name === "pick-tool")!;

  expect(JSON.parse(String(attr(picked, "langfuse.observation.output"))).tool_calls[0].function).toEqual({ name: "team_history", arguments: '{"team":"T1"}' });
});

test("an exception marks the trace and still reaches the caller", async () => {
  exporter.reset();

  const failed = traceQuestion(QUESTION, null, async () => {
    throw new Error("base illisible");
  });

  expect(failed).rejects.toThrow("base illisible");
  await failed.catch(() => {});
  await flushTracing();
  const root = exporter.getFinishedSpans().find((s) => s.name === TRACE_NAME)!;

  expect(attr(root, "langfuse.observation.level")).toBe("ERROR");
  expect(attr(root, "langfuse.observation.status_message")).toBe("base illisible");
  expect(attr(root, "langfuse.trace.tags")).toEqual(["error"]);
});

test("a failing export never throws", async () => {
  exporter.export = () => {
    throw new Error("Langfuse est injoignable");
  };

  await runQuestion(answer({}));
  await flushTracing();
});

// Feedback score -----------------------------------------------------------------

test("a thumbs down is a boolean score on the trace", async () => {
  process.env.LANGFUSE_BASE_URL = "https://langfuse.test/";
  const traceId = "0123456789abcdef0123456789abcdef";
  const calls: { url: string; init: RequestInit }[] = [];

  const send = Object.assign(
    async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });

      return new Response("{}", { status: 200 });
    },
    { preconnect: fetch.preconnect },
  );

  expect(await sendFeedback({ traceId, value: 0 }, send)).toBe(true);
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe("https://langfuse.test/api/public/scores");
  expect(calls[0].init.method).toBe("POST");
  expect(new Headers(calls[0].init.headers).get("authorization")).toBe(`Basic ${btoa("pk-test:sk-test")}`);
  expect(JSON.parse(String(calls[0].init.body))).toEqual({
    id: `${FEEDBACK_SCORE}-${traceId}`,
    traceId,
    name: "response_rating",
    value: 0,
    dataType: "BOOLEAN",
    environment: "development",
  });
});

test("Langfuse refusing or failing the score is reported, never thrown", async () => {
  const refuse = Object.assign(async () => new Response("nope", { status: 500 }), { preconnect: fetch.preconnect });

  const fail = Object.assign(
    async (): Promise<Response> => {
      throw new Error("réseau coupé");
    },
    { preconnect: fetch.preconnect },
  );

  expect(await sendFeedback({ traceId: "a".repeat(32), value: 1 }, refuse)).toBe(false);
  expect(await sendFeedback({ traceId: "a".repeat(32), value: 1 }, fail)).toBe(false);
});
