import { describe, expect, test } from "bun:test";
import { guardQuery } from "../src/lib/agent/guard";
import { type Coverage, type CoverageLookup, coverageLookup, groundLeague, routeQuestion } from "../src/lib/agent/query";
import { bindTool, TOOLS } from "../src/lib/agent/tools";
import type { Entities, LeagueName, ResolvedPlayer, ResolvedTeam } from "../src/lib/agent/types";
import { resolveTeam, understandQuestion } from "../src/lib/agent/understand";
import { readSchema } from "../src/lib/db";
import { LEAGUES } from "../src/lib/domain/leagues";
import { testDb, type TestDb } from "./fixtures/test-db";

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
  ])("%s", async (q, e) => {
    const route = await routeQuestion(q, e, SCHEMA, COVERAGE);

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
  ] as const)("one team and a role: the current roster, that role first (%s)", async (q, t, role) => {
    const route = await routeQuestion(q, entities({ teams: [t] }), SCHEMA, COVERAGE);

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
  ])("one team and a role word, in either order, with or without « de », a year or a competition (%s)", async (w, role) => {
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
      const route = await routeQuestion(q, e, SCHEMA, COVERAGE);

      expect({ q, route }).toMatchObject({
        q,
        route: { kind: "tool", call: { tool: "team_roster", input: { team: "FunPlus Phoenix", league: e.league, yearFrom: e.yearFrom, yearTo: e.yearTo, role } } },
      });
      expect({ q, unread: route.kind === "tool" ? route.unread : null }).toEqual({ q, unread: undefined });
    }
  });

  test.each(["botlaner TL 2019", "TL botlaner 2019"])("a team mention inside a role word does not hide the role (%s)", async (q) => {
    const route = await routeQuestion(q, entities({ teams: [team("TL", "Team Liquid")], ...year(2019) }), SCHEMA, COVERAGE);

    expect(route).toMatchObject({ kind: "tool", call: { tool: "team_roster", input: { team: "Team Liquid", role: "Bot" } } });
  });

  test("short role words stay rankings, teams and metrics where they were", async () => {
    const route = async (q: string, e: Entities) => {
      const r = await routeQuestion(q, e, SCHEMA, COVERAGE);

      return r.kind === "tool" ? r.call.tool : r.kind;
    };

    const TES = team("Top Esports", "Top Esports");

    expect(await route("top 5 de T1", entities({ teams: [T1_NOW] }))).not.toBe("team_roster");
    expect(await route("Top Esports 2019", entities({ teams: [TES], ...year(2019) }))).toBe("team_history");
    expect(await route("KDA du top de fpx 2019", entities({ teams: [FPX], ...year(2019) }))).not.toBe("team_roster");
    expect(await route("kills du jg de fpx", entities({ teams: [FPX] }))).not.toBe("team_roster");
    expect(await route("meilleur top de fpx", entities({ teams: [FPX] }))).not.toBe("team_roster");
    expect(await route("champion pool du top de fpx", entities({ teams: [FPX] }))).toBe("champion_pool");
    expect(await route("top 5 kda LCK 2024", entities({ ...league("LoL Champions Korea", "LCK"), ...year(2024) }))).toBe("player_leaderboard");
    expect(await route("comparaison des mid au worlds 2026", entities({ ...WORLDS, ...year(2026) }))).toBe("player_leaderboard");
    expect(await route("top de Top Esports 2019", entities({ teams: [TES], ...year(2019) }))).toBe("team_roster");
  });

  test("the other rules are kept", async () => {
    const route = async (q: string, e: Entities) => {
      const r = await routeQuestion(q, e, SCHEMA, COVERAGE);

      return r.kind === "tool" ? r.call.tool : r.kind;
    };

    expect(await route("historique de Fnatic en 2018", entities({ teams: [FNC], ...year(2018) }))).toBe("team_history");
    expect(await route("G2 vs Fnatic", entities({ teams: [G2, FNC] }))).toBe("head_to_head");
    expect(await route("Faker vs Chovy", entities({ players: [player("Faker"), player("Chovy")] }))).toBe("player_comparison");
    expect(await route("meilleurs mids LEC 2025", entities({ ...league("LoL EMEA Championship", "LEC"), ...year(2025) }))).toBe("player_leaderboard");
    expect(await route("classement worlds 2024", entities({ ...league("World Championship", "Worlds"), ...year(2024) }))).toBe("tournament_standings");
    expect(await route("joueur de Fnatic avec le plus de kills en 2018", entities({ teams: [FNC], ...year(2018) }))).toBe("sql");
    expect(await route("historique de T1", entities({ teams: [T1] }))).toBe("team_history");
    expect(await route("meilleur adc de T1", entities({ teams: [T1] }))).not.toBe("team_roster");
    expect(await route("KDA de l'adc de T1", entities({ teams: [T1] }))).not.toBe("team_roster");
    expect(await route("assists du support de T1", entities({ teams: [T1] }))).not.toBe("team_roster");
    expect(await route("deaths of the jungler of G2", entities({ teams: [G2] }))).not.toBe("team_roster");
  });
});

describe("one player and a team or roster word: the roster of the team they last played for", () => {
  const found = { team: "Shifters", year: 2026, others: ["Team BDS"] };
  const lookup: CoverageLookup = { ...COVERAGE, playerTeam: (p) => (p === "Rooster" ? found : null) };
  const rooster = player("Rooster");

  test.each(["Rooster team 2026", "l'équipe de Rooster en 2026", "Rooster roster 2026", "coéquipiers de Rooster en 2026", "who played with Rooster in 2026", "dans quelle équipe jouait Rooster en 2026 ?", "which team did Rooster play for in 2026?"])("%s", async (q) => {
    const route = await routeQuestion(q, entities({ players: [rooster], ...year(2026) }), SCHEMA, lookup);

    expect(route).toMatchObject({ kind: "tool", call: { tool: "team_roster", input: { team: "Shifters", league: null, yearFrom: 2026, yearTo: 2026, split: null, role: null } }, forced: true });
    expect(route.kind === "tool" && route.unread).toBeUndefined();
    expect(route.kind === "tool" && route.notes).toEqual([
      "Équipe de Rooster sur la période demandée : Shifters.",
      "Rooster a aussi joué pour Team BDS sur cette période : seule sa dernière équipe est affichée.",
    ]);
  });

  test("without a period, the season of the player's latest game", async () => {
    const route = await routeQuestion("Rooster team", entities({ players: [rooster] }), SCHEMA, lookup);

    expect(route).toMatchObject({ kind: "tool", call: { tool: "team_roster", input: { team: "Shifters", yearFrom: 2026, yearTo: 2026 } } });
    expect(route.kind === "tool" && route.notes).toEqual(["Aucune période précisée : dernière équipe de Rooster (Shifters, 2026)."]);
  });

  test("the player's name is not a roster word, and the other rules are kept", async () => {
    const route = async (q: string, e: Entities, coverage: CoverageLookup = lookup) => {
      const r = await routeQuestion(q, e, SCHEMA, coverage);

      return r.kind === "tool" ? r.call.tool : r.kind;
    };

    expect(await route("Rooster 2026", entities({ players: [rooster], ...year(2026) }))).toBe("player_event_history");
    expect(await route("résultats de l'équipe de Rooster en 2026", entities({ players: [rooster], ...year(2026) }))).toBe("player_event_history");
    expect(await route("meilleure équipe de Rooster", entities({ players: [rooster] }))).not.toBe("team_roster");
    expect(await route("KDA de Rooster avec son équipe", entities({ players: [rooster] }))).not.toBe("team_roster");
    expect(await route("Rooster team ranking 2026", entities({ players: [rooster], ...year(2026) }))).toBe("player_event_history");
    expect(await route("Rooster team record 2026", entities({ players: [rooster], ...year(2026) }))).toBe("player_event_history");
    expect(await route("How did Rooster's team rank in 2026?", entities({ players: [rooster], ...year(2026) }))).not.toBe("team_roster");
    expect(await route("Rooster team placement 2026", entities({ players: [rooster], ...year(2026) }))).not.toBe("team_roster");
    expect(await route("Which team beat Rooster in 2026?", entities({ players: [rooster], ...year(2026) }))).not.toBe("team_roster");
    expect(await route("l'équipe qui a battu Rooster en 2026", entities({ players: [rooster], ...year(2026) }))).not.toBe("team_roster");
    expect(await route("How did Rooster's team do in 2026?", entities({ players: [rooster], ...year(2026) }))).toBe("player_event_history");
    expect(await route("Which team did Rooster play in the 2026 final?", entities({ players: [rooster], ...year(2026) }))).not.toBe("team_roster");
    expect(await route("Did Rooster's team qualify for Worlds in 2026?", entities({ players: [rooster], ...league("World Championship", "Worlds"), ...year(2026) }))).not.toBe("team_roster");
    expect(await route("Which team was Rooster facing in the 2026 final?", entities({ players: [rooster], ...year(2026) }))).not.toBe("team_roster");
    expect(await route("Who did Rooster's team play at Worlds 2026?", entities({ players: [rooster], ...league("World Championship", "Worlds"), ...year(2026) }))).not.toBe("team_roster");
    expect(await route("who was Rooster in 2026?", entities({ players: [rooster], ...year(2026) }))).not.toBe("team_roster");
    expect(await route("items de l'équipe de Rooster en 2026", entities({ players: [rooster], ...year(2026) }))).not.toBe("team_roster");
    expect(await routeQuestion("roster de Fnatic en 2018", entities({ teams: [FNC], ...year(2018) }), SCHEMA, lookup)).toMatchObject({ call: { input: { team: "Fnatic" } } });
    expect(await route("Faker team 2026", entities({ players: [player("Faker")], ...year(2026) }))).toBe("player_event_history");
    expect(await route("Rooster team 2026", entities({ players: [rooster], ...year(2026) }), COVERAGE)).toBe("player_event_history");
  });
});

describe("in-game statistics of one team: absent data is said", () => {
  const UP = team("Ultra Prime", "Ultra Prime");
  const stub = (team: (members: string[], league: string | null, yearFrom: number | null, yearTo: number | null) => Coverage) => ({ ...COVERAGE, team });

  test("a team with games but no Riot data at all (an LPL team): data absent", async () => {
    const route = await routeQuestion("first blood de Ultra Prime", entities({ teams: [UP] }), SCHEMA, stub(() => ({ games: 362, ingame: 0 })));

    expect(route).toMatchObject({ kind: "missing", coverage: true, concepts: ["les statistiques in-game (first blood) de Ultra Prime"] });
  });

  test("games in the scope asked but none with Riot data: data absent, with the competition named", async () => {
    const route = await routeQuestion("first blood de T1 au MSI 2016", entities({ teams: [T1_NOW], ...MSI, ...year(2016) }), SCHEMA, stub((_, l) => (l ? { games: 12, ingame: 0 } : { games: 900, ingame: 600 })));

    expect(route).toMatchObject({ kind: "missing", coverage: true, concepts: ["les statistiques in-game (first blood) de T1 au MSI"] });
  });

  test("no game in the scope asked but Riot data elsewhere: the tool, whose relaxations widen the scope", async () => {
    const members: string[][] = [];

    const route = await routeQuestion(
      "first blood de T1 au MSI 2020",
      entities({ teams: [T1_NOW], ...MSI, ...year(2020) }),
      SCHEMA,
      stub((m, l, from, to) => (members.push(m), l == null && from == null && to == null ? { games: 50, ingame: 40 } : { games: 0, ingame: 0 })),
    );

    expect(route).toMatchObject({ kind: "tool", call: { tool: "team_ingame_stats", input: { team: "T1" } } });
    expect(members).toEqual([["T1", "SK Telecom T1"], ["T1", "SK Telecom T1"]]);
  });

  test("a team with Riot data in the scope: the tool", async () => {
    const route = await routeQuestion("first blood de T1 aux Worlds 2023", entities({ teams: [T1_NOW], ...league("World Championship", "Worlds"), ...year(2023) }), SCHEMA, stub(() => ({ games: 15, ingame: 15 })));

    expect(route).toMatchObject({ kind: "tool", call: { tool: "team_ingame_stats", input: { team: "T1", league: "World Championship", yearFrom: 2023, yearTo: 2023 } } });
  });
});

async function seed(db: TestDb) {
  for (const [i, l] of LEAGUES.entries()) await db.run("INSERT INTO leagues VALUES(?,?,?,?,?)", i + 1, l.name, l.short, l.region, +l.international);
  const id = async (name: string) => Number((await db.query("SELECT id FROM leagues WHERE name = ?", [name]))[0]!.id);

  await db.run(
    "INSERT INTO tournaments(id,page,event_page,name,stage,league_id,year,split) VALUES (1,'OGN14Sp','OGN14Sp','Champions 2014 Spring','season',?,2014,'Spring'),(2,'OGN14Su','OGN14Su','Champions 2014 Summer','season',?,2014,'Summer'),(3,'W14','W14','Worlds 2014','main_event',?,2014,NULL),(4,'W15','W15','Worlds 2015','main_event',?,2015,NULL)",
  await id("LoL The Champions"), await id("LoL The Champions"), await id("World Championship"), await id("World Championship"));
  await db.exec(`
    INSERT INTO teams(id,name) VALUES (1,'Samsung Ozone'),(2,'Samsung White'),(3,'Samsung Blue'),(4,'Other');
    INSERT INTO players(id,page) VALUES (1,'Looper'),(2,'DanDy'),(3,'PawN'),(4,'Imp'),(5,'Mata'),(6,'Homme'),(7,'Dade'),(8,'Deft');
    INSERT INTO games(id,tournament_id,tab,match_n,game_n,blue_team_id,red_team_id,winner_side,played_at) VALUES
      (1,1,'Week 1',1,1,1,4,1,100),(2,1,'Week 1',2,1,1,4,2,110),
      (3,2,'Week 1',1,1,2,4,1,200),
      (4,3,'Final',1,1,2,3,1,300),(5,3,'Final',1,2,3,2,2,310),
      (6,4,'Groups',1,1,2,4,1,400);
  `);

  const roles = ["Top", "Jungle", "Mid", "Bot", "Support"];

  const five = async (game: number, teamId: number, players: number[], side: number, win: number) => {
    for (const [i, p] of players.entries()) await db.run("INSERT INTO game_players(game_id,player_id,team_id,role,side,win) VALUES (?,?,?,?,?,?)", game, p, teamId, roles[i], side, win);
  };

  await five(1, 1, [6, 2, 7, 4, 5], 1, 1);
  await five(2, 1, [1, 2, 7, 4, 5], 1, 0);
  await five(3, 2, [1, 2, 3, 4, 5], 1, 1);
  await five(4, 2, [1, 2, 3, 4, 5], 1, 1);
  await five(5, 2, [1, 2, 3, 4, 5], 2, 1);
  await db.run("INSERT INTO game_players(game_id,player_id,team_id,role,side,win) VALUES (?,?,?,?,?,?)", 5, 8, 3, "Bot", 1, 0);
  await five(6, 2, [1, 2, 3, 4, 5], 1, 1);
}

describe("team coverage on a seeded database", () => {
  test("every name of the franchise counts, and only games with Riot data count as in-game", async () => {
    const db = await testDb();

    try {
      await seed(db);
      const coverage = coverageLookup(db);
      const names = ["Samsung Ozone", "Samsung White"];

      expect(await coverage.team(names, null, null, null)).toEqual({ games: 6, ingame: 0 });
      expect(await coverage.team(["Samsung White"], null, null, null)).toEqual({ games: 4, ingame: 0 });
      expect(await coverage.team(names, "World Championship", 2014, 2014)).toEqual({ games: 2, ingame: 0 });
      expect(await coverage.team(names, null, 2016, null)).toEqual({ games: 0, ingame: 0 });

      await db.exec("INSERT INTO game_riot VALUES (4,'k4','V5 data:W14_1',5,1,0),(1,'k1','V5 data:OGN14Sp_1',5,1,0)");
      expect(await coverage.team(names, null, null, null)).toEqual({ games: 6, ingame: 2 });
      expect(await coverage.team(names, "World Championship", 2014, 2014)).toEqual({ games: 2, ingame: 1 });
    } finally {
      await db.close();
    }
  });
});

describe("a player's team on a seeded database", () => {
  test("the team of their latest game in the scope, its year, and the other teams of the scope", async () => {
    const db = await testDb();

    try {
      await seed(db);
      const { playerTeam } = coverageLookup(db);

      expect(await playerTeam!("Looper", null, null, null, null)).toEqual({ team: "Samsung White", year: 2015, others: [] });
      await db.exec("INSERT INTO game_players(game_id,player_id,team_id,role,side,win) VALUES (5,6,3,'Top',1,0)");
      expect(await playerTeam!("Homme", null, null, null, null)).toEqual({ team: "Samsung Blue", year: 2014, others: ["Samsung Ozone"] });
      expect(await playerTeam!("Looper", null, 2014, 2014, "Spring")).toEqual({ team: "Samsung Ozone", year: 2014, others: [] });
      expect(await playerTeam!("Looper", "World Championship", 2014, 2014, null)).toEqual({ team: "Samsung White", year: 2014, others: [] });
      expect(await playerTeam!("Deft", null, null, null, null)).toEqual({ team: "Samsung Blue", year: 2014, others: [] });
      expect(await playerTeam!("Looper", null, 2016, null, null)).toBeNull();
    } finally {
      await db.close();
    }
  });
});

describe("a competition the LLM router adds on its own", () => {
  const looper = player("Looper");
  const history = (league: LeagueName, y: number | null = 2014) => ({ tool: "player_event_history" as const, input: { player: "Looper", league, yearFrom: y, yearTo: y } });
  const roster = (league: LeagueName | null) => ({ tool: "team_roster" as const, input: { team: "Samsung White", league, yearFrom: 2014, yearTo: 2014, split: null, role: null } });
  const WORLDS_NAME: LeagueName = "World Championship";
  // Not the LEC: its family holds "LoL The Champions", where the seeded team played.
  const LEC: LeagueName = "LoL EMEA Championship";

  test("no game of the player in it: back to the rules' competition for the same tool, to every competition otherwise", async () => {
    const db = await testDb();

    try {
      await seed(db);
      await db.exec("INSERT INTO player_aliases(alias,player_id,raw) VALUES ('looper',1,'Looper')");
      const coverage = coverageLookup(db);
      const e = entities({ players: [looper], ...year(2014) });
      const rules = await routeQuestion("Looper 2014", e, SCHEMA, coverage);

      expect(rules).toMatchObject({ call: { tool: "player_event_history", input: { league: WORLDS_NAME } } });
      expect(await groundLeague(db, history(LEC), e, rules, coverage)).toEqual({ call: history(WORLDS_NAME), dropped: LEC });
      expect(await groundLeague(db, roster(LEC), entities({ teams: [SSW], ...year(2014) }), rules, coverage)).toEqual({ call: roster(null), dropped: LEC });
      expect(await groundLeague(db, history(WORLDS_NAME, 2015), entities({ players: [player("Homme")], ...year(2014) }), rules, coverage)).toEqual({ call: history(WORLDS_NAME, 2015), dropped: null });
      expect(await groundLeague(db, history(LEC), e, { kind: "sql", reason: "", open: true }, coverage)).toEqual({ call: null, dropped: LEC });
    } finally {
      await db.close();
    }
  });

  test("kept when the data agrees, when the question named a competition, when nobody is named or nothing was played", async () => {
    const db = await testDb();

    try {
      await seed(db);
      const coverage = coverageLookup(db);
      const open: Parameters<typeof groundLeague>[3] = { kind: "sql", reason: "", open: true };
      const kept = async (call: Parameters<typeof groundLeague>[1], e: Entities) => expect(await groundLeague(db, call, e, open, coverage)).toEqual({ call, dropped: null });

      await kept(history(WORLDS_NAME), entities({ players: [looper], ...year(2014) }));
      await kept(history(LEC), entities({ players: [looper], ...league(LEC, "LEC"), ...year(2014) }));
      await kept(roster(LEC), entities({ ...year(2014) }));
      await kept(history(LEC, 2020), entities({ players: [looper], ...year(2020) }));
      await kept(roster(null), entities({ teams: [SSW], ...year(2014) }));
    } finally {
      await db.close();
    }
  });
});

describe("roster of a team on a seeded database", () => {
  test("old names count for the team; each role lists its starter first, then the others, with games and tournaments", async () => {
    const db = await testDb();

    try {
      await seed(db);
      expect(await resolveTeam(db, "SSW")).toMatchObject({ team: "Samsung White", members: ["Samsung Ozone", "Samsung White"] });
      expect(await resolveTeam(db, "Samsung Galaxy White")).toMatchObject({ team: "Samsung White" });
      expect((await understandQuestion(db, "Samsung White roster 2014", new Date("2026-11-14")))?.result.teams.map((t) => t.team)).toEqual(["Samsung White"]);

      const tool = await bindTool(db, { tool: "team_roster", input: { team: "Samsung White", league: null, yearFrom: 2014, yearTo: 2014, split: null, role: null } });

      expect(guardQuery(await readSchema(db), tool.sql).ok).toBe(true);
      const out = await tool.format(db, (await db.query(tool.sql, tool.params)));

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

      const worlds = await bindTool(db, { tool: "team_roster", input: { team: "Samsung White", league: "World Championship", yearFrom: 2014, yearTo: 2014, split: null, role: null } });
      const atWorlds = await worlds.format(db, (await db.query(worlds.sql, worlds.params)));

      expect(atWorlds.roster).toMatchObject({ games: 2, scope: "aux Worlds en 2014", names: ["Samsung White"] });
      expect(atWorlds.roster!.players.map((p) => p.player)).toEqual(["Looper", "DanDy", "PawN", "Imp", "Mata"]);

      const spring = await bindTool(db, { tool: "team_roster", input: { team: "Samsung White", league: null, yearFrom: 2014, yearTo: 2014, split: "Spring", role: null } });

      expect(guardQuery(await readSchema(db), spring.sql).ok).toBe(true);
      const inSpring = await spring.format(db, (await db.query(spring.sql, spring.params)));

      expect(inSpring.roster).toMatchObject({ games: 2, scope: "au split Spring en 2014", names: ["Samsung Ozone"] });
      expect(inSpring.roster!.tournaments.map((t) => t.label)).toEqual(["Champions 2014 Spring"]);
      expect(inSpring.roster!.players.filter((p) => p.role === "Top").map((p) => [p.player, p.starter])).toEqual([["Homme", true], ["Looper", true]]);

      const current = await bindTool(db, { tool: "team_roster", input: { team: "SSW", league: null, yearFrom: null, yearTo: null, split: null, role: "Bot" } });
      const now = await current.format(db, (await db.query(current.sql, current.params)));

      expect(now.roster).toMatchObject({ games: 1, scope: "en 2015" });
      expect(now.totals).toMatchObject({ season: 2015, bot: "Imp" });
      expect(now.facts.startsWith("ADC de Samsung White en 2015 : Imp (1 partie)")).toBe(true);
      expect(now.notes).toContain("Aucune période précisée : roster de la saison la plus récente de Samsung White (2015).");

      const lastSpring = await bindTool(db, { tool: "team_roster", input: { team: "SSW", league: null, yearFrom: null, yearTo: null, split: "Spring", role: null } });
      const spring14 = await lastSpring.format(db, (await db.query(lastSpring.sql, lastSpring.params)));

      expect(spring14.roster).toMatchObject({ games: 2, scope: "au split Spring en 2014" });

      expect(await TOOLS.team_roster.normalize(db, { team: "Samsung Ozone", league: null, yearFrom: 2014, yearTo: 2014, split: null, role: null })).toMatchObject({ input: { team: "Samsung White" } });
    } finally {
      await db.close();
    }
  });
});

describe("the KeSPA Cup in a roster", () => {
  test("left out unless asked: the academy players it fields are not substitutes of the main roster, nor its last season", async () => {
    const db = await testDb();

    try {
      await seed(db);
      const kespa = Number((await db.query("SELECT id FROM leagues WHERE name = ?", ["KeSPA Cup"]))[0]!.id);

      await db.run("INSERT INTO tournaments(id,page,event_page,name,stage,league_id,year,split) VALUES (5,'KeSPA14','KeSPA14','KeSPA Cup 2014','main_event',?,2014,NULL),(6,'KeSPA16','KeSPA16','KeSPA Cup 2016','main_event',?,2016,NULL)", kespa, kespa);
      await db.exec(`
        INSERT INTO players(id,page) VALUES (9,'Rookie Top'),(10,'Rookie Jungle'),(11,'Rookie Mid'),(12,'Rookie Bot'),(13,'Rookie Support');
        INSERT INTO games(id,tournament_id,tab,match_n,game_n,blue_team_id,red_team_id,winner_side,played_at) VALUES (7,5,'Round 1',1,1,2,4,1,350),(8,6,'Round 1',1,1,2,4,1,500);
      `);

      for (const game of [7, 8])
        for (const [i, role] of ["Top", "Jungle", "Mid", "Bot", "Support"].entries())
          await db.run("INSERT INTO game_players(game_id,player_id,team_id,role,side,win) VALUES (?,?,?,?,?,?)", game, 9 + i, 2, role, 1, 1);

      const roster = async (input: { league: LeagueName | null; yearFrom: number | null }) => {
        const tool = await bindTool(db, { tool: "team_roster", input: { team: "Samsung White", split: null, role: null, yearTo: input.yearFrom, ...input } });

        expect(guardQuery(await readSchema(db), tool.sql).ok).toBe(true);

        return await tool.format(db, await db.query(tool.sql, tool.params));
      };

      const in2014 = await roster({ league: null, yearFrom: 2014 });

      expect(in2014.roster).toMatchObject({ games: 5, wins: 4 });
      expect(in2014.roster!.tournaments.map((t) => t.label)).toEqual(["Champions 2014 Spring", "Champions 2014 Summer", "Worlds 2014"]);
      expect(in2014.roster!.players.map((p) => p.player)).not.toContain("Rookie Top");

      expect((await roster({ league: null, yearFrom: null })).roster).toMatchObject({ games: 1, scope: "en 2015" });

      const atKespa = await roster({ league: "KeSPA Cup", yearFrom: 2014 });

      expect(atKespa.roster).toMatchObject({ games: 1 });
      expect(atKespa.roster!.players.map((p) => p.player)).toEqual(["Rookie Top", "Rookie Jungle", "Rookie Mid", "Rookie Bot", "Rookie Support"]);

      await db.exec("INSERT INTO games(id,tournament_id,tab,match_n,game_n,blue_team_id,red_team_id,winner_side,played_at) VALUES (9,6,'Round 1',2,1,3,4,1,510)");
      await db.run("INSERT INTO game_players(game_id,player_id,team_id,role,side,win) VALUES (?,?,?,?,?,?)", 9, 4, 3, "Bot", 1, 1);
      expect(await coverageLookup(db).playerTeam!("Imp", null, null, null, null)).toEqual({ team: "Samsung White", year: 2015, others: [] });
      expect(await coverageLookup(db).playerTeam!("Imp", "KeSPA Cup", null, null, null)).toMatchObject({ team: "Samsung Blue", year: 2016 });

      expect(await coverageLookup(db).team(["Samsung Ozone", "Samsung White"], null, 2014, 2014)).toEqual({ games: 6, ingame: 0 });
    } finally {
      await db.close();
    }
  });
});
