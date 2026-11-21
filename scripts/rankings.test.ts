import { describe, expect, test } from "bun:test";
import { guardQuery } from "../src/lib/agent/guard";
import { withLocale } from "../src/lib/agent/messages";
import { championExtraSortOf, recentCountOf, recordMetricOf, routeQuestion, sideOf, teamCriterionOf, toolPlan } from "../src/lib/agent/query";
import { execute } from "../src/lib/agent/run";
import { detectMetric } from "../src/lib/agent/metrics";
import { bindTool, type ChampionRankingInput } from "../src/lib/agent/tools";
import type { Entities, LeagueName, ResolvedPlayer } from "../src/lib/agent/types";
import { understandQuestion } from "../src/lib/agent/understand";
import { detectChampionRanking } from "../src/lib/champions";
import { readSchema } from "../src/lib/db";
import { LEAGUES } from "../src/lib/domain/leagues";
import { testDb, type TestDb } from "./fixtures/test-db";

const SCHEMA = { v_games: ["game_id"] };
const COVERAGE = { league: () => ({ games: 100, ingame: 100 }), player: () => ({ games: 100, ingame: 100 }), team: () => ({ games: 100, ingame: 100 }) };

const scope = (league: LeagueName | null, leagueShort: string | null, year: number | null = null): Entities => ({
  players: [], teams: [], champion: null, unresolved: [], league, leagueShort, leagueMention: leagueShort, yearFrom: year, yearTo: year, split: null, outOfScope: null,
});

const player = (name: string): ResolvedPlayer => ({ mention: name, player: name, matchedAlias: name, realName: null, nativeName: null, otherCandidates: [], ambiguity: null });

const NONE = scope(null, null);
const LEC25 = scope("LoL EMEA Championship", "LEC", 2025);
const WORLDS = scope("World Championship", "Worlds");
const champion = (name: string) => ({ mention: name, champion: name });
const route = async (question: string, e: Entities) => routeQuestion(question, e, SCHEMA, COVERAGE);

describe("cues of the rankings", () => {
  test.each([
    ["meilleurs mids côté bleu", "blue"],
    ["best ADC on red side", "red"],
    ["winrate en rouge", "red"],
    ["côté bleu ou côté rouge", null],
    ["meilleurs mids", null],
  ])("side of %p", (question, side) => {
    expect<string | null>(sideOf(question)).toBe(side);
  });

  test.each([
    ["équipes avec le meilleur winrate", "winrate"],
    ["quelle équipe a les parties les plus courtes", "game_length"],
    ["quelle équipe joue le plus de champions différents", "champions"],
    ["équipe qui prend le plus de dragons", "dragons"],
    ["teams with the most barons", "barons"],
    ["équipes avec le plus de kills par partie", "kills"],
    ["meilleures équipes", null],
  ])("team criterion of %p", (question, criterion) => {
    expect<string | null>(teamCriterionOf(question)).toBe(criterion);
  });

  test.each([
    ["champions avec le plus de dégâts par minute", "dpm"],
    ["champions avec le meilleur écart d'or à 15 min", "gold_diff_15"],
    ["champions avec le plus de solo kills", "solo_kills"],
    ["champions joués par le plus de joueurs", "players"],
    // Another minute than 15, or the lowest figure: not a column of the ranking.
    ["champions avec le meilleur écart d'or à 10 min", null],
    ["champions avec le moins de dégâts par minute", null],
    ["champions les plus joués", null],
  ])("extra champion sort of %p", (question, sort) => {
    expect<string | null>(championExtraSortOf(question, detectMetric(question))).toBe(sort);
  });

  test.each([
    ["record de kills en une partie", "kills"],
    ["most damage in a single game", "damage"],
    ["meilleur écart d'or à 15 min sur une partie", "gold_diff_15"],
    // Two figures, or a minute the records do not hold.
    ["record de kills et d'assists", null],
    ["meilleur écart d'or à 10 min sur une partie", null],
  ])("record metric of %p", (question, metric) => {
    expect<string | null>(recordMetricOf(question, detectMetric(question))).toBe(metric);
  });

  test.each([
    ["5 dernières parties de Caps", 5],
    ["last 7 games of Chovy", 7],
    ["dernières 50 parties", 20],
    ["2 dernières parties", 3],
    ["forme récente de Faker", null],
  ])("count of %p", (question, count) => {
    expect(recentCountOf(question)).toBe(count);
  });
});

describe("routes of the rankings", () => {
  test("a side of the map filters the player, champion and in-game rankings", async () => {
    expect(await route("meilleurs mids côté bleu en LEC 2025", LEC25)).toMatchObject({ kind: "tool", confidence: 0.85, call: { tool: "player_leaderboard", input: { role: "Mid", side: "blue", criterion: "kda" } } });
    expect(await route("champions les plus joués côté rouge en LEC 2025", LEC25)).toMatchObject({ kind: "tool", confidence: 0.9, call: { tool: "champion_ranking", input: { sort: "picks", side: "red" } } });
    expect(await route("qui a le plus de solo kills côté bleu en LEC 2025", LEC25)).toMatchObject({ kind: "tool", confidence: 0.85, call: { tool: "ingame_leaderboard", input: { metric: "solo_kills", side: "blue" } } });
    expect(await route("meilleurs mids en LEC 2025", LEC25)).toMatchObject({ kind: "tool", call: { tool: "player_leaderboard", input: { side: null } } });
  });

  test("a share of the team's damage or gold is a criterion of the players, not a team ranking", async () => {
    expect(await route("joueurs avec la plus grosse part des dégâts de leur équipe en LEC 2025", LEC25)).toMatchObject({
      kind: "tool", confidence: 0.85, call: { tool: "player_leaderboard", input: { criterion: "dmg_share" } },
    });
    expect(await route("quel ADC a la plus grosse part de l'or en LEC 2025", LEC25)).toMatchObject({ kind: "tool", call: { tool: "player_leaderboard", input: { criterion: "gold_share", role: "Bot" } } });
    // Damage alone stays the per-minute figure.
    expect(await route("joueurs avec le plus de dégâts en LEC 2025", LEC25)).toMatchObject({ kind: "tool", call: { tool: "player_leaderboard", input: { criterion: "dpm" } } });
  });

  test("champions ranked on a figure of their picks", async () => {
    expect(await route("champions avec le meilleur écart d'or à 15 min en mid en LEC 2025", LEC25)).toMatchObject({
      kind: "tool", confidence: 0.9, call: { tool: "champion_ranking", input: { sort: "gold_diff_15", role: "Mid" } },
    });
    expect(await route("champions avec le plus de dégâts par minute en LEC 2025", LEC25)).toMatchObject({ kind: "tool", confidence: 0.9, call: { tool: "champion_ranking", input: { sort: "dpm" } } });
    // The ranking has no snapshot at 10 min: generated SQL.
    expect(await route("champions avec le meilleur écart d'or à 10 min en LEC 2025", LEC25)).toMatchObject({ kind: "sql" });
  });

  test("champions ranked on a total over the scope: end-of-game figures, multikills and lane counts of the Riot data", async () => {
    const ranked = async (q: string, input: Partial<ChampionRankingInput>, e = LEC25) =>
      expect(await route(q, e)).toMatchObject({ kind: "tool", confidence: 0.9, call: { tool: "champion_ranking", input } });

    await ranked("champion avec le plus de mort au worlds 2026", { sort: "deaths", total: true, minPicks: null, league: "World Championship" }, WORLDS);
    await ranked("Champions les plus morts — Worlds 2026", { sort: "deaths", total: true }, WORLDS);
    await ranked("champions avec le plus de kills en LEC 2025", { sort: "kills", total: true });
    await ranked("quel champion fait le plus de dégâts en LEC 2025", { sort: "damage", total: true });
    await ranked("quel champion a le plus de pentakills en LEC 2025", { sort: "penta_kills", total: true });
    await ranked("champions avec le plus de quadra kills en LEC 2025", { sort: "quadra_kills", total: true });
    await ranked("champions avec le plus de solo kills en LEC 2025", { sort: "solo_kills", total: true });
    await ranked("quels champions ont le plus de first bloods au total en LEC 2025", { sort: "first_blood", total: true });
    // A champion's games are its picks: "plus de 4 parties" is a minimum of 5, for a total as for an average.
    await ranked("champion avec le plus de morts au worlds 2026 avec plus de 4 parties", { sort: "deaths", total: true, minPicks: 5 }, WORLDS);
    await ranked("champion avec le plus de morts par game au worlds 2026 avec plus de 4 parties", { sort: "deaths", total: false, minPicks: 5 }, WORLDS);
    // A share, a figure per minute or per game keep their own sort.
    await ranked("champions avec le plus de first bloods en LEC 2025", { sort: "first_blood", total: false });
    await ranked("champions avec le plus de solo kills par partie en LEC 2025", { sort: "solo_kills", total: false });
    await ranked("champions avec le plus de dégâts par minute en LEC 2025", { sort: "dpm", total: false });
    // The lowest figure, two figures at once: generated SQL. A competition without Riot data has no multikill.
    expect(await route("champion avec le moins de morts en LEC 2025", LEC25)).toMatchObject({ kind: "sql" });
    expect(await route("champions avec le plus de kills et d'assists en LEC 2025", LEC25)).toMatchObject({ kind: "sql" });
    expect(await routeQuestion("quel champion a le plus de pentakills aux Worlds", WORLDS, SCHEMA, { ...COVERAGE, league: () => ({ games: 100, ingame: 0 }) })).toMatchObject({ kind: "missing", coverage: true });
  });

  // The ranking only goes from the highest down: the least played would be answered by the most played.
  test.each([
    ["champions les moins joués aux Worlds 2024", WORLDS],
    ["least played champions at Worlds 2024", WORLDS],
    ["champions les moins bannis en LEC 2025", LEC25],
    ["least banned champions", NONE],
    ["champions les moins joués en LEC Spring 2024", { ...scope("LoL EMEA Championship", "LEC", 2024), split: "Spring" } satisfies Entities],
  ])("a lowest champion ranking goes to generated SQL: %p", async (question, e) => {
    expect(await route(question, e)).toMatchObject({ kind: "sql" });
  });

  // "au moins 10 picks" is a minimum, not an order.
  test.each([
    ["champions les plus joués avec au moins 10 picks", 10],
    ["most played champions with at least 10 picks", 10],
  ])("a minimum keeps the champion ranking: %p", async (question, minPicks) => {
    expect(await route(question, WORLDS)).toMatchObject({ kind: "tool", call: { tool: "champion_ranking", input: { sort: "picks", minPicks } } });
  });

  test("teams ranked on a named criterion; the standings keep 'meilleures équipes'", async () => {
    expect(await route("équipes avec le meilleur winrate côté bleu en LEC 2025", LEC25)).toMatchObject({
      kind: "tool", confidence: 0.85, call: { tool: "team_leaderboard", input: { criterion: "winrate", order: "desc", side: "blue", league: "LoL EMEA Championship" } },
    });
    expect(await route("quelle équipe a les parties les plus courtes en LEC 2025", LEC25)).toMatchObject({ kind: "tool", confidence: 0.85, call: { tool: "team_leaderboard", input: { criterion: "game_length", order: "asc" } } });
    expect(await route("équipe avec le moins de morts par partie en LEC 2025", LEC25)).toMatchObject({ kind: "tool", call: { tool: "team_leaderboard", input: { criterion: "deaths", order: "asc" } } });
    expect(await route("équipes avec le meilleur winrate", NONE)).toMatchObject({ kind: "tool", call: { tool: "team_leaderboard", input: { league: "World Championship" } }, notes: ["Aucune compétition précisée : classement sur les Worlds."] });
    expect(await route("meilleures équipes en LEC 2025", LEC25)).toMatchObject({ kind: "tool", call: { tool: "tournament_standings" } });
    // An in-game metric keeps its own leaderboard.
    expect(await route("quelle équipe prend le plus souvent le premier dragon en LEC 2025", LEC25)).toMatchObject({ kind: "tool", call: { tool: "ingame_leaderboard", input: { subject: "team", metric: "first_dragon" } } });
  });

  test("dragons by element and souls: their breakdown; a ranking of teams keeps the in-game leaderboard", async () => {
    const t1 = { ...WORLDS, teams: [{ mention: "T1", team: "T1", members: ["T1"] }] };

    expect(await route("quelles âmes ont été prises aux Worlds", WORLDS)).toMatchObject({ kind: "tool", confidence: 0.85, call: { tool: "dragon_stats", input: { team: null, league: "World Championship" } } });
    expect(await route("taux de victoire avec l'âme infernale en LEC 2025", LEC25)).toMatchObject({ kind: "tool", call: { tool: "dragon_stats", input: { team: null, yearFrom: 2025, yearTo: 2025 } } });
    expect(await route("types de dragons pris par T1 aux Worlds", t1)).toMatchObject({ kind: "tool", call: { tool: "dragon_stats", input: { team: "T1" } } });
    expect(await route("combien de dragons ancestraux pour T1 aux Worlds", t1)).toMatchObject({ kind: "tool", call: { tool: "dragon_stats", input: { team: "T1" } } });
    expect(await route("dragon soul win rate at Worlds", WORLDS)).toMatchObject({ kind: "tool", call: { tool: "dragon_stats" } });
    // Teams ranked on the soul or the elder dragons: the leaderboard; on one element, no typed tool.
    expect(await route("quelle équipe prend le plus souvent l'âme du dragon en LEC 2025", LEC25)).toMatchObject({ kind: "tool", call: { tool: "ingame_leaderboard", input: { subject: "team", metric: "dragon_soul" } } });
    expect(await route("équipes avec le plus de dragons ancestraux en LEC 2025", LEC25)).toMatchObject({ kind: "tool", call: { tool: "ingame_leaderboard", input: { subject: "team", metric: "elder_dragons" } } });
    expect(await route("quelle équipe a pris le plus d'âmes infernales en LEC 2025", LEC25)).toMatchObject({ kind: "sql" });
    // The dragon count of the scoreboards stays a criterion of the team ranking, and the first dragon its own metric.
    expect(await route("équipes avec le plus de dragons par partie en LEC 2025", LEC25)).toMatchObject({ kind: "tool", call: { tool: "team_leaderboard", input: { criterion: "dragons" } } });
    // A competition without Riot data has no soul to read.
    expect(await routeQuestion("quelles âmes ont été prises aux Worlds", WORLDS, SCHEMA, { ...COVERAGE, league: () => ({ games: 100, ingame: 0 }) })).toMatchObject({ kind: "missing", coverage: true });
    expect(await route("âmes du dragon de Faker", { ...NONE, players: [player("Faker")] })).toMatchObject({ kind: "sql" });
  });

  test("champion matchups: two champions set against each other, or one and a matchup word", async () => {
    const azir = { ...NONE, champion: champion("Azir") };
    const duel = { ...azir, opponentChampion: champion("Orianna") };

    expect(await route("Azir contre Orianna", duel)).toMatchObject({
      kind: "tool", confidence: 0.9, call: { tool: "champion_matchup", input: { champion: "Azir", opponent: "Orianna", role: null, league: null } },
      notes: ["Aucune compétition précisée : toutes compétitions confondues."],
    });
    expect(await route("winrate d'Azir face à Orianna en mid en LEC 2025", { ...LEC25, champion: champion("Azir"), opponentChampion: champion("Orianna") })).toMatchObject({
      kind: "tool", confidence: 0.9, call: { tool: "champion_matchup", input: { opponent: "Orianna", role: "Mid", league: "LoL EMEA Championship", yearFrom: 2025 } }, notes: [],
    });
    expect(await route("matchups d'Azir", azir)).toMatchObject({ kind: "tool", confidence: 0.9, call: { tool: "champion_matchup", input: { champion: "Azir", opponent: null } } });
    expect(await route("counters d'Azir en mid", azir)).toMatchObject({ kind: "tool", call: { tool: "champion_matchup", input: { opponent: null, role: "Mid" } } });
    // Without an opposing word, the first champion's profile, as before.
    expect(await route("stats d'Azir et Orianna", duel)).toMatchObject({ kind: "tool", call: { tool: "champion_event_stats", input: { champion: "Azir" } } });
    expect(await route("stats d'Azir aux Worlds", { ...WORLDS, champion: champion("Azir") })).toMatchObject({ kind: "tool", call: { tool: "champion_event_stats" } });
  });

  test("single-game records, of everyone or of one player", async () => {
    expect(await route("record de kills en une partie aux Worlds", WORLDS)).toMatchObject({
      kind: "tool", confidence: 0.9, call: { tool: "game_records", input: { metric: "kills", player: null, league: "World Championship" } }, notes: [],
    });
    expect(await route("most damage in a single game", NONE)).toMatchObject({ kind: "tool", call: { tool: "game_records", input: { metric: "damage", league: null } } });
    expect(await route("record de kills des mids en une partie aux Worlds", WORLDS)).toMatchObject({ kind: "tool", call: { tool: "game_records", input: { metric: "kills", role: "Mid" } } });
    // A per-minute figure is not one the records hold, and a competition without Riot data has no lane record.
    expect(await route("record de dégâts par minute en une partie aux Worlds", WORLDS)).toMatchObject({ kind: "sql" });

    for (const figure of ["DPM", "GPM", "CSPM"]) expect(await route(`record de ${figure} en une partie aux Worlds`, WORLDS)).toMatchObject({ kind: "sql" });
    expect(await routeQuestion("record de solo kills en une partie aux Worlds", WORLDS, SCHEMA, { ...COVERAGE, league: () => ({ games: 100, ingame: 0 }) })).toMatchObject({ kind: "missing", coverage: true });
    expect(await routeQuestion("champions avec le meilleur écart d'or à 15 min aux Worlds", WORLDS, SCHEMA, { ...COVERAGE, league: () => ({ games: 100, ingame: 0 }) })).toMatchObject({ kind: "missing", coverage: true });
    expect(await route("meilleure game de Faker en kills", { ...NONE, players: [player("Faker")] })).toMatchObject({ kind: "tool", confidence: 0.9, call: { tool: "game_records", input: { metric: "kills", player: "Faker", role: null } } });
    // A total over the scope stays the player ranking, and a team's "record" is its results.
    expect(await route("qui a le plus de kills aux Worlds", WORLDS)).toMatchObject({ kind: "tool", call: { tool: "player_leaderboard", input: { criterion: "kills" } } });
    expect(await route("record de T1", { ...NONE, teams: [{ mention: "T1", team: "T1", members: ["T1"] }] })).toMatchObject({ kind: "tool", call: { tool: "team_history" } });
  });

  test("a player's latest games", async () => {
    const faker = { ...NONE, players: [player("Faker")] };

    expect(await route("forme récente de Faker", faker)).toMatchObject({ kind: "tool", confidence: 0.9, call: { tool: "player_recent_games", input: { player: "Faker", league: null, count: null } } });
    expect(await route("5 dernières parties de Faker en LEC", { ...scope("LoL EMEA Championship", "LEC"), players: [player("Faker")] })).toMatchObject({
      kind: "tool", confidence: 0.9, call: { tool: "player_recent_games", input: { count: 5, league: "LoL EMEA Championship" } },
    });
    expect(await route("last 5 games of Faker", faker)).toMatchObject({ kind: "tool", call: { tool: "player_recent_games", input: { count: 5 } } });
    // Their results at an event stay the history.
    expect(await route("résultats de Faker aux Worlds", { ...WORLDS, players: [player("Faker")] })).toMatchObject({ kind: "tool", call: { tool: "player_event_history" } });
  });
});

/**
 * Three LEC 2025 games between G2 (Caps mid, BrokenBlade top) and Fnatic (Humanoid mid, Oscarinin top):
 * G2 wins game 1 on blue and game 2 on red, Fnatic wins game 3 on red. Every game has Riot data.
 */
async function seed(db: TestDb) {
  for (const [i, l] of LEAGUES.entries()) await db.run("INSERT INTO leagues VALUES(?,?,?,?,?)", i + 1, l.name, l.short, l.region, +l.international);
  const lec = Number((await db.query("SELECT id FROM leagues WHERE name = 'LoL EMEA Championship'"))[0]!.id);

  await db.run("INSERT INTO tournaments(id,page,event_page,stage,league_id,year) VALUES (1,'LEC25','LEC25','season',?,2025)", lec);
  await db.exec(`
    INSERT INTO teams(id,name) VALUES (1,'G2 Esports'),(2,'Fnatic');
    INSERT INTO players(id,page) VALUES (1,'Caps'),(2,'Humanoid'),(3,'BrokenBlade'),(4,'Oscarinin');
    INSERT INTO champions VALUES (1,'Azir','https://ddragon/Azir.png'),(2,'Orianna','https://ddragon/Orianna.png'),(3,'Gnar','https://ddragon/Gnar.png'),(4,'Jax',NULL),(5,'Locke',NULL);
    INSERT INTO games(id,tournament_id,tab,blue_team_id,red_team_id,winner_side,length_s,played_at,blue_dragons,red_dragons,blue_barons,red_barons,blue_towers,red_towers)
      VALUES (1,1,'Week 1',1,2,1,1800,1735776000,3,1,1,0,9,2),(2,1,'Week 1',2,1,2,1500,1735862400,1,2,0,1,3,8),(3,1,'Week 2',1,2,2,2400,1736380800,1,4,0,2,4,11);
    INSERT INTO game_riot VALUES (1,'K1','V5 data:K1',5,1,0),(2,'K2','V5 data:K2',5,1,0),(3,'K3','V5 data:K3',5,1,0);
    INSERT INTO game_player_stats(game_id,player_id,gold_diff_15,solo_kills,first_blood_kill)
      VALUES (1,1,300,2,1),(2,1,100,0,0),(3,1,-100,0,0),(1,2,-300,0,0),(2,2,-100,0,0),(3,2,100,1,1);
    INSERT INTO game_team_stats(game_id,side,first_dragon,first_herald,first_baron,gold_diff_15) VALUES (1,1,1,1,1,1000),(1,2,0,0,0,-1000);
    -- game_id, player_id, team_id, side, role, champion_id, win, kills, deaths, assists, gold, cs, damage, vision, keystone
    INSERT INTO game_players(game_id,player_id,team_id,side,role,champion_id,win,kills,deaths,assists,gold,cs,damage,vision,keystone_id) VALUES
      (1,1,1,1,'Mid',1,1,5,1,5,15000,300,30000,30,NULL),
      (1,3,1,1,'Top',3,1,3,0,2,13000,280,20000,20,NULL),
      (1,2,2,2,'Mid',2,0,1,3,2,12000,270,18000,25,NULL),
      (1,4,2,2,'Top',4,0,0,5,1,9000,240,12000,15,NULL),
      (2,1,1,2,'Mid',1,1,4,2,6,14000,290,25000,30,NULL),
      (2,3,1,2,'Top',3,1,2,1,3,12000,250,15000,20,NULL),
      (2,2,2,1,'Mid',2,0,2,2,1,11000,250,15000,20,NULL),
      (2,4,2,1,'Top',4,0,1,4,0,10000,230,12000,15,NULL),
      (3,1,1,1,'Mid',1,0,1,4,3,12000,320,20000,40,NULL),
      (3,3,1,1,'Top',4,0,0,3,1,9000,200,10000,10,NULL),
      (3,2,2,2,'Mid',2,1,6,1,4,15000,330,26000,35,NULL),
      (3,4,2,2,'Top',3,1,3,0,5,12000,300,14000,20,NULL);
  `);
}

async function run(db: TestDb, call: Parameters<typeof bindTool>[1]) {
  const tool = await bindTool(db, call);

  // Typed queries go through the same guard as generated ones.
  expect(guardQuery(await readSchema(db), tool.sql).ok).toBe(true);

  return tool.format(db, (await db.query(tool.sql, tool.params)));
}

async function seeded<T>(body: (db: TestDb) => Promise<T>): Promise<T> {
  const db = await testDb();

  try {
    await seed(db);

    return await body(db);
  } finally {
    await db.close();
  }
}

const LEC = { league: "LoL EMEA Championship" as const, yearFrom: 2025, yearTo: 2025 };
const LCKCL = { league: "LCK Challengers League" as const, yearFrom: 2025, yearTo: 2025 };

/**
 * One LCK CL 2025 game where Leaguepedia writes the blue team "Dplus KIA Challengers" on the game and
 * "Dplus Kia Challengers" on its player lines (two rows of teams), against KT Rolster Challengers on red.
 */
async function seededCaseDrift<T>(body: (db: TestDb) => Promise<T>): Promise<T> {
  const db = await testDb();

  try {
    for (const [i, l] of LEAGUES.entries()) await db.run("INSERT INTO leagues VALUES(?,?,?,?,?)", i + 1, l.name, l.short, l.region, +l.international);
    const cl = Number((await db.query("SELECT id FROM leagues WHERE name = 'LCK Challengers League'"))[0]!.id);

    const lines = Array.from({ length: 10 }, (_, i) => {
      const blue = i < 5;

      return `(1,${i + 1},${blue ? 3 : 2},${blue ? 1 : 2},'Mid',${i + 1},${blue ? 1 : 0},${blue ? 4 - i : 1},1,1,10000,200,10000,10,NULL)`;
    });

    await db.run("INSERT INTO tournaments(id,page,event_page,stage,league_id,year) VALUES (1,'CL25','CL25','season',?,2025)", cl);
    await db.exec(`
      INSERT INTO teams(id,name) VALUES (1,'Dplus KIA Challengers'),(2,'KT Rolster Challengers'),(3,'Dplus Kia Challengers');
      INSERT INTO players(id,page) VALUES ${Array.from({ length: 10 }, (_, i) => `(${i + 1},'${i ? `P${i + 1}` : "Rahel"}')`).join(",")};
      INSERT INTO champions(id,name) VALUES ${Array.from({ length: 10 }, (_, i) => `(${i + 1},'C${i + 1}')`).join(",")};
      INSERT INTO games(id,tournament_id,tab,blue_team_id,red_team_id,winner_side,length_s,played_at) VALUES (1,1,'Week 1',1,2,1,1800,1735776000);
      INSERT INTO game_players(game_id,player_id,team_id,side,role,champion_id,win,kills,deaths,assists,gold,cs,damage,vision,keystone_id) VALUES ${lines.join(",")};
    `);

    return await body(db);
  } finally {
    await db.close();
  }
}

describe("rankings on a seeded season", () => {
  test("champion ranking: per-minute figures, lane figures of the Riot data, players, and one side of the map", () =>
    seeded(async (db) => {
      const input = { ...LEC, role: null, side: null, minPicks: null };
      const out = await run(db, { tool: "champion_ranking", input: { total: false, ...input, sort: "picks" } });
      const cell = (row: number, column: string) => out.table!.rows[row][out.table!.columns.indexOf(column)];

      expect(out.table!.columns).toEqual(["rank", "champion", "picks", "bans", "presence", "winrate", "kda", "dpm", "gpm", "cspm", "gold_diff_15", "cs_diff_15", "xp_diff_15", "first_blood", "solo_kills", "players"]);
      // Azir, Caps' three games: 75 000 damage, 41 000 gold and 910 CS in 95 min; +300, +100 and −100 gold at 15 min; one first blood.
      expect(out.table!.rows[0].slice(0, 7)).toEqual([1, "Azir", 3, 0, 100, 66.7, 3.43]);
      expect(["dpm", "gpm", "cspm", "gold_diff_15", "cs_diff_15", "first_blood", "solo_kills", "players"].map((c) => cell(0, c))).toEqual([789, 432, 9.58, 100, null, 33.3, 0.67, 1]);
      // Gnar was played by both top laners; no lane figure in the Riot data seeded for them.
      expect([cell(1, "champion"), cell(1, "players"), cell(1, "gold_diff_15")]).toEqual(["Gnar", 2, null]);
      expect(out.sources.some((s) => s.label.includes("données Riot"))).toBe(true);

      // The champion layout reads every column, the ranking one from the tool's sort.
      const lead = await run(db, { tool: "champion_ranking", input: { total: false, ...input, sort: "gold_diff_15", minPicks: 3 } });

      expect(lead.table!.rows.map((r) => r[1])).toEqual(["Azir", "Orianna"]);
      expect(lead.facts).toContain("1. Azir (+100 d'or à 15 min, 3 picks");
      expect(lead.facts).toContain("Critère : écart d'or moyen à 15 min face à l'adversaire direct, sur les parties avec données Riot, minimum 3 picks.");
      const layout = detectChampionRanking(lead.table!, lead.icons!, "gold_diff_15")!;

      expect(layout.metrics[layout.primary]).toEqual({ key: "gold_diff_15", label: "écart or @15", percent: false });
      expect(layout.metrics.find((m) => m.key === "first_blood")).toEqual({ key: "first_blood", label: "first blood", percent: true });
      // A column without any figure (the CS and XP differences here) is left out of the layout.
      expect(layout.metrics.map((m) => m.key)).not.toContain("cs_diff_15");

      // Blue side: Azir's games 1 and 3, one win; presence counts the blue picks and bans only.
      const blue = await run(db, { tool: "champion_ranking", input: { total: false, ...input, sort: "picks", side: "blue" } });

      expect(blue.table!.rows[0].slice(0, 7)).toEqual([1, "Azir", 2, 0, 66.7, 50, 2.8]);
      expect(blue.title).toBe("Champions les plus joués côté bleu — LEC 2025");
      expect(blue.facts).toContain("Picks, bans et présence côté bleu seulement, sur les 3 parties.");
    }));

  test("champion ranking on a total: no minimum of picks, multikills of the Riot data, a true zero and an absent figure", () =>
    seeded(async (db) => {
      const input = { ...LEC, role: null, side: null, minPicks: null, total: true };
      const deaths = await run(db, { tool: "champion_ranking", input: { ...input, sort: "deaths" } });

      // Jax: 5 + 4 (Oscarinin) + 3 (BrokenBlade) deaths; Gnar, 2 picks, is ranked without a minimum.
      expect(deaths.table!.columns.slice(0, 4)).toEqual(["rank", "champion", "total_deaths", "picks"]);
      expect(deaths.table!.rows.map((r) => r.slice(1, 4))).toEqual([["Jax", 12, 3], ["Azir", 7, 3], ["Orianna", 6, 3], ["Gnar", 1, 3]]);
      expect(deaths.title).toBe("Champions avec le plus de morts — LEC 2025");
      expect(deaths.facts).toContain("(3 parties) : 1. Jax (12 morts, 3 picks");
      expect(deaths.facts).toContain("Critère : morts au total sur le périmètre.");
      const layout = detectChampionRanking(deaths.table!, { ...deaths.icons, Jax: "jax.png" }, "total_deaths")!;

      expect(layout.metrics[layout.primary]).toEqual({ key: "total_deaths", label: "morts (total)", percent: false });

      // A minimum the question sets still applies to a total.
      const min = await run(db, { tool: "champion_ranking", input: { ...input, sort: "deaths", minPicks: 3 } });

      expect(min.facts).toContain("minimum 3 picks");

      await db.exec("UPDATE game_player_stats SET penta_kills = 0, quadra_kills = CASE WHEN game_id = 1 AND player_id = 1 THEN 1 ELSE 0 END");
      const quadras = await run(db, { tool: "champion_ranking", input: { ...input, sort: "quadra_kills" } });

      // Champions without one are left out of a total ranking.
      expect(quadras.table!.rows.map((r) => r.slice(1, 3))).toEqual([["Azir", 1]]);
      expect(quadras.facts).toContain("(3 parties avec données Riot) : 1. Azir (1 quadrakill, 3 picks");
      expect(quadras.sources.some((s) => s.label.includes("données Riot"))).toBe(true);

      // No pentakill in games that have Riot data: a true zero, said as such, without an empty table.
      const pentas = await run(db, { tool: "champion_ranking", input: { ...input, sort: "penta_kills" } });

      expect(pentas.table).toBeUndefined();
      expect(pentas.facts).toStartWith("Aucun pentakill en LEC en 2025 : 0 au total sur les 3 parties avec données Riot.");
      expect(pentas.totals).toMatchObject({ rows: 0, games: 3, ingame_games: 3, leader: "" });
      expect(pentas.followUps).toEqual(["Champions avec le plus de quadrakills en LEC 2025", "Champions les plus joués en LEC 2025"]);

      // No Riot data at all in the scope (the LPL): the figure is absent, not zero, and the scope is not widened.
      await db.exec("DELETE FROM game_player_stats");
      const absent = await run(db, { tool: "champion_ranking", input: { ...input, sort: "penta_kills" } });

      expect(absent.table).toBeUndefined();
      expect(absent.facts).toStartWith("Aucune partie en LEC en 2025 n'a de données Riot sur Leaguepedia (3 parties)");
      expect(absent.totals).toMatchObject({ rows: 0, ingame_games: 0 });
    }));

  test("player leaderboard: share of the team's damage and gold, and one side of the map", () =>
    seeded(async (db) => {
      const input = { ...LEC, role: null, minGames: 2, side: null };
      const out = await run(db, { tool: "player_leaderboard", input: { ...input, criterion: "dmg_share" } });
      const col = (name: string) => out.table!.columns.indexOf(name);

      // Caps: 75 000 of G2's 120 000 damage, 41 000 of its 75 000 gold.
      expect(out.table!.rows[0].slice(0, 2)).toEqual([1, "Caps"]);
      expect([out.table!.rows[0][col("DMG %")], out.table!.rows[0][col("or %")]]).toEqual([62.5, 54.7]);
      expect(out.facts).toContain("selon le critère DMG % (part des dégâts aux champions de son équipe)");
      expect(out.facts).toContain("1. Caps (G2 Esports) : 62,5 %, 3 parties");

      // Blue side only: Caps' games 1 and 3, (5 + 5 + 1 + 3) / (1 + 4).
      const blue = await run(db, { tool: "player_leaderboard", input: { ...input, criterion: "kda", role: "Mid", side: "blue" } });

      expect(blue.table!.rows.map((r) => [r[1], r[3], r[blue.table!.columns.indexOf("KDA")]])).toEqual([["Caps", 2, 2.8]]);
      expect(blue.title).toBe("Meilleurs mids côté bleu — KDA (LEC 2025)");
    }));

  test("in-game leaderboard on one side of the map", () =>
    seeded(async (db) => {
      const out = await run(db, { tool: "ingame_leaderboard", input: { ...LEC, subject: "player", metric: "solo_kills", minute: null, role: null, minGames: null, side: "red" } });

      // Humanoid's solo kill came on red side; Caps' two on blue.
      expect(out.table!.rows.map((r) => [r[1], r[4]])).toEqual([["Humanoid", 1]]);
      expect(out.title).toBe("Classement — solo kills côté rouge (LEC 2025)");
    }));

  test("an in-game ranking keeps the identity of players sharing a handle", () =>
    seeded(async (db) => {
      await db.exec("UPDATE players SET page = CASE id WHEN 1 THEN 'Echo (Kim)' ELSE 'Echo (Lee)' END WHERE id IN (1, 2)");
      const out = await run(db, { tool: "ingame_leaderboard", input: { ...LEC, subject: "player", metric: "solo_kills", minute: null, role: null, minGames: null, side: null } });

      expect(out.table!.rows.map((r) => r[1])).toEqual(["Echo (Kim)", "Echo (Lee)"]);
      expect(out.totals.leader).toBe("Echo (Kim)");
      expect(out.facts).toContain("2. Echo (Lee)");
    }));

  test("dragons and souls: kills by element, souls and the wins of the teams that got them, for every team or one", () =>
    seeded(async (db) => {
      // Game 1: G2 (blue, winner) takes four dragons and the mountain soul. Game 2: no soul. Game 3: Fnatic (red, winner) the chemtech soul, G2 the elder.
      await db.exec(`
        UPDATE game_team_stats SET elder_dragons = 0, dragon_soul = (side = 1)::integer, soul = CASE side WHEN 1 THEN 'mountain' END WHERE game_id = 1;
        INSERT INTO game_team_stats(game_id,side,elder_dragons,dragon_soul,soul) VALUES (2,1,0,0,NULL),(2,2,0,0,NULL),(3,1,1,0,NULL),(3,2,0,1,'chemtech');
        -- game_id, seq, team_seq, side, kind, time_s
        INSERT INTO game_dragons VALUES
          (1,1,1,1,'infernal',400),(1,2,1,2,'cloud',700),(1,3,2,1,'ocean',1000),(1,4,3,1,'mountain',1300),(1,5,4,1,'mountain',1600),
          (2,1,1,2,'hextech',400),(2,2,1,1,'infernal',700),(2,3,2,2,'hextech',1000),
          (3,1,1,2,'ocean',400),(3,2,2,2,'ocean',700),(3,3,3,2,'chemtech',1000),(3,4,4,2,'chemtech',1300),(3,5,1,1,'elder',2000);
      `);
      const all = await run(db, { tool: "dragon_stats", input: { ...LEC, team: null } });

      expect(all.table!.columns).toEqual(["Dragon", "Pris", "Part %", "Âmes", "Victoires avec l'âme", "% victoire avec l'âme"]);
      // Most killed first, the elder last; a soul only for the elements.
      expect(all.table!.rows).toEqual([
        ["Océan", 3, 23.1, 0, 0, null],
        ["Chemtech", 2, 15.4, 1, 1, 100],
        ["Hextech", 2, 15.4, 0, 0, null],
        ["Infernal", 2, 15.4, 0, 0, null],
        ["Montagne", 2, 15.4, 1, 1, 100],
        ["Nuage", 1, 7.7, 0, 0, null],
        ["Ancestral", 1, 7.7, null, null, null],
      ]);
      expect(all.totals).toMatchObject({ dragons: 13, elder_dragons: 1, top_dragon: "océan", top_dragon_count: 3, soul_games: 3, souls: 2, soul_wins: 2, top_soul_count: 1 });
      expect(all.facts).toContain("L'âme du dragon est prise dans 2 parties sur 3 (67 %) ; l'équipe qui la prend gagne 2 sur 2 (100 %). Âmes : chemtech 1, montagne 1.");
      expect(all.title).toBe("Dragons et âmes (LEC 2025)");

      // One team: its own dragons and souls, over its games.
      const g2 = await run(db, { tool: "dragon_stats", input: { ...LEC, team: "G2 Esports" } });

      expect(g2.table!.rows.map((r) => [r[0], r[1], r[3]])).toEqual([["Hextech", 2, 0], ["Montagne", 2, 1], ["Infernal", 1, 0], ["Océan", 1, 0], ["Ancestral", 1, null]]);
      expect(g2.totals).toMatchObject({ dragons: 7, elder_dragons: 1, soul_games: 3, souls: 1, soul_wins: 1, top_soul: "montagne" });
      expect(g2.facts).toContain("G2 Esports prend l'âme du dragon dans 1 de ses 3 parties (33 %) et en gagne 1 sur 1 (100 %).");

      // The leaderboard ranks the soul rate over the games where it is known, and counts the elder dragons.
      const rate = await run(db, { tool: "ingame_leaderboard", input: { ...LEC, subject: "team", metric: "dragon_soul", minute: null, role: null, minGames: 1, side: null } });

      expect(rate.table!.rows.map((r) => [r[1], r[2], r[3], r[4]])).toEqual([["Fnatic", 3, 1, 33.3], ["G2 Esports", 3, 1, 33.3]]);
      // A game where the soul is unknown (no timeline, or before patch 9.23) is not in the rate nor in its games.
      await db.exec("UPDATE game_team_stats SET dragon_soul = NULL, soul = NULL WHERE game_id = 2");
      const known = await run(db, { tool: "ingame_leaderboard", input: { ...LEC, subject: "team", metric: "dragon_soul", minute: null, role: null, minGames: 1, side: null } });

      expect(known.table!.rows.map((r) => [r[1], r[2], r[3], r[4]])).toEqual([["Fnatic", 2, 1, 50], ["G2 Esports", 2, 1, 50]]);
      const elders = await run(db, { tool: "ingame_leaderboard", input: { ...LEC, subject: "team", metric: "elder_dragons", minute: null, role: null, minGames: null, side: null } });

      expect(elders.table!.rows.map((r) => [r[1], r[3]])).toEqual([["G2 Esports", 1]]);
    }));

  test("team leaderboard: every criterion as a column, lowest first on request, one side of the map", () =>
    seeded(async (db) => {
      const input = { ...LEC, order: "desc" as const, side: null, minGames: 3 };
      const out = await run(db, { tool: "team_leaderboard", input: { ...input, criterion: "winrate" } });
      const row = (n: number) => Object.fromEntries(out.table!.columns.map((c, i) => [c, out.table!.rows[n][i]]));

      expect(out.table!.columns.slice(0, 4)).toEqual(["Rang", "Équipe", "Parties", "% victoires"]);
      // G2: two wins in three, one of its two blue games, its red game; 15 kills and 11 deaths; Azir, Gnar and Jax.
      expect(row(0)).toMatchObject({
        Équipe: "G2 Esports", Parties: 3, "% victoires": 66.7, "% côté bleu": 50, "% côté rouge": 100, KDA: 3.18, "kills / partie": 5, "morts / partie": 3.7,
        "durée (min)": 31.7, champions: 3, "dragons / partie": 2, "barons / partie": 0.67, "tours / partie": 7, "grubs / partie": null, "1er dragon %": 100, "écart or @15": 1000,
      });
      expect(row(1)).toMatchObject({ Équipe: "Fnatic", "% victoires": 33.3, "1er dragon %": 0 });
      expect(out.facts).toContain("Équipes classées en LEC en 2025 selon le critère % victoires (victoires / parties), minimum 3 parties : 1. G2 Esports : 66,7 %, 3 parties ; 2. Fnatic : 33,3 %, 3 parties.");
      expect(out.totals).toMatchObject({ leader: "G2 Esports", leader_value: 66.7, rows: 2, criterion: "winrate" });

      const deaths = await run(db, { tool: "team_leaderboard", input: { ...input, criterion: "deaths", order: "asc" } });

      expect(deaths.table!.rows.map((r) => [r[1], r[3]])).toEqual([["G2 Esports", 3.7], ["Fnatic", 5]]);
      expect(deaths.facts).toContain("du plus bas au plus haut");

      // Red side: Fnatic's games 1 and 3 (one win), G2's game 2. A side's own win rate is not a column then.
      const red = await run(db, { tool: "team_leaderboard", input: { ...input, criterion: "winrate", side: "red", minGames: 1 } });

      expect(red.table!.rows.map((r) => [r[1], r[2], r[3]])).toEqual([["G2 Esports", 1, 100], ["Fnatic", 2, 50]]);
      expect(red.table!.columns).not.toContain("% côté bleu");
      expect(red.title).toBe("Classement des équipes — % victoires côté rouge (LEC 2025)");

      // The default minimum of a league season (10 games) leaves nobody: the first correction lowers it.
      const strict = await bindTool(db, { tool: "team_leaderboard", input: { ...input, criterion: "winrate", minGames: null } });

      expect((await db.query(strict.sql, strict.params))).toEqual([]);
      expect(strict.relaxations(LEC25)[0]).toMatchObject({ key: "minGames" });
    }));

  test("champion matchup against one champion: the games, both KDAs and the gold difference at 15", () =>
    seeded(async (db) => {
      const out = await run(db, { tool: "champion_matchup", input: { ...LEC, champion: "Azir", opponent: "Orianna", role: null } });

      expect(out.title).toBe("Azir contre Orianna — LEC 2025");
      expect(out.totals).toMatchObject({ games: 3, wins: 2, losses: 1, winrate: 67, kda: 3.43, opponent_kda: 2.67, gold_diff_15: 100, ingame_games: 3 });
      expect(out.facts).toContain("Azir contre Orianna en LEC en 2025 (même rôle, équipes opposées) : 3 parties, Azir en gagne 2 (67 %) et Orianna 1.");
      expect(out.facts).toContain("KDA d'Azir : 3,43, d'Orianna : 2,67. Écart d'or moyen d'Azir à 15 min : +100, sur 3 parties avec données Riot.");
      // Newest first: game 3, won by Orianna.
      expect(out.table!.rows[0]).toEqual(["9 janv. 2025", "LEC 2025", "Mid", "Caps (G2 Esports)", "1/4/3", "Humanoid (Fnatic)", "6/1/4", "Orianna", -100]);
      expect(out.icons).toEqual({ Azir: "https://ddragon/Azir.png", Orianna: "https://ddragon/Orianna.png" });

      // The other way round, the same games.
      const back = await run(db, { tool: "champion_matchup", input: { ...LEC, champion: "Orianna", opponent: "Azir", role: "Mid" } });

      expect(back.totals).toMatchObject({ games: 3, wins: 1, gold_diff_15: -100 });

      // Never in the same role: nothing, then the role filter is the first correction.
      const top = await bindTool(db, { tool: "champion_matchup", input: { ...LEC, champion: "Azir", opponent: "Orianna", role: "Top" } });

      expect((await db.query(top.sql, top.params))).toEqual([]);
      expect(top.relaxations(LEC25).map((r) => r.key)).toEqual(["role", "period", "league"]);
    }));

  test("champion matchups without an opponent: the champions it faced, as a champion ranking", () =>
    seeded(async (db) => {
      const out = await run(db, { tool: "champion_matchup", input: { ...LEC, champion: "Gnar", opponent: null, role: null } });

      // Gnar faced Jax in all three games (BrokenBlade twice, Oscarinin once) and won them all.
      expect(out.table).toEqual({ columns: ["rank", "champion", "games", "wins", "winrate", "kda", "gold_diff_15"], rows: [[1, "Jax", 3, 3, 100, 18, null]] });
      expect(out.totals).toMatchObject({ games: 3, wins: 3, winrate: 100, opponents: 1, top_opponent: "Jax", top_opponent_games: 3 });
      expect(out.facts).toContain("Gnar en LEC en 2025 : 3 parties face à un adversaire direct (même rôle, équipe opposée), 100 % de victoires, 1 champions affrontés.");
      expect(out.followUps[0]).toBe("Gnar contre Jax");
    }));

  test("champion matchup: names resolved, the same champion twice is no opponent", () =>
    seeded(async (db) => {
      const { TOOLS } = await import("../src/lib/agent/tools");
      const input = { ...LEC, role: null };

      expect(await TOOLS.champion_matchup.normalize(db, { ...input, champion: "azir", opponent: "ORIANNA" })).toMatchObject({ input: { champion: "Azir", opponent: "Orianna" } });
      expect(await TOOLS.champion_matchup.normalize(db, { ...input, champion: "Azir", opponent: "Azir" })).toMatchObject({ input: { champion: "Azir", opponent: null } });
      expect(await TOOLS.champion_matchup.normalize(db, { ...input, champion: "Azir", opponent: "Nobody" })).toBeNull();
    }));

  test("the ranked column a table names as its focus is one of its columns, in both languages", () =>
    seeded(async (db) => {
      const calls: Parameters<typeof bindTool>[1][] = [
        { tool: "team_leaderboard", input: { ...LEC, order: "desc", side: null, minGames: 1, criterion: "winrate" } },
        { tool: "team_leaderboard", input: { ...LEC, order: "desc", side: null, minGames: 1, criterion: "games" } },
        { tool: "game_records", input: { ...LEC, player: null, role: null, metric: "kills" } },
        { tool: "game_records", input: { ...LEC, player: null, role: null, metric: "damage" } },
      ];

      for (const call of calls)
        for (const locale of ["fr", "en"] as const) {
          const { table } = await withLocale(locale, () => run(db, call));

          expect(table!.columns).toContain(table!.focus!);
        }

      // The views and the link preview read the focus by name: an English table with a French focus has none.
      const en = await withLocale("en", () => run(db, calls[0]));

      expect(en.table).toMatchObject({ focus: "win %" });
    }));

  test("game records: one line per game, of everyone, of a role or of one player", () =>
    seeded(async (db) => {
      const input = { ...LEC, player: null, role: null };
      const out = await run(db, { tool: "game_records", input: { ...input, metric: "kills" } });

      expect(out.table!.columns).toEqual(["Rang", "Joueur", "Champion joué", "Équipe", "Adversaire", "Compétition", "Date", "Kills", "K/D/A", "Durée", "Résultat"]);
      expect(out.table!.rows.slice(0, 2)).toEqual([
        [1, "Humanoid", "Orianna", "Fnatic", "G2 Esports", "LEC 2025", "9 janv. 2025", 6, "6/1/4", "40:00", "Victoire"],
        [2, "Caps", "Azir", "G2 Esports", "Fnatic", "LEC 2025", "2 janv. 2025", 5, "5/1/5", "30:00", "Victoire"],
      ]);
      expect(out.facts).toContain("Meilleures parties en LEC en 2025 sur le critère kills, une ligne par partie : 1. Humanoid : 6 (Orianna, Fnatic contre G2 Esports, LEC 2025, 9 janv. 2025)");
      expect(out.totals).toMatchObject({ leader: "Humanoid", leader_value: 6, leader_champion: "Orianna", rows: 12, metric: "kills" });

      const tops = await run(db, { tool: "game_records", input: { ...input, metric: "kills", role: "Top" } });

      // Two games with 3 kills: the older one first, and the tie is said.
      expect(tops.table!.rows.slice(0, 2).map((r) => [r[1], r[7]])).toEqual([["BrokenBlade", 3], ["Oscarinin", 3]]);
      expect(tops.facts).toContain("2 parties à égalité en tête.");

      const caps = await run(db, { tool: "game_records", input: { ...input, metric: "gold_diff_15", player: "Caps" } });

      expect(caps.table!.rows.map((r) => r[7])).toEqual([300, 100, -100]);
      expect(caps.title).toBe("Records sur une partie — écart or @15 de Caps (LEC 2025)");
      expect(caps.facts).toContain("1. Caps : +300 (Azir, G2 Esports contre Fnatic, LEC 2025, 2 janv. 2025)");
      expect(caps.sources.some((s) => s.label.includes("données Riot"))).toBe(true);
    }));

  test("a player's latest games: record, KDA and streak over the games listed", () =>
    seeded(async (db) => {
      const out = await run(db, { tool: "player_recent_games", input: { player: "Caps", league: null, yearFrom: null, yearTo: null, count: null } });

      expect(out.title).toBe("Caps — 3 dernières parties");
      expect(out.table!.rows[0]).toEqual(["9 janv. 2025", "LEC 2025 · semaine 2", "G2 Esports", "Fnatic", "Azir", "Défaite", "1/4/3", 320, 20000, "40:00"]);
      expect(out.totals).toMatchObject({ games: 3, wins: 2, losses: 1, kda: 3.43, streak: 1, streak_kind: "losses", last_champion: "Azir", last_opponent: "Fnatic" });
      expect(out.facts).toContain("Caps : ses 3 dernières parties (du 2 janv. 2025 au 9 janv. 2025) : 2 victoires, 1 défaite, KDA 3,43 (3,3 / 2,3 / 4,7 par partie).");
      expect(out.facts).toContain("Dernière partie : défaite contre Fnatic sur Azir (LEC 2025).");
      expect(out.facts).not.toContain("Série en cours");

      // BrokenBlade ends on a loss too, after two wins; Humanoid's two losses before his win are no current streak either.
      const hum = await run(db, { tool: "player_recent_games", input: { player: "Humanoid", league: "LoL EMEA Championship", yearFrom: 2025, yearTo: 2025, count: 3 } });

      expect(hum.totals).toMatchObject({ wins: 1, losses: 2, streak: 1, streak_kind: "wins" });
    }));

  test("a player's opponent comes from the side when the team of the player lines is written another way", () =>
    seededCaseDrift(async (db) => {
      const out = await run(db, { tool: "player_recent_games", input: { player: "Rahel", league: null, yearFrom: null, yearTo: null, count: null } });

      expect(out.table!.rows[0].slice(2, 4)).toEqual(["Dplus Kia Challengers", "KT Rolster Challengers"]);
      expect(out.totals).toMatchObject({ last_opponent: "KT Rolster Challengers" });

      const records = await run(db, { tool: "game_records", input: { ...LCKCL, player: "Rahel", role: null, metric: "kills" } });

      expect(records.table!.rows[0].slice(3, 5)).toEqual(["Dplus Kia Challengers", "KT Rolster Challengers"]);
    }));

  test("team leaderboard: the player lines of a team written another way still count for its side", () =>
    seededCaseDrift(async (db) => {
      const out = await run(db, { tool: "team_leaderboard", input: { ...LCKCL, order: "desc", side: null, minGames: 1, criterion: "kills" } });
      const row = (team: string) => Object.fromEntries(out.table!.columns.map((c, i) => [c, out.table!.rows.find((r) => r[1] === team)![i]]));

      // Blue: 4 + 3 + 2 + 1 + 0 kills, five champions; red: one kill each.
      expect(row("Dplus KIA Challengers")).toMatchObject({ Parties: 1, "kills / partie": 10, champions: 5 });
      expect(row("KT Rolster Challengers")).toMatchObject({ Parties: 1, "kills / partie": 5, champions: 5 });
    }));

  test("a second champion in the question is the opponent, in the order written", () =>
    seeded(async (db) => {
      const read = async (question: string) => (await understandQuestion(db, question, new Date("2026-11-15")))?.result;

      expect(await read("Azir contre Orianna")).toMatchObject({ champion: { champion: "Azir" }, opponentChampion: { champion: "Orianna" }, players: [] });
      expect(await read("Orianna vs Azir en mid")).toMatchObject({ champion: { champion: "Orianna" }, opponentChampion: { champion: "Azir" } });
      expect(await read("stats d'Azir")).toMatchObject({ champion: { champion: "Azir" }, opponentChampion: null });
    }));

  test("a champion misspelled by one letter is still read, in the order written", () =>
    seeded(async (db) => {
      const read = async (question: string) => (await understandQuestion(db, question, new Date("2026-11-15")))?.result;

      expect(await read("Match up oriana azir aux worlds")).toMatchObject({ champion: { mention: "oriana", champion: "Orianna" }, opponentChampion: { champion: "Azir" } });
      expect(await read("Azir vs Orianan")).toMatchObject({ champion: { champion: "Azir" }, opponentChampion: { champion: "Orianna" } });
      expect(await read("oriana en mid")).toMatchObject({ champion: { champion: "Orianna" }, opponentChampion: null });
      // An everyday word one letter away from a champion is not one, nor a short word.
      expect(await read("given the stats of Azir")).toMatchObject({ champion: { champion: "Azir" }, opponentChampion: null });
      expect(await read("Azir vs Jaxx")).toMatchObject({ champion: { champion: "Azir" }, opponentChampion: null });
    }));

  test("a short or everyday word one letter away is the opponent only next to a champion in a matchup", () =>
    seeded(async (db) => {
      const read = async (question: string) => (await understandQuestion(db, question, new Date("2026-11-15")))?.result;

      expect(await read("oriana vs lock au worlds 2026")).toMatchObject({ champion: { champion: "Orianna" }, opponentChampion: { mention: "lock", champion: "Locke" } });
      expect(await read("Match up oriana lock au worlds 2026")).toMatchObject({ champion: { champion: "Orianna" }, opponentChampion: { champion: "Locke" } });
      expect(await read("lock contre Azir")).toMatchObject({ champion: { champion: "Locke" }, opponentChampion: { champion: "Azir" } });
      // Without a matchup word, away from the champion, or a grammar word: "lock" and "when" stay words.
      expect(await read("Azir lock in")).toMatchObject({ champion: { champion: "Azir" }, opponentChampion: null });
      expect(await read("Azir lock in vs G2 at Worlds 2026")).toMatchObject({ champion: { champion: "Azir" }, opponentChampion: null });
      expect(await read("Azir lock in vs Orianna")).toMatchObject({ champion: { champion: "Azir" }, opponentChampion: { champion: "Orianna" } });
      expect(await read("pick Azir puis lock le mid vs G2")).toMatchObject({ champion: { champion: "Azir" }, opponentChampion: null });
      expect(await read("matchups d'Azir when playing mid")).toMatchObject({ champion: { champion: "Azir" }, opponentChampion: null });
      expect(await read("Azir vs Jaxx")).toMatchObject({ champion: { champion: "Azir" }, opponentChampion: null });
    }));
});

/**
 * LEC 2024 over two splits of the same league and year. Spring (2 games): Caps wins both on Azir against Humanoid
 * (Orianna, then Jax), Locke banned in the first. Summer (3 games): Humanoid on Orianna every time, Caps on Gnar, Jax
 * and Gnar, Humanoid wins two. Over the year Orianna leads the picks (4 of 5 games) and Humanoid the kills (14 to 13);
 * Azir leads Spring (2 picks) and Caps its kills (10), Orianna leads Summer (3 picks) and Humanoid its kills (12).
 */
async function seededSplits<T>(body: (db: TestDb) => Promise<T>): Promise<T> {
  const db = await testDb();

  try {
    for (const [i, l] of LEAGUES.entries()) await db.run("INSERT INTO leagues VALUES(?,?,?,?,?)", i + 1, l.name, l.short, l.region, +l.international);
    const lec = Number((await db.query("SELECT id FROM leagues WHERE name = 'LoL EMEA Championship'"))[0]!.id);

    await db.run(
      "INSERT INTO tournaments(id,page,event_page,stage,league_id,year,split) VALUES (1,'LEC24 Spring','LEC24 Spring','season',?,2024,'Spring'),(2,'LEC24 Summer','LEC24 Summer','season',?,2024,'Summer')",
      lec,
      lec,
    );
    await db.exec(`
      INSERT INTO teams(id,name) VALUES (1,'G2 Esports'),(2,'Fnatic');
      INSERT INTO players(id,page) VALUES (1,'Caps'),(2,'Humanoid');
      INSERT INTO champions VALUES (1,'Azir',NULL),(2,'Orianna',NULL),(3,'Gnar',NULL),(4,'Jax',NULL),(5,'Locke',NULL);
      INSERT INTO games(id,tournament_id,tab,blue_team_id,red_team_id,winner_side,length_s,played_at)
        VALUES (1,1,'Week 1',1,2,1,1800,1704067200),(2,1,'Week 1',1,2,1,1800,1704153600),
               (3,2,'Week 1',1,2,2,1800,1717200000),(4,2,'Week 1',1,2,2,1800,1717286400),(5,2,'Week 2',1,2,1,1800,1717372800);
      INSERT INTO game_draft VALUES (1,2,1,1,5);
      -- game_id, player_id, team_id, side, role, champion_id, win, kills, deaths, assists, gold, cs, damage, vision, keystone
      INSERT INTO game_players(game_id,player_id,team_id,side,role,champion_id,win,kills,deaths,assists,gold,cs,damage,vision,keystone_id) VALUES
        (1,1,1,1,'Mid',1,1,5,1,5,15000,300,30000,30,NULL),(1,2,2,2,'Mid',2,0,1,3,2,12000,270,18000,25,NULL),
        (2,1,1,1,'Mid',1,1,5,1,5,15000,300,30000,30,NULL),(2,2,2,2,'Mid',4,0,1,3,2,12000,270,18000,25,NULL),
        (3,1,1,1,'Mid',3,0,1,3,2,12000,270,18000,25,NULL),(3,2,2,2,'Mid',2,1,4,1,5,15000,300,30000,30,NULL),
        (4,1,1,1,'Mid',4,0,1,3,2,12000,270,18000,25,NULL),(4,2,2,2,'Mid',2,1,4,1,5,15000,300,30000,30,NULL),
        (5,1,1,1,'Mid',3,1,1,3,2,12000,270,18000,25,NULL),(5,2,2,2,'Mid',2,0,4,1,5,15000,300,30000,30,NULL);
    `);

    return await body(db);
  } finally {
    await db.close();
  }
}

describe("rankings of one split", () => {
  const LEC24 = scope("LoL EMEA Championship", "LEC", 2024);
  const year = { league: "LoL EMEA Championship" as const, yearFrom: 2024, yearTo: 2024 };
  const picks = { ...year, sort: "picks" as const, total: false, role: null, side: null, minPicks: null };
  const kills = { ...year, role: null, criterion: "kills" as const, minGames: null, side: null };

  test("the split of the question reaches the champion and player rankings; without one, the whole season", async () => {
    for (const split of ["Spring", "Summer", null] as const) {
      const e = { ...LEC24, split };

      expect(await route("champions les plus joués en LEC 2024", e)).toMatchObject({ kind: "tool", call: { tool: "champion_ranking", input: { ...year, sort: "picks", split } } });
      expect(await route("joueurs avec le plus de kills en LEC 2024", e)).toMatchObject({ kind: "tool", call: { tool: "player_leaderboard", input: { ...year, criterion: "kills", split } } });
    }

    // The split word is read: the question keeps the typed tool.
    expect(await route("champions les plus joués en LEC Spring 2024", { ...LEC24, split: "Spring" })).toMatchObject({ kind: "tool", confidence: 0.9, call: { tool: "champion_ranking" } });
    expect(await route("meilleurs mids LEC Summer 2024", { ...LEC24, split: "Summer" })).toMatchObject({ kind: "tool", confidence: 0.85, call: { tool: "player_leaderboard", input: { role: "Mid", split: "Summer" } } });
  });

  test("champion ranking: picks, bans, presence and sources of the split's games only", () =>
    seededSplits(async (db) => {
      const spring = await run(db, { tool: "champion_ranking", input: { ...picks, split: "Spring" } });
      const summer = await run(db, { tool: "champion_ranking", input: { ...picks, split: "Summer" } });
      const whole = await run(db, { tool: "champion_ranking", input: picks });
      const nulled = await run(db, { tool: "champion_ranking", input: { ...picks, split: null } });
      const row = (out: typeof spring, champion: string) => Object.fromEntries(out.table!.columns.map((c, i) => [c, out.table!.rows.find((r) => r[1] === champion)?.[i]]));

      expect(spring.totals).toMatchObject({ leader: "Azir", leader_picks: 2, games: 2 });
      expect(summer.totals).toMatchObject({ leader: "Orianna", leader_picks: 3, games: 3 });
      expect(whole.totals).toMatchObject({ leader: "Orianna", leader_picks: 4, games: 5 });
      expect(nulled).toEqual(whole);

      // A ban of Spring counts over Spring's two games, not the year's five; Summer never saw it.
      expect(row(spring, "Locke")).toMatchObject({ bans: 1, presence: 50 });
      expect(row(whole, "Locke")).toMatchObject({ bans: 1, presence: 20 });
      expect(row(summer, "Locke").bans).toBeUndefined();

      expect(spring.title).toBe("Champions les plus joués — LEC 2024 Spring");
      expect(spring.facts).toStartWith("Champions les plus joués au split Spring en LEC en 2024 (2 parties) : 1. Azir (2 picks");
      expect(spring.sources.map((s) => s.label)).toContain("Leaguepedia — LEC24 Spring");
      expect(spring.sources.map((s) => s.label)).not.toContain("Leaguepedia — LEC24 Summer");
      expect(whole.title).toBe("Champions les plus joués — LEC 2024");

      const en = await withLocale("en", () => run(db, { tool: "champion_ranking", input: { ...picks, split: "Summer" } }));

      expect(en.title).toBe("Most played champions — LEC 2024 Summer");
      expect(en.facts).toStartWith("Most played champions in the Summer split in LEC in 2024 (3 games): 1. Orianna (3 picks");
    }));

  test("player leaderboard: games, totals and sources of the split's games only", () =>
    seededSplits(async (db) => {
      const spring = await run(db, { tool: "player_leaderboard", input: { ...kills, split: "Spring" } });
      const summer = await run(db, { tool: "player_leaderboard", input: { ...kills, split: "Summer" } });
      const whole = await run(db, { tool: "player_leaderboard", input: kills });

      expect(spring.totals).toMatchObject({ leader: "Caps", leader_value: 10, leader_games: 2 });
      expect(summer.totals).toMatchObject({ leader: "Humanoid", leader_value: 12, leader_games: 3 });
      expect(whole.totals).toMatchObject({ leader: "Humanoid", leader_value: 14, leader_games: 5 });

      expect(spring.title).toEndWith("(LEC 2024 Spring)");
      expect(spring.facts).toContain("au split Spring en LEC en 2024");
      expect(spring.sources.map((s) => s.label)).not.toContain("Leaguepedia — LEC24 Summer");
      // The comparison it leads to reads no split.
      expect(spring.followUps[0]).toBe("Caps vs Humanoid en LEC en 2024");

      const en = await withLocale("en", () => run(db, { tool: "player_leaderboard", input: { ...kills, split: "Summer" } }));

      expect(en.title).toEndWith("(LEC 2024 Summer)");
      expect(en.facts).toContain("in the Summer split in LEC in 2024");
    }));

  test("a split without a game says so, without widening to the whole season", () =>
    seededSplits(async (db) => {
      for (const call of [{ tool: "champion_ranking", input: { ...picks, split: "Winter" } }, { tool: "player_leaderboard", input: { ...kills, split: "Winter" } }] as const) {
        const notes: string[] = [];
        const out = await execute(db, "classement en LEC Winter 2024", { ...LEC24, split: "Winter" }, toolPlan(await bindTool(db, call), 1), () => {}, notes);

        expect(out.rows).toEqual([]);
        expect(out.plan.relaxed).toEqual([]);
        expect(notes).toEqual([]);
        expect(out.empty).toMatchObject({ reason: "no_games", summary: "Aucune partie au split Winter en LEC en 2024 dans la base." });
      }
    }));
});
