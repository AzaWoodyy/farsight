/**
 * What the agent reports to Langfuse: one trace per question (`answer-question`),
 * one observation per step, and the tags and metadata that single out the
 * failures. The AI SDK integration adds a generation under the step that made
 * each LLM call.
 *
 * Nothing here knows whether tracing is on: without a registered provider
 * (src/lib/tracing/langfuse.ts) every observation is a no-op.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import {
  type LangfuseAgent,
  LangfuseOtelSpanAttributes,
  type LangfuseSpan,
  type LangfuseSpanAttributes,
  propagateAttributes,
  startActiveObservation,
} from "@langfuse/tracing";
import { context, ROOT_CONTEXT } from "@opentelemetry/api";
import type { LanguageModelCallEndEvent, Telemetry } from "ai";
import { z } from "zod";
import { MASKED, maskPersonalData } from "../tracing/mask";
import { llmStatus } from "./llm";
import type { Route } from "./query";
import type { Answer, Entities, QueryPlan, StepName, StepPart, TraceStatus } from "./types";

/** Observation names: stable, they are what Langfuse filters and evaluators target. */
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

type Scope = { root: LangfuseAgent; usage: Usage };

const scope = new AsyncLocalStorage<Scope>();

const LEVELS: Record<TraceStatus, Level> = { ok: "DEFAULT", fix: "DEFAULT", warn: "WARNING", error: "ERROR" };

const DETAIL_MAX = 2000;

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

/** Tags are a trace attribute: set on the root observation before it ends. */
function setTags(root: LangfuseAgent, tags: string[]) {
  if (tags.length) root.otelSpan.setAttribute(LangfuseOtelSpanAttributes.TRACE_TAGS, tags);
}

/** Called by the agent with its answer: output, tags and metadata of the trace. */
export function recordOutcome(answer: Answer, entities: Entities, steps: Map<StepName, StepPart>): void {
  const current = scope.getStore();

  if (!current) return;
  const { root, usage } = current;

  setTags(root, outcomeTags(answer, entities, steps, usage));
  root.update({
    output: answer.summary,
    statusMessage: answer.title,
    level: [...steps.values()].some((s) => s.status === "error") ? "ERROR" : "DEFAULT",
    metadata: {
      route: answer.meta.route,
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
 * Runs the agent inside a new trace. `run` receives the trace id when the
 * question is actually traced (tracing on, and sampled), null otherwise: the
 * UI only offers the thumbs when there is a trace to score.
 */
export function traceQuestion<T>(question: string, run: (traceId: string | null) => Promise<T>): Promise<T> {
  const traced = () =>
    startActiveObservation(
      TRACE_NAME,
      (root) => {
        root.update({ input: question });

        return scope.run({ root, usage: { calls: 0, errors: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 } }, async () => {
          try {
            return await run(root.otelSpan.isRecording() ? root.traceId : null);
          } catch (err) {
            setTags(root, ["error"]);
            root.update({ level: "ERROR", statusMessage: err instanceof Error ? err.message : String(err) });

            throw err;
          }
        });
      },
      { asType: "agent" },
    );

  // A root context: the trace never hangs under a span of the web framework.
  return context.with(ROOT_CONTEXT, () => propagateAttributes({ traceName: TRACE_NAME }, traced));
}

/** What OpenRouter bills for one call, as its provider metadata reports it. */
const OpenRouterCost = z.object({ openrouter: z.object({ usage: z.object({ cost: z.number() }) }) });

/**
 * AI SDK telemetry integration that sums the LLM usage of the current
 * question: it tells whether a question went through the LLM, and at what cost.
 */
export const usageCollector: Telemetry = {
  onLanguageModelCallEnd(event: LanguageModelCallEndEvent) {
    const usage = scope.getStore()?.usage;

    if (!usage) return;
    const cost = OpenRouterCost.safeParse(event.providerMetadata);

    usage.calls += 1;
    usage.inputTokens += event.usage.inputTokens ?? 0;
    usage.outputTokens += event.usage.outputTokens ?? 0;
    usage.costUsd += cost.success ? cost.data.openrouter.usage.cost : 0;
  },
  onError() {
    const usage = scope.getStore()?.usage;

    if (usage) usage.errors += 1;
  },
};
