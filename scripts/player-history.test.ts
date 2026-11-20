import { describe, expect, test } from "bun:test";
import { guardQuery } from "../src/lib/agent/guard";
import { bindTool } from "../src/lib/agent/tools";
import { readSchema } from "../src/lib/db";
import { LEAGUES } from "../src/lib/domain/leagues";
import { testDb, type TestDb } from "./fixtures/test-db";

/**
 * Faker (T1) against Gen.G. LCK 2024: Spring Season (games at 100 and 110), then Spring Playoffs (game at 200),
 * pages whose names sort the other way round. Worlds: one page in 2023 (no game date) and one in 2024.
 */
async function seed(db: TestDb) {
  for (const [i, l] of LEAGUES.entries()) await db.run("INSERT INTO leagues VALUES(?,?,?,?,?)", i + 1, l.name, l.short, l.region, +l.international);
  const id = async (name: string) => Number((await db.query("SELECT id FROM leagues WHERE name = ?", [name]))[0]!.id);
  const lck = await id("LoL Champions Korea");
  const worlds = await id("World Championship");

  await db.run(
    `INSERT INTO tournaments(id,page,event_page,stage,league_id,year,split) VALUES
      (1,'LCK/2024 Season/Spring Season','LCK/2024 Season/Spring Season','season',?,2024,'Spring'),
      (2,'LCK/2024 Season/Spring Playoffs','LCK/2024 Season/Spring Playoffs','playoffs',?,2024,'Spring'),
      (3,'2023 Season World Championship/Main Event','2023 Season World Championship','main_event',?,2023,NULL),
      (4,'2024 Season World Championship/Main Event','2024 Season World Championship','main_event',?,2024,NULL)`,
  lck, lck, worlds, worlds);
  await db.exec(`
    INSERT INTO teams(id,name) VALUES (1,'T1'),(2,'Gen.G');
    INSERT INTO players(id,page) VALUES (1,'Faker'),(2,'Chovy');
    INSERT INTO champions VALUES (1,'Azir',NULL),(2,'Orianna',NULL);
    INSERT INTO games(id,tournament_id,tab,blue_team_id,red_team_id,winner_side,length_s,played_at)
      VALUES (1,1,'Week 1',1,2,1,1800,100),(2,1,'Week 2',2,1,1,1800,110),(3,2,'Finals',1,2,1,1800,200),
             (4,3,'Finals',1,2,1,1800,NULL),(5,4,'Finals',1,2,1,1800,300);
    -- game_id, player_id, team_id, side, role, champion_id, win, kills, deaths, assists, gold, cs, damage, vision, keystone
    INSERT INTO game_players(game_id,player_id,team_id,side,role,champion_id,win,kills,deaths,assists,gold,cs,damage,vision,keystone_id) VALUES
      (1,1,1,1,'Mid',1,1,5,1,5,15000,300,30000,30,NULL),
      (1,2,2,2,'Mid',2,0,1,3,2,12000,270,18000,25,NULL),
      (2,1,1,2,'Mid',2,0,2,4,2,14000,290,25000,30,NULL),
      (2,2,2,1,'Mid',1,1,4,1,6,11000,250,15000,20,NULL),
      (3,1,1,1,'Mid',1,1,3,1,4,12000,320,20000,40,NULL),
      (3,2,2,2,'Mid',2,0,0,2,1,15000,330,26000,35,NULL),
      (4,1,1,1,'Mid',1,1,3,1,4,12000,320,20000,40,NULL),
      (4,2,2,2,'Mid',2,0,0,2,1,15000,330,26000,35,NULL),
      (5,1,1,1,'Mid',2,1,3,1,4,12000,320,20000,40,NULL),
      (5,2,2,2,'Mid',1,0,0,2,1,15000,330,26000,35,NULL);
    INSERT INTO tournament_results VALUES (2,1,'1',1,NULL),(3,1,'1',1,NULL),(4,1,'1',1,NULL);
  `);
}

async function history(input: { league: "LoL Champions Korea" | "World Championship"; yearFrom: number | null; yearTo: number | null }) {
  const db = await testDb();

  try {
    await seed(db);
    const tool = await bindTool(db, { tool: "player_event_history", input: { player: "Faker", ...input } });

    // Typed queries go through the same guard as generated ones.
    expect(guardQuery(await readSchema(db), tool.sql).ok).toBe(true);

    return await tool.format(db, (await db.query(tool.sql, tool.params)));
  } finally {
    await db.close();
  }
}

describe("player_event_history on a seeded history", () => {
  test("a league year lists its pages in the order they were played and counts them as tournaments", async () => {
    const out = await history({ league: "LoL Champions Korea", yearFrom: 2024, yearTo: 2024 });

    // By name, Spring Playoffs would come before Spring Season.
    expect(out.rows!.map((r) => r.event)).toEqual(["LCK/2024 Season/Spring Season", "LCK/2024 Season/Spring Playoffs"]);
    expect(out.facts).toContain("Faker a disputé 2 tournois de la LCK");
    expect(out.totals).toMatchObject({ events: 2 });
  });

  test("one page per year of an international event is an edition", async () => {
    const out = await history({ league: "World Championship", yearFrom: null, yearTo: null });

    expect(out.facts).toContain("Faker a disputé 2 éditions des Worlds");
    expect(out.totals).toMatchObject({ events: 2 });
  });

  test("a page whose games have no date is still listed", async () => {
    const out = await history({ league: "World Championship", yearFrom: 2023, yearTo: 2023 });

    expect(out.rows!.map((r) => r.event)).toEqual(["2023 Season World Championship"]);
    expect(out.rows![0]).toMatchObject({ wins: 1, losses: 0 });
  });
});
