import { AsyncLocalStorage } from "node:async_hooks";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { APICallError, type LanguageModel, RetryError } from "ai";
import { msg } from "./messages";

export const DEFAULT_MODEL = "anthropic/claude-haiku-5.5";

export const LLM_CALL = { maxOutputTokens: 600, maxRetries: 1, timeoutMs: 15_000 } as const;

export const QUOTA_COOLDOWN_MS = 15 * 60_000;

export type Llm = { model: LanguageModel; id: string };

export type LlmStatus = "ready" | "missing" | "exhausted";

let cached: Llm | null | undefined;
let exhaustedUntil = 0;

function configured(): Llm | null {
  if (cached !== undefined) return cached;
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();

  if (!apiKey) return (cached = null);
  const id = process.env.OPENROUTER_MODEL?.trim() || DEFAULT_MODEL;
  const openrouter = createOpenRouter({ apiKey });

  return (cached = { model: openrouter(id, { reasoning: { effort: "none" } }), id });
}

export function llmStatus(): LlmStatus {
  if (!configured()) return "missing";

  return Date.now() < exhaustedUntil ? "exhausted" : "ready";
}

export function getLlm(): Llm | null {
  requestSignal.getStore()?.throwIfAborted();

  if (rulesOnly.getStore()) return null;

  return llmStatus() === "ready" ? configured() : null;
}

function isQuotaError(error: Error): boolean {
  if (RetryError.isInstance(error)) return error.lastError instanceof Error && isQuotaError(error.lastError);

  if (!APICallError.isInstance(error)) return false;

  if (error.statusCode === 402) return true;

  return error.statusCode === 403 && /key limit exceeded/i.test(`${error.message} ${error.responseBody ?? ""}`);
}

export function describeLlmError(error: Error): string {
  if (!isQuotaError(error)) return error.message;
  exhaustedUntil = Date.now() + QUOTA_COOLDOWN_MS;

  return msg().llm.quotaError;
}

const rulesOnly = new AsyncLocalStorage<boolean>();
export const withoutLlm = <T>(run: () => T): T => rulesOnly.run(true, run);

const requestSignal = new AsyncLocalStorage<AbortSignal | undefined>();
export const withLlmSignal = <T>(signal: AbortSignal | undefined, run: () => T): T => requestSignal.run(signal, run);

export function llmSignal(timeoutMs?: number): AbortSignal | undefined {
  const signal = requestSignal.getStore();
  signal?.throwIfAborted();

  return timeoutMs == null ? signal : signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
}

export const requestAborted = (): boolean => requestSignal.getStore()?.aborted === true;
