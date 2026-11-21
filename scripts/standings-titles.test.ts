import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { guardQuery } from "../src/lib/agent/guard";
import { bindTool, type ToolCall } from "../src/lib/agent/tools";
import { readSchema } from "../src/lib/db";
import { LEAGUES } from "../src/lib/domain/leagues";
import { testDb, type TestDb } from "./fixtures/test-db";

const LCK = "LoL Champions Korea";

async function seed(db: TestDb) {
  for (const [i, l] of LEAGUES.entries()) await db.run("INSERT INTO leagues VALUES(?,?,?,?,?)", i + 1, l.name, l.short, l.region, +l.international);
  const league = Number((await db.query("SELECT id FROM leagues WHERE name = ?", [LCK]))[0]!.id);

  const pages = [
    [1, "X/2025 Season/Cup", "Cup", "2025-01-15"],
    [2, "X/2025 Season/Rounds 1-2", "Rounds 1-2", "2025-04-01"],
    [3, "X/2025 Season/Rounds 3-5", "Rounds 3-5", "2025-07-01"],
    [4, "X/2025 Season/Season Playoffs", "Rounds 3-5", "2025-09-01"],
    [5, "X Academy/2025 Season/March", null, "2025-03-01"],
  ] as const;

  for (const [id, page, split, start] of pages)
    await db.run("INSERT INTO tournaments(id,page,event_page,stage,name,league_id,year,date_start,split) VALUES (?,?,?,?,?,?,2025,?,?)", id,
      page,
      page,
      id === 4 ? "playoffs" : "season",
      page,
      league,
      start,
      split,);
  await db.exec(`
    INSERT INTO teams(id,name) VALUES (1,'Alpha'),(2,'Beta'),(3,'Gamma'),(4,'Delta'),(5,'Echo');
    INSERT INTO players(id,page) VALUES (1,'Pilot');
    INSERT INTO champions VALUES (1,'Ahri',NULL);
    INSERT INTO tournament_results VALUES
      (1,1,'1',1,NULL),(1,2,'2',2,NULL),
      (2,1,'1',1,NULL),(2,2,'2',2,NULL),
      (3,3,'1',1,NULL),(3,1,'2',2,NULL),
      (4,4,'1',1,NULL),(4,1,'2',2,NULL),
      (5,5,'1',1,NULL),(5,2,'2',2,NULL);
    INSERT INTO games(id,tournament_id,tab,match_n,game_n,blue_team_id,red_team_id,winner_side,played_at) VALUES
      (1,1,'Week 1',1,1,1,2,1,100),(2,1,'Finals',1,1,1,2,1,110),
      (3,2,'Week 1',1,1,1,2,1,200),(4,2,'Week 2',1,1,2,1,2,210),
      (5,3,'Week 10',1,1,3,1,1,300),
      (6,4,'Finals',1,1,4,1,1,400);
    INSERT INTO game_players(game_id,player_id,team_id,side,champion_id,win) VALUES (1,1,1,1,1,1),(2,1,1,1,1,1),(3,1,1,1,1,1),(4,1,1,2,1,1),(5,1,1,2,1,0),(6,1,1,2,1,0);
  `);
}

describe("which season pages carry a title", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await testDb();
    await seed(db);
  });
  afterAll(() => db.close());

  const run = async (call: ToolCall) => {
    const tool = await bindTool(db, call);

    expect(guardQuery(await readSchema(db), tool.sql).ok).toBe(true);
    const rows = (await db.query(tool.sql, tool.params));

    return { rows, out: await tool.format(db, rows) };
  };

  test("the roll of honour lists the Cup, the playoffs and the page without games, not the regular seasons", async () => {
    const { rows } = await run({ tool: "tournament_standings", input: { league: LCK, yearFrom: null, yearTo: null, split: null, full: false } });

    expect([...new Set(rows.map((r) => r.event_page))]).toEqual(["X/2025 Season/Cup", "X Academy/2025 Season/March", "X/2025 Season/Season Playoffs"]);
  });

  test("team history: the Cup is a title, leading Rounds 1-2 is not", async () => {
    const { out } = await run({ tool: "team_history", input: { team: "Alpha", league: LCK, yearFrom: null, yearTo: null } });
    const place = (page: string) => out.table!.rows.find((r) => r[2] === page)?.[3];

    expect(out.totals).toMatchObject({ titles: 1 });
    expect(place("X/2025 Season/Cup")).toBe("Champion (1)");
    expect(place("X/2025 Season/Rounds 1-2")).toBe("1er de la saison régulière (1)");
    expect(place("X/2025 Season/Season Playoffs")).toBe("Finaliste (2)");
  });

  test("team history: leading a regular season whose playoffs carry another split is not a title", async () => {
    const { out } = await run({ tool: "team_history", input: { team: "Gamma", league: LCK, yearFrom: null, yearTo: null } });

    expect(out.totals).toMatchObject({ titles: 0 });
    expect(out.table!.rows[0][3]).toBe("1er de la saison régulière (1)");
  });

  test("player history: the Cup ranks first, the regular season is not ranked", async () => {
    const { out } = await run({ tool: "player_event_history", input: { player: "Pilot", league: LCK, yearFrom: null, yearTo: null } });
    const row = (page: string) => out.rows!.find((r) => r.event === page);

    expect(row("X/2025 Season/Cup")).toMatchObject({ placeNumber: 1, placeLabel: "Champion" });
    expect(row("X/2025 Season/Rounds 1-2")).toMatchObject({ placeNumber: null, placeLabel: "1er de la saison régulière" });
    expect(out.totals).toMatchObject({ titles: 1 });
  });
});
