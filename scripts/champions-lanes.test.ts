import { describe, expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import { guardQuery } from "../src/lib/agent/guard";
import { routeQuestion } from "../src/lib/agent/query";
import { roleOf } from "../src/lib/agent/roles";
import { bindTool } from "../src/lib/agent/tools";
import type { Entities, LeagueName } from "../src/lib/agent/types";
import { resolveChampion, understandQuestion } from "../src/lib/agent/understand";
import { detectChampionRanking } from "../src/lib/champions";
import { readSchema } from "../src/lib/db";
import { createQuerySchema, createSchema } from "../src/lib/db/schema";
import { LEAGUES } from "../src/lib/domain/leagues";

const SCHEMA = { v_games: ["game_id"] };
const COVERAGE = { league: () => ({ games: 100, ingame: 100 }), player: () => ({ games: 100, ingame: 100 }), team: () => ({ games: 100, ingame: 100 }) };

const scope = (league: LeagueName | null, leagueShort: string | null, year: number | null = null): Entities => ({
  players: [], teams: [], champion: null, unresolved: [], league, leagueShort, leagueMention: leagueShort, yearFrom: year, yearTo: year, split: null, outOfScope: null,
});

const LCK24 = scope("LoL Champions Korea", "LCK", 2024);
const LEC25 = scope("LoL EMEA Championship", "LEC", 2025);
const WORLDS24 = scope("World Championship", "Worlds", 2024);

describe("roles, French and English", () => {
  test.each([
    ["meilleurs mids LEC 2025", "Mid"],
    ["best mid laners", "Mid"],
    ["quel jungler", "Jungle"],
    ["les junglers de LCK", "Jungle"],
    ["best ADC", "Bot"],
    ["les bots de LPL", "Bot"],
    ["botlaners LEC", "Bot"],
    ["top 5 supports", "Support"],
    ["meilleurs toplaners", "Top"],
    ["quel top a le plus de solo kills", "Top"],
    ["les tops de LCK", "Top"],
  ] as const)("%s → %s", (q, role) => expect(roleOf(q)).toBe(role));

  // "top 5" is a ranking, "mid-season" a competition: no role.
  test.each(["top 5 des équipes", "mid-season invitational", "Top Esports en LPL"])("%s → no role", (q) => expect(roleOf(q)).toBeNull());
});

describe("champion questions route to the champion tools, decided by the rules", () => {
  test.each([
    ["champions les plus joués en LCK 2024", LCK24, { sort: "picks", role: null }],
    ["champions les plus bannis aux Worlds 2024", WORLDS24, { sort: "bans" }],
    ["most banned champions at Worlds 2024", WORLDS24, { sort: "bans" }],
    ["most played champions in LEC 2025", LEC25, { sort: "picks" }],
    ["quel champion a le meilleur winrate en LCK 2024", LCK24, { sort: "winrate" }],
    ["champions les plus joués en mid en LCK 2024", LCK24, { sort: "picks", role: "Mid" }],
    ["meta LCK 2024", LCK24, { sort: "presence" }],
    ["top 10 champions LCK 2024", LCK24, { sort: "presence" }],
  ] as const)("%s", (q, e, input) => {
    const route = routeQuestion(q, e, SCHEMA, COVERAGE);

    expect(route).toMatchObject({ kind: "tool", call: { tool: "champion_ranking", input: { league: e.league, ...input } } });
    expect(route.kind === "tool" && route.confidence).toBeGreaterThanOrEqual(0.8);
  });

  test.each([
    ["champion avec le plus de morts par game aux Worlds 2024", WORLDS24, { sort: "deaths", role: null }],
    ["which champion has the most kills per game at Worlds 2024", WORLDS24, { sort: "kills" }],
    ["quel champion fait le plus de dégâts en moyenne en mid en LCK 2024", LCK24, { sort: "damage", role: "Mid" }],
    ["champions avec le plus d'or par partie aux Worlds 2024", WORLDS24, { sort: "gold" }],
    ["champions with the most deaths per game in LCK 2024, at least 10 picks", LCK24, { sort: "deaths", minPicks: 10 }],
    ["champions avec le plus de morts par partie en LCK 2024, au moins 10 picks", LCK24, { sort: "deaths", minPicks: 10 }],
  ] as const)("a per-game average the ranking sorts by: %s", (q, e, input) => {
    const route = routeQuestion(q, e, SCHEMA, COVERAGE);

    expect(route).toMatchObject({ kind: "tool", call: { tool: "champion_ranking", input: { league: e.league, ...input } } });
    expect(route.kind === "tool" && route.confidence).toBeGreaterThanOrEqual(0.8);
  });

  test("a figure the ranking does not sort by goes to generated SQL", () => {
    for (const [q, e] of [
      // A total, the lowest figure, two figures at once: not the ranking's per-game average, highest first.
      ["champion avec le moins de morts par partie aux Worlds 2024", WORLDS24],
      ["champions avec le plus de kills et d'assists par partie en LCK 2024", LCK24],
      ["champions avec le plus de kills et d'or par partie en LCK 2024", LCK24],
      ["champions avec le plus de dragons par partie en LCK 2024", LCK24],
      ["quel champion a le plus de pentakills aux Worlds 2024", WORLDS24],
      ["quel champion fait le plus de dégâts aux Worlds 2024", WORLDS24],
      ["champions avec le plus de kills en LCK 2024", LCK24],
    ] as const)
      expect(routeQuestion(q, e, SCHEMA, COVERAGE).kind).toBe("sql");
  });

  test("a champion alone gets its profile, even with an end-of-game metric", () => {
    const azir = { ...WORLDS24, champion: { mention: "Azir", champion: "Azir" } };

    for (const q of ["stats d'Azir aux Worlds 2024", "KDA d'Azir aux Worlds 2024", "Azir damage at Worlds 2024", "meilleurs joueurs d'Azir aux Worlds 2024"])
      expect(routeQuestion(q, azir, SCHEMA, COVERAGE)).toMatchObject({ kind: "tool", confidence: 0.9, call: { tool: "champion_event_stats", input: { champion: "Azir", yearFrom: 2024 } } });
  });

  test("the profile has the gold and CS differences at 15 only: another in-game metric of a champion is not routed to it", () => {
    const azir = { ...WORLDS24, champion: { mention: "Azir", champion: "Azir" } };

    expect(routeQuestion("gold diff at 15 of Azir at Worlds 2024", azir, SCHEMA, COVERAGE)).toMatchObject({ call: { tool: "champion_event_stats" } });

    for (const q of ["gold diff at 10 of Azir at Worlds 2024", "solo kills sur Azir aux Worlds 2024"])
      expect(routeQuestion(q, azir, SCHEMA, COVERAGE)).not.toMatchObject({ call: { tool: "champion_event_stats" } });
  });

  test("a world champion is a title, not a champion ranking", () => {
    expect(routeQuestion("qui a gagné les Worlds 2023", scope("World Championship", "Worlds", 2023), SCHEMA, COVERAGE)).toMatchObject({ call: { tool: "tournament_standings" } });
    expect(routeQuestion("champion du monde 2023", scope(null, null, 2023), SCHEMA, COVERAGE)).not.toMatchObject({ call: { tool: "champion_ranking" } });
  });
});

describe("lane questions: a role, an explicit criterion", () => {
  test.each([
    ["meilleurs mids LEC 2025", LEC25, { role: "Mid", criterion: "kda" }],
    ["best ADC LCK 2024", LCK24, { role: "Bot", criterion: "kda" }],
    ["qui est le meilleur jungler de LCK 2024", LCK24, { role: "Jungle", criterion: "kda" }],
    ["top 5 supports Worlds 2024", WORLDS24, { role: "Support", criterion: "kda" }],
    ["ADC with the highest winrate in LCK 2024", LCK24, { role: "Bot", criterion: "winrate" }],
    ["meilleurs toplaners en dégâts par minute LCK 2024", LCK24, { role: "Top", criterion: "dpm" }],
    ["les plus gros farmers en mid LCK 2024", LCK24, { role: "Mid", criterion: "cspm" }],
    ["meilleur KDA de la LEC 2025", LEC25, { role: null, criterion: "kda" }],
  ] as const)("%s", (q, e, input) => {
    const route = routeQuestion(q, e, SCHEMA, COVERAGE);

    expect(route).toMatchObject({ kind: "tool", call: { tool: "player_leaderboard", input: { league: e.league, minGames: null, ...input } } });
    expect(route.kind === "tool" && route.confidence).toBeGreaterThanOrEqual(0.8);
  });

  test("a ranking of a role's players is not a tournament's standings; a minimum the question sets is kept", () => {
    expect(routeQuestion("classement des mids par KDA en LEC 2025", LEC25, SCHEMA, COVERAGE)).toMatchObject({
      kind: "tool",
      call: { tool: "player_leaderboard", input: { role: "Mid", criterion: "kda", minGames: null } },
    });
    expect(routeQuestion("classement LEC 2025", LEC25, SCHEMA, COVERAGE)).toMatchObject({ call: { tool: "tournament_standings" } });

    for (const [q, min] of [
      ["meilleurs mids LEC 2025 avec au moins 50 parties", 50],
      ["best mids LEC 2025 with at least 50 games", 50],
      // The minimum is inclusive: "more than 50" starts at 51.
      ["meilleurs mids LEC 2025 avec plus de 50 parties", 51],
      ["best mids LEC 2025 with more than 50 games", 51],
    ] as const)
      expect(routeQuestion(q, LEC25, SCHEMA, COVERAGE)).toMatchObject({ confidence: 0.85, call: { tool: "player_leaderboard", input: { role: "Mid", minGames: min } } });

    expect(routeQuestion("champions au meilleur winrate en LCK 2024, minimum 20 picks", LCK24, SCHEMA, COVERAGE)).toMatchObject({
      call: { tool: "champion_ranking", input: { sort: "winrate", minPicks: 20 } },
    });
  });

  // A role with a comparison or ranking word gives the role's leaderboard, never the competition's standings.
  test.each([
    ["comparaison des mid au worlds 2026", scope("World Championship", "Worlds", 2026), "Mid"],
    ["compare les junglers LCK 2025", scope("LoL Champions Korea", "LCK", 2025), "Jungle"],
    ["meilleurs supports MSI 2024", scope("Mid-Season Invitational", "MSI", 2024), "Support"],
    ["top laners comparison LEC", scope("LoL EMEA Championship", "LEC"), "Top"],
    ["classement des mids aux Worlds 2026", scope("World Championship", "Worlds", 2026), "Mid"],
    ["comparaison des ADC en LPL 2024", scope("Tencent LoL Pro League", "LPL", 2024), "Bot"],
    ["supports comparison at Worlds 2026", scope("World Championship", "Worlds", 2026), "Support"],
    ["mid laners ranking Worlds 2026", scope("World Championship", "Worlds", 2026), "Mid"],
    ["ranking of supports at Worlds 2026", scope("World Championship", "Worlds", 2026), "Support"],
  ] as const)("%s → the %s players ranked", (q, e, role) => {
    const route = routeQuestion(q, e, SCHEMA, COVERAGE);

    expect(route).toMatchObject({ kind: "tool", call: { tool: "player_leaderboard", input: { role, criterion: "kda", league: e.league } } });
    // Every word read: the rules' pick is not put in doubt.
    expect(route.kind === "tool" && route.unread).toBeFalsy();
    expect(route.kind === "tool" && route.confidence).toBeGreaterThanOrEqual(0.8);
  });

  test("without a role, a ranking word is still the standings; two players named are still their comparison", () => {
    const worlds26 = scope("World Championship", "Worlds", 2026);
    const two = { ...worlds26, players: ["Faker", "Chovy"].map((p) => ({ mention: p, player: p, matchedAlias: p, realName: null, nativeName: null, otherCandidates: [], ambiguity: null })) };

    for (const q of ["classement worlds 2026", "Worlds 2026 ranking"])
      expect(routeQuestion(q, worlds26, SCHEMA, COVERAGE)).toMatchObject({ call: { tool: "tournament_standings", input: { full: true } } });
    expect(routeQuestion("comparaison des équipes LCK 2025", scope("LoL Champions Korea", "LCK", 2025), SCHEMA, COVERAGE)).not.toMatchObject({ call: { tool: "player_leaderboard" } });
    expect(routeQuestion("comparaison des mids Faker et Chovy aux Worlds 2026", two, SCHEMA, COVERAGE)).toMatchObject({ call: { tool: "player_comparison" } });
  });

  test.each([
    ["écart d'or à 15 min des junglers", scope(null, null), { role: "Jungle", metric: "gold_diff", minute: 15 }],
    ["gold diff at 15 of mid laners in LCK 2024", LCK24, { role: "Mid", metric: "gold_diff", minute: 15 }],
    ["quel top a le plus de solo kills en LEC 2025", LEC25, { role: "Top", metric: "solo_kills" }],
  ] as const)("in-game metric of a role, without a ranking word: %s", (q, e, input) => {
    expect(routeQuestion(q, e, SCHEMA, COVERAGE)).toMatchObject({ kind: "tool", call: { tool: "ingame_leaderboard", input: { subject: "player", ...input } } });
  });
});

/**
 * LEC 2025, four games (one without Riot data and of unknown length):
 * Caps (Mid, G2) plays Azir three times against Humanoid (Mid, Fnatic), once Orianna; Fnatic bans Ahri twice.
 */
function seed(db: DatabaseSync) {
  createSchema(db);
  createQuerySchema(db);
  LEAGUES.forEach((l, i) => db.prepare("INSERT INTO leagues VALUES(?,?,?,?,?)").run(i + 1, l.name, l.short, l.region, +l.international));
  const lec = Number(db.prepare("SELECT id FROM leagues WHERE name = 'LoL EMEA Championship'").get()!.id);

  db.prepare("INSERT INTO tournaments(id,page,event_page,stage,league_id,year) VALUES (1,'LEC25','LEC25','season',?,2025)").run(lec);
  db.exec(`
    INSERT INTO teams VALUES (1,'G2 Esports'),(2,'Fnatic');
    INSERT INTO players(id,page) VALUES (1,'Caps'),(2,'Humanoid'),(3,'BrokenBlade'),(4,'Oscarinin');
    INSERT INTO champions VALUES (1,'Azir','https://ddragon.leagueoflegends.com/cdn/16.22.1/img/champion/Azir.png'),
      (2,'Orianna','https://ddragon.leagueoflegends.com/cdn/16.22.1/img/champion/Orianna.png'),(3,'Ahri',NULL),(4,'Gnar',NULL),(5,'Wukong',NULL),
      (6,'Nunu & Willump',NULL),(7,'K''Sante',NULL),(8,'Bel''Veth',NULL);
    INSERT INTO games(id,tournament_id,blue_team_id,red_team_id,winner_side,length_s,played_at)
      VALUES (1,1,1,2,1,1800,100),(2,1,2,1,2,1500,200),(3,1,1,2,2,2400,300),(4,1,1,2,1,NULL,400);
    INSERT INTO game_riot VALUES (1,'K1','V5 data:K1',5,1,0),(2,'K2','V5 data:K2',5,1,0),(3,'K3','V5 data:K3',5,1,0);
    INSERT INTO game_player_stats(game_id,player_id,gold_diff_15) VALUES (1,1,300),(2,1,100),(3,1,-100),(1,2,-300),(2,2,-100),(3,2,100);
    INSERT INTO game_draft VALUES (1,2,1,1,3),(2,1,1,1,3),(1,1,0,1,1),(1,2,0,1,2);
    -- game_id, player_id, team_id, side, role, champion_id, win, kills, deaths, assists, gold, cs, damage, vision, keystone
    INSERT INTO game_players(game_id,player_id,team_id,side,role,champion_id,win,kills,deaths,assists,gold,cs,damage,vision,keystone_id) VALUES
      (1,1,1,1,'Mid',1,1,5,1,5,15000,300,30000,30,NULL),
      (1,2,2,2,'Mid',2,0,1,3,2,12000,270,18000,25,NULL),
      (1,3,1,1,'Top',4,1,3,0,2,13000,280,20000,20,NULL),
      (2,1,1,2,'Mid',1,1,4,2,6,14000,290,25000,30,NULL),
      (2,2,2,1,'Mid',2,0,2,2,1,11000,250,15000,20,NULL),
      (2,4,2,1,'Top',4,0,1,4,0,10000,230,12000,15,NULL),
      (3,1,1,1,'Mid',1,0,1,4,3,12000,320,20000,40,NULL),
      (3,2,2,2,'Mid',2,1,6,1,4,15000,330,26000,35,NULL),
      (4,1,1,1,'Mid',2,1,2,0,2,9000,200,NULL,NULL,NULL),
      (4,2,2,2,'Mid',1,0,0,2,1,8000,190,NULL,NULL,NULL);
  `);
}

async function run(db: DatabaseSync, call: Parameters<typeof bindTool>[1]) {
  const tool = bindTool(db, call);

  // Typed queries go through the same guard as generated ones.
  expect(guardQuery(db, readSchema(db), tool.sql).ok).toBe(true);

  return tool.format(db, db.prepare(tool.sql).all(tool.params));
}

describe("tools on a seeded season", () => {
  test("champion ranking: picks, bans, presence, winrate and KDA; a role keeps its own picks", async () => {
    const db = new DatabaseSync(":memory:");

    try {
      seed(db);
      const lec = { league: "LoL EMEA Championship" as const, yearFrom: 2025, yearTo: 2025, minPicks: null };
      const out = await run(db, { tool: "champion_ranking", input: { ...lec, sort: "picks", role: null } });

      expect(out.table!.columns).toEqual(["rank", "champion", "picks", "bans", "presence", "winrate", "kda"]);
      // Azir: 4 picks (3 Caps + 1 Humanoid), 2 wins, (10 kills + 15 assists) / 9 deaths; ties go to the name.
      expect(out.table!.rows.slice(0, 3)).toEqual([
        [1, "Azir", 4, 0, 100, 50, 2.78],
        [2, "Orianna", 4, 0, 100, 50, 3.33],
        [3, "Gnar", 2, 0, 50, 50, 1.5],
      ]);
      expect(out.icons).toEqual({ Azir: "https://ddragon.leagueoflegends.com/cdn/16.22.1/img/champion/Azir.png", Orianna: "https://ddragon.leagueoflegends.com/cdn/16.22.1/img/champion/Orianna.png" });
      expect(out.facts).toContain("Critère : nombre de picks.");

      const bans = await run(db, { tool: "champion_ranking", input: { ...lec, sort: "bans", role: null } });

      expect(bans.table!.rows[0]).toEqual([1, "Ahri", 0, 2, 50, null, null]);

      const tops = await run(db, { tool: "champion_ranking", input: { ...lec, sort: "picks", role: "Top" } });

      expect(tops.table!.rows).toEqual([[1, "Gnar", 2, 0, 50, 50, 1.5]]);
      expect(tops.facts).toContain("bans et présence tous rôles confondus");

      // Winrate needs a minimum of picks: 3 by default here (2 % of 4 games, at least 3).
      const winrate = await run(db, { tool: "champion_ranking", input: { ...lec, sort: "winrate", role: null } });

      expect(winrate.table!.rows.map((r) => r[1])).toEqual(["Azir", "Orianna"]);
      expect(winrate.facts).toContain("minimum 3 picks");

      // A per-game average needs 5 picks by default: nobody here has them.
      expect((await run(db, { tool: "champion_ranking", input: { ...lec, sort: "deaths", role: null } })).table!.rows).toEqual([]);

      // One more column for the average; Gnar (2 picks, 2 deaths a game) stays under the minimum asked.
      const deaths = await run(db, { tool: "champion_ranking", input: { ...lec, sort: "deaths", role: null, minPicks: 3 } });

      expect(deaths.table!.columns).toEqual(["rank", "champion", "deaths", "picks", "bans", "presence", "winrate", "kda"]);
      expect(deaths.table!.rows).toEqual([
        [1, "Azir", 2.25, 4, 0, 100, 50, 2.78],
        [2, "Orianna", 1.5, 4, 0, 100, 50, 3.33],
      ]);
      expect(deaths.facts).toContain("1. Azir (2,25 morts par partie, 4 picks");
      expect(deaths.facts).toContain("Critère : morts par partie, en moyenne, minimum 3 picks.");

      // Games without the figure are left out of the average, not counted as zero.
      const damage = await run(db, { tool: "champion_ranking", input: { ...lec, sort: "damage", role: null, minPicks: 1 } });

      expect(damage.table!.rows.slice(0, 2).map((r) => [r[1], r[2]])).toEqual([["Azir", 25000], ["Orianna", 19667]]);
    } finally {
      db.close();
    }
  });

  test("champion profile: averages with partial and missing figures, players and roles", async () => {
    const db = new DatabaseSync(":memory:");

    try {
      seed(db);
      const out = await run(db, { tool: "champion_event_stats", input: { champion: "Azir", league: "LoL EMEA Championship", yearFrom: 2025, yearTo: 2025 } });
      const p = out.champion!;

      expect(p).toMatchObject({ champion: "Azir", picks: 4, bans: 0, wins: 2, games: 4, kda: 2.78, roles: [{ role: "Mid", games: 4 }] });
      expect(p.players.map((x) => [x.player, x.games, x.wins, x.kda])).toEqual([["Caps", 3, 2, 3.43], ["Humanoid", 1, 0, 0.5]]);
      // Damage is missing on game 4: averaged over the three games that have it, and said so.
      expect(p.averages.find((a) => a.key === "damage")).toMatchObject({ value: 25000, counted: 3 });
      // Riot data on games 1 to 3 only.
      expect(p.averages.find((a) => a.key === "gold_diff_15")).toMatchObject({ value: 100, counted: 3, signed: true });
      expect(out.facts).toContain("dégâts sur 3");
      expect(out.totals).toMatchObject({ picks: 4, kda: 2.78, top_player: "Caps", main_role: "Mid", gold_diff_15: 100 });
    } finally {
      db.close();
    }
  });

  test("champion presence counts every game of the scope, editions without the champion included", async () => {
    const db = new DatabaseSync(":memory:");

    try {
      seed(db);
      const lec = Number(db.prepare("SELECT id FROM leagues WHERE name = 'LoL EMEA Championship'").get()!.id);

      // Playoffs of the same year and a 2024 season: two games each, Azir neither picked nor banned.
      db.prepare("INSERT INTO tournaments(id,page,event_page,stage,league_id,year) VALUES (2,'LEC25P','LEC25P','playoffs',?,2025),(3,'LEC24','LEC24','season',?,2024)").run(lec, lec);
      db.exec(`
        INSERT INTO games(id,tournament_id,blue_team_id,red_team_id,winner_side,length_s,played_at)
          VALUES (5,2,1,2,1,1800,500),(6,2,2,1,1,1800,600),(7,3,1,2,1,1800,50),(8,3,2,1,2,1800,60);
        INSERT INTO game_players(game_id,player_id,team_id,side,role,champion_id,win,kills,deaths,assists,gold,cs,damage,vision,keystone_id) VALUES
          (5,1,1,1,'Mid',2,1,1,1,1,10000,200,10000,10,NULL),(6,1,1,2,'Mid',2,0,1,1,1,10000,200,10000,10,NULL),
          (7,1,1,1,'Mid',2,1,1,1,1,10000,200,10000,10,NULL),(8,1,1,2,'Mid',2,1,1,1,1,10000,200,10000,10,NULL);
      `);

      const season = await run(db, { tool: "champion_event_stats", input: { champion: "Azir", league: "LoL EMEA Championship", yearFrom: 2025, yearTo: 2025 } });

      // 4 picks over the 6 games of 2025, not over the 4 of the only edition with Azir.
      expect(season.totals).toMatchObject({ picks: 4, games: 6, events: 1 });
      expect(season.facts).toContain("sur les 6 parties du périmètre (présence 67 %)");
      // The table keeps one row per edition with the champion, at the edition's own presence.
      expect(season.table!.rows).toEqual([[2025, "LEC25", 4, 4, 0, 100, "2-2", 50, "Caps ×3, Humanoid ×1"]]);

      // No period: the 2024 season widens the scope beyond Azir's years, and the sentence says so.
      const all = await run(db, { tool: "champion_event_stats", input: { champion: "Azir", league: "LoL EMEA Championship", yearFrom: null, yearTo: null } });

      expect(all.totals).toMatchObject({ games: 8 });
      expect(all.facts).toContain("sur les 8 parties du périmètre, 2024–2025 (présence 50 %)");
    } finally {
      db.close();
    }
  });

  test("player leaderboard: explicit criterion, minimum of games, n/d without Riot data", async () => {
    const db = new DatabaseSync(":memory:");

    try {
      seed(db);
      const input = { role: "Mid" as const, league: "LoL EMEA Championship" as const, yearFrom: 2025, yearTo: 2025, minGames: 2 };
      const out = await run(db, { tool: "player_leaderboard", input: { ...input, criterion: "kda" } });
      const col = (name: string) => out.table!.columns.indexOf(name);

      expect(out.table!.rows.map((r) => [r[col("Joueur")], r[col("Parties")], r[col("KDA")], r[col("% victoires")], r[col("Écart or @15")]])).toEqual([
        ["Caps", 4, 4, 75, 100],
        ["Humanoid", 4, 2.13, 25, -100],
      ]);
      // DPM over the games with both damage and length: Caps 75 000 damage in 5 700 s.
      expect(out.table!.rows[0][col("DPM")]).toBe(789);
      // Kill participation: Caps (12 kills + 16 assists) / G2's 15 kills (the seed's teams are incomplete, hence above 100 %).
      expect(out.table!.rows[0][col("KP %")]).toBe(186.7);
      expect(out.facts).toContain("selon le critère KDA ((kills + assists) / morts, sur toutes leurs parties), minimum 2 parties");
      expect(out.facts).toContain("Écart d'or à 15 min calculé sur les 6 parties avec données Riot seulement (sur 8)");

      // No champion in the season's standings and its games are the newest: in progress, said with the figures.
      expect(out.facts).toContain("LEC25 en cours : chiffres sur les 4 parties jouées jusqu'au");
      expect(out.totals.in_progress).toBe("yes");
      db.exec("INSERT INTO tournament_results VALUES (1, 1, '1', 1, NULL)");
      expect((await run(db, { tool: "player_leaderboard", input: { ...input, criterion: "kda" } })).totals.in_progress).toBe("no");

      // Top laners have a single game each: below the default minimum, so nobody until it is lowered.
      const tops = bindTool(db, { tool: "player_leaderboard", input: { ...input, role: "Top", minGames: null, criterion: "kda" } });

      expect(db.prepare(tops.sql).all(tops.params)).toEqual([]);
      expect(tops.relaxations(scope("LoL EMEA Championship", "LEC", 2025)).map((r) => r.key)).toEqual(["minGames", "period"]);
    } finally {
      db.close();
    }
  });

  test("champion names and aliases are recognized", async () => {
    const db = new DatabaseSync(":memory:");

    try {
      seed(db);

      for (const [mention, name] of [
        ["MonkeyKing", "Wukong"],
        ["monkey king", "Wukong"],
        ["Nunu", "Nunu & Willump"],
        ["nunu et willump", "Nunu & Willump"],
        ["K'Sante", "K'Sante"],
        ["ksante", "K'Sante"],
        ["Bel'Veth", "Bel'Veth"],
        ["belveth", "Bel'Veth"],
      ]) expect(resolveChampion(db, mention)?.champion).toBe(name);

      for (const [q, name] of [
        ["stats de K'Sante en LEC 2025", "K'Sante"],
        ["Bel'Veth en LEC", "Bel'Veth"],
        ["Nunu & Willump aux Worlds", "Nunu & Willump"],
        ["winrate of MonkeyKing in LEC", "Wukong"],
      ]) expect((await understandQuestion(db, q, new Date("2026-11-14")))?.result.champion?.champion).toBe(name);
    } finally {
      db.close();
    }
  });
});

describe("champion layout detection", () => {
  const icons = { Azir: "a.png", Orianna: "o.png" };

  test("a champion column and numeric columns: the ranking, with the bar on the hinted or decreasing column", () => {
    const table = { columns: ["rank", "champion", "picks", "bans"], rows: [[1, "Azir", 4, 1], [2, "Orianna", 3, 5]] };

    expect(detectChampionRanking(table, icons)).toMatchObject({ primary: 0, lines: [{ rank: 1, champion: "Azir", icon: "a.png", values: [4, 1] }, { rank: 2 }] });
    expect(detectChampionRanking(table, icons, "bans")?.primary).toBe(1);
  });

  test("a generated table without rank, a missing icon falls back to null", () => {
    const table = { columns: ["champion", "times_banned"], rows: [["Azir", 9], ["Orianna", 7], ["Hwei", 2]] };
    const ranking = detectChampionRanking(table, icons)!;

    expect(ranking.metrics[0]).toMatchObject({ label: "bans" });
    expect(ranking.lines.map((l) => [l.rank, l.icon])).toEqual([[1, "a.png"], [2, "o.png"], [3, null]]);
  });

  test("anything else stays a plain table", () => {
    // Another text column (a player), no champion column, or names that are not champions.
    expect(detectChampionRanking({ columns: ["champion", "player", "games"], rows: [["Azir", "Faker", 3]] }, icons)).toBeNull();
    expect(detectChampionRanking({ columns: ["player", "games"], rows: [["Faker", 3]] }, icons)).toBeNull();
    expect(detectChampionRanking({ columns: ["champion", "games"], rows: [["T1", 3], ["Gen.G", 2]] }, icons)).toBeNull();
  });
});
