import { describe, expect, test } from "bun:test";
import type { EmptyExplanation } from "../src/lib/agent/empty";
import { toolPlan } from "../src/lib/agent/query";
import { MAX_ATTEMPTS, nextMove, type Problem, probesEmptiness } from "../src/lib/agent/recovery";
import type { QueryPlan } from "../src/lib/agent/types";

const problem = (kind: Problem["kind"]): Problem => ({ kind, message: kind });

const explanation = (reason: EmptyExplanation["reason"], conclusive: boolean): EmptyExplanation => ({
  reason, conclusive, title: reason, summary: reason, table: null, sources: [],
});

const generated: QueryPlan = { intent: "sql", tool: null, sql: "SELECT 1", params: {}, attempt: 1, relaxed: [] };

const typed = toolPlan(
  {
    call: { tool: "team_ingame_stats", input: { team: "T1", metric: null, minute: null, league: null, yearFrom: 2023, yearTo: 2023 } },
    label: "team_ingame_stats",
    sql: "SELECT 1",
    params: {},
    relaxations: () => [],
    format: () => {
      throw new Error("the recovery policy never formats");
    },
  },
  1,
);

describe("which empty results are probed for an explanation", () => {
  test("a generated query always, a typed tool only before its first relaxation", () => {
    expect(probesEmptiness(generated, problem("empty"))).toBe(true);
    expect(probesEmptiness({ ...generated, relaxed: ["period"] }, problem("empty"))).toBe(true);
    expect(probesEmptiness(typed, problem("empty"))).toBe(true);
    expect(probesEmptiness({ ...typed, relaxed: ["period"] }, problem("empty"))).toBe(false);
  });

  test("a failure that is not an empty result is never probed", () => {
    for (const kind of ["guard", "error", "timeout"] as const) {
      expect(probesEmptiness(generated, problem(kind))).toBe(false);
      expect(probesEmptiness(typed, problem(kind))).toBe(false);
    }
  });
});

describe("what execute does after a failed attempt", () => {
  test("a conclusive explanation ends a generated query, and a typed tool only when the scope has no game", () => {
    expect(nextMove(generated, problem("empty"), explanation("zero_count", true)).kind).toBe("explained");
    expect(nextMove(typed, problem("empty"), explanation("no_games", true)).kind).toBe("explained");
    expect(nextMove(typed, problem("empty"), explanation("qualifier_only", true))).toEqual({ kind: "correct", by: "relax" });
    expect(nextMove(generated, problem("empty"), explanation("unexplained", false))).toEqual({ kind: "correct", by: "repair" });
  });

  test("an explanation wins over the last attempt", () => {
    expect(nextMove({ ...generated, attempt: MAX_ATTEMPTS }, problem("empty"), explanation("no_games", true)).kind).toBe("explained");
  });

  test("a timeout, or the last attempt, gives up", () => {
    expect(nextMove(generated, problem("timeout"), null)).toEqual({ kind: "given_up" });
    expect(nextMove(typed, problem("timeout"), null)).toEqual({ kind: "given_up" });
    expect(nextMove({ ...typed, attempt: MAX_ATTEMPTS }, problem("empty"), null)).toEqual({ kind: "given_up" });
    expect(nextMove({ ...generated, attempt: MAX_ATTEMPTS }, problem("error"), null)).toEqual({ kind: "given_up" });
  });

  test("an empty typed tool is relaxed; anything else is repaired by the model", () => {
    expect(nextMove(typed, problem("empty"), null)).toEqual({ kind: "correct", by: "relax" });
    expect(nextMove(typed, problem("guard"), null)).toEqual({ kind: "correct", by: "repair" });
    expect(nextMove(typed, problem("error"), null)).toEqual({ kind: "correct", by: "repair" });
    expect(nextMove(generated, problem("empty"), null)).toEqual({ kind: "correct", by: "repair" });
    expect(nextMove(generated, problem("guard"), null)).toEqual({ kind: "correct", by: "repair" });
  });
});
