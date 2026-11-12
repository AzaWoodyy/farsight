import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";

/**
 * LLM access, through OpenRouter only.
 *
 *   OPENROUTER_API_KEY   capped key; without it the agent stays fully
 *                        deterministic (rules level of every cascade)
 *   OPENROUTER_MODEL     model id (default: a small, cheap model)
 */
export const DEFAULT_MODEL = "anthropic/claude-haiku-5.5";

/** Every LLM call is short: bound its cost and latency. */
export const LLM_CALL = { maxOutputTokens: 600, maxRetries: 1, timeoutMs: 15_000 } as const;

export type Llm = { model: LanguageModel; id: string };

let cached: Llm | null | undefined;

export function getLlm(): Llm | null {
  if (cached !== undefined) return cached;
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();

  if (!apiKey) return (cached = null);
  const id = process.env.OPENROUTER_MODEL?.trim() || DEFAULT_MODEL;
  const openrouter = createOpenRouter({ apiKey });

  return (cached = { model: openrouter(id), id });
}
