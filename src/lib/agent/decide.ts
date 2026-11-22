import { describeLlmError, recordLlmFailure, requestAborted } from "./llm";
import { msg } from "./messages";

export type DecisionLevel = "rules" | "llm";

export type Decision<T> = {
  result: T;
  confidence: number;
  level: DecisionLevel;
  reason?: string;
};

export type Decider<I, O> = {
  level: DecisionLevel;
  name: string;
  run: (input: I) => Promise<Decision<O> | null> | Decision<O> | null;
};

export type DecisionAttempt = {
  name: string;
  level: DecisionLevel;
  confidence: number | null;
  error?: string;
};

export type DecideOutcome<T> = Decision<T> & { name: string; attempts: DecisionAttempt[] };

export async function decide<I, O>(
  input: I,
  cascade: Decider<I, O>[],
  { threshold = 0.75 }: { threshold?: number } = {},
): Promise<DecideOutcome<O> | null> {
  const attempts: DecisionAttempt[] = [];
  let best: (Decision<O> & { name: string }) | null = null;

  for (const d of cascade) {
    let decision: Decision<O> | null = null;

    try {
      decision = await d.run(input);
    } catch (err) {
      if (requestAborted()) throw err;
      const error = err instanceof Error ? err : new Error(String(err));

      if (d.level === "llm") recordLlmFailure(error);
      attempts.push({ name: d.name, level: d.level, confidence: null, error: d.level === "llm" ? describeLlmError(error) : error.message });
      continue;
    }

    attempts.push({ name: d.name, level: d.level, confidence: decision?.confidence ?? null });

    if (!decision) continue;

    if (!best || decision.confidence > best.confidence) best = { ...decision, name: d.name };

    if (decision.confidence >= threshold) break;
  }

  return best ? { ...best, attempts } : null;
}

export function describeAttempts(attempts: DecisionAttempt[]): string {
  const m = msg().decide;

  return attempts
    .map((a) => {
      const who = `${a.level}/${m.names[a.name] ?? a.name}`;

      return a.error ? m.failed(who, a.error) : a.confidence == null ? m.unavailable(who) : m.confidence(who, a.confidence.toFixed(2));
    })
    .join(" → ");
}
