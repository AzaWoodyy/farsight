import { describe, expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import { guardQuery } from "../src/lib/agent/guard";
import { routeQuestion } from "../src/lib/agent/query";
import { bindTool, type SeriesInput } from "../src/lib/agent/tools";
import type { Entities, LeagueName, ResolvedTeam } from "../src/lib/agent/types";
import { readSchema } from "../src/lib/db";
import { createQuerySchema, createSchema } from "../src/lib/db/schema";
import { LEAGUES } from "../src/lib/domain/leagues";

const SCHEMA = { v_games: ["game_id"] };
const COVERAGE = { league: () => ({ games: 100, ingame: 100 }), player: () => ({ games: 100, ingame: 100 }), team: () => ({ games: 100, ingame: 100 }) };

const WORLDS = "World Championship";

const team = (name: string): ResolvedTeam => ({ mention: name, team: name, members: [name] });

const MENTION: Partial<Record<LeagueName, string>> = { [WORLDS]: "worlds", "LoL Champions Korea": "LCK", "Mid-Season Invitational": "MSI" };

const entities = (league: LeagueName | null, year: number | null, teams: ResolvedTeam[] = []): Entities => ({
  players: [], teams, champion: null, unresolved: [], league, leagueShort: null, leagueMention: league ? (MENTION[league] ?? null) : null, yearFrom: year, yearTo: year, split: null, outOfScope: null,
});

const route = (q: string, e: Entities) => {
  const r = routeQuestion(q, e, SCHEMA, COVERAGE);

  return r.kind === "tool" ? { tool: r.call.tool, input: r.call.input, confidence: r.confidence } : { tool: r.kind };
};

describe("a stage of a competition routes to its series", () => {
  test.each([
    ["Final worlds 2025", "final"],
    ["final worlds 2025", "final"],
    ["Finale des Worlds 2025", "final"],
    ["grande finale worlds 2025", "final"],
    ["worlds 2025 grand final", "final"],
    ["qui a gagné la finale des worlds 2025", "final"],
    ["demi-finales worlds 2025", "semifinal"],
    ["demi finale worlds 2025", "semifinal"],
    ["semis worlds 2025", "semifinal"],
    ["semifinals worlds 2025", "semifinal"],
    ["quarts worlds 2025", "quarterfinal"],
    ["quarts de finale des worlds 2025", "quarterfinal"],
    ["quarters worlds 2025", "quarterfinal"],
    ["quarterfinals worlds 2025", "quarterfinal"],
  ])("%s → %s", (q, phase) => {
    expect(route(q, entities(WORLDS, 2025))).toMatchObject({ tool: "series", input: { phase, league: WORLDS, yearFrom: 2025, yearTo: 2025, teamA: null }, confidence: 0.9 });
  });

  test("two teams and a stage: that match, before their head-to-head", () => {
    expect(route("T1 vs Gen.G finale LCK 2024", entities("LoL Champions Korea", 2024, [team("T1"), team("Gen.G")]))).toMatchObject({
      tool: "series",
      input: { teamA: "T1", teamB: "Gen.G", league: "LoL Champions Korea", phase: "final", split: null },
    });
    expect(route("T1 vs Gen.G LCK 2024", entities("LoL Champions Korea", 2024, [team("T1"), team("Gen.G")]))).toMatchObject({ tool: "head_to_head" });
  });

  test("standings words keep the standings, a game number keeps the timeline, a metric keeps its route", () => {
    expect(route("classement des Worlds 2025", entities(WORLDS, 2025))).toMatchObject({ tool: "tournament_standings" });
    expect(route("palmarès des finales des Worlds", entities(WORLDS, null))).toMatchObject({ tool: "tournament_standings" });
    expect(route("game 5 de la finale des Worlds 2024", entities(WORLDS, 2024))).toMatchObject({ tool: "game_timeline" });
    expect(route("kills en finale des Worlds 2025", entities(WORLDS, 2025)).tool).not.toBe("series");
  });

  test("the split asked is kept: the LCK summer final is not the spring one", () => {
    expect(route("finale LCK summer 2024", { ...entities("LoL Champions Korea", 2024), split: "Summer" })).toMatchObject({ tool: "series", input: { phase: "final", split: "Summer" } });
  });

  test("a stage alone, without a competition or a team, is not routed to a series", () => {
    expect(route("finale", entities(null, null)).tool).not.toBe("series");
  });
});

/**
 * Worlds 2025: the LPL Regional Finals (a qualifier under the Worlds league, tab "Finals") and the main event's final, a Bo5
 * T1 3-2 KT. MSI 2024: a double-elimination bracket without a "Semifinals" tab (Bracket Round 3, Bracket Round 4, Finals).
 */
function seed(db: DatabaseSync) {
  createSchema(db);
  createQuerySchema(db);
  LEAGUES.forEach((l, i) => db.prepare("INSERT INTO leagues VALUES(?,?,?,?,?)").run(i + 1, l.name, l.short, l.region, +l.international));
  const id = (name: string) => Number(db.prepare("SELECT id FROM leagues WHERE name = ?").get(name)!.id);

  db.prepare(
    `INSERT INTO tournaments(id,page,event_page,stage,name,league_id,year) VALUES
     (1,'LPL/2025 Season/Regional Finals','LPL/2025 Season/Regional Finals','qualifier','LPL 2025 Regional Finals',?,2025),
     (2,'2025 Season World Championship/Main Event','2025 Season World Championship','main_event','Worlds 2025 Main Event',?,2025),
     (3,'2024 Mid-Season Invitational','2024 Mid-Season Invitational','main_event','MSI 2024',?,2024)`,
  ).run(id(WORLDS), id(WORLDS), id("Mid-Season Invitational"));
  db.exec(`
    INSERT INTO teams VALUES (1,'Top Esports'),(2,'Invictus Gaming'),(3,'T1'),(4,'KT Rolster'),(5,'Gen.G'),(6,'Bilibili Gaming'),(7,'G2 Esports');
    INSERT INTO champions VALUES (1,'Ryze','https://ddragon/Ryze.png'),(2,'Taliyah','https://ddragon/Taliyah.png'),(3,'Azir',NULL);
    INSERT INTO players(id,page,ign) VALUES (1,'Bdd','Bdd'),(2,'Faker','Faker'),(3,'Doran (Choi Hyeon-jun)','Doran');
    INSERT INTO games(id,tournament_id,tab,match_n,game_n,blue_team_id,red_team_id,winner_side,length_s,patch,played_at) VALUES
      (1,1,'Finals',1,1,1,2,1,1800,'25.1',100),
      (10,2,'Finals',1,1,4,3,2,2170,'25.2',1000),(11,2,'Finals',1,2,4,3,1,2552,'25.2',1100),(12,2,'Finals',1,3,3,4,2,2212,'25.2',1200),
      (13,2,'Finals',1,4,3,4,1,1780,'25.2',1300),(14,2,'Finals',1,5,4,3,2,2207,'25.2',1400),
      (20,3,'Bracket Round 3',1,1,7,3,2,1700,'14.8',500),
      (21,3,'Bracket Round 4',1,1,5,6,1,1800,'14.8',600),(22,3,'Bracket Round 4',2,1,6,3,1,1900,'14.8',700),
      (23,3,'Finals',1,1,6,5,2,2000,'14.8',800);
    INSERT INTO game_players(game_id,player_id,team_id,side,role,champion_id,win) VALUES
      (10,2,3,2,'Mid',2,1),(10,3,3,2,'Top',3,1),(10,1,4,1,'Mid',1,0);
    INSERT INTO game_draft VALUES (10,1,1,1,3),(10,2,1,1,1);
    INSERT INTO game_riot VALUES (10,'LOLTMNT01_1','V5 data:LOLTMNT01 1',5,1,0);
  `);
}

const run = async (db: DatabaseSync, input: SeriesInput) => {
  const tool = bindTool(db, { tool: "series", input });
  const guarded = guardQuery(db, readSchema(db), tool.sql);

  expect(guarded.ok).toBe(true);

  return tool.format(db, db.prepare(tool.sql).all(tool.params));
};

describe("series tool on a seeded database", () => {
  test("the Worlds final is the main event's, not the LPL Regional Finals: one Bo5 with every game", async () => {
    const db = new DatabaseSync(":memory:");

    try {
      seed(db);
      const out = await run(db, { teamA: null, teamB: null, league: WORLDS, yearFrom: 2025, yearTo: 2025, phase: "final", split: null });

      expect(out.series?.series.map((s) => [s.teamA, s.winsA, s.winsB, s.teamB, s.bestOf, s.label])).toEqual([["T1", 3, 2, "KT Rolster", 5, "Worlds 2025 · finale"]]);
      expect(out.title).toBe("T1 3-2 KT Rolster — Worlds 2025 · finale");
      expect(out.facts).toContain("T1 bat KT Rolster 3-2 (BO5)");
      expect(out.facts).not.toContain("Top Esports");
      expect(out.totals).toMatchObject({ series: 1, games: 5, score: "3-2", best_of: 5 });

      const [g1] = out.series!.series[0].games!;

      // Sides, winner, duration, picks Top → Support (page names shortened) and bans with their icons.
      expect(g1).toMatchObject({ n: 1, blue: "KT Rolster", red: "T1", winner: "red", durationS: 2170, patch: "25.2" });
      expect(g1.picks.red.map((p) => [p.role, p.player, p.champion])).toEqual([["Top", "Doran", "Azir"], ["Mid", "Faker", "Taliyah"]]);
      expect(g1.picks.blue.map((p) => [p.player, p.icon])).toEqual([["Bdd", "https://ddragon/Ryze.png"]]);
      expect(g1.bans).toEqual({ blue: [{ champion: "Azir", icon: null }], red: [{ champion: "Ryze", icon: "https://ddragon/Ryze.png" }] });
      // The game with Riot data links its own page; the others the tournament page.
      expect(g1.source.url).toBe("https://lol.fandom.com/wiki/V5_data%3ALOLTMNT01_1");
      expect(out.series!.series[0].games![1].source.url).toBe("https://lol.fandom.com/wiki/2025_Season_World_Championship/Main_Event");
      expect(out.table?.rows).toHaveLength(5);
      // A follow-up recap names both teams, so it opens a game of this series.
      expect(out.followUps[0]).toBe("Récap de la game 5 de T1 vs KT Rolster, la finale des Worlds 2025");
    } finally {
      db.close();
    }
  });

  test("a double-elimination bracket: its semifinal is the last round before the final, with a note", async () => {
    const db = new DatabaseSync(":memory:");

    try {
      seed(db);
      const out = await run(db, { teamA: null, teamB: null, league: "Mid-Season Invitational", yearFrom: 2024, yearTo: 2024, phase: "semifinal", split: null });

      expect(out.series?.series.map((s) => `${s.teamA} ${s.winsA}-${s.winsB} ${s.teamB}`)).toEqual(["Gen.G 1-0 Bilibili Gaming", "Bilibili Gaming 1-0 T1"]);
      expect(out.title).toBe("Demi-finales — MSI 2024");
      expect(out.notes?.join(" ")).toContain("double élimination");
    } finally {
      db.close();
    }
  });

  test("a split filters the tournaments: no MSI 2024 semifinal in a Summer split", async () => {
    const db = new DatabaseSync(":memory:");

    try {
      seed(db);
      db.exec("UPDATE tournaments SET split = 'Spring' WHERE id = 3");
      const input = { teamA: null, teamB: null, league: "Mid-Season Invitational", yearFrom: 2024, yearTo: 2024, phase: "semifinal" } as const;
      const summer = bindTool(db, { tool: "series", input: { ...input, split: "Summer" } });
      const spring = bindTool(db, { tool: "series", input: { ...input, split: "Spring" } });

      expect(db.prepare(summer.sql).all(summer.params)).toHaveLength(0);
      expect(db.prepare(spring.sql).all(spring.params)).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  test("a team that did not reach the stage: the stage without the team, said in a note", () => {
    const db = new DatabaseSync(":memory:");

    try {
      seed(db);
      const tool = bindTool(db, { tool: "series", input: { teamA: "G2 Esports", teamB: null, league: WORLDS, yearFrom: 2025, yearTo: 2025, phase: "final", split: null } });

      expect(db.prepare(tool.sql).all(tool.params)).toHaveLength(0);
      const [relax] = tool.relaxations(entities(WORLDS, 2025));

      expect(relax.note).toContain("G2 Esports n'a pas joué de finale");
      const next = relax.next();

      expect(db.prepare(next.sql).all(next.params)).toHaveLength(5);
    } finally {
      db.close();
    }
  });
});
