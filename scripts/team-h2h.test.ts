import { describe, expect, test } from "bun:test";
import { guardQuery } from "../src/lib/agent/guard";
import { routeQuestion } from "../src/lib/agent/query";
import { bindTool, TOOLS } from "../src/lib/agent/tools";
import type { Entities, LeagueName, ResolvedTeam } from "../src/lib/agent/types";
import { resolveTeam, understandQuestion } from "../src/lib/agent/understand";
import { readSchema } from "../src/lib/db";
import { LEAGUES } from "../src/lib/domain/leagues";
import { testDb, type TestDb } from "./fixtures/test-db";

const SCHEMA = { v_games: ["game_id"] };
const COVERAGE = { league: () => ({ games: 100, ingame: 100 }), player: () => ({ games: 100, ingame: 100 }), team: () => ({ games: 100, ingame: 100 }) };

const team = (mention: string, name: string, members = [name]): ResolvedTeam => ({ mention, team: name, members });

const teams = (list: ResolvedTeam[], league: LeagueName | null = null, leagueShort: string | null = null): Entities => ({
  players: [], teams: list, champion: null, unresolved: [], league, leagueShort, leagueMention: leagueShort, yearFrom: null, yearTo: null, split: null, outOfScope: null,
});

const KC = team("kc", "Karmine Corp");
const MKOI = team("mkoi", "Movistar KOI", ["MAD Lions", "MAD Lions KOI", "Movistar KOI"]);

describe("two teams and an opposing word: their head-to-head, decided by the rules", () => {
  test.each([
    ["h2h kc et mkoi en lec", teams([KC, MKOI], "LoL EMEA Championship", "LEC")],
    ["h2h kc et mkoi", teams([KC, MKOI])],
    ["KC head to head MKOI", teams([KC, MKOI])],
    ["confrontations KC contre MKOI", teams([KC, MKOI])],
    ["compare KC et MKOI", teams([KC, MKOI])],
    ["G2 vs Fnatic", teams([team("G2", "G2 Esports"), team("Fnatic", "Fnatic")])],
    ["T1 contre Gen.G aux Worlds", teams([team("T1", "T1"), team("Gen.G", "Gen.G")], "World Championship", "Worlds")],
  ])("%s", async (q, e) => {
    const route = await routeQuestion(q, e, SCHEMA, COVERAGE);

    expect(route).toMatchObject({
      kind: "tool",
      forced: true,
      call: { tool: "head_to_head", input: { kind: "team", sideA: e.teams[0].team, sideB: e.teams[1].team, league: e.league } },
    });
    expect(route.kind === "tool" && route.confidence).toBeGreaterThanOrEqual(0.8);
  });

  test("a franchise's names over time are one team", async () => {
    const db = await testDb();

    try {
      await db.exec(`INSERT INTO teams(id,name) VALUES (1,'DragonX'),(2,'DRX'),(3,'Kiwoom DRX'),(4,'HANJIN BRION'),(5,'OKSavingsBank BRION'),(6,'DN SOOPers'),(7,'Kwangdong Freecs');
        INSERT INTO games(id,tournament_id,blue_team_id,red_team_id) VALUES (1,1,1,2),(2,1,3,4),(3,1,5,6),(4,1,7,1);`);

      for (const [mention, name, members] of [
        ["DRX", "DRX", ["DragonX", "DRX", "Kiwoom DRX"]],
        ["BRO", "HANJIN BRION", ["OKSavingsBank BRION", "HANJIN BRION"]],
        ["KDF", "DN SOOPers", ["Kwangdong Freecs", "DN SOOPers"]],
      ] as const)
        expect(await resolveTeam(db, mention)).toMatchObject({ team: name, members });
    } finally {
      await db.close();
    }
  });

  test("one team stays its history", async () => {
    expect(await routeQuestion("palmarès de KC", teams([KC]), SCHEMA, COVERAGE)).toMatchObject({ call: { tool: "team_history", input: { team: "Karmine Corp" } } });
  });
});

async function seed(db: TestDb) {
  for (const [i, l] of LEAGUES.entries()) await db.run("INSERT INTO leagues VALUES(?,?,?,?,?)", i + 1, l.name, l.short, l.region, +l.international);
  const id = async (name: string) => Number((await db.query("SELECT id FROM leagues WHERE name = ?", [name]))[0]!.id);

  await db.run("INSERT INTO tournaments(id,page,event_page,stage,league_id,year) VALUES (1,'LEC24','LEC24','season',?,2024),(2,'LEC25','LEC25','playoffs',?,2025),(3,'W25','W25','main_event',?,2025)", await id("LoL EMEA Championship"),
    await id("LoL EMEA Championship"),
    await id("World Championship"),);
  await db.exec(`
    INSERT INTO teams(id,name) VALUES (1,'Karmine Corp'),(2,'MAD Lions KOI'),(3,'Movistar KOI'),(4,'MAD Lions'),(5,'Fnatic');
    INSERT INTO games(id,tournament_id,tab,match_n,game_n,blue_team_id,red_team_id,winner_side,played_at) VALUES
      (1,1,'Week 2',3,1,1,2,1,100),
      (2,2,'Semifinals',1,1,1,3,1,200),(3,2,'Semifinals',1,2,3,1,1,210),(4,2,'Semifinals',1,3,1,3,2,220),
      (5,3,'Round 3',4,1,3,1,2,300),
      (6,1,'Week 1',1,1,4,5,1,50);
  `);
}

describe("head-to-head of two teams on a seeded database", () => {
  test("old names count for the franchise; every series is listed newest first with its score and source", async () => {
    const db = await testDb();

    try {
      await seed(db);
      expect(await resolveTeam(db, "mkoi")).toMatchObject({ team: "Movistar KOI", members: ["MAD Lions", "MAD Lions KOI", "Movistar KOI"] });
      expect((await understandQuestion(db, "h2h kc et mkoi en lec", new Date("2026-11-14")))?.result.teams.map((t) => t.team)).toEqual(["Karmine Corp", "Movistar KOI"]);

      const tool = await bindTool(db, { tool: "head_to_head", input: { kind: "team", sideA: "Karmine Corp", sideB: "Movistar KOI", league: null, yearFrom: null, yearTo: null } });

      expect(guardQuery(await readSchema(db), tool.sql).ok).toBe(true);
      const out = await tool.format(db, (await db.query(tool.sql, tool.params)));

      expect(out.teams).toMatchObject({ teamA: "Karmine Corp", teamB: "Movistar KOI", seriesA: 2, seriesB: 1, gamesA: 3, gamesB: 2, seriesCount: 3 });
      expect(out.teams!.series.map((s) => [s.label, s.teamA, s.winsA, s.winsB, s.teamB, s.source.url])).toEqual([
        ["Worlds 2025 · tour 3", "Karmine Corp", 1, 0, "Movistar KOI", "https://lol.fandom.com/wiki/W25"],
        ["LEC 2025 · demi-finale", "Karmine Corp", 1, 2, "Movistar KOI", "https://lol.fandom.com/wiki/LEC25"],
        ["LEC 2024 · semaine 2", "Karmine Corp", 1, 0, "MAD Lions KOI", "https://lol.fandom.com/wiki/LEC24"],
      ]);
      expect(out.totals).toMatchObject({ series: 3, series_a: 2, series_b: 1, wins_a: 3, wins_b: 2 });
      expect(out.facts).toContain("3 séries");
      expect(out.facts).toContain("Dernière rencontre : Worlds 2025 · tour 3");

      expect(await TOOLS.head_to_head.normalize(db, { kind: "team", sideA: "kc", sideB: "MAD Lions KOI", league: null, yearFrom: null, yearTo: null })).toMatchObject({
        input: { sideA: "Karmine Corp", sideB: "Movistar KOI" },
      });
      expect(await TOOLS.team_history.normalize(db, { team: "MAD Lions", league: null, yearFrom: null, yearTo: null })).toMatchObject({ input: { team: "Movistar KOI" } });

      const lec = await bindTool(db, { tool: "head_to_head", input: { kind: "team", sideA: "Karmine Corp", sideB: "Movistar KOI", league: "LoL EMEA Championship", yearFrom: null, yearTo: null } });
      const inLec = await lec.format(db, (await db.query(lec.sql, lec.params)));

      expect(inLec.teams).toMatchObject({ seriesA: 1, seriesB: 1, gamesA: 2, gamesB: 2, seriesCount: 2, scope: "en LEC" });
    } finally {
      await db.close();
    }
  });

  test("the order of the question holds for a name written with an apostrophe", async () => {
    const db = await testDb();

    try {
      await seed(db);
      await db.exec(`INSERT INTO teams(id,name) VALUES (6,'Anyone''s Legend');
        INSERT INTO games(id,tournament_id,tab,match_n,game_n,blue_team_id,red_team_id,winner_side,played_at) VALUES (7,3,'Round 1',1,1,5,6,1,310);`);
      const order = async (q: string) => (await understandQuestion(db, q, new Date("2026-11-14")))?.result.teams.map((t) => t.team);

      expect(await order("Fnatic vs Anyone's Legend")).toEqual(["Fnatic", "Anyone's Legend"]);
      expect(await order("Anyone's Legend vs Fnatic")).toEqual(["Anyone's Legend", "Fnatic"]);
      expect(await order("Fnatic vs Anyone’s Legend")).toEqual(["Fnatic", "Anyone's Legend"]);
      expect(await order("Karmine Corp contre Fnatic")).toEqual(["Karmine Corp", "Fnatic"]);
    } finally {
      await db.close();
    }
  });
});
