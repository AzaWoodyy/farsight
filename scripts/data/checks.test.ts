import { expect, test } from "bun:test";
import { type DerivedTables, datasetProblems, photoLoss } from "./checks";
import type { Cell } from "./derive";

function dataset(change: Record<string, { columns: string[]; rows: Cell[][] }> = {}): DerivedTables {
  return new Map(
    Object.entries({
      leagues: { columns: ["id", "name"], rows: [[1, "LCK"]] },
      tournaments: { columns: ["id", "league_id"], rows: [[10, 1]] },
      games: { columns: ["id", "tournament_id"], rows: [[100, 10]] },
      players: { columns: ["id"], rows: [[7]] },
      champions: { columns: ["id"], rows: [[3]] },
      items: { columns: ["id"], rows: [[5]] },
      teams: { columns: ["id", "short", "logo"], rows: [[1, "T1", "T1logo square.png"], [2, null, null]] },
      game_players: { columns: ["game_id", "player_id"], rows: [[100, 7]] },
      game_draft: { columns: ["game_id", "champion_id"], rows: [[100, 3]] },
      game_player_items: { columns: ["game_id", "item_id"], rows: [[100, 5]] },
      player_aliases: { columns: ["player_id"], rows: [[7]] },
      player_images: { columns: ["player_id"], rows: [[7]] },
      game_riot: { columns: ["game_id"], rows: [[100]] },
      game_player_stats: { columns: ["game_id", "player_id"], rows: [[100, 7]] },
      game_team_stats: { columns: ["game_id"], rows: [[100]] },
      series_results: { columns: ["id"], rows: [[1]] },
      ...change,
    }),
  );
}

const current = { stale_derive: 0, older_derive: 0 };

test("complete rows pass every check", () => {
  expect(datasetProblems(dataset(), current, { leagues: 1 })).toEqual([]);
});

test("a row without its parent, a league without a game and a raw file that was not saved are each reported", () => {
  const problems = datasetProblems(
    dataset({
      leagues: { columns: ["id", "name"], rows: [[1, "LCK"], [2, "LEC"]] },
      game_player_stats: { columns: ["game_id", "player_id"], rows: [[100, 7], [100, 8]] },
      game_team_stats: { columns: ["game_id"], rows: [[101]] },
      teams: { columns: ["id", "short", "logo"], rows: [[1, null, null]] },
      player_images: { columns: ["player_id"], rows: [] },
    }),
    current,
    { leagues: 2 },
  );

  expect(problems).toEqual([
    "1 in-game player rows without player line",
    "1 in-game team rows without game",
    "leagues without any game: LEC",
    "1 leagues with games, scope has 2",
    "no player photo: data:fetch did not save player_images.json",
    "no team abbreviation: data:fetch did not save teams.json",
    "no team logo: data:fetch did not save team_logo_files.json",
  ]);
});

test("summaries of an older derivation are refused unless the load allows them; stale ones always", () => {
  const older = { stale_derive: 0, older_derive: 12 };

  expect(datasetProblems(dataset(), older, { leagues: 1 })).toHaveLength(1);
  expect(datasetProblems(dataset(), older, { leagues: 1, allowOlder: true })).toEqual([]);
  expect(datasetProblems(dataset(), { stale_derive: 3, older_derive: 0 }, { leagues: 1, allowOlder: true })).toHaveLength(1);
});

test("rows derived without ingame.jsonl are refused: a first load has no live data to compare them with", () => {
  const empty = { columns: ["game_id"], rows: [] };

  expect(datasetProblems(dataset({ game_riot: empty, game_team_stats: empty, game_player_stats: { columns: ["game_id", "player_id"], rows: [] } }), current, { leagues: 1 })).toEqual([
    "no game with in-game stats: data:fetch did not write ingame.jsonl",
  ]);
});

test("a load keeps at least 98 % of the players with a photo", () => {
  expect(photoLoss(3_472, 3_403)).toEqual([]);
  expect(photoLoss(3_472, 3_402)).toEqual(["players with a photo 3472 → 3402"]);
  expect([photoLoss(0, 0), photoLoss(0, 120)]).toEqual([[], []]);
});
