import { expect, test } from "bun:test";
import { Store } from "./derive";

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
