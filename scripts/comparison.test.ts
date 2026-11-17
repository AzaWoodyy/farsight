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
const NO_COVERAGE = { league: () => ({ games: 0, ingame: 0 }), player: () => ({ games: 0, ingame: 0 }), team: () => ({ games: 0, ingame: 0 }) };
const LEC = ["LoL EMEA Championship", "LEC"] as const;

const FAKER_CHOVY = entities([player("Faker"), player("Chovy")]);

test.each([
  ["comparaison Saken et Kyeahoo en LEC", entities([player("Saken", "SAKEN"), player("Kyeahoo")], ...LEC), "SAKEN", "Kyeahoo"],
  ["Saken vs Kyeahoo", entities([player("Saken", "SAKEN"), player("Kyeahoo")]), "SAKEN", "Kyeahoo"],
  ["compare Chovy et Faker aux Worlds", entities([player("Chovy"), player("Faker")], "World Championship", "Worlds"), "Chovy", "Faker"],
  ["Caps contre Humanoid en LEC", entities([player("Caps"), player("Humanoid")], ...LEC), "Caps", "Humanoid"],
  ["Kyeahoo or Saken who is better", entities([player("Kyeahoo"), player("Saken", "SAKEN")]), "Kyeahoo", "SAKEN"],
  ["Faker face à face avec Chovy, qui est le meilleur ?", FAKER_CHOVY, "Faker", "Chovy"],
])("%s → comparison, decided by the rules", (question, e, a, b) => {
  const route = routeQuestion(question, e, SCHEMA, NO_COVERAGE);

  // At or above the build threshold (0.8): neither the LLM router nor text-to-SQL is asked.
  expect(route).toMatchObject({ kind: "tool", forced: true, call: { tool: "player_comparison", input: { playerA: a, playerB: b, league: e.league } } });
  expect(route.kind === "tool" && route.confidence).toBeGreaterThanOrEqual(0.8);
});

// Every word opposing two players gives the same answer, whatever its case: one case per variant.
test.each([
  "Faker Chovy head to head",
  "Faker Chovy HEAD TO HEAD",
  "Faker Chovy head-to-head",
  "Faker Chovy Head-To-Head",
  "Faker Chovy head 2 head",
  "Faker Chovy HEAD 2 HEAD",
  "h2h Faker Chovy",
  "H2H Faker Chovy",
  "confrontations Faker Chovy",
  "CONFRONTATIONS Faker Chovy",
  "matchs entre Faker et Chovy",
  "Matchs Entre Faker et Chovy",
  "Faker face-à-face Chovy",
  "Faker Face-À-Face Chovy",
  "Faker face à face Chovy",
  "Faker vs Chovy",
  "Faker VS Chovy",
  "Faker contre Chovy",
  "Faker or Chovy",
  "Faker ou Chovy, le meilleur ?",
])("%s → the same comparison, decided by the rules", (question) => {
  const route = routeQuestion(question, FAKER_CHOVY, SCHEMA, NO_COVERAGE);

  expect(route).toMatchObject({ kind: "tool", forced: true, call: { tool: "player_comparison", input: { playerA: "Faker", playerB: "Chovy" } } });
  expect(route.kind === "tool" && route.confidence).toBeGreaterThanOrEqual(0.8);
});

test("two teams still route to their head-to-head; a metric keeps two opposed players on the comparison", () => {
  const teams = { ...entities([]), teams: [{ mention: "T1", team: "T1", members: ["T1"] }, { mention: "Gen.G", team: "Gen.G", members: ["Gen.G"] }] };

  expect(routeQuestion("T1 contre Gen.G", teams, SCHEMA, NO_COVERAGE)).toMatchObject({ call: { tool: "head_to_head", input: { kind: "team" } } });

  // A metric does not take two opposed players away from the comparison, in-game ones included.
  for (const q of ["compare les dégâts de Chovy et Faker", "Faker vs Chovy KDA", "compare les solo kills de Faker et Chovy"])
    expect(routeQuestion(q, FAKER_CHOVY, SCHEMA, NO_COVERAGE)).toMatchObject({ kind: "tool", forced: true, call: { tool: "player_comparison" } });
});

test.each([
  ["Faker vs Chovy pentakills", "penta_kills", null],
  ["Faker vs Chovy first bloods", "first_bloods", null],
  ["compare les wards de Faker et Chovy", "wards_placed", null],
  ["Faker vs Chovy gold diff at 10", "gold_diff", 10],
  ["compare les solo kills de Faker et Chovy", "solo_kills", null],
  ["Faker contre Chovy, qui a le moins de morts ?", "deaths", null],
  ["compare les dégâts de Chovy et Faker", "damage", null],
  ["Faker vs Chovy KDA", null, null],
  ["Faker vs Chovy kills et morts", null, null],
])("%s → the comparison puts %s first", (question, metric, minute) => {
  const route = routeQuestion(question, FAKER_CHOVY, SCHEMA, NO_COVERAGE);

  // The metric is read: no unread word puts the comparison in doubt, and no note says it is missing.
  expect(route).toMatchObject({ kind: "tool", forced: true, call: { tool: "player_comparison", input: { metric, minute } } });
  expect(route.kind === "tool" && route.confidence).toBeGreaterThanOrEqual(0.8);
  expect(route.kind === "tool" && route.notes).toEqual([]);
});

test("a metric the comparison cannot put first is said in a note", () => {
  for (const [q, note] of [
    ["Faker vs Chovy first tower", "statistique d'équipe"],
    ["Faker vs Chovy gold à 25 min", "qu'à 10, 15 et 20 min"],
  ]) {
    const route = routeQuestion(q, FAKER_CHOVY, SCHEMA, NO_COVERAGE);

    expect(route).toMatchObject({ kind: "tool", call: { tool: "player_comparison", input: { metric: null } } });
    expect(route.kind === "tool" && route.notes.some((n) => n.includes(note))).toBe(true);
  }
});

/** LEC 2024: Caps (G2) and Humanoid (Fnatic) meet twice; Caps also plays MAD Lions (Elyoya) once, and once in the LCK. */
function seed(db: DatabaseSync) {
  createSchema(db);
  createQuerySchema(db);
  LEAGUES.forEach((l, i) => db.prepare("INSERT INTO leagues VALUES(?,?,?,?,?)").run(i + 1, l.name, l.short, l.region, +l.international));
  const lec = Number(db.prepare("SELECT id FROM leagues WHERE name = 'LoL EMEA Championship'").get()!.id);
  const lck = Number(db.prepare("SELECT id FROM leagues WHERE name = 'LoL Champions Korea'").get()!.id);

  db.prepare("INSERT INTO tournaments(id,page,event_page,stage,league_id,year) VALUES (1,'LEC24','LEC24','season',?,2024), (2,'LCK24','LCK24','season',?,2024)").run(lec, lck);
  db.exec(`
    INSERT INTO teams VALUES (1,'G2 Esports'),(2,'Fnatic'),(3,'MAD Lions');
    INSERT INTO players(id,page) VALUES (1,'Caps'),(2,'Humanoid'),(3,'Elyoya');
    INSERT INTO champions VALUES (1,'Azir','https://ddragon.leagueoflegends.com/cdn/img/Azir.png'),(2,'Orianna',NULL);
    INSERT INTO games(id,tournament_id,tab,game_n,blue_team_id,red_team_id,winner_side,played_at)
      VALUES (1,1,'Week 1',1,1,2,1,100),(2,1,'Week 2',1,2,1,1,200),(3,2,'Week 1',1,1,2,1,300),(4,1,'Week 3',1,1,3,1,400);
    INSERT INTO game_riot VALUES (1,'K1','V5 data:K1',5,1,0),(4,'K4','V5 data:K4',5,1,0);
    -- Riot data for games 1 and 4 only: solo kills average over those.
    INSERT INTO game_player_stats(game_id,player_id,solo_kills,penta_kills) VALUES (1,1,1,0),(1,2,0,1),(4,1,2,1),(4,3,0,0);
    -- game 1: Caps wins against Humanoid; game 2: Humanoid wins; game 3 is outside the LEC; game 4: Caps against Elyoya.
    INSERT INTO game_players(game_id,player_id,team_id,side,role,champion_id,win,kills,deaths,assists,gold,cs,damage,vision,keystone_id) VALUES
      (1,1,1,1,'Mid',1,1,4,1,6,15000,300,25000,40,NULL),
      (1,2,2,2,'Mid',2,0,1,4,2,12000,280,18000,30,NULL),
      (2,1,1,2,'Mid',2,0,2,3,1,11000,270,NULL,NULL,NULL),
      (2,2,2,1,'Mid',1,1,5,0,5,14000,310,22000,36,NULL),
      (3,1,1,1,'Mid',NULL,1,9,0,9,16000,320,30000,50,NULL),
      (4,1,1,1,'Mid',NULL,1,6,0,6,16000,330,28000,44,NULL),
      (4,3,3,2,'Jungle',NULL,0,0,3,1,9000,180,9000,60,NULL);
  `);
}

const compare = (db: DatabaseSync, playerA: string, playerB: string, metric: "penta_kills" | "deaths" | null = null) =>
  bindTool(db, { tool: "player_comparison", input: { playerA, playerB, league: "LoL EMEA Championship", yearFrom: null, yearTo: null, metric, minute: null } });

test("two players who met: their games against each other first, the scope's statistics, and the list of games", async () => {
  const db = new DatabaseSync(":memory:");

  try {
    seed(db);
    const tool = compare(db, "Caps", "Humanoid");
    const out = await tool.format(db, db.prepare(tool.sql).all(tool.params));
    const v = out.versus!;

    // Typed queries go through the same guard as generated ones.
    expect(guardQuery(db, readSchema(db), tool.sql).ok).toBe(true);

    // Face to face: games 1 and 2 only.
    expect(v.h2h!.rows.map((r) => r.slice(0, 5))).toEqual([["Caps", 2, 1, 3, 2], ["Humanoid", 2, 1, 3, 2]]);
    // Null damage on one game: the average reads the known one only.
    expect(v.h2h!.rows[0][v.h2h!.columns.indexOf("avg_damage")]).toBe(25000);

    // Scope (LEC): Caps also has game 4, never the LCK game 3.
    expect(v.global.rows.map((r) => r.slice(0, 3))).toEqual([["Caps", 3, 2], ["Humanoid", 2, 1]]);
    expect(out.table).toEqual(v.global);

    // Newest first; the game's own page when it has Riot data, else the tournament page.
    expect(v.games.map((g) => [g.label, g.winA, g.a.team, g.a.champion, g.a.kills, g.b.team, g.b.champion, g.b.deaths, g.source.url])).toEqual([
      ["LEC 2024 · semaine 2 · game 1", false, "G2 Esports", "Orianna", 2, "Fnatic", "Azir", 0, "https://lol.fandom.com/wiki/LEC24"],
      ["LEC 2024 · semaine 1 · game 1", true, "G2 Esports", "Azir", 4, "Fnatic", "Orianna", 4, "https://lol.fandom.com/wiki/V5_data%3AK1"],
    ]);
    expect([v.games[1].a.championIcon, v.games[0].a.championIcon]).toEqual(["https://ddragon.leagueoflegends.com/cdn/img/Azir.png", null]);

    // Solo kills: face to face over their games with Riot data (game 1), globally over games 1 and 4.
    const solo = (t: { columns: string[]; rows: unknown[][] }) => t.rows.map((r) => r[t.columns.indexOf("avg_solo_kills")]);

    expect(solo(v.h2h!)).toEqual([1, 0]);
    expect(solo(v.global)).toEqual([1.5, 0]);

    expect(out.totals).toMatchObject({ games_a: 3, wins_a: 2, games_b: 2, wins_b: 1, h2h_games: 2, h2h_wins_a: 1, h2h_listed: 2, solo_kills_a: 1, solo_kills_b: 0, h2h_same_lane: 2 });
    // Both games against each other were in mid: a lane face-off, said in the answer and drawn per game.
    expect(v.lanes).toEqual({ same: 2, roles: [{ role: "Mid", games: 2 }] });
    expect(v.games.map((g) => [g.a.role, g.b.role])).toEqual([["Mid", "Mid"], ["Mid", "Mid"]]);
    expect(out.facts).toContain("Toutes ces parties se sont jouées dans la même lane (Mid).");
    expect(out.facts).toContain("Caps et Humanoid en LEC se sont affrontés sur 2 parties : Caps 1 – 1 Humanoid");
    expect(out.facts).toContain("face à face, Caps 2 parties, 1 victoires (50 %), KDA 3,3, 1 solo kill ;");
    expect(out.facts).toContain("Sur toutes leurs parties : Caps 3 parties, 2 victoires (67 %), KDA 6,3, 3 solo kills ;");
  } finally {
    db.close();
  }
});

test("two players who never met: the scope's statistics only, and a sentence saying so", async () => {
  const db = new DatabaseSync(":memory:");

  try {
    seed(db);
    const tool = compare(db, "Humanoid", "Elyoya");
    const out = await tool.format(db, db.prepare(tool.sql).all(tool.params));

    expect(out.versus).toMatchObject({ h2h: null, games: [] });
    expect(out.versus!.global.rows.map((r) => r.slice(0, 3))).toEqual([["Humanoid", 2, 1], ["Elyoya", 1, 0]]);
    // Never met: the solo kills shown are the scope's.
    expect(out.versus!.global.rows.map((r) => r[out.versus!.global.columns.indexOf("avg_solo_kills")])).toEqual([0, 0]);
    expect(out.totals).toMatchObject({ h2h_games: 0, h2h_listed: 0, solo_kills_a: 0, solo_kills_b: 0 });
    expect(out.facts).toContain("Humanoid et Elyoya en LEC ne se sont jamais affrontés.");
  } finally {
    db.close();
  }
});

test("the closing sentence on Riot data: partial coverage is said, no coverage at all reads n/d", async () => {
  const db = new DatabaseSync(":memory:");

  try {
    seed(db);

    const run = async () => {
      const tool = compare(db, "Caps", "Humanoid");

      return (await tool.format(db, db.prepare(tool.sql).all(tool.params))).facts;
    };

    expect(await run()).toEndWith(" Écarts à 15 min et solo kills calculés sur les parties avec données Riot seulement.");

    // No game of the scope has Riot data (an LPL comparison): nothing is computed "on the games with Riot data".
    db.exec("DELETE FROM game_riot");
    const facts = await run();

    expect(facts).toEndWith(" Écarts à 15 min et solo kills : n/d, aucune partie avec données Riot dans ce périmètre.");
    expect(facts).not.toContain("données Riot seulement");
  } finally {
    db.close();
  }
});

test("a metric the question names comes first: in the facts, the tables and the totals, on the games with Riot data", async () => {
  const db = new DatabaseSync(":memory:");

  try {
    seed(db);

    const run = async (metric: "penta_kills" | "deaths") => {
      const tool = compare(db, "Caps", "Humanoid", metric);

      expect(guardQuery(db, readSchema(db), tool.sql).ok).toBe(true);

      return tool.format(db, db.prepare(tool.sql).all(tool.params));
    };

    const penta = await run("penta_kills");
    const v = penta.versus!;

    // Face to face over game 1 (the one with Riot data); globally over games 1 and 4.
    expect(penta.facts).toStartWith(
      "Caps et Humanoid en LEC, pentakills : face à face, Caps 0 (sur 1 partie avec données Riot), Humanoid 1 (sur 1 partie avec données Riot) ; " +
        "sur toutes leurs parties, Caps 1 (sur 2 parties avec données Riot), Humanoid 1 (sur 1 partie avec données Riot). ",
    );
    expect(v.focus).toBe("penta_kills");
    expect(v.h2h!.columns.slice(0, 5)).toEqual(["player", "games", "wins", "penta_kills", "ingame_games"]);
    expect(v.h2h!.rows.map((r) => r.slice(3, 5))).toEqual([[0, 1], [1, 1]]);
    expect(v.global.rows.map((r) => r.slice(3, 5))).toEqual([[1, 2], [1, 1]]);
    expect(penta.table).toEqual(v.global);
    expect(penta.totals).toMatchObject({ metric_a: 1, metric_b: 1, h2h_metric_a: 0, h2h_metric_b: 1 });

    // An end-of-game average: every game counts, with its total.
    const deaths = await run("deaths");

    expect(deaths.facts).toStartWith("Caps et Humanoid en LEC, morts : face à face, Caps 2 par partie (4 au total), Humanoid 2 par partie (4 au total) ; sur toutes leurs parties, Caps 1,33 par partie (4 au total), ");
    expect(deaths.versus!.global.columns.slice(0, 4)).toEqual(["player", "games", "wins", "avg_deaths"]);
    expect(deaths.versus!.global.columns.filter((c) => c === "avg_deaths")).toHaveLength(1);

    // No Riot data in the scope (an LPL comparison): the in-game figure is n/d, never 0.
    db.exec("DELETE FROM game_riot");
    const none = await run("penta_kills");

    expect(none.facts).toStartWith("Caps et Humanoid en LEC, pentakills : n/d, aucune partie avec données Riot dans ce périmètre. ");
    expect(none.versus!.global.rows.map((r) => r.slice(3, 5))).toEqual([[null, 0], [null, 0]]);
    expect(none.totals).toMatchObject({ metric_a: "n/d", metric_b: "n/d" });
  } finally {
    db.close();
  }
});
