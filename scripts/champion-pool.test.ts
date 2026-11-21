import { afterAll, describe, expect, test } from "bun:test";
import { guardQuery } from "../src/lib/agent/guard";
import { routeQuestion } from "../src/lib/agent/query";
import { bindTool } from "../src/lib/agent/tools";
import type { Entities, LeagueName, ResolvedPlayer, ResolvedTeam } from "../src/lib/agent/types";
import { understandQuestion } from "../src/lib/agent/understand";
import { readSchema } from "../src/lib/db";
import { LEAGUES } from "../src/lib/domain/leagues";
import { testDb, type TestDb } from "./fixtures/test-db";

const SCHEMA = { v_games: ["game_id"] };
const COVERAGE = { league: () => ({ games: 100, ingame: 100 }), player: () => ({ games: 100, ingame: 100 }), team: () => ({ games: 100, ingame: 100 }) };

const player = (name: string): ResolvedPlayer => ({ mention: name, player: name, matchedAlias: name, realName: null, nativeName: null, otherCandidates: [], ambiguity: null });

const team = (mention: string, name = mention): ResolvedTeam => ({ mention, team: name, members: [name] });

const scope = (
  { players = [], teams = [], league = null, short = null, year = null }: { players?: string[]; teams?: ResolvedTeam[]; league?: LeagueName | null; short?: string | null; year?: number | null },
): Entities => ({
  players: players.map(player), teams, champion: null, unresolved: [], league, leagueShort: short, leagueMention: short, yearFrom: year, yearTo: year, split: null, outOfScope: null,
});

const WORLDS = { league: "World Championship" as const, short: "Worlds" };
const LEC = { league: "LoL EMEA Championship" as const, short: "LEC" };

describe("champion pool questions route to champion_pool, decided by the rules", () => {
  test.each([
    ["champion pool de Faker", scope({ players: ["Faker"] }), { subject: "player", name: "Faker", league: null, yearFrom: null }],
    ["champion pool de Chovy aux Worlds 2024", scope({ players: ["Chovy"], ...WORLDS, year: 2024 }), { subject: "player", name: "Chovy", league: "World Championship", yearFrom: 2024, yearTo: 2024 }],
    ["pool de Caps en LEC 2025", scope({ players: ["Caps"], ...LEC, year: 2025 }), { subject: "player", name: "Caps", league: "LoL EMEA Championship", yearFrom: 2025 }],
    ["quels champions joue Keria", scope({ players: ["Keria"] }), { subject: "player", name: "Keria" }],
    ["champion pool de T1 aux Worlds 2023", scope({ teams: [team("T1")], ...WORLDS, year: 2023 }), { subject: "team", name: "T1", yearFrom: 2023 }],
    ["champions joués par Caps en LEC 2025", scope({ players: ["Caps"], ...LEC, year: 2025 }), { subject: "player", name: "Caps" }],
    ["Faker champion pool", scope({ players: ["Faker"] }), { subject: "player" }],
    ["which champions does Keria play", scope({ players: ["Keria"] }), { subject: "player" }],
    ["most played champions of G2 in LEC 2025", scope({ teams: [team("G2", "G2 Esports")], ...LEC, year: 2025 }), { subject: "team", name: "G2 Esports" }],
    ["winrate de Faker par champion", scope({ players: ["Faker"] }), { subject: "player" }],
    ["pool de champions de T1", scope({ teams: [team("T1")] }), { subject: "team" }],
  ] as const)("%s", async (q, e, input) => {
    const route = await routeQuestion(q, e, SCHEMA, COVERAGE);

    expect(route).toMatchObject({ kind: "tool", confidence: 0.9, call: { tool: "champion_pool", input } });
    expect(route.kind === "tool" && route.unread).toBeFalsy();
  });

  test.each([
    "pool champ Bin",
    "Bin champ pool",
    "champ pool Bin",
    "champs pool Bin",
    "pool champion Bin",
    "pool champions de Bin",
    "Bin pool de champions",
    "pool of champions Bin",
    "championpool Bin",
    "champion-pool Bin",
    "pool Bin",
    "chamion pool Bin",
    "champoin pool Bin",
    "champion pol Bin",
    "pool chmapion Bin",
  ])("%s", async (q) => {
    const route = await routeQuestion(q, scope({ players: ["Bin"] }), SCHEMA, COVERAGE);

    expect(route).toMatchObject({ kind: "tool", confidence: 0.9, call: { tool: "champion_pool", input: { subject: "player", name: "Bin" } } });
    expect(route.kind === "tool" && route.unread).toBeFalsy();
  });

  test("a team's pool, with the short word and in either order", async () => {
    for (const q of ["pool champ T1 aux Worlds 2023", "T1 champs pool aux Worlds 2023"])
      expect(await routeQuestion(q, scope({ teams: [team("T1")], ...WORLDS, year: 2023 }), SCHEMA, COVERAGE)).toMatchObject({
        call: { tool: "champion_pool", input: { subject: "team", name: "T1", yearFrom: 2023 } },
      });
  });

  test("without a competition, every competition, said in a note; a team named with the player is ignored, said too", async () => {
    expect(await routeQuestion("champion pool de Faker", scope({ players: ["Faker"] }), SCHEMA, COVERAGE)).toMatchObject({
      notes: ["Aucune compétition précisée : toutes compétitions confondues."],
    });
    expect(await routeQuestion("champion pool de Faker chez T1 aux Worlds", scope({ players: ["Faker"], teams: [team("T1")], ...WORLDS }), SCHEMA, COVERAGE)).toMatchObject({
      call: { tool: "champion_pool", input: { subject: "player", name: "Faker" } },
      notes: ["Équipe « T1 » ignorée : champion pool de Faker toutes équipes confondues."],
    });
  });

  test("a role with a team does not make it a roster question: the team's pool, the role said unfiltered", async () => {
    expect(await routeQuestion("quels champions joue le mid de T1", scope({ teams: [team("T1")] }), SCHEMA, COVERAGE)).toMatchObject({
      call: { tool: "champion_pool", input: { subject: "team", name: "T1" } },
      notes: ["Aucune compétition précisée : toutes compétitions confondues.", "Poste non filtré : pool de toute l'équipe, avec le joueur de chaque champion."],
    });
  });

  test("the split asked is kept", async () => {
    const e = { ...scope({ players: ["Caps"], ...LEC, year: 2025 }), split: "Summer" as const };

    expect(await routeQuestion("pool de Caps en LEC Summer 2025", e, SCHEMA, COVERAGE)).toMatchObject({ call: { tool: "champion_pool", input: { split: "Summer" } } });
  });
});

describe("the other rules keep their questions", () => {
  test.each([
    ["champion pool de Faker vs Chovy", scope({ players: ["Faker", "Chovy"] }), "player_comparison"],
    ["Faker contre Chovy", scope({ players: ["Faker", "Chovy"] }), "player_comparison"],
    ["T1 vs Gen.G", scope({ teams: [team("T1"), team("Gen.G")] }), "head_to_head"],
    ["champions les plus joués en LEC 2025", scope({ ...LEC, year: 2025 }), "champion_ranking"],
    ["quels champions sont les plus bannis aux Worlds 2024", scope({ ...WORLDS, year: 2024 }), "champion_ranking"],
    ["meilleurs mids LEC 2025", scope({ ...LEC, year: 2025 }), "player_leaderboard"],
    ["résultats de Chovy aux Worlds", scope({ players: ["Chovy"], ...WORLDS }), "player_event_history"],
    ["palmarès de T1", scope({ teams: [team("T1")] }), "team_history"],
    ["roster de T1 en 2024", scope({ teams: [team("T1")], year: 2024 }), "team_roster"],
    ["qui jouait chez Fnatic en 2018", scope({ teams: [team("Fnatic")], year: 2018 }), "team_roster"],
    ["adc de T1", scope({ teams: [team("T1")] }), "team_roster"],
    ["classement LEC 2025", scope({ ...LEC, year: 2025 }), "tournament_standings"],
  ] as const)("%s → %s", async (q, e, tool) => {
    expect(await routeQuestion(q, e, SCHEMA, COVERAGE)).toMatchObject({ kind: "tool", call: { tool } });
  });

  test("a champion named with the player, or an in-game metric, is not a pool", async () => {
    const fakerAzir = { ...scope({ players: ["Faker"] }), champion: { mention: "Azir", champion: "Azir" } };

    expect(await routeQuestion("quels champions joue Faker à part Azir", fakerAzir, SCHEMA, COVERAGE)).not.toMatchObject({ call: { tool: "champion_pool" } });
    expect(await routeQuestion("gold diff at 15 de Faker par champion", scope({ players: ["Faker"] }), SCHEMA, COVERAGE)).not.toMatchObject({ call: { tool: "champion_pool" } });
  });
});

describe("a pool phrase is a LoL cue: a short or everyday handle next to it is a player", async () => {
  const db = await testDb();

  await db.exec(`
    INSERT INTO players(id,page) VALUES (1,'Bin'),(2,'Faker');
    INSERT INTO player_aliases VALUES ('bin','Bin',1),('faker','Faker',2);
  `);

  afterAll(() => db.close());

  const players = async (q: string) => (await understandQuestion(db, q, new Date("2026-11-14")))?.result.players.map((p) => p.player) ?? [];

  test.each(["pool champ bin", "bin champ pool", "champs pool bin", "pool de champions bin", "chamion pool bin", "pool bin", "pool champion faker"])(
    "%s",
    async (q) => {
      expect(await players(q)).toEqual([q.includes("faker") ? "Faker" : "Bin"]);
    },
  );

  test("not \"pool\" with other everyday words, nor a sentence about something else", async () => {
    expect(await players("pool party bin")).toEqual([]);
    expect(await players("vider le bin")).toEqual([]);
  });
});

async function seed(db: TestDb) {
  for (const [i, l] of LEAGUES.entries()) await db.run("INSERT INTO leagues VALUES(?,?,?,?,?)", i + 1, l.name, l.short, l.region, +l.international);
  const lec = Number((await db.query("SELECT id FROM leagues WHERE name = 'LoL EMEA Championship'"))[0]!.id);

  await db.run(
    "INSERT INTO tournaments(id,page,event_page,stage,league_id,year,split) VALUES (1,'LEC25/Spring','LEC25 Spring','season',?,2025,'Spring'),(2,'LEC25/Summer','LEC25 Summer','season',?,2025,'Summer')",
  lec, lec);
  await db.exec(`
    INSERT INTO teams(id,name) VALUES (1,'G2 Esports'),(2,'Fnatic');
    INSERT INTO players(id,page) VALUES (1,'Caps'),(2,'Humanoid'),(3,'BrokenBlade');
    INSERT INTO champions VALUES (1,'Azir','https://ddragon.leagueoflegends.com/cdn/16.22.1/img/champion/Azir.png'),(2,'Orianna',NULL),(3,'Gnar',NULL);
    INSERT INTO games(id,tournament_id,blue_team_id,red_team_id,winner_side,length_s,played_at)
      VALUES (1,1,1,2,1,1800,100),(2,1,2,1,1,1500,200),(3,2,1,2,1,2400,300);
    -- game_id, player_id, team_id, side, role, champion_id, win, kills, deaths, assists, gold, cs, damage, vision, keystone
    INSERT INTO game_players(game_id,player_id,team_id,side,role,champion_id,win,kills,deaths,assists,gold,cs,damage,vision,keystone_id) VALUES
      (1,1,1,1,'Mid',1,1,5,1,5,15000,300,30000,30,NULL),
      (1,3,1,1,'Top',3,1,3,0,2,13000,280,20000,20,NULL),
      (1,2,2,2,'Mid',2,0,1,3,2,12000,270,18000,25,NULL),
      (2,1,1,2,'Mid',2,0,2,4,2,14000,290,25000,30,NULL),
      (2,3,1,2,'Top',1,0,1,2,1,11000,250,15000,20,NULL),
      (2,2,2,1,'Mid',2,1,4,1,6,11000,250,15000,20,NULL),
      (3,1,1,1,'Mid',1,1,3,NULL,4,12000,320,20000,40,NULL),
      (3,2,2,2,'Mid',2,0,0,2,1,15000,330,26000,35,NULL);
    INSERT INTO tournament_results VALUES (1, 1, '1', 1, NULL), (2, 1, '1', 1, NULL);
  `);
}

async function run(db: TestDb, call: Parameters<typeof bindTool>[1]) {
  const tool = await bindTool(db, call);

  expect(guardQuery(await readSchema(db), tool.sql).ok).toBe(true);

  return tool.format(db, (await db.query(tool.sql, tool.params)));
}

const LEC25 = { league: "LoL EMEA Championship" as const, yearFrom: 2025, yearTo: 2025, split: null };

describe("champion_pool on a seeded season", () => {
  test("a player's pool: games, W-L, win rate, KDA, share and diversity", async () => {
    const db = await testDb();

    try {
      await seed(db);
      const out = await run(db, { tool: "champion_pool", input: { subject: "player", name: "Caps", ...LEC25 } });

      expect(out.table!.columns).toEqual(["rank", "champion", "games", "wins", "losses", "winrate", "kda", "share"]);
      expect(out.table!.rows).toEqual([
        [1, "Azir", 2, 2, 0, 100, 10, 66.7],
        [2, "Orianna", 1, 0, 1, 0, 1, 33.3],
      ]);
      expect(out.pool).toMatchObject({ subject: "player", name: "Caps", games: 3, wins: 2, losses: 1, picks: 3, unique: 2, top3Share: 100 });
      expect(out.icons).toEqual({ Azir: "https://ddragon.leagueoflegends.com/cdn/16.22.1/img/champion/Azir.png" });
      expect(out.facts).toContain("2 champions différents sur 3 parties (2 victoires, 1 défaite)");
      expect(out.sources[0]).toMatchObject({ label: "Leaguepedia — Caps" });
      expect(out.sources.map((s) => s.label)).toContain("Leaguepedia — LEC25 Spring");
      expect(out.totals).toMatchObject({ games: 3, unique: 2, top: "Azir", top_games: 2, top3_share: 100 });
    } finally {
      await db.close();
    }
  });

  test("a split narrows the pool; a team's pool counts every pick of its players", async () => {
    const db = await testDb();

    try {
      await seed(db);
      const summer = await run(db, { tool: "champion_pool", input: { subject: "player", name: "Caps", ...LEC25, split: "Summer" } });

      expect(summer.table!.rows.map((r) => r[1])).toEqual(["Azir"]);
      expect(summer.title).toContain("Summer");

      const g2 = await run(db, { tool: "champion_pool", input: { subject: "team", name: "G2 Esports", ...LEC25 } });

      expect(g2.table!.columns.at(-1)).toBe("players");
      expect(g2.table!.rows.map((r) => [r[1], r[2], r[3], r[7], r[8]])).toEqual([
        ["Azir", 3, 2, 60, "Caps ×2, BrokenBlade ×1"],
        ["Gnar", 1, 1, 20, "BrokenBlade ×1"],
        ["Orianna", 1, 0, 20, "Caps ×1"],
      ]);
      expect(g2.pool).toMatchObject({ subject: "team", games: 3, wins: 2, picks: 5, unique: 3 });
    } finally {
      await db.close();
    }
  });

  test("an empty split or period is relaxed, said in a note", async () => {
    const db = await testDb();

    try {
      await seed(db);
      const tool = await bindTool(db, { tool: "champion_pool", input: { subject: "player", name: "Caps", ...LEC25, split: "Winter" } });

      expect((await db.query(tool.sql, tool.params))).toEqual([]);
      expect(tool.relaxations(scope({ players: ["Caps"] })).map((r) => [r.key, r.note])).toEqual([
        ["split", "Aucune partie en Winter : toute la saison."],
        ["period", "Rien entre 2025 et 2025 : affichage de toutes les saisons."],
      ]);
    } finally {
      await db.close();
    }
  });
});
