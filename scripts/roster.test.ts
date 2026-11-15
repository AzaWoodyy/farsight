import { describe, expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import { guardQuery } from "../src/lib/agent/guard";
import { type Coverage, coverageLookup, routeQuestion } from "../src/lib/agent/query";
import { bindTool, TOOLS } from "../src/lib/agent/tools";
import type { Entities, LeagueName, ResolvedPlayer, ResolvedTeam } from "../src/lib/agent/types";
import { resolveTeam, understandQuestion } from "../src/lib/agent/understand";
import { readSchema } from "../src/lib/db";
import { createQuerySchema, createSchema } from "../src/lib/db/schema";
import { LEAGUES } from "../src/lib/domain/leagues";

const SCHEMA = { v_games: ["game_id"] };
const COVERAGE = { league: () => ({ games: 100, ingame: 100 }), player: () => ({ games: 100, ingame: 100 }), team: () => ({ games: 100, ingame: 100 }) };

const team = (mention: string, name: string, members = [name]): ResolvedTeam => ({ mention, team: name, members });
const player = (name: string): ResolvedPlayer => ({ mention: name, player: name, matchedAlias: name, realName: null, nativeName: null, otherCandidates: [], ambiguity: null });

const entities = (over: Partial<Entities>): Entities => ({
  players: [], teams: [], champion: null, unresolved: [], league: null, leagueShort: null, leagueMention: null, yearFrom: null, yearTo: null, split: null, outOfScope: null,
  ...over,
});

const year = (y: number) => ({ yearFrom: y, yearTo: y });
const SSW = team("Samsung White", "Samsung White", ["Samsung Ozone", "Samsung White"]);
const T1 = team("SKT", "T1", ["T1", "SK Telecom T1"]);
const T1_NOW = team("T1", "T1", ["T1", "SK Telecom T1"]);
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
    ["T1 roaster 2024", entities({ teams: [T1_NOW], ...year(2024) })],
    ["roster de Fnatic en LEC au Spring 2018", entities({ teams: [FNC], league: "Europe League Championship Series", leagueShort: "EU LCS", leagueMention: "LEC", ...year(2018), split: "Spring" })],
  ])("%s", (q, e) => {
    const route = routeQuestion(q, e, SCHEMA, COVERAGE);

    expect(route).toMatchObject({
      kind: "tool",
      call: { tool: "team_roster", input: { team: e.teams[0].team, league: e.league, yearFrom: e.yearFrom, yearTo: e.yearTo, split: e.split, role: null } },
    });
    expect(route.kind === "tool" && route.confidence).toBeGreaterThanOrEqual(0.9);
    expect(route.kind === "tool" && route.unread).toBeUndefined();
  });

  test.each([
    ["adc de T1", T1_NOW, "Bot"],
    ["c'est qui le toplaner de T1 ?", T1_NOW, "Top"],
    ["who is the jungler of G2", G2, "Jungle"],
    ["le support actuel de Fnatic", FNC, "Support"],
  ] as const)("one team and a role: the current roster, that role first (%s)", (q, t, role) => {
    const route = routeQuestion(q, entities({ teams: [t] }), SCHEMA, COVERAGE);

    expect(route).toMatchObject({ kind: "tool", call: { tool: "team_roster", input: { team: t.team, yearFrom: null, yearTo: null, role } } });
    expect(route.kind === "tool" && route.unread).toBeUndefined();
  });

  const FPX = team("fpx", "FunPlus Phoenix");
  const WORLDS = league("World Championship", "Worlds");

  test.each([
    ...["top", "toplaner", "toplane", "top lane", "top laner"].map((w) => [w, "Top"] as const),
    ...["jg", "jgl", "jungle", "jungler"].map((w) => [w, "Jungle"] as const),
    ...["mid", "midlaner", "midlane", "mid lane"].map((w) => [w, "Mid"] as const),
    ...["adc", "bot", "botlaner", "botlane", "ad carry"].map((w) => [w, "Bot"] as const),
    ...["support", "supp", "sup"].map((w) => [w, "Support"] as const),
  ])("one team and a role word, in either order, with or without « de », a year or a competition (%s)", (w, role) => {
    const cases: [string, Entities][] = [
      [`${w} fpx 2019`, entities({ teams: [FPX], ...year(2019) })],
      [`${w} de fpx 2019`, entities({ teams: [FPX], ...year(2019) })],
      [`fpx ${w} 2019`, entities({ teams: [FPX], ...year(2019) })],
      [`${w} fpx`, entities({ teams: [FPX] })],
      [`fpx ${w}`, entities({ teams: [FPX] })],
      [`${w} de fpx aux worlds 2019`, entities({ teams: [FPX], ...WORLDS, ...year(2019) })],
      [`fpx ${w} worlds 2019`, entities({ teams: [FPX], ...WORLDS, ...year(2019) })],
    ];

    for (const [q, e] of cases) {
      const route = routeQuestion(q, e, SCHEMA, COVERAGE);

      expect({ q, route }).toMatchObject({
        q,
        route: { kind: "tool", call: { tool: "team_roster", input: { team: "FunPlus Phoenix", league: e.league, yearFrom: e.yearFrom, yearTo: e.yearTo, role } } },
      });
      expect({ q, unread: route.kind === "tool" ? route.unread : null }).toEqual({ q, unread: undefined });
    }
  });

  test.each(["botlaner TL 2019", "TL botlaner 2019"])("a team mention inside a role word does not hide the role (%s)", (q) => {
    const route = routeQuestion(q, entities({ teams: [team("TL", "Team Liquid")], ...year(2019) }), SCHEMA, COVERAGE);

    expect(route).toMatchObject({ kind: "tool", call: { tool: "team_roster", input: { team: "Team Liquid", role: "Bot" } } });
  });

  test("short role words stay rankings, teams and metrics where they were", () => {
    const route = (q: string, e: Entities) => {
      const r = routeQuestion(q, e, SCHEMA, COVERAGE);

      return r.kind === "tool" ? r.call.tool : r.kind;
    };

    const TES = team("Top Esports", "Top Esports");

    expect(route("top 5 de T1", entities({ teams: [T1_NOW] }))).not.toBe("team_roster");
    expect(route("Top Esports 2019", entities({ teams: [TES], ...year(2019) }))).toBe("team_history");
    expect(route("KDA du top de fpx 2019", entities({ teams: [FPX], ...year(2019) }))).not.toBe("team_roster");
    expect(route("kills du jg de fpx", entities({ teams: [FPX] }))).not.toBe("team_roster");
    expect(route("meilleur top de fpx", entities({ teams: [FPX] }))).not.toBe("team_roster");
    expect(route("champion pool du top de fpx", entities({ teams: [FPX] }))).toBe("champion_pool");
    expect(route("top 5 kda LCK 2024", entities({ ...league("LoL Champions Korea", "LCK"), ...year(2024) }))).toBe("player_leaderboard");
    expect(route("comparaison des mid au worlds 2026", entities({ ...WORLDS, ...year(2026) }))).toBe("player_leaderboard");
    expect(route("top de Top Esports 2019", entities({ teams: [TES], ...year(2019) }))).toBe("team_roster");
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
    // A role with a team and a history or ranking word keeps its route.
    expect(route("historique de T1", entities({ teams: [T1] }))).toBe("team_history");
    expect(route("meilleur adc de T1", entities({ teams: [T1] }))).not.toBe("team_roster");
    expect(route("KDA de l'adc de T1", entities({ teams: [T1] }))).not.toBe("team_roster");
    expect(route("assists du support de T1", entities({ teams: [T1] }))).not.toBe("team_roster");
    expect(route("deaths of the jungler of G2", entities({ teams: [G2] }))).not.toBe("team_roster");
  });
});

describe("in-game statistics of one team: absent data is said", () => {
  const UP = team("Ultra Prime", "Ultra Prime");
  const stub = (team: (members: string[], league: string | null, yearFrom: number | null, yearTo: number | null) => Coverage) => ({ ...COVERAGE, team });

  test("a team with games but no Riot data at all (an LPL team): data absent", () => {
    const route = routeQuestion("first blood de Ultra Prime", entities({ teams: [UP] }), SCHEMA, stub(() => ({ games: 362, ingame: 0 })));

    expect(route).toMatchObject({ kind: "missing", coverage: true, concepts: ["les statistiques in-game (first blood) de Ultra Prime"] });
  });

  test("games in the scope asked but none with Riot data: data absent, with the competition named", () => {
    const route = routeQuestion("first blood de T1 au MSI 2016", entities({ teams: [T1_NOW], ...MSI, ...year(2016) }), SCHEMA, stub((_, l) => (l ? { games: 12, ingame: 0 } : { games: 900, ingame: 600 })));

    expect(route).toMatchObject({ kind: "missing", coverage: true, concepts: ["les statistiques in-game (first blood) de T1 en MSI"] });
  });

  test("no game in the scope asked but Riot data elsewhere: the tool, whose relaxations widen the scope", () => {
    const members: string[][] = [];

    const route = routeQuestion(
      "first blood de T1 au MSI 2020",
      entities({ teams: [T1_NOW], ...MSI, ...year(2020) }),
      SCHEMA,
      stub((m, l, from, to) => (members.push(m), l == null && from == null && to == null ? { games: 50, ingame: 40 } : { games: 0, ingame: 0 })),
    );

    expect(route).toMatchObject({ kind: "tool", call: { tool: "team_ingame_stats", input: { team: "T1" } } });
    expect(members).toEqual([["T1", "SK Telecom T1"], ["T1", "SK Telecom T1"]]);
  });

  test("a team with Riot data in the scope: the tool", () => {
    const route = routeQuestion("first blood de T1 aux Worlds 2023", entities({ teams: [T1_NOW], ...league("World Championship", "Worlds"), ...year(2023) }), SCHEMA, stub(() => ({ games: 15, ingame: 15 })));

    expect(route).toMatchObject({ kind: "tool", call: { tool: "team_ingame_stats", input: { team: "T1", league: "World Championship", yearFrom: 2023, yearTo: 2023 } } });
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

describe("team coverage on a seeded database", () => {
  test("every name of the franchise counts, and only games with Riot data count as in-game", () => {
    const db = new DatabaseSync(":memory:");

    try {
      seed(db);
      const coverage = coverageLookup(db);
      const names = ["Samsung Ozone", "Samsung White"];

      expect(coverage.team(names, null, null, null)).toEqual({ games: 6, ingame: 0 });
      expect(coverage.team(["Samsung White"], null, null, null)).toEqual({ games: 4, ingame: 0 });
      expect(coverage.team(names, "World Championship", 2014, 2014)).toEqual({ games: 2, ingame: 0 });
      expect(coverage.team(names, null, 2016, null)).toEqual({ games: 0, ingame: 0 });

      db.exec("INSERT INTO game_riot VALUES (4,'k4','V5 data:W14_1',5,1,0),(1,'k1','V5 data:OGN14Sp_1',5,1,0)");
      expect(coverage.team(names, null, null, null)).toEqual({ games: 6, ingame: 2 });
      expect(coverage.team(names, "World Championship", 2014, 2014)).toEqual({ games: 2, ingame: 1 });
    } finally {
      db.close();
    }
  });
});

describe("roster of a team on a seeded database", () => {
  test("old names count for the team; each role lists its starter first, then the others, with games and tournaments", async () => {
    const db = new DatabaseSync(":memory:");

    try {
      seed(db);
      expect(resolveTeam(db, "SSW")).toMatchObject({ team: "Samsung White", members: ["Samsung Ozone", "Samsung White"] });
      expect(resolveTeam(db, "Samsung Galaxy White")).toMatchObject({ team: "Samsung White" });
      expect((await understandQuestion(db, "Samsung White roster 2014", new Date("2026-11-14")))?.result.teams.map((t) => t.team)).toEqual(["Samsung White"]);

      const tool = bindTool(db, { tool: "team_roster", input: { team: "Samsung White", league: null, yearFrom: 2014, yearTo: 2014, split: null, role: null } });

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
      const worlds = bindTool(db, { tool: "team_roster", input: { team: "Samsung White", league: "World Championship", yearFrom: 2014, yearTo: 2014, split: null, role: null } });
      const atWorlds = await worlds.format(db, db.prepare(worlds.sql).all(worlds.params));

      expect(atWorlds.roster).toMatchObject({ games: 2, scope: "aux Worlds en 2014", names: ["Samsung White"] });
      expect(atWorlds.roster!.players.map((p) => p.player)).toEqual(["Looper", "DanDy", "PawN", "Imp", "Mata"]);

      // A split restricts the roster and its tournaments; an even split of the games gives two starters.
      const spring = bindTool(db, { tool: "team_roster", input: { team: "Samsung White", league: null, yearFrom: 2014, yearTo: 2014, split: "Spring", role: null } });

      expect(guardQuery(db, readSchema(db), spring.sql).ok).toBe(true);
      const inSpring = await spring.format(db, db.prepare(spring.sql).all(spring.params));

      expect(inSpring.roster).toMatchObject({ games: 2, scope: "au split Spring en 2014", names: ["Samsung Ozone"] });
      expect(inSpring.roster!.tournaments.map((t) => t.label)).toEqual(["Champions 2014 Spring"]);
      expect(inSpring.roster!.players.filter((p) => p.role === "Top").map((p) => [p.player, p.starter])).toEqual([["Homme", true], ["Looper", true]]);

      // Without a period, the current roster: the team's latest season (2015 here), and the role asked comes first.
      const current = bindTool(db, { tool: "team_roster", input: { team: "SSW", league: null, yearFrom: null, yearTo: null, split: null, role: "Bot" } });
      const now = await current.format(db, db.prepare(current.sql).all(current.params));

      expect(now.roster).toMatchObject({ games: 1, scope: "en 2015" });
      expect(now.totals).toMatchObject({ season: 2015, bot: "Imp" });
      expect(now.facts.startsWith("ADC de Samsung White en 2015 : Imp (1 partie)")).toBe(true);
      expect(now.notes).toContain("Aucune période précisée : roster de la saison la plus récente de Samsung White (2015).");

      // The latest season keeps the split asked: Spring was last played in 2014, not in 2015.
      const lastSpring = bindTool(db, { tool: "team_roster", input: { team: "SSW", league: null, yearFrom: null, yearTo: null, split: "Spring", role: null } });
      const spring14 = await lastSpring.format(db, db.prepare(lastSpring.sql).all(lastSpring.params));

      expect(spring14.roster).toMatchObject({ games: 2, scope: "au split Spring en 2014" });

      // The router model may write an old name: the input carries the team's current one.
      expect(TOOLS.team_roster.normalize(db, { team: "Samsung Ozone", league: null, yearFrom: 2014, yearTo: 2014, split: null, role: null })).toMatchObject({ input: { team: "Samsung White" } });
    } finally {
      db.close();
    }
  });
});
