/**
 * What the agent reports to Langfuse: one trace per question (`answer-question`),
 * one observation per step, and the tags and metadata that single out the
 * failures. `llmTelemetry` adds one generation per LLM call, under the step
 * that made it.
 *
 * Nothing here knows whether tracing is on: without a registered provider
 * (src/lib/tracing/langfuse.ts) every observation is a no-op.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import {
  type LangfuseAgent,
  type LangfuseGeneration,
  LangfuseOtelSpanAttributes,
  type LangfuseSpan,
  type LangfuseSpanAttributes,
  propagateAttributes,
  startActiveObservation,
  startObservation,
} from "@langfuse/tracing";
import { context, ROOT_CONTEXT } from "@opentelemetry/api";
import type { LanguageModelCallEndEvent, Telemetry } from "ai";
import { z } from "zod";
import type { Locale } from "../locale";
import { MASKED, maskPersonalData } from "../tracing/mask";
import { llmStatus } from "./llm";
import { answerLocale } from "./messages";
import type { Route } from "./query";
import type { Answer, Entities, QueryPlan, StepName, StepPart, TraceStatus } from "./types";

/** Observation names: stable, they are what Langfuse filters and evaluators target. `TRACE_NAME` is the root observation of every question. */
export const TRACE_NAME = "answer-question";

export const STEP_SPANS = {
  understand: "understand-question",
  build: "build-query",
  execute: "execute-query",
  format: "format-answer",
} as const satisfies Record<StepName, string>;

type Level = "DEFAULT" | "WARNING" | "ERROR";

/** What a finished step reports on its observation. */
export type StepReport = Required<Pick<LangfuseSpanAttributes, "output" | "metadata">> & { level: Level; statusMessage?: string };

/** What a step starts from: the question, the query to run, or the rows to format. */
export type StepInput = { question: string } | { sql: string | null; params: QueryPlan["params"] } | { route: string; rowCount: number };

/** LLM usage of one question, summed over its calls. */
type Usage = { calls: number; errors: number; inputTokens: number; outputTokens: number; costUsd: number };

/** The question being traced: its root observation, the language of its answer, its LLM usage and its LLM calls still waiting for an answer. */
type Scope = { root: LangfuseAgent; locale: Locale; usage: Usage; calls: Map<string, LangfuseGeneration> };

const scope = new AsyncLocalStorage<Scope>();

const LEVELS: Record<TraceStatus, Level> = { ok: "DEFAULT", fix: "DEFAULT", warn: "WARNING", error: "ERROR" };

const DETAIL_MAX = 2000;

/** Langfuse drops a propagated metadata value longer than 200 characters. */
const QUESTION_MAX = 200;

/** Length of the question excerpt that names a trace in the Langfuse lists. */
const TRACE_NAME_MAX = 80;

/**
 * The step as the UI showed it, one line of text per entry (status, decision
 * level and confidence, title, detail). One text: a metadata value that is a
 * list of objects does not survive the export.
 */
const stepLog = (part: StepPart | undefined) =>
  (part?.entries ?? []).map((e) => {
    const decision = e.level ? ` [${e.level}${e.confidence == null ? "" : ` ${e.confidence.toFixed(2)}`}]` : "";
    const detail = e.detail ? `\n${e.detail.length > DETAIL_MAX ? `${e.detail.slice(0, DETAIL_MAX)}…` : e.detail}` : "";

    return `${e.status}${decision} ${e.title}${detail}`;
  }).join("\n");

/** Level and confidence of the step's decision (the line written by `decide()`). */
function decisionOf(part: StepPart | undefined) {
  const line = part?.entries.findLast((e) => e.level);

  return { decidedBy: line?.level ?? null, confidence: line?.confidence ?? null };
}

const status = (part: StepPart | undefined): Pick<StepReport, "level" | "statusMessage"> => ({
  level: LEVELS[part?.status ?? "ok"],
  statusMessage: part?.title,
});

const words = (text: string) => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/**
 * Words of the question no entity, competition or year accounts for. On the
 * rules path an unknown player leaves no other sign than its word here.
 * Personal data is masked first: split into words, an email would slip through.
 */
export function unconsumedWords(question: string, e: Entities): string[] {
  const mentions = [...e.players.map((p) => p.mention), ...e.teams.map((t) => t.mention), e.champion?.mention, e.leagueMention, ...e.unresolved];
  const consumed = new Set(mentions.flatMap((m) => (m ? words(m) : [])));

  const left = words(maskPersonalData(question).replaceAll(MASKED, " "));

  return [...new Set(left.filter((w) => w.length > 2 && !/^\d+$/.test(w) && !consumed.has(w)))];
}

export function understandReport(question: string, e: Entities, part: StepPart | undefined): StepReport {
  return {
    output: {
      players: e.players.map((p) => ({
        mention: p.mention,
        player: p.player,
        alias: p.matchedAlias,
        homonyms: p.otherCandidates,
        uncertain: p.ambiguity?.uncertain ?? false,
      })),
      teams: e.teams.map((t) => ({ mention: t.mention, team: t.team })),
      champion: e.champion?.champion ?? null,
      unresolved: e.unresolved,
      league: e.league,
      yearFrom: e.yearFrom,
      yearTo: e.yearTo,
      split: e.split,
      outOfScope: e.outOfScope,
    },
    metadata: { ...decisionOf(part), unconsumed: unconsumedWords(question, e), log: stepLog(part) },
    ...status(part),
  };
}

export function buildReport(route: Route, plan: QueryPlan | null, part: StepPart | undefined): StepReport {
  return {
    output: plan
      ? { route: plan.intent, input: plan.tool?.call.input ?? null, sql: plan.sql, params: plan.params }
      : { route: route.kind, reason: route.reason },
    metadata: { ...decisionOf(part), ruleRoute: route.kind, ruleReason: route.reason, log: stepLog(part) },
    ...status(part),
  };
}

export function executeReport(plan: QueryPlan | null, rowCount: number, part: StepPart | undefined): StepReport {
  return {
    output: plan ? { rowCount, attempts: plan.attempt, relaxed: plan.relaxed, sql: plan.sql, params: plan.params } : { rowCount: 0, attempts: 0 },
    metadata: { retries: plan ? plan.attempt - 1 : 0, log: stepLog(part) },
    ...status(part),
  };
}

export function formatReport(answer: Answer, part: StepPart | undefined): StepReport {
  return {
    output: {
      title: answer.title,
      summary: answer.summary,
      rows: answer.rows.length || (answer.table?.rows.length ?? 0),
      timeline: answer.timeline != null,
      sources: answer.sources.length,
      followUps: answer.followUps,
      notes: answer.notes,
    },
    metadata: { route: answer.meta.route, summaryBy: decisionOf(part).decidedBy, log: stepLog(part) },
    ...status(part),
  };
}

/** Runs one step inside its observation; `report` describes it once it is done. */
export function traceStep<T>(step: StepName, input: StepInput, run: () => Promise<T>, report: (result: T) => StepReport): Promise<T> {
  // Outside a question's trace (the card of a link preview), a step would open a trace of its own.
  if (!scope.getStore()) return run();

  const observed = async (span: Pick<LangfuseSpan, "update">) => {
    span.update({ input });
    const result = await run();
    span.update(report(result));

    return result;
  };

  // The query step looks data up; the others are plain steps of the pipeline.
  return step === "execute"
    ? startActiveObservation(STEP_SPANS[step], observed, { asType: "retriever" })
    : startActiveObservation(STEP_SPANS[step], observed);
}

/**
 * Tags of a finished question. They name what went wrong (or which path was
 * taken), so a Langfuse filter on one tag lists the questions to look at.
 */
export function outcomeTags(answer: Answer, entities: Entities, steps: Map<StepName, StepPart>, usage: Pick<Usage, "calls" | "errors">): string[] {
  const { meta } = answer;
  const understood = decisionOf(steps.get("understand")).confidence;
  const queried = meta.attempts > 0;

  const tags = {
    "out-of-scope": meta.route === "out_of_scope",
    "missing-data": meta.route === "missing_data",
    "no-query": !queried && meta.route !== "out_of_scope" && meta.route !== "missing_data",
    "empty-result": queried && meta.rowCount === 0,
    // The scope explains the empty result: no game, qualifiers only, a real zero.
    "empty-explained": meta.empty != null && meta.empty !== "unexplained",
    error: [...steps.values()].some((s) => s.status === "error"),
    "self-corrected": meta.attempts > 1,
    "sql-fallback": meta.route === "sql",
    llm: usage.calls > 0,
    "llm-error": usage.errors > 0,
    "llm-quota": llmStatus() === "exhausted",
    "low-confidence": understood != null && understood < 0.8,
    "unresolved-mention": entities.unresolved.length > 0,
    "ambiguous-alias": meta.ambiguities.length > 0,
  };

  return Object.entries(tags).flatMap(([tag, on]) => (on ? [tag] : []));
}

/** Tag of the language the agent answered in: a Langfuse filter on it lists the questions of one language. */
export const localeTag = (locale: Locale) => `locale:${locale}`;

/** Tags are a trace attribute: set on the root observation before it ends, always with the language of the answer. */
function setTags({ root, locale }: Pick<Scope, "root" | "locale">, tags: string[]) {
  root.otelSpan.setAttribute(LangfuseOtelSpanAttributes.TRACE_TAGS, [...tags, localeTag(locale)]);
}

/** Called by the agent with its answer: output, tags and metadata of the trace. */
export function recordOutcome(answer: Answer, entities: Entities, steps: Map<StepName, StepPart>): void {
  const current = scope.getStore();

  if (!current) return;
  const { root, usage } = current;

  setTags(current, outcomeTags(answer, entities, steps, usage));
  root.update({
    output: answer.summary,
    statusMessage: answer.title,
    level: [...steps.values()].some((s) => s.status === "error") ? "ERROR" : "DEFAULT",
    metadata: {
      route: answer.meta.route,
      // The language of the page that asked: candidate eval cases are replayed in it (scripts/eval-candidates.ts).
      locale: answerLocale(),
      rowCount: answer.meta.rowCount,
      attempts: answer.meta.attempts,
      unread: answer.meta.unread,
      llmStatus: llmStatus(),
      llmCalls: usage.calls,
      llmErrors: usage.errors,
      llmInputTokens: usage.inputTokens,
      llmOutputTokens: usage.outputTokens,
      llmCostUsd: usage.costUsd,
    },
  });
}

/**
 * Runs the agent inside a new trace. `sessionId` is the anonymous id of the
 * visitor's conversation, when the browser sent one: Langfuse groups the
 * questions of a conversation under it. `run` receives the trace id when the
 * question is actually traced (tracing on, and sampled), null otherwise: the
 * UI only offers the thumbs when there is a trace to score. `locale` is the
 * language the agent answers in (the one `runAgent` is given): a tag and a
 * metadata value of the trace.
 */
export function traceQuestion<T>(question: string, sessionId: string | null, locale: Locale, run: (traceId: string | null) => Promise<T>): Promise<T> {
  const traced = () =>
    startActiveObservation(
      TRACE_NAME,
      (root) => {
        root.update({ input: question });
        // Set from the start: a question that fails before its outcome still says its language.
        setTags({ root, locale }, []);

        const current: Scope = { root, locale, usage: { calls: 0, errors: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }, calls: new Map() };

        return scope.run(current, async () => {
          try {
            return await run(root.otelSpan.isRecording() ? root.traceId : null);
          } catch (err) {
            setTags(current, ["error"]);
            root.update({ level: "ERROR", statusMessage: err instanceof Error ? err.message : String(err) });

            throw err;
          } finally {
            // A call the SDK never closed (aborted, timed out) still ends inside its trace.
            for (const callId of current.calls.keys()) failGeneration(current, callId, "appel LLM interrompu");
          }
        });
      },
      { asType: "agent" },
    );

  // The question goes on every observation: any line of the Langfuse table tells which question it belongs to.
  const masked = maskPersonalData(question);

  const shared = {
    // The trace is listed under the start of its question; its root observation keeps the stable name.
    traceName: masked.length > TRACE_NAME_MAX ? `${masked.slice(0, TRACE_NAME_MAX)}…` : masked,
    sessionId: sessionId ?? undefined,
    metadata: { question: masked.slice(0, QUESTION_MAX), locale },
  };

  // A root context: the trace never hangs under a span of the web framework.
  return context.with(ROOT_CONTEXT, () => propagateAttributes(shared, traced));
}

/** What OpenRouter bills for one call, as its provider metadata reports it. */
const OpenRouterCost = z.object({ openrouter: z.object({ usage: z.object({ cost: z.number() }) }) });

/** A failed call as the AI SDK reports it: the call it belongs to, and the error when there is one. */
const FailedCall = z.object({ callId: z.string(), error: z.instanceof(Error).optional().catch(undefined) });

/** Name of an LLM call nobody named: every call of the agent passes its own `functionId`. */
const UNNAMED_CALL = "call-llm";

/** The model's answer as one assistant message, tool calls included, so Langfuse renders it as a conversation. */
function assistantMessage(content: LanguageModelCallEndEvent["content"]) {
  const text = content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");

  const toolCalls = content.flatMap((part) =>
    part.type === "tool-call" ? [{ id: part.toolCallId, type: "function", function: { name: part.toolName, arguments: JSON.stringify(part.input) } }] : [],
  );

  return { role: "assistant", content: text, tool_calls: toolCalls.length ? toolCalls : undefined };
}

/** Ends a generation that got no answer. */
function failGeneration(current: Scope, callId: string, message: string) {
  current.calls.get(callId)?.update({ level: "ERROR", statusMessage: message }).end();
  current.calls.delete(callId);
}

/**
 * AI SDK telemetry integration: each model call of the current question is
 * one Langfuse generation, named after the call (`functionId`) and nested
 * under the step that makes it, with its messages, model, tokens and the cost
 * OpenRouter billed. The SDK's own retry of a call stays inside its generation;
 * a query repair is a call of its own (`repair-sql`). Calls made outside a
 * question are not traced.
 */
export const llmTelemetry: Telemetry = {
  onLanguageModelCallStart(event) {
    const current = scope.getStore();

    if (!current) return;

    current.calls.set(
      event.callId,
      startObservation(
        event.functionId ?? UNNAMED_CALL,
        {
          model: event.modelId,
          input: [...(event.instructions ? [{ role: "system", content: event.instructions }] : []), ...event.messages],
          modelParameters: event.maxOutputTokens == null ? undefined : { maxOutputTokens: event.maxOutputTokens },
          metadata: { provider: event.provider, tools: (event.tools ?? []).length },
        },
        { asType: "generation" },
      ),
    );
  },
  onLanguageModelCallEnd(event) {
    const current = scope.getStore();

    if (!current) return;
    const cost = OpenRouterCost.safeParse(event.providerMetadata);
    const input = event.usage.inputTokens ?? 0;
    const output = event.usage.outputTokens ?? 0;

    current.usage.calls += 1;
    current.usage.inputTokens += input;
    current.usage.outputTokens += output;
    current.usage.costUsd += cost.success ? cost.data.openrouter.usage.cost : 0;

    current.calls
      .get(event.callId)
      ?.update({
        output: assistantMessage(event.content),
        usageDetails: { input, output },
        costDetails: cost.success ? { total: cost.data.openrouter.usage.cost } : undefined,
        metadata: { finishReason: event.finishReason },
      })
      .end();
    current.calls.delete(event.callId);
  },
  onError(event) {
    const current = scope.getStore();

    if (!current) return;
    const failed = FailedCall.safeParse(event);

    current.usage.errors += 1;

    if (failed.success) failGeneration(current, failed.data.callId, failed.data.error?.message ?? "appel LLM en échec");
  },
};
