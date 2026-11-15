import { describe, expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import { guardQuery } from "../src/lib/agent/guard";
import { routeQuestion } from "../src/lib/agent/query";
import { bindTool } from "../src/lib/agent/tools";
import type { Entities, LeagueName } from "../src/lib/agent/types";
import { readSchema } from "../src/lib/db";
import { createQuerySchema, createSchema } from "../src/lib/db/schema";
import { LEAGUES } from "../src/lib/domain/leagues";

const SCHEMA = { v_games: ["game_id"] };
const COVERAGE = { league: () => ({ games: 100, ingame: 100 }), player: () => ({ games: 100, ingame: 100 }), team: () => ({ games: 100, ingame: 100 }) };

const scope = (league: LeagueName | null, leagueShort: string | null, year: number | null = null): Entities => ({
  players: [], teams: [], champion: null, unresolved: [], league, leagueShort, leagueMention: leagueShort, yearFrom: year, yearTo: year, split: null, outOfScope: null,
});

const LCK24 = scope("LoL Champions Korea", "LCK", 2024);
const WORLDS = scope("World Championship", "Worlds");

describe("team rankings route to the team leaderboard, decided by the rules", () => {
  test.each([
    ["meilleur winrate d'équipe en LCK 2024", LCK24, "winrate"],
    ["quelle équipe a le meilleur winrate en LCK 2024", LCK24, "winrate"],
    ["équipes avec le plus de victoires aux Worlds", WORLDS, "wins"],
    ["which team won the most at Worlds", WORLDS, "wins"],
    ["quelle équipe a gagné le plus de parties en LCK 2024", LCK24, "wins"],
    ["classement des équipes LCK 2024 par victoires", LCK24, "wins"],
    ["classement des équipes par kills en LCK 2024", LCK24, "kills"],
    ["quelle équipe joue le plus de parties en LCK 2024", LCK24, "games"],
    ["équipe avec le meilleur gold par minute en LCK 2024", LCK24, "gpm"],
  ] as const)("%s", (q, e, criterion) => {
    const route = routeQuestion(q, e, SCHEMA, COVERAGE);

    expect(route).toMatchObject({ kind: "tool", call: { tool: "team_leaderboard", input: { league: e.league, criterion } } });
    expect(route.kind === "tool" && route.confidence).toBeGreaterThanOrEqual(0.8);
  });

  test("without a competition, the Worlds, said in a note", () => {
    expect(routeQuestion("équipes avec le plus de victoires", scope(null, null), SCHEMA, COVERAGE)).toMatchObject({
      kind: "tool",
      call: { tool: "team_leaderboard", input: { league: "World Championship" } },
      notes: ["Aucune compétition précisée : classement sur les Worlds."],
    });
  });

  // The nearest routes keep their questions: standings without a criterion, trophies, in-game metrics, players.
  test.each([
    ["classement des équipes LCK 2024", LCK24, "tournament_standings"],
    ["meilleure équipe LCK 2024", LCK24, "tournament_standings"],
    ["équipes avec le plus de first dragons en LCK 2024", LCK24, "ingame_leaderboard"],
    ["meilleurs joueurs par kills en LCK 2024", LCK24, "player_leaderboard"],
  ] as const)("%s → %s", (q, e, tool) => {
    expect(routeQuestion(q, e, SCHEMA, COVERAGE)).toMatchObject({ kind: "tool", call: { tool } });
  });

  test.each(["quelle équipe a gagné le plus de titres en LCK", "which team won the most trophies in LCK"])("a ranking of titles is not a ranking of wins: %s", (q) => {
    expect(routeQuestion(q, scope("LoL Champions Korea", "LCK"), SCHEMA, COVERAGE).kind).toBe("sql");
  });
});

/**
 * LCK 2019, six games: SK Telecom T1 (renamed T1 later) plays two games, T1 two more, Griffin four, Gen.G four.
 * Game 5 has no player rows (kills and gold unknown) and game 4 no length. LPL 2019: one game, no Riot data at all.
 */
function seed(db: DatabaseSync) {
  createSchema(db);
  createQuerySchema(db);
  LEAGUES.forEach((l, i) => db.prepare("INSERT INTO leagues VALUES(?,?,?,?,?)").run(i + 1, l.name, l.short, l.region, +l.international));
  const lck = Number(db.prepare("SELECT id FROM leagues WHERE name = 'LoL Champions Korea'").get()!.id);
  const lpl = Number(db.prepare("SELECT id FROM leagues WHERE name = 'Tencent LoL Pro League'").get()!.id);

  db.prepare("INSERT INTO tournaments(id,page,event_page,stage,league_id,year) VALUES (1,'LCK19','LCK19','season',?,2019),(2,'LPL19','LPL19','season',?,2019)").run(lck, lpl);
  db.exec(`
    INSERT INTO teams VALUES (1,'SK Telecom T1'),(2,'T1'),(3,'Griffin'),(4,'Gen.G'),(5,'Invictus Gaming'),(6,'FunPlus Phoenix');
    INSERT INTO players(id,page) VALUES (1,'Faker'),(2,'Chovy'),(3,'Ruler'),(4,'Rookie'),(5,'Doinb');
    INSERT INTO champions VALUES (1,'Azir',NULL);
    -- winner_side 1 = blue
    INSERT INTO games(id,tournament_id,blue_team_id,red_team_id,winner_side,length_s,played_at)
      VALUES (1,1,1,3,1,1800,100),(2,1,3,1,2,1500,200),(3,1,2,4,1,2400,300),(4,1,4,2,2,NULL,400),(5,1,3,4,2,1800,500),(6,1,3,4,2,1800,600),
             (7,2,5,6,1,1800,700);
    -- game_id, player_id, team_id, side, role, champion_id, win, kills, deaths, assists, gold, cs, damage, vision, keystone
    INSERT INTO game_players VALUES
      (1,1,1,1,'Mid',1,1,10,1,5,60000,300,30000,30,NULL),(1,2,3,2,'Mid',1,0,4,3,2,50000,270,18000,25,NULL),
      (2,1,1,2,'Mid',1,1,20,2,6,60000,290,25000,30,NULL),(2,2,3,1,'Mid',1,0,6,2,1,45000,250,15000,20,NULL),
      (3,1,2,1,'Mid',1,1,12,4,3,80000,320,20000,40,NULL),(3,3,4,2,'Bot',1,0,8,1,4,70000,330,26000,35,NULL),
      (4,1,2,2,'Mid',1,1,14,0,2,50000,200,NULL,NULL,NULL),(4,3,4,1,'Bot',1,0,2,2,1,40000,190,NULL,NULL,NULL),
      (6,2,3,1,'Mid',1,0,3,3,1,45000,250,15000,20,NULL),(6,3,4,2,'Bot',1,1,9,1,1,55000,250,15000,20,NULL),
      (7,4,5,1,'Mid',1,1,15,1,5,60000,300,30000,30,NULL),(7,5,6,2,'Mid',1,0,5,3,2,50000,270,18000,25,NULL);
  `);
}

async function run(db: DatabaseSync, call: Parameters<typeof bindTool>[1]) {
  const tool = bindTool(db, call);

  expect(guardQuery(db, readSchema(db), tool.sql).ok).toBe(true);

  return tool.format(db, db.prepare(tool.sql).all(tool.params));
}

const LCK19 = { league: "LoL Champions Korea" as const, yearFrom: 2019, yearTo: 2019 };

describe("team leaderboard on a seeded season", () => {
  test("a renamed team is one row; win rate, kills per game and gold per minute over the games that have them", async () => {
    const db = new DatabaseSync(":memory:");

    try {
      seed(db);
      const out = await run(db, { tool: "team_leaderboard", input: { ...LCK19, criterion: "winrate", minGames: 3 } });

      expect(out.table!.columns).toEqual(["Rang", "Équipe", "Parties", "V-D", "% victoires", "kills / partie", "or/min"]);
      // T1: 2 games as SK Telecom T1 and 2 as T1, 4 wins; kills (10+20+12+14) / 4; gold per minute over the three games with a length (game 4 has none).
      // Gen.G and Griffin: kills over the games with player rows (not game 5), gold per minute over those with both gold and length.
      expect(out.table!.rows).toEqual([
        [1, "T1", 4, "4-0", 100, 14, Math.round((60 * 200000) / 5700)],
        [2, "Gen.G", 4, "2-2", 50, 6.3, Math.round((60 * 125000) / 4200)],
        [3, "Griffin", 4, "0-4", 0, 4.3, Math.round((60 * 140000) / 5100)],
      ]);
      expect(out.facts).toContain("Meilleures équipes en LCK en 2019 selon le critère % victoires (victoires / parties), minimum 3 parties : 1. T1 : 100 %, 4 parties");
      expect(out.facts).toContain("anciens noms d'une même équipe regroupés");
      expect(out.totals).toMatchObject({ leader: "T1", leader_value: 100, leader_games: 4, rows: 3, min_games: 3, criterion: "winrate" });
      expect(out.sources.map((s) => s.label)).toContain("Leaguepedia — T1");

      const kills = await run(db, { tool: "team_leaderboard", input: { ...LCK19, criterion: "kills", minGames: 3 } });

      expect(kills.table!.rows.map((r) => [r[1], r[4]])).toEqual([["T1", 14], ["Gen.G", 6.3], ["Griffin", 4.3]]);
    } finally {
      db.close();
    }
  });

  test("minimum of games: 10 in one league season by default, none for a count, then lowered to 3", async () => {
    const db = new DatabaseSync(":memory:");

    try {
      seed(db);
      const rate = bindTool(db, { tool: "team_leaderboard", input: { ...LCK19, criterion: "winrate", minGames: null } });

      expect(rate.params.minGames).toBe(10);
      expect(db.prepare(rate.sql).all(rate.params)).toEqual([]);
      expect(rate.relaxations(scope("LoL Champions Korea", "LCK", 2019)).map((r) => r.key)).toEqual(["minGames", "period"]);

      const wins = await run(db, { tool: "team_leaderboard", input: { ...LCK19, criterion: "wins", minGames: null } });

      expect(wins.totals).toMatchObject({ leader: "T1", leader_value: 4, min_games: 1, rows: 3 });
      expect(wins.facts).toContain("Équipes avec le plus de victoires en LCK en 2019 selon le critère victoires (nombre de victoires) : 1. T1 : 4, 4 parties");

      // Worlds in one year: 5 games.
      expect(bindTool(db, { tool: "team_leaderboard", input: { league: "World Championship", yearFrom: 2023, yearTo: 2023, criterion: "winrate", minGames: null } }).params.minGames).toBe(5);
    } finally {
      db.close();
    }
  });

  test("a league without Riot data is ranked all the same: the criteria are end-of-game ones", async () => {
    const db = new DatabaseSync(":memory:");

    try {
      seed(db);
      const out = await run(db, { tool: "team_leaderboard", input: { league: "Tencent LoL Pro League", yearFrom: 2019, yearTo: 2019, criterion: "wins", minGames: null } });

      expect(out.table!.rows).toEqual([
        [1, "Invictus Gaming", 1, "1-0", 100, 15, 2000],
        [2, "FunPlus Phoenix", 1, "0-1", 0, 5, 1667],
      ]);
      expect(out.sources.some((s) => s.label.includes("Riot"))).toBe(false);

      // A scope without any game: no row, and the tool's relaxations widen it.
      const empty = bindTool(db, { tool: "team_leaderboard", input: { league: "LoL EMEA Championship", yearFrom: 2019, yearTo: 2019, criterion: "wins", minGames: null } });

      expect(db.prepare(empty.sql).all(empty.params)).toEqual([]);
    } finally {
      db.close();
    }
  });
});
