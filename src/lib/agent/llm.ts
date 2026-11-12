import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { APICallError, type LanguageModel, RetryError } from "ai";

/**
 * LLM access, through OpenRouter only.
 *
 *   OPENROUTER_API_KEY   capped key; without it the agent stays fully
 *                        deterministic (rules level of every cascade)
 *   OPENROUTER_MODEL     model id (default: a small, cheap model)
 *
 * When the key runs out of credit (402, or 403 "Key limit exceeded"), the LLM
 * is switched off for QUOTA_COOLDOWN_MS: every cascade falls back to its rules
 * level, and the answer says so.
 */
export const DEFAULT_MODEL = "anthropic/claude-haiku-5.5";

/** Every LLM call is short: bound its cost and latency. */
export const LLM_CALL = { maxOutputTokens: 600, maxRetries: 1, timeoutMs: 15_000 } as const;

/** How long an exhausted key stays switched off before the next try. */
export const QUOTA_COOLDOWN_MS = 15 * 60_000;

/** Shown to the user when the answer was produced without the LLM because of the quota. */
export const QUOTA_NOTE =
  "Le quota du modèle de langage est épuisé pour le moment : réponse en mode déterministe (règles et outils typés uniquement, sans text-to-SQL).";

export type Llm = { model: LanguageModel; id: string };

/** ready: key configured and usable · missing: no key · exhausted: key out of credit. */
export type LlmStatus = "ready" | "missing" | "exhausted";

let cached: Llm | null | undefined;
let exhaustedUntil = 0;

function configured(): Llm | null {
  if (cached !== undefined) return cached;
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();

  if (!apiKey) return (cached = null);
  const id = process.env.OPENROUTER_MODEL?.trim() || DEFAULT_MODEL;
  const openrouter = createOpenRouter({ apiKey });

  return (cached = { model: openrouter(id), id });
}

export function llmStatus(): LlmStatus {
  if (!configured()) return "missing";

  return Date.now() < exhaustedUntil ? "exhausted" : "ready";
}

/** The model to call, or null when there is no key or the key is out of credit. */
export function getLlm(): Llm | null {
  return llmStatus() === "ready" ? configured() : null;
}

/** OpenRouter's answer to a key without credit left: 402, or 403 "Key limit exceeded". */
function isQuotaError(error: Error): boolean {
  if (RetryError.isInstance(error)) return error.lastError instanceof Error && isQuotaError(error.lastError);

  if (!APICallError.isInstance(error)) return false;

  if (error.statusCode === 402) return true;

  return error.statusCode === 403 && /key limit exceeded/i.test(`${error.message} ${error.responseBody ?? ""}`);
}

/**
 * Trace message for a failed LLM call. A quota error also switches the LLM
 * off, so the rest of the request (and the next ones) stay deterministic.
 */
export function describeLlmError(error: Error): string {
  if (!isQuotaError(error)) return error.message;
  exhaustedUntil = Date.now() + QUOTA_COOLDOWN_MS;

  return "quota OpenRouter épuisé, bascule en mode déterministe";
}
