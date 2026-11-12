import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

/**
 * LLM provider, configured only through environment variables:
 *
 *   LLM_PROVIDER=none | anthropic | openai   (default: none)
 *   LLM_MODEL=<model id>
 *   ANTHROPIC_API_KEY / OPENAI_API_KEY
 *   OPENAI_BASE_URL   (any OpenAI-compatible endpoint: OpenRouter, Ollama, ...)
 *
 * With LLM_PROVIDER=none the graph runs fully deterministic (rule-based
 * understanding + templated summary), which is enough for the first milestone.
 */
export type LlmInfo = { provider: string; model: string } | null;

let cached: { model: BaseChatModel; info: LlmInfo } | null | undefined;

export async function getChatModel(): Promise<{
  model: BaseChatModel;
  info: LlmInfo;
} | null> {
  if (cached !== undefined) return cached;
  const provider = (process.env.LLM_PROVIDER ?? "none").toLowerCase();

  if (provider === "anthropic" && process.env.ANTHROPIC_API_KEY) {
    const { ChatAnthropic } = await import("@langchain/anthropic");
    const modelName = process.env.LLM_MODEL ?? "claude-sonnet-5-5";
    cached = {
      model: new ChatAnthropic({ model: modelName, temperature: 0 }),
      info: { provider, model: modelName },
    };
  } else if (provider === "openai" && process.env.OPENAI_API_KEY) {
    const { ChatOpenAI } = await import("@langchain/openai");
    const modelName = process.env.LLM_MODEL;
    if (!modelName) throw new Error("LLM_MODEL is required with LLM_PROVIDER=openai");
    cached = {
      model: new ChatOpenAI({
        model: modelName,
        temperature: 0,
        configuration: process.env.OPENAI_BASE_URL
          ? { baseURL: process.env.OPENAI_BASE_URL }
          : undefined,
      }),
      info: { provider, model: modelName },
    };
  } else {
    cached = null;
  }
  return cached;
}
