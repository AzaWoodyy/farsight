import { expect, test } from "bun:test";
import { Store, bestFirst, rankedSeconds } from "./derive";

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

test("a 15-second remake left in milliseconds does not rank as a long game", () => {
  expect([rankedSeconds(15_000), rankedSeconds(2_000), rankedSeconds(5_700), rankedSeconds(null)]).toEqual([15, 2_000, 5_700, 0]);
});
