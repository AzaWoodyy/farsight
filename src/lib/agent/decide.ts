/**
 * Decision cascade shared by the four steps.
 *
 * Each decision point lists its deciders from cheapest to most expensive:
 *
 *   rules  regex, alias table, typed query templates (free, ~1 ms)
 *   model  small local model, e.g. a classifier or NER exported to ONNX
 *          (reserved: no decider uses it yet)
 *   llm    OpenRouter, only when the cheaper levels are not confident enough
 *
 * `decide()` runs them in order and stops at the first result whose
 * confidence reaches the threshold. A decider that is unavailable (no key, no
 * model) or fails returns null and the cascade moves on. When nobody reaches
 * the threshold, the most confident result wins.
 */
export type DecisionLevel = "rules" | "model" | "llm";

export type Decision<T> = {
  result: T;
  /** 0..1, self-reported by the decider. */
  confidence: number;
  level: DecisionLevel;
  /** Short human-readable explanation, shown in the trace. */
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
      attempts.push({ name: d.name, level: d.level, confidence: null, error: err instanceof Error ? err.message : String(err) });
      continue;
    }

    attempts.push({ name: d.name, level: d.level, confidence: decision?.confidence ?? null });

    if (!decision) continue;

    if (!best || decision.confidence > best.confidence) best = { ...decision, name: d.name };

    if (decision.confidence >= threshold) break;
  }

  return best ? { ...best, attempts } : null;
}

/** One-line description of the cascade, for the trace. */
export function describeAttempts(attempts: DecisionAttempt[]): string {
  return attempts
    .map((a) =>
      a.error
        ? `${a.level}/${a.name}: erreur (${a.error})`
        : a.confidence == null
          ? `${a.level}/${a.name}: indisponible`
          : `${a.level}/${a.name}: confiance ${a.confidence.toFixed(2)}`,
    )
    .join(" → ");
}
