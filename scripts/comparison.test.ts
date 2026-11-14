import { expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import { guardQuery } from "../src/lib/agent/guard";
import { routeQuestion } from "../src/lib/agent/query";
import { bindTool } from "../src/lib/agent/tools";
import type { Entities, LeagueName, ResolvedPlayer } from "../src/lib/agent/types";
import { readSchema } from "../src/lib/db";
import { createQuerySchema, createSchema } from "../src/lib/db/schema";
import { LEAGUES } from "../src/lib/domain/leagues";

const player = (mention: string, page = mention): ResolvedPlayer => ({
  mention, player: page, matchedAlias: mention.toLowerCase(), realName: null, nativeName: null, otherCandidates: [], ambiguity: null,
});

const entities = (players: ResolvedPlayer[], league: LeagueName | null = null, leagueShort: string | null = null): Entities => ({
  players, teams: [], champion: null, unresolved: [], league, leagueShort, leagueMention: leagueShort, yearFrom: null, yearTo: null, split: null, outOfScope: null,
});

const SCHEMA = { v_games: ["game_id"], v_game_player_stats: ["penta_kills"] };
const NO_COVERAGE = { league: () => ({ games: 0, ingame: 0 }), player: () => ({ games: 0, ingame: 0 }) };
const LEC = ["LoL EMEA Championship", "LEC"] as const;

test.each([
  ["comparaison Saken et Kyeahoo en LEC", entities([player("Saken", "SAKEN"), player("Kyeahoo")], ...LEC), "SAKEN", "Kyeahoo"],
  ["Saken vs Kyeahoo", entities([player("Saken", "SAKEN"), player("Kyeahoo")]), "SAKEN", "Kyeahoo"],
  ["compare Chovy et Faker aux Worlds", entities([player("Chovy"), player("Faker")], "World Championship", "Worlds"), "Chovy", "Faker"],
  ["Caps contre Humanoid en LEC", entities([player("Caps"), player("Humanoid")], ...LEC), "Caps", "Humanoid"],
  ["Kyeahoo or Saken who is better", entities([player("Kyeahoo"), player("Saken", "SAKEN")]), "Kyeahoo", "SAKEN"],
  ["Faker face à face avec Chovy, qui est le meilleur ?", entities([player("Faker"), player("Chovy")]), "Faker", "Chovy"],
])("%s → comparison, decided by the rules", (question, e, a, b) => {
  const route = routeQuestion(question, e, SCHEMA, NO_COVERAGE);

  // At or above the build threshold (0.8): neither the LLM router nor text-to-SQL is asked.
  expect(route).toMatchObject({ kind: "tool", forced: true, call: { tool: "player_comparison", input: { playerA: a, playerB: b, league: e.league } } });
  expect(route.kind === "tool" && route.confidence).toBeGreaterThanOrEqual(0.8);
});

test("explicit matchup words keep the games two players played against each other", () => {
  for (const q of ["confrontations Faker contre Chovy", "Faker Chovy head to head", "h2h Faker Chovy", "matchs entre Faker et Chovy"])
    expect(routeQuestion(q, entities([player("Faker"), player("Chovy")]), SCHEMA, NO_COVERAGE)).toMatchObject({ call: { tool: "head_to_head", input: { kind: "player" } } });
});

test("two teams still route to their head-to-head, a metric to text-to-SQL", () => {
  const teams = { ...entities([]), teams: [{ mention: "T1", team: "T1", members: ["T1"] }, { mention: "Gen.G", team: "Gen.G", members: ["Gen.G"] }] };

  expect(routeQuestion("T1 contre Gen.G", teams, SCHEMA, NO_COVERAGE)).toMatchObject({ call: { tool: "head_to_head", input: { kind: "team" } } });
  expect(routeQuestion("compare les dégâts de Chovy et Faker", entities([player("Chovy"), player("Faker")]), SCHEMA, NO_COVERAGE)).toMatchObject({ kind: "sql" });
});

test("the comparison reads both players' averages in the scope and their record against each other", async () => {
  const db = new DatabaseSync(":memory:");

  try {
    createSchema(db);
    createQuerySchema(db);
    LEAGUES.forEach((l, i) => db.prepare("INSERT INTO leagues VALUES(?,?,?,?,?)").run(i + 1, l.name, l.short, l.region, +l.international));
    const lec = Number(db.prepare("SELECT id FROM leagues WHERE name = 'LoL EMEA Championship'").get()!.id);
    const lck = Number(db.prepare("SELECT id FROM leagues WHERE name = 'LoL Champions Korea'").get()!.id);

    db.prepare("INSERT INTO tournaments(id,page,event_page,stage,league_id,year) VALUES (1,'LEC24','LEC24','season',?,2024), (2,'LCK24','LCK24','season',?,2024)").run(lec, lck);
    db.exec(`
      INSERT INTO teams VALUES (1,'G2 Esports'),(2,'Fnatic');
      INSERT INTO players(id,page) VALUES (1,'Caps'),(2,'Humanoid');
      INSERT INTO games(id,tournament_id,blue_team_id,red_team_id,winner_side) VALUES (1,1,1,2,1),(2,1,2,1,1),(3,2,1,2,1);
      -- game 1: Caps wins against Humanoid; game 2: Humanoid wins; game 3 is outside the LEC.
      INSERT INTO game_players VALUES
        (1,1,1,1,'Mid',NULL,1,4,1,6,15000,300,25000,40,NULL),
        (1,2,2,2,'Mid',NULL,0,1,4,2,12000,280,18000,30,NULL),
        (2,1,1,2,'Mid',NULL,0,2,3,1,11000,270,NULL,NULL,NULL),
        (2,2,2,1,'Mid',NULL,1,5,0,5,14000,310,22000,36,NULL),
        (3,1,1,1,'Mid',NULL,1,9,0,9,16000,320,30000,50,NULL);
    `);

    const tool = bindTool(db, { tool: "player_comparison", input: { playerA: "Caps", playerB: "Humanoid", league: "LoL EMEA Championship", yearFrom: null, yearTo: null } });
    const sql = db.prepare(tool.sql);
    const out = await tool.format(db, sql.all(tool.params));

    // Typed queries go through the same guard as generated ones.
    expect(guardQuery(db, readSchema(db), tool.sql).ok).toBe(true);
    expect(out.table!.columns.slice(0, 4)).toEqual(["player", "games", "wins", "avg_kills"]);
    expect(out.table!.rows.map((r) => r.slice(0, 5))).toEqual([["Caps", 2, 1, 3, 2], ["Humanoid", 2, 1, 3, 2]]);
    // Null damage on one game: the average reads the known one only.
    expect(out.table!.rows[0][out.table!.columns.indexOf("avg_damage")]).toBe(25000);
    expect(out.totals).toMatchObject({ games_a: 2, wins_a: 1, games_b: 2, wins_b: 1, h2h_games: 2, h2h_wins_a: 1 });
    expect(out.facts).toContain("Face à face : 2 parties, Caps 1 – 1 Humanoid.");
  } finally {
    db.close();
  }
});
