import { describe, expect, test } from "bun:test";
import { guardQuery } from "../src/lib/agent/guard";
import { routeQuestion, unreadWords } from "../src/lib/agent/query";
import { bindTool } from "../src/lib/agent/tools";
import type { Entities, LeagueName, ResolvedPlayer, ResolvedTeam } from "../src/lib/agent/types";
import { readSchema } from "../src/lib/db";
import { LEAGUES } from "../src/lib/domain/leagues";
import { testDb, type TestDb } from "./fixtures/test-db";

const SCHEMA = { v_games: ["game_id"] };
const COVERAGE = { league: () => ({ games: 100, ingame: 100 }), player: () => ({ games: 100, ingame: 100 }), team: () => ({ games: 100, ingame: 100 }) };

const player = (name: string): ResolvedPlayer => ({ mention: name, player: name, matchedAlias: name, realName: null, nativeName: null, otherCandidates: [], ambiguity: null });

const team = (mention: string, name = mention): ResolvedTeam => ({ mention, team: name, members: [name] });

const scope = ({
  players = [],
  teams = [],
  champion = null,
  league = null,
  short = null,
  year = null,
}: { players?: string[]; teams?: ResolvedTeam[]; champion?: string | null; league?: LeagueName | null; short?: string | null; year?: number | null }): Entities => ({
  players: players.map(player),
  teams,
  champion: champion ? { mention: champion, champion } : null,
  unresolved: [],
  league,
  leagueShort: short,
  leagueMention: short,
  yearFrom: year,
  yearTo: year,
  split: null,
  outOfScope: null,
});

const WORLDS = { league: "World Championship" as const, short: "Worlds" };
const LCK = { league: "LoL Champions Korea" as const, short: "LCK" };

describe("a player's rune questions route to player_runes, decided by the rules", () => {
  test.each([
    ["runes de Faker aux Worlds 2019", scope({ players: ["Faker"], ...WORLDS, year: 2019 }), { player: "Faker", league: "World Championship", yearFrom: 2019, champion: null, role: null }],
    ["Faker's runes at Worlds 2019", scope({ players: ["Faker"], ...WORLDS, year: 2019 }), { player: "Faker", league: "World Championship", yearFrom: 2019 }],
    ["keystones de Chovy en LCK 2025", scope({ players: ["Chovy"], ...LCK, year: 2025 }), { player: "Chovy", league: "LoL Champions Korea", yearFrom: 2025 }],
    ["runes de Faker sur Azir", scope({ players: ["Faker"], champion: "Azir" }), { player: "Faker", league: null, champion: "Azir" }],
    ["Faker's rune pages on Azir at Worlds", scope({ players: ["Faker"], champion: "Azir", ...WORLDS }), { player: "Faker", champion: "Azir" }],
    ["keystones les plus fréquentes de Chovy", scope({ players: ["Chovy"] }), { player: "Chovy" }],
    ["runes de Faker en mid", scope({ players: ["Faker"] }), { player: "Faker", role: "Mid" }],
  ] as const)("%s", async (q, e, input) => {
    const route = await routeQuestion(q, e, SCHEMA, COVERAGE);

    expect(route).toMatchObject({ kind: "tool", confidence: 0.9, call: { tool: "player_runes", input } });
    expect(route.kind === "tool" && route.unread).toBeFalsy();
  });

  test("without a competition, every competition, said in a note; a team named with the player is ignored, said too", async () => {
    expect(await routeQuestion("runes de Faker", scope({ players: ["Faker"] }), SCHEMA, COVERAGE)).toMatchObject({
      notes: ["Aucune compétition précisée : toutes compétitions confondues."],
    });
    expect(await routeQuestion("runes de Faker chez T1 aux Worlds", scope({ players: ["Faker"], teams: [team("T1")], ...WORLDS }), SCHEMA, COVERAGE)).toMatchObject({
      call: { tool: "player_runes", input: { player: "Faker" } },
      notes: ["Équipe « T1 » ignorée : runes de Faker toutes équipes confondues."],
    });
  });

  test("a champion's runes without a player stay on the champion's profile, runes first", async () => {
    for (const q of ["Runes de Yunara aux Worlds 2026", "Yunara keystones at Worlds 2026", "runes d'Azir"])
      expect(await routeQuestion(q, scope({ champion: q.includes("Azir") ? "Azir" : "Yunara", ...WORLDS, year: 2026 }), SCHEMA, COVERAGE)).toMatchObject({
        kind: "tool",
        call: { tool: "champion_event_stats", input: { focus: "runes" } },
      });
  });

  test("two players keep their comparison", async () => {
    expect(await routeQuestion("runes de Faker vs Chovy", scope({ players: ["Faker", "Chovy"] }), SCHEMA, COVERAGE)).toMatchObject({ call: { tool: "player_comparison" } });
  });

  test("the words of a rune question are all read", () => {
    const e = scope({ players: ["Faker"], ...WORLDS, year: 2019 });

    expect(unreadWords("quelles runes Faker prend aux Worlds 2019", e, { tool: "player_runes", input: { player: "Faker", league: "World Championship", yearFrom: 2019, yearTo: 2019, split: null, champion: null, role: null } }).words).toEqual([]);
  });
});

async function seed(db: TestDb) {
  for (const [i, l] of LEAGUES.entries()) await db.run("INSERT INTO leagues VALUES(?,?,?,?,?)", i + 1, l.name, l.short, l.region, +l.international);
  const lck = Number((await db.query("SELECT id FROM leagues WHERE name = 'LoL Champions Korea'"))[0]!.id);

  await db.run("INSERT INTO tournaments(id,page,event_page,stage,league_id,year,split) VALUES (1,'LCK25/Rounds 1-2','LCK 2025','season',?,2025,NULL)", lck);
  await db.exec(`
    INSERT INTO teams(id,name) VALUES (1,'T1'),(2,'Gen.G');
    INSERT INTO players(id,page) VALUES (1,'Faker'),(2,'Chovy');
    INSERT INTO champions VALUES (1,'Azir','/azir.png'),(2,'Orianna',NULL);
    INSERT INTO runes VALUES
      (1,'Lethal Tempo','Precision','/lt.png'),(2,'Electrocute','Domination','/el.png'),(3,'Presence of Mind','Precision',NULL),
      (4,'Legend: Alacrity','Precision',NULL),(5,'Cut Down','Precision',NULL),(6,'Manaflow Band','Sorcery',NULL),(7,'Scorch','Sorcery',NULL),
      (8,'Attack Speed',NULL,NULL),(9,'Adaptive Force',NULL,NULL),(10,'Health',NULL,NULL),(11,'Conqueror','Precision',NULL);
    INSERT INTO games(id,tournament_id,blue_team_id,red_team_id,winner_side,length_s,played_at)
      VALUES (1,1,1,2,1,1800,100),(2,1,2,1,1,1500,200),(3,1,1,2,1,2400,300);
    INSERT INTO game_players(game_id,player_id,team_id,side,role,champion_id,win,kills,deaths,assists,keystone_id) VALUES
      (1,1,1,1,'Mid',1,1,5,1,5,1),
      (1,2,2,2,'Mid',2,0,1,3,2,11),
      (2,1,1,2,'Mid',1,0,2,4,2,1),
      (3,1,1,1,'Mid',2,1,3,1,4,2);
    -- game_id, player_id, primary 1-3, secondary 1-2, shards 1-3.
    INSERT INTO game_player_runes VALUES
      (1,1,3,4,5,6,7,8,9,10),
      -- The secondary runes the other way round: still the same page.
      (2,1,3,4,5,7,6,8,9,10),
      (1,2,3,4,5,6,7,8,9,10);
  `);
}

async function run(db: TestDb, call: Parameters<typeof bindTool>[1]) {
  const tool = await bindTool(db, call);

  expect(guardQuery(await readSchema(db), tool.sql).ok).toBe(true);

  return tool.format(db, await db.query(tool.sql, tool.params));
}

const LCK25 = { league: "LoL Champions Korea" as const, yearFrom: 2025, yearTo: 2025, split: null, champion: null, role: null };

describe("player_runes on a seeded season", () => {
  test("keystones, trees, runes by part and the most frequent page, each with its games and wins", async () => {
    const db = await testDb();

    try {
      await seed(db);
      const out = await run(db, { tool: "player_runes", input: { player: "Faker", ...LCK25 } });
      const r = out.runes!;

      expect([r.games, r.wins, r.keystoneGames, r.pageGames]).toEqual([3, 2, 3, 2]);
      expect(r.runes.filter((x) => x.kind === "keystone").map((x) => [x.rune, x.tree, x.games, x.wins, x.icon])).toEqual([
        ["Lethal Tempo", "Precision", 2, 1, "/lt.png"],
        ["Electrocute", "Domination", 1, 1, "/el.png"],
      ]);
      expect(r.trees).toEqual([
        { tree: "Precision", part: "primary", games: 2, wins: 1 },
        { tree: "Domination", part: "primary", games: 1, wins: 1 },
        { tree: "Sorcery", part: "secondary", games: 2, wins: 1 },
      ]);
      expect(r.runes.find((x) => x.rune === "Attack Speed")).toMatchObject({ kind: "shard", games: 2, icon: expect.stringContaining("StatModsAttackSpeedIcon") });
      expect(r.pages).toEqual([
        {
          games: 2,
          wins: 1,
          runes: [
            { rune: "Lethal Tempo", kind: "keystone", tree: "Precision", icon: "/lt.png" },
            { rune: "Presence of Mind", kind: "primary", tree: "Precision", icon: null },
            { rune: "Legend: Alacrity", kind: "primary", tree: "Precision", icon: null },
            { rune: "Cut Down", kind: "primary", tree: "Precision", icon: null },
            { rune: "Manaflow Band", kind: "secondary", tree: "Sorcery", icon: null },
            { rune: "Scorch", kind: "secondary", tree: "Sorcery", icon: null },
          ],
        },
      ]);
      expect(r.notes).toEqual(["Page de runes complète pour 2 parties sur 3 (keystone seule en 2018, 2019 et sur une partie de 2020)."]);
      expect(out.title).toBe("Runes de Faker — LCK 2025");
      expect(out.facts).toContain("Runes de Faker (en LCK en 2025) sur 3 parties, keystones les plus fréquentes : Lethal Tempo (2/3 parties, 67 %, 50 % de victoires), Electrocute (1/3 parties, 33 %, 100 % de victoires).");
      expect(out.facts).toContain("Page la plus fréquente (hors fragments) : Lethal Tempo, Presence of Mind, Legend: Alacrity, Cut Down, Manaflow Band, Scorch (2/2 parties).");
      expect(out.table!.rows.map((row) => row[0])).toEqual(["keystone", "keystone", "primaire", "primaire", "primaire", "secondaire", "secondaire", "fragment", "fragment", "fragment"]);
      expect(out.totals).toMatchObject({ games: 3, keystone_games: 3, page_games: 2, top_keystone: "Lethal Tempo", top_keystone_games: 2, top_secondary_tree: "Sorcery", top_champion: "Azir" });
      expect(out.followUps).toEqual(["Runes de Faker sur Azir en LCK 2025", "Runes d'Azir en LCK 2025", "Champion pool de Faker en LCK 2025"]);
      expect(out.sources[0]).toMatchObject({ label: "Leaguepedia — Faker" });
    } finally {
      await db.close();
    }
  });

  test("a champion narrows the games; a scope with the keystone alone says so and lists no page", async () => {
    const db = await testDb();

    try {
      await seed(db);
      const azir = await run(db, { tool: "player_runes", input: { player: "Faker", ...LCK25, champion: "Azir" } });

      expect(azir.runes).toMatchObject({ games: 2, keystoneGames: 2, pageGames: 2, champion: { name: "Azir", icon: "/azir.png" } });
      expect(azir.title).toBe("Runes de Faker sur Azir — LCK 2025");

      const orianna = await run(db, { tool: "player_runes", input: { player: "Faker", ...LCK25, champion: "Orianna" } });

      expect(orianna.runes).toMatchObject({ games: 1, keystoneGames: 1, pageGames: 0, pages: [] });
      expect(orianna.runes!.trees).toEqual([{ tree: "Domination", part: "primary", games: 1, wins: 1 }]);
      expect(orianna.runes!.notes).toEqual(["Seule la keystone est listée pour ces parties (page de runes complète listée à partir de 2020)."]);
    } finally {
      await db.close();
    }
  });

  test("games without any rune still answer, with the reason; an empty scope is relaxed", async () => {
    const db = await testDb();

    try {
      await seed(db);
      await db.exec("UPDATE game_players SET keystone_id = NULL; DELETE FROM game_player_runes;");
      const out = await run(db, { tool: "player_runes", input: { player: "Faker", ...LCK25 } });

      expect(out.runes).toMatchObject({ games: 3, keystoneGames: 0, runes: [], trees: [], pages: [] });
      expect(out.runes!.notes).toEqual(["Leaguepedia ne liste aucune rune pour ces parties (aucune avant la saison 2018)."]);
      expect(out.followUps.some((f) => f.startsWith("Runes"))).toBe(false);

      const tool = await bindTool(db, { tool: "player_runes", input: { player: "Faker", ...LCK25, yearFrom: 2024, yearTo: 2024 } });

      expect(await db.query(tool.sql, tool.params)).toEqual([]);
      expect(tool.relaxations(scope({ players: ["Faker"] })).map((r) => r.key)).toEqual(["period"]);
    } finally {
      await db.close();
    }
  });
});
