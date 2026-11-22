import { afterEach, describe, expect, test } from "bun:test";
import { APICallError } from "ai";
import { type Decider, type DecisionLevel, decide, describeAttempts } from "../src/lib/agent/decide";
import { withLocale } from "../src/lib/agent/messages";
import { describeLlmError, QUOTA_COOLDOWN_MS, quotaExhausted, recordLlmFailure, resetLlmQuota, withLlmSignal } from "../src/lib/agent/llm";

const input = { question: "q" };

const failing = (error: Error, before?: () => void, level: DecisionLevel = "rules"): Decider<typeof input, string> => ({
  level,
  id: "alias",
  run: () => {
    before?.();
    throw error;
  },
});

function counted() {
  const calls = { count: 0 };

  const decider: Decider<typeof input, string> = {
    level: "rules",
    id: "typed_tool",
    run: () => {
      calls.count++;

      return { result: "b", confidence: 0.9, level: "rules" };
    },
  };

  return { calls, decider };
}

describe("decide", () => {
  test("a failing decider falls through to the next one", async () => {
    const { decider } = counted();
    const outcome = await decide(input, [failing(new Error("boom")), decider]);

    expect(outcome?.result).toBe("b");
    expect(outcome?.attempts[0].error).toBe("boom");
  });

  test("a cancelled request stops the cascade", async () => {
    const controller = new AbortController();
    const reason = new DOMException("client gone", "AbortError");
    controller.abort(reason);
    const { calls, decider } = counted();

    await expect(withLlmSignal(controller.signal, () => decide(input, [failing(reason), decider]))).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(calls.count).toBe(0);
  });

  test("a per-call timeout still falls through while the request is live", async () => {
    const controller = new AbortController();
    const { decider } = counted();
    const outcome = await withLlmSignal(controller.signal, () => decide(input, [failing(new DOMException("timed out", "TimeoutError")), decider]));

    expect(outcome?.result).toBe("b");
    expect(outcome?.attempts[0].error).toBe("timed out");
  });

  test("a request cancelled during a decider stops before the next one", async () => {
    const controller = new AbortController();
    const { calls, decider } = counted();
    const aborting = failing(new Error("network"), () => controller.abort());

    await expect(withLlmSignal(controller.signal, () => decide(input, [aborting, decider]))).rejects.toThrow("network");
    expect(calls.count).toBe(0);
  });
});

describe("describing a cascade", () => {
  const attempts = [
    { id: "typed_tool" as const, level: "rules" as const, confidence: null },
    { id: "sql_repair" as const, level: "llm" as const, confidence: 0.9 },
  ];

  test("each decider is named in the answer's language", () => {
    expect(describeAttempts(attempts)).toBe("rules/outil typé: indisponible → llm/réparation SQL: confiance 0.90");
    expect(withLocale("en", () => describeAttempts(attempts))).toBe("rules/typed tool: unavailable → llm/SQL repair: confidence 0.90");
  });
});

describe("OpenRouter quota", () => {
  const quotaError = () => new APICallError({ message: "Payment Required", url: "https://openrouter.ai/api/v1/chat/completions", requestBodyValues: {}, statusCode: 402 });

  afterEach(resetLlmQuota);

  test("describing a quota error leaves the quota as it was", () => {
    expect(describeLlmError(quotaError())).not.toBe("Payment Required");
    expect(quotaExhausted()).toBe(false);
  });

  test("a quota failure of an LLM decider marks the quota exhausted for the cooldown", async () => {
    const { decider } = counted();
    const outcome = await decide(input, [failing(quotaError(), undefined, "llm"), decider]);

    expect(outcome?.result).toBe("b");
    expect(outcome?.attempts[0].error).toBe(describeLlmError(quotaError()));
    expect(quotaExhausted()).toBe(true);
    expect(quotaExhausted(Date.now() + QUOTA_COOLDOWN_MS + 1)).toBe(false);
  });

  test("other failures, and quota errors outside an LLM decider, leave the quota open", async () => {
    await decide(input, [failing(new Error("boom"), undefined, "llm"), failing(quotaError())]);

    expect(quotaExhausted()).toBe(false);
  });

  test("a recorded quota failure ends with its cooldown", () => {
    const at = Date.now();

    recordLlmFailure(quotaError(), at);

    expect(quotaExhausted(at + QUOTA_COOLDOWN_MS - 1)).toBe(true);
    expect(quotaExhausted(at + QUOTA_COOLDOWN_MS)).toBe(false);
  });
});
