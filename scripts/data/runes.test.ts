import { expect, test } from "bun:test";
import { RETIRED_RUNES, RUNE_TREES, runeName } from "./runes";

const current = new Map([
  [8135, "Treasure Hunter"],
  [8230, "Stormraider's Surge"],
  [8229, "Arcane Comet"],
  [9105, "Legend: Haste"],
  [8017, "Cut Down"],
]);

test("the LCK 2019 game of the fixtures: the page Leaguepedia would have written", () => {
  const ids = [8230, 8226, 8210, 8236, 8139, 8135, 5008, 5008, 5002];
  const names = new Map([...current, [8226, "Manaflow Band"], [8210, "Transcendence"], [8236, "Gathering Storm"], [8139, "Taste of Blood"]]);

  expect(ids.map((id) => runeName(id, "9.11.276.3025", names))).toEqual([
    "Phase Rush", "Manaflow Band", "Transcendence", "Gathering Storm", "Taste of Blood", "Ravenous Hunter", "Adaptive Force", "Adaptive Force", "Armor",
  ]);
});

test("a renamed id takes the name of the game's patch", () => {
  expect(["12.5.1", "12.6.1", "16.8.1", "16.9.1"].map((v) => [runeName(8135, v, current), runeName(8230, v, current)])).toEqual([
    ["Ravenous Hunter", "Phase Rush"],
    ["Treasure Hunter", "Phase Rush"],
    ["Treasure Hunter", "Phase Rush"],
    ["Treasure Hunter", "Stormraider's Surge"],
  ]);
  expect(runeName(9105, "14.18.617.4123", current)).toBe("Legend: Haste");
});

test("a renamed id without a version is not guessed; other ids do not need one", () => {
  expect(runeName(8135, null, current)).toBeNull();
  expect(runeName(8229, null, current)).toBe("Arcane Comet");
});

test("removed runes, stat shards, unknown ids", () => {
  expect(runeName(8359, "9.1.1", current)).toBe("Kleptomancy");
  expect(RETIRED_RUNES.get(8359)?.tree).toBe("Inspiration");
  expect(runeName(5007, "10.1.1", current)).toBe("Ability Haste");
  expect(runeName(5013, "14.1.1", current)).toBe("Tenacity and Slow Resist");
  expect(runeName(1234, "9.1.1", current)).toBeNull();
  expect(RUNE_TREES.get(8300)).toBe("Inspiration");
});
