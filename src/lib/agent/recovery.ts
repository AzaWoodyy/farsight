import type { EmptyExplanation } from "./empty";
import type { QueryPlan } from "./types";

export const MAX_ATTEMPTS = 3;

export type Problem = { kind: "guard" | "error" | "empty" | "timeout"; message: string };

export type Correction = "relax" | "repair";

export type NextMove =
  | { kind: "explained"; explanation: EmptyExplanation }
  | { kind: "given_up" }
  | { kind: "correct"; by: Correction };

export const probesEmptiness = (plan: QueryPlan, problem: Problem): boolean =>
  problem.kind === "empty" && (plan.tool == null || plan.relaxed.length === 0);

export function nextMove(plan: QueryPlan, problem: Problem, explanation: EmptyExplanation | null): NextMove {
  if (explanation?.conclusive && (plan.tool == null || explanation.reason === "no_games")) return { kind: "explained", explanation };

  if (problem.kind === "timeout" || plan.attempt >= MAX_ATTEMPTS) return { kind: "given_up" };

  return { kind: "correct", by: plan.tool != null && problem.kind === "empty" ? "relax" : "repair" };
}
