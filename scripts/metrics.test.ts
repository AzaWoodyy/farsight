import { describe, expect, test } from "bun:test";
import { detectMetric } from "../src/lib/agent/metrics";
import { routeQuestion } from "../src/lib/agent/query";
import type { Entities, ResolvedPlayer, ResolvedTeam } from "../src/lib/agent/types";

const player = (name: string): ResolvedPlayer => ({ mention: name, player: name, matchedAlias: name, realName: null, nativeName: null, otherCandidates: [], ambiguity: null });
const team = (name: string): ResolvedTeam => ({ mention: name, team: name, members: [name] });

const LCK_2024: Pick<Entities, "league" | "leagueShort" | "leagueMention" | "yearFrom" | "yearTo"> = {
  league: "LoL Champions Korea",
  leagueShort: "LCK",
  leagueMention: "LCK",
  yearFrom: 2024,
  yearTo: 2024,
};

const entities = (over: Partial<Entities>): Entities => ({
  players: [], teams: [], champion: null, unresolved: [], split: null, outOfScope: null,
  ...LCK_2024,
  ...over,
});

const SCHEMA = { v_games: ["game_id"] };
const COVERAGE = { league: () => ({ games: 100, ingame: 100 }), player: () => ({ games: 100, ingame: 100 }), team: () => ({ games: 100, ingame: 100 }) };

describe("detectMetric: the minute asked", () => {
  test.each([
    ["gold diff à 10 de Chovy", "gold_diff", 10],
    ["gold diff a 10 de Chovy", "gold_diff", 10],
    ["gold diff at 10 Chovy", "gold_diff", 10],
    ["écart d'or à 10 min de Chovy", "gold_diff", 10],
    ["écart d'or de Chovy à 20 minutes", "gold_diff", 20],
    ["cs diff @20 Chovy", "cs_diff", 20],
    ["cs diff @ 10 Chovy", "cs_diff", 10],
    ["xp diff à 20 de Chovy", "xp_diff", 20],
    ["xp diff 10' de Chovy", "xp_diff", 10],
    ["écart d'or à 15min de Chovy", "gold_diff", 15],
    ["gold à 10 de Chovy", "gold", 10],
  ])("%s → %s at %i", (question, metric, minute) => {
    expect(detectMetric(question)).toMatchObject({ player: metric, minute, askedMinute: minute });
  });

  test("no minute named: null, the tools' default (15) applies", () => {
    for (const q of ["gold diff de Chovy en LCK 2024", "cs diff de Chovy aux Worlds 2024", "écart d'or de T1 en 2024"])
      expect(detectMetric(q)).toMatchObject({ minute: null, askedMinute: null });
  });

  test("a minute the data does not hold is kept as asked, not held", () => {
    expect(detectMetric("gold diff à 25 min de Chovy")).toMatchObject({ minute: null, askedMinute: 25 });
    expect(detectMetric("écart de CS à 5 minutes de Chovy")).toMatchObject({ minute: null, askedMinute: 5 });
    expect(detectMetric("xp diff @30 de Chovy")).toMatchObject({ minute: null, askedMinute: 30 });
  });

  test("a figure is not a minute", () => {
    expect(detectMetric("gold diff de Chovy à 10k gold")).toMatchObject({ askedMinute: null });
  });

  test("a year is not a minute", () => {
    for (const q of ["gold diff à 2024 de Chovy", "gold diff de Chovy en 2024", "gold diff de Chovy 2024'"]) expect(detectMetric(q)).toMatchObject({ askedMinute: null });
  });
});

describe("routing keeps the minute asked", () => {
  test.each([
    ["gold diff à 10 de Chovy en LCK 2024", 10],
    ["cs diff @20 de Chovy en LCK 2024", 20],
    ["xp diff à 20 de Chovy en LCK 2024", 20],
    ["gold diff de Chovy en LCK 2024", null],
  ])("player: %s → minute %p", async (q, minute) => {
    expect(await routeQuestion(q, entities({ players: [player("Chovy")] }), SCHEMA, COVERAGE)).toMatchObject({ kind: "tool", call: { tool: "player_ingame_stats", input: { minute } } });
  });

  test("team: gold diff à 10 de T1", async () => {
    expect(await routeQuestion("gold diff à 10 de T1 en LCK 2024", entities({ teams: [team("T1")] }), SCHEMA, COVERAGE)).toMatchObject({
      kind: "tool",
      call: { tool: "team_ingame_stats", input: { minute: 10 } },
    });
  });

  test("leaderboard: écart d'or à 10 des junglers", async () => {
    expect(await routeQuestion("meilleur gold diff à 10 des junglers en LCK 2024", entities({}), SCHEMA, COVERAGE)).toMatchObject({
      kind: "tool",
      call: { tool: "ingame_leaderboard", input: { metric: "gold_diff", minute: 10, role: "Jungle" } },
    });
  });

  test("a minute without snapshots is said missing, not answered at 15", async () => {
    for (const [q, e] of [
      ["gold diff à 25 min de Chovy en LCK 2024", entities({ players: [player("Chovy")] })],
      ["cs diff à 5 minutes de Chovy en LCK 2024", entities({ players: [player("Chovy")] })],
      ["gold diff à 30 min de T1 en LCK 2024", entities({ teams: [team("T1")] })],
      ["meilleur gold diff à 25 min des mids en LCK 2024", entities({})],
      ["gold à 25 min de Chovy en LCK 2024", entities({ players: [player("Chovy")] })],
      ["cs à 30 min de Chovy en LCK 2024", entities({ players: [player("Chovy")] })],
      ["xp à 5 minutes de Chovy en LCK 2024", entities({ players: [player("Chovy")] })],
    ] as const) {
      const route = await routeQuestion(q, e, SCHEMA, COVERAGE);

      expect(route).toMatchObject({ kind: "missing" });

      if (route.kind === "missing") expect(route.concepts.join(" ")).toContain("seulement à 10, 15 et 20 min");
    }
  });

  test("a minute on a metric that has none stays with its tool", async () => {
    expect(await routeQuestion("solo kills de Chovy à 25 min en LCK 2024", entities({ players: [player("Chovy")] }), SCHEMA, COVERAGE)).toMatchObject({
      kind: "tool",
      call: { tool: "player_ingame_stats", input: { metric: "solo_kills" } },
    });
  });

  test("a comparison at a minute without snapshots says so", async () => {
    const route = await routeQuestion("Faker vs Chovy gold diff à 25 min", entities({ players: [player("Faker"), player("Chovy")], league: null, leagueShort: null, leagueMention: null, yearFrom: null, yearTo: null }), SCHEMA, COVERAGE);

    expect(route).toMatchObject({ kind: "tool", call: { tool: "player_comparison" } });

    if (route.kind === "tool") expect(route.notes.join(" ")).toContain("qu'à 10, 15 et 20 min");
  });
});
