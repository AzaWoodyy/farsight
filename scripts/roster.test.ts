import { describe, expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import { guardQuery } from "../src/lib/agent/guard";
import { routeQuestion } from "../src/lib/agent/query";
import { bindTool, TOOLS } from "../src/lib/agent/tools";
import type { Entities, LeagueName, ResolvedPlayer, ResolvedTeam } from "../src/lib/agent/types";
import { resolveTeam, understandQuestion } from "../src/lib/agent/understand";
import { readSchema } from "../src/lib/db";
import { createQuerySchema, createSchema } from "../src/lib/db/schema";
import { LEAGUES } from "../src/lib/domain/leagues";

const SCHEMA = { v_games: ["game_id"] };
const COVERAGE = { league: () => ({ games: 100, ingame: 100 }), player: () => ({ games: 100, ingame: 100 }) };

const team = (mention: string, name: string, members = [name]): ResolvedTeam => ({ mention, team: name, members });
const player = (name: string): ResolvedPlayer => ({ mention: name, player: name, matchedAlias: name, realName: null, nativeName: null, otherCandidates: [], ambiguity: null });

const entities = (over: Partial<Entities>): Entities => ({
  players: [], teams: [], champion: null, unresolved: [], league: null, leagueShort: null, leagueMention: null, yearFrom: null, yearTo: null, split: null, outOfScope: null,
  ...over,
});

const year = (y: number) => ({ yearFrom: y, yearTo: y });
const SSW = team("Samsung White", "Samsung White", ["Samsung Ozone", "Samsung White"]);
const T1 = team("SKT", "T1", ["T1", "SK Telecom T1"]);
const G2 = team("G2", "G2 Esports");
const FNC = team("Fnatic", "Fnatic");
const league = (name: LeagueName, short: string): Partial<Entities> => ({ league: name, leagueShort: short, leagueMention: short });
const MSI = league("Mid-Season Invitational", "MSI");

describe("one team and a roster word: its players by role, decided by the rules", () => {
  test.each([
    ["Samsung White roster 2014", entities({ teams: [SSW], ...year(2014) })],
    ["roster de SKT en 2015", entities({ teams: [T1], ...year(2015) })],
    ["line-up de G2 au MSI 2019", entities({ teams: [G2], ...MSI, ...year(2019) })],
    ["qui jouait chez Fnatic en 2018", entities({ teams: [FNC], ...year(2018) })],
    ["effectif de Fnatic en 2018", entities({ teams: [FNC], ...year(2018) })],
    ["composition de G2 au MSI 2019", entities({ teams: [G2], ...MSI, ...year(2019) })],
    ["G2 lineup MSI 2019", entities({ teams: [G2], ...MSI, ...year(2019) })],
    ["who played for Fnatic in 2018", entities({ teams: [FNC], ...year(2018) })],
    ["quels joueurs de SKT en 2015", entities({ teams: [T1], ...year(2015) })],
    ["roster de Fnatic en LEC au Spring 2018", entities({ teams: [FNC], league: "Europe League Championship Series", leagueShort: "EU LCS", leagueMention: "LEC", ...year(2018), split: "Spring" })],
  ])("%s", (q, e) => {
    const route = routeQuestion(q, e, SCHEMA, COVERAGE);

    expect(route).toMatchObject({
      kind: "tool",
      call: { tool: "team_roster", input: { team: e.teams[0].team, league: e.league, yearFrom: e.yearFrom, yearTo: e.yearTo, split: e.split } },
    });
    expect(route.kind === "tool" && route.confidence).toBeGreaterThanOrEqual(0.9);
    expect(route.kind === "tool" && route.unread).toBeUndefined();
  });

  test("the other rules are kept", () => {
    const route = (q: string, e: Entities) => {
      const r = routeQuestion(q, e, SCHEMA, COVERAGE);

      return r.kind === "tool" ? r.call.tool : r.kind;
    };

    expect(route("historique de Fnatic en 2018", entities({ teams: [FNC], ...year(2018) }))).toBe("team_history");
    expect(route("G2 vs Fnatic", entities({ teams: [G2, FNC] }))).toBe("head_to_head");
    expect(route("Faker vs Chovy", entities({ players: [player("Faker"), player("Chovy")] }))).toBe("player_comparison");
    expect(route("meilleurs mids LEC 2025", entities({ ...league("LoL EMEA Championship", "LEC"), ...year(2025) }))).toBe("player_leaderboard");
    expect(route("classement worlds 2024", entities({ ...league("World Championship", "Worlds"), ...year(2024) }))).toBe("tournament_standings");
    // A ranking or a metric inside a team is not its roster.
    expect(route("joueur de Fnatic avec le plus de kills en 2018", entities({ teams: [FNC], ...year(2018) }))).toBe("sql");
  });
});

/**
 * Samsung Ozone (Spring 2014) then Samsung White (Summer 2014, Worlds 2014): the same five, plus Homme (two
 * games at top) and Dade (mid, Spring only). Samsung Blue (another team) and a 2015 game must not count.
 */
function seed(db: DatabaseSync) {
  createSchema(db);
  createQuerySchema(db);
  LEAGUES.forEach((l, i) => db.prepare("INSERT INTO leagues VALUES(?,?,?,?,?)").run(i + 1, l.name, l.short, l.region, +l.international));
  const id = (name: string) => Number(db.prepare("SELECT id FROM leagues WHERE name = ?").get(name)!.id);

  db.prepare(
    "INSERT INTO tournaments(id,page,event_page,name,stage,league_id,year,split) VALUES (1,'OGN14Sp','OGN14Sp','Champions 2014 Spring','season',?,2014,'Spring'),(2,'OGN14Su','OGN14Su','Champions 2014 Summer','season',?,2014,'Summer'),(3,'W14','W14','Worlds 2014','main_event',?,2014,NULL),(4,'W15','W15','Worlds 2015','main_event',?,2015,NULL)",
  ).run(id("LoL The Champions"), id("LoL The Champions"), id("World Championship"), id("World Championship"));
  db.exec(`
    INSERT INTO teams VALUES (1,'Samsung Ozone'),(2,'Samsung White'),(3,'Samsung Blue'),(4,'Other');
    INSERT INTO players(id,page) VALUES (1,'Looper'),(2,'DanDy'),(3,'PawN'),(4,'Imp'),(5,'Mata'),(6,'Homme'),(7,'Dade'),(8,'Deft');
    INSERT INTO games(id,tournament_id,tab,match_n,game_n,blue_team_id,red_team_id,winner_side,played_at) VALUES
      (1,1,'Week 1',1,1,1,4,1,100),(2,1,'Week 1',2,1,1,4,2,110),
      (3,2,'Week 1',1,1,2,4,1,200),
      (4,3,'Final',1,1,2,3,1,300),(5,3,'Final',1,2,3,2,2,310),
      (6,4,'Groups',1,1,2,4,1,400);
  `);
  const line = db.prepare("INSERT INTO game_players(game_id,player_id,team_id,role,side,win) VALUES (?,?,?,?,?,?)");
  const roles = ["Top", "Jungle", "Mid", "Bot", "Support"];
  const five = (game: number, teamId: number, players: number[], side: number, win: number) => players.forEach((p, i) => line.run(game, p, teamId, roles[i], side, win));

  five(1, 1, [6, 2, 7, 4, 5], 1, 1);
  five(2, 1, [1, 2, 7, 4, 5], 1, 0);
  five(3, 2, [1, 2, 3, 4, 5], 1, 1);
  five(4, 2, [1, 2, 3, 4, 5], 1, 1);
  five(5, 2, [1, 2, 3, 4, 5], 2, 1);
  line.run(5, 8, 3, "Bot", 1, 0);
  five(6, 2, [1, 2, 3, 4, 5], 1, 1);
}

describe("roster of a team on a seeded database", () => {
  test("old names count for the team; each role lists its starter first, then the others, with games and tournaments", async () => {
    const db = new DatabaseSync(":memory:");

    try {
      seed(db);
      expect(resolveTeam(db, "SSW")).toMatchObject({ team: "Samsung White", members: ["Samsung Ozone", "Samsung White"] });
      expect(resolveTeam(db, "Samsung Galaxy White")).toMatchObject({ team: "Samsung White" });
      expect((await understandQuestion(db, "Samsung White roster 2014", new Date("2026-11-14")))?.result.teams.map((t) => t.team)).toEqual(["Samsung White"]);

      const tool = bindTool(db, { tool: "team_roster", input: { team: "Samsung White", league: null, yearFrom: 2014, yearTo: 2014, split: null } });

      expect(guardQuery(db, readSchema(db), tool.sql).ok).toBe(true);
      const out = await tool.format(db, db.prepare(tool.sql).all(tool.params));

      expect(out.roster).toMatchObject({ team: "Samsung White", names: ["Samsung Ozone", "Samsung White"], games: 5, wins: 4 });
      expect(out.roster!.tournaments.map((t) => [t.label, t.games])).toEqual([
        ["Champions 2014 Spring", 2],
        ["Champions 2014 Summer", 1],
        ["Worlds 2014", 2],
      ]);
      expect(out.roster!.players.map((p) => [p.role, p.player, p.starter, p.games])).toEqual([
        ["Top", "Looper", true, 4],
        ["Top", "Homme", false, 1],
        ["Jungle", "DanDy", true, 5],
        ["Mid", "PawN", true, 3],
        ["Mid", "Dade", false, 2],
        ["Bot", "Imp", true, 5],
        ["Support", "Mata", true, 5],
      ]);
      expect(out.roster!.players.find((p) => p.player === "Looper")!.tournaments).toEqual(["Champions 2014 Spring", "Champions 2014 Summer", "Worlds 2014"]);
      expect(out.totals).toMatchObject({ top: "Looper", jungle: "DanDy", mid: "PawN", bot: "Imp", support: "Mata", players: 7, games: 5 });
      expect(out.facts).toContain("Noms pris en compte : Samsung Ozone, Samsung White");
      expect(out.sources.map((s) => s.url)).toContain("https://lol.fandom.com/wiki/W14");

      // A competition restricts the roster.
      const worlds = bindTool(db, { tool: "team_roster", input: { team: "Samsung White", league: "World Championship", yearFrom: 2014, yearTo: 2014, split: null } });
      const atWorlds = await worlds.format(db, db.prepare(worlds.sql).all(worlds.params));

      expect(atWorlds.roster).toMatchObject({ games: 2, scope: "aux Worlds en 2014", names: ["Samsung White"] });
      expect(atWorlds.roster!.players.map((p) => p.player)).toEqual(["Looper", "DanDy", "PawN", "Imp", "Mata"]);

      // A split restricts the roster and its tournaments; an even split of the games gives two starters.
      const spring = bindTool(db, { tool: "team_roster", input: { team: "Samsung White", league: null, yearFrom: 2014, yearTo: 2014, split: "Spring" } });

      expect(guardQuery(db, readSchema(db), spring.sql).ok).toBe(true);
      const inSpring = await spring.format(db, db.prepare(spring.sql).all(spring.params));

      expect(inSpring.roster).toMatchObject({ games: 2, scope: "au split Spring en 2014", names: ["Samsung Ozone"] });
      expect(inSpring.roster!.tournaments.map((t) => t.label)).toEqual(["Champions 2014 Spring"]);
      expect(inSpring.roster!.players.filter((p) => p.role === "Top").map((p) => [p.player, p.starter])).toEqual([["Homme", true], ["Looper", true]]);

      // The router model may write an old name: the input carries the team's current one.
      expect(TOOLS.team_roster.normalize(db, { team: "Samsung Ozone", league: null, yearFrom: 2014, yearTo: 2014, split: null })).toMatchObject({ input: { team: "Samsung White" } });
    } finally {
      db.close();
    }
  });
});
