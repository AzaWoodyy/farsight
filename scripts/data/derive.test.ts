import { expect, test } from "bun:test";
import { Store, bestFirst, summaryRank } from "./derive";

test("a Riot value only fills what Leaguepedia left empty, by primary key", () => {
  const store = new Store();
  const line = store.insert("game_players", ["game_id", "player_id", "damage"]);
  line.run(1, 1, 12000);
  line.run(1, 2, null);
  const fill = store.fill("game_players", "damage");

  expect([fill.run(9999, 1, 1), fill.run(4923, 1, 2), fill.run(5000, 1, 2), fill.run(null, 1, 1), fill.run(1, 2, 1)]).toEqual([false, true, false, false, false]);
  const { columns, rows } = store.tables.get("game_players")!;

  expect(rows.map((r) => r[columns.indexOf("damage")])).toEqual([12000, 4923]);
  expect([store.has("game_players", 1, 2), store.has("game_players", 2, 1)]).toEqual([true, false]);
});

test("of two summaries of one game, the best ranked comes first whatever the order of the file", () => {
  const lines = [
    { key: "A_1", game: 1, rank: [10, 28] },
    { key: "B_7", game: 2, rank: [10, 1800] },
    { key: "A_2", game: 1, rank: [10, 2032] },
    { key: "C_3", game: undefined, rank: [0, 0] },
    { key: "D_9", game: 3, rank: [4, 2400] },
    { key: "D_8", game: 3, rank: [10, 1500] },
    { key: "D_7", game: 3, rank: [10, 1500] },
  ];

  const keys = (order: typeof lines) => bestFirst(order, (l) => l.game, (l) => l.rank).map((l) => l.key);

  // The real game before its 28-second remake, the champions of the scoreboard before the length, then the key;
  // the line of another game (B_7) and the one without a game (C_3) stay where they were.
  expect(keys(lines)).toEqual(["A_2", "B_7", "A_1", "C_3", "D_7", "D_8", "D_9"]);

  const kept = (order: typeof lines) => {
    const first = new Map<number, string>();

    for (const l of bestFirst(order, (x) => x.game, (x) => x.rank)) if (l.game != null && !first.has(l.game)) first.set(l.game, l.key);

    return [...first].sort(([a], [b]) => a - b);
  };

  expect(kept(lines.toReversed())).toEqual(kept(lines));
  expect(kept(lines)).toEqual([[1, "A_2"], [2, "B_7"], [3, "D_7"]]);
});

test("a remake whose length stayed in milliseconds does not rank before the game the scoreboard describes", () => {
  const first = (lines: { key: string; champions: number; durationS: number | null }[], scoreboardS: number | null) =>
    [lines, lines.toReversed()].map((order) => bestFirst(order, () => 1, (l) => summaryRank(l.champions, l.durationS, scoreboardS))[0].key);

  const full = { key: "FULL_2", champions: 10, durationS: 2_000 };

  // Five seconds written 5 000: longer than the game as a number, not the length of the scoreboard.
  expect(first([{ key: "REMAKE_1", champions: 10, durationS: 5_000 }, full], 2_000)).toEqual(["FULL_2", "FULL_2"]);
  // A real 5 700-second game is not a remake.
  expect(first([{ key: "LONG_1", champions: 10, durationS: 5_700 }, { key: "REMAKE_2", champions: 10, durationS: 28 }], 5_700)).toEqual(["LONG_1", "LONG_1"]);
  // The scoreboard's game in milliseconds is still the scoreboard's game.
  expect(summaryRank(10, 15_000, 15)).toEqual([10, 1, 15]);
  // Without a scoreboard length: the champions, then the length, three hours being no game.
  expect(first([{ key: "REMAKE_3", champions: 10, durationS: 15_000 }, full], null)).toEqual(["FULL_2", "FULL_2"]);
  expect(first([{ key: "OTHER_1", champions: 4, durationS: 2_400 }, full], null)).toEqual(["FULL_2", "FULL_2"]);
  // A summary without a length never agrees with the scoreboard, even one of a few seconds.
  expect([summaryRank(10, null, 2_000), summaryRank(10, null, 5)]).toEqual([[10, 0, 0], [10, 0, 0]]);
});
