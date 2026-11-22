import { expect, test } from "bun:test";
import { withLocale } from "../src/lib/agent/messages";
import { inQuestionSplit } from "../src/lib/agent/query";
import type { ToolCall } from "../src/lib/agent/tools";
import type { Entities } from "../src/lib/agent/types";

const entities: Entities = {
  players: [], teams: [], champion: null, unresolved: [], league: "LoL EMEA Championship", leagueShort: "LEC", leagueMention: "LEC",
  yearFrom: 2024, yearTo: 2024, split: "Summer", outOfScope: null,
};

const ranking: ToolCall = {
  tool: "champion_ranking",
  input: { league: "LoL EMEA Championship", yearFrom: 2024, yearTo: 2024, sort: "picks", total: null, role: null, side: null, minPicks: null },
};

const teams: ToolCall = {
  tool: "team_leaderboard",
  input: { league: "LoL EMEA Championship", yearFrom: 2024, yearTo: 2024, criterion: "winrate", order: "desc", side: null, minGames: null },
};

test("a tool that takes a split always receives the split of the question", () => {
  const scoped = inQuestionSplit(ranking, entities);

  expect(scoped.call.input).toMatchObject({ split: "Summer" });
  expect(scoped.notes).toEqual([]);
  expect(inQuestionSplit({ ...ranking, input: { ...ranking.input, split: "Spring" } }, entities).call.input).toMatchObject({ split: "Spring" });
});

test("a tool that cannot filter by split says so in both languages instead of answering on the whole season silently", () => {
  expect(inQuestionSplit(teams, entities)).toEqual({ call: teams, notes: [expect.stringContaining("ne filtre pas par split")] });
  expect(withLocale("en", () => inQuestionSplit(teams, entities).notes)).toEqual([expect.stringContaining("does not filter by split")]);
  expect(inQuestionSplit(teams, { ...entities, split: null })).toEqual({ call: teams, notes: [] });
});
