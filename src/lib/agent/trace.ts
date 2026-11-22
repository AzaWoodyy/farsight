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

export const TRACE_NAME = "answer-question";

export const STEP_SPANS = {
  understand: "understand-question",
  build: "build-query",
  execute: "execute-query",
  format: "format-answer",
} as const satisfies Record<StepName, string>;

type Level = "DEFAULT" | "WARNING" | "ERROR";

export type StepReport = Required<Pick<LangfuseSpanAttributes, "output" | "metadata">> & { level: Level; statusMessage?: string };

export type StepInput = { question: string } | { sql: string | null; params: QueryPlan["params"] } | { route: string; rowCount: number };

type Usage = { calls: number; errors: number; inputTokens: number; outputTokens: number; costUsd: number };

type Scope = { root: LangfuseAgent; locale: Locale; usage: Usage; calls: Map<string, LangfuseGeneration> };

const scope = new AsyncLocalStorage<Scope>();

export const withoutTracing = <T>(run: () => T): T => scope.exit(run);

const LEVELS: Record<TraceStatus, Level> = { ok: "DEFAULT", fix: "DEFAULT", warn: "WARNING", error: "ERROR" };

const DETAIL_MAX = 2000;

const QUESTION_MAX = 200;

const TRACE_NAME_MAX = 80;

const stepLog = (part: StepPart | undefined) =>
  (part?.entries ?? []).map((e) => {
    const decision = e.level ? ` [${e.level}${e.confidence == null ? "" : ` ${e.confidence.toFixed(2)}`}]` : "";
    const detail = e.detail ? `\n${e.detail.length > DETAIL_MAX ? `${e.detail.slice(0, DETAIL_MAX)}…` : e.detail}` : "";

    return `${e.status}${decision} ${e.title}${detail}`;
  }).join("\n");

function decisionOf(part: StepPart | undefined) {
  const line = part?.entries.findLast((e) => e.level);

  return { decidedBy: line?.level ?? null, confidence: line?.confidence ?? null };
}

const status = (part: StepPart | undefined): Pick<StepReport, "level" | "statusMessage"> => ({
  level: LEVELS[part?.status ?? "ok"],
  statusMessage: part?.title,
});

const words = (text: string) => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

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

export function traceStep<T>(step: StepName, input: StepInput, run: () => Promise<T>, report: (result: T) => StepReport): Promise<T> {
  if (!scope.getStore()) return run();

  const observed = async (span: Pick<LangfuseSpan, "update">) => {
    span.update({ input });
    const result = await run();
    span.update(report(result));

    return result;
  };

  return step === "execute"
    ? startActiveObservation(STEP_SPANS[step], observed, { asType: "retriever" })
    : startActiveObservation(STEP_SPANS[step], observed);
}

export function outcomeTags(answer: Answer, entities: Entities, steps: Map<StepName, StepPart>, usage: Pick<Usage, "calls" | "errors">): string[] {
  const { meta } = answer;
  const understood = decisionOf(steps.get("understand")).confidence;
  const queried = meta.attempts > 0;

  const tags = {
    "out-of-scope": meta.route === "out_of_scope",
    "missing-data": meta.route === "missing_data",
    "no-query": !queried && meta.route !== "out_of_scope" && meta.route !== "missing_data",
    "empty-result": queried && meta.rowCount === 0,
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

export const localeTag = (locale: Locale) => `locale:${locale}`;

function setTags({ root, locale }: Pick<Scope, "root" | "locale">, tags: string[]) {
  root.otelSpan.setAttribute(LangfuseOtelSpanAttributes.TRACE_TAGS, [...tags, localeTag(locale)]);
}

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

export function traceQuestion<T>(question: string, sessionId: string | null, locale: Locale, run: (traceId: string | null) => Promise<T>): Promise<T> {
  const traced = () =>
    startActiveObservation(
      TRACE_NAME,
      (root) => {
        root.update({ input: question });
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
            for (const callId of current.calls.keys()) failGeneration(current, callId, "appel LLM interrompu");
          }
        });
      },
      { asType: "agent" },
    );

  const masked = maskPersonalData(question);

  const shared = {
    traceName: masked.length > TRACE_NAME_MAX ? `${masked.slice(0, TRACE_NAME_MAX)}…` : masked,
    sessionId: sessionId ?? undefined,
    metadata: { question: masked.slice(0, QUESTION_MAX), locale },
  };

  return context.with(ROOT_CONTEXT, () => propagateAttributes(shared, traced));
}

const OpenRouterCost = z.object({ openrouter: z.object({ usage: z.object({ cost: z.number() }) }) });

const FailedCall = z.object({ callId: z.string(), error: z.instanceof(Error).optional().catch(undefined) });

const UNNAMED_CALL = "call-llm";

function assistantMessage(content: LanguageModelCallEndEvent["content"]) {
  const text = content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");

  const toolCalls = content.flatMap((part) =>
    part.type === "tool-call" ? [{ id: part.toolCallId, type: "function", function: { name: part.toolName, arguments: JSON.stringify(part.input) } }] : [],
  );

  return { role: "assistant", content: text, tool_calls: toolCalls.length ? toolCalls : undefined };
}

function failGeneration(current: Scope, callId: string, message: string) {
  current.calls.get(callId)?.update({ level: "ERROR", statusMessage: message }).end();
  current.calls.delete(callId);
}

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
