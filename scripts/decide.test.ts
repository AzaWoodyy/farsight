import { describe, expect, test } from "bun:test";
import { type Decider, decide } from "../src/lib/agent/decide";
import { withLlmSignal } from "../src/lib/agent/llm";

const input = { question: "q" };

const failing = (error: Error, before?: () => void): Decider<typeof input, string> => ({
  level: "rules",
  name: "a",
  run: () => {
    before?.();
    throw error;
  },
});

function counted() {
  const calls = { count: 0 };

  const decider: Decider<typeof input, string> = {
    level: "rules",
    name: "b",
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
