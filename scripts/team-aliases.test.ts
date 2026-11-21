import { describe, expect, test } from "bun:test";
import { withoutLlm } from "../src/lib/agent/llm";
import { resolveTeam, understandQuestion } from "../src/lib/agent/understand";
import { LEAGUES } from "../src/lib/domain/leagues";
import { testDb, type TestDb } from "./fixtures/test-db";

/**
 * Karmine Corp, its academy Karmine Corp Blue and their second academy Karmine Corp Blue Stars, with their Leaguepedia
 * abbreviations; a player called Blue; RED Canids, whose abbreviation is an everyday word; Gamers Two ("GT"), too short;
 * Splyce Vipers ("SVP", a chat shorthand); Wizards ("WIZ"), with more games than the player Wiz; DRX and Kiwoom DRX ("KRX").
 */
async function seed() {
  const db = await testDb();

  for (const [i, l] of LEAGUES.entries()) await db.run("INSERT INTO leagues VALUES(?,?,?,?,?)", i + 1, l.name, l.short, l.region, +l.international);
  await db.exec(`
    INSERT INTO tournaments(id,page,event_page,name,stage,league_id,year) VALUES (1,'LFL D2 2025','LFL D2 2025','LFL D2 2025','season',1,2025);
    INSERT INTO teams(id,name,short) VALUES (1,'Karmine Corp','KC'),(2,'Karmine Corp Blue','KCB'),(3,'Karmine Corp Blue Stars','KCBS'),
      (4,'RED Canids','RED'),(5,'Gamers Two','GT'),(6,'Other',NULL),
      (7,'Wizards','WIZ'),(8,'Splyce Vipers','SVP'),(11,'For The Win Esports','FTW'),(12,'Taipei Snipers','TPS'),(13,'Project Conquerors','PCS'),(14,'Percent Esports','PER'),(9,'DRX',NULL),(10,'Kiwoom DRX','KRX');
    INSERT INTO players(id,page,ign) VALUES (1,'Blue (Player)','Blue'),(2,'Wiz','Wiz');
    INSERT INTO player_aliases VALUES ('blue','Blue',1),('wiz','Wiz',2);
  `);
  let id = 0;

  for (const [team, games] of [[1, 5], [2, 4], [3, 3], [4, 2], [5, 2], [7, 3], [8, 2], [9, 2], [10, 2], [11, 2], [12, 2], [13, 2], [14, 2]])
    for (let i = 0; i < games; i++) {
      id++;
      await db.run("INSERT INTO games(id,tournament_id,blue_team_id,red_team_id,winner_side,played_at) VALUES (?,1,?,6,1,?)", id, team, id);
    }

  for (let g = 1; g <= id; g++) await db.run("INSERT INTO game_players(game_id,player_id,team_id,role,side,win) VALUES (?,1,6,'Mid',2,0)", g);
  await db.run("INSERT INTO game_players(game_id,player_id,team_id,role,side,win) VALUES (1,2,1,'Mid',1,1)");

  return db;
}

const teamsOf = async (db: TestDb, q: string) => {
  const r = await withoutLlm(() => understandQuestion(db, q, new Date("2026-11-20")));

  return { teams: r?.result.teams.map((t) => t.team), players: r?.result.players.map((p) => p.player) };
};

describe("team abbreviations from Leaguepedia", () => {
  test.each([
    ["KCB", "Karmine Corp Blue"],
    ["kcbs", "Karmine Corp Blue Stars"],
    ["KC Blue", "Karmine Corp Blue"],
    ["kc blue stars", "Karmine Corp Blue Stars"],
    ["KCB Stars", "Karmine Corp Blue Stars"],
    ["Karmine Corp Blue Star", "Karmine Corp Blue Stars"],
    ["KC Blue Star", "Karmine Corp Blue Stars"],
    ["KC", "Karmine Corp"],
  ])("%s names %s", async (mention, team) => {
    const db = await seed();

    expect((await resolveTeam(db, mention))?.team).toBe(team);
  });

  test("the abbreviation's longer form wins over a shorter team and a player on the same words", async () => {
    const db = await seed();

    expect(await teamsOf(db, "KC Blue en LFL D2")).toEqual({ teams: ["Karmine Corp Blue"], players: [] });
    expect(await teamsOf(db, "résultats de KC Blue Stars")).toEqual({ teams: ["Karmine Corp Blue Stars"], players: [] });
    expect(await teamsOf(db, "KCB vs KCBS")).toEqual({ teams: ["Karmine Corp Blue", "Karmine Corp Blue Stars"], players: [] });
  });

  test("an abbreviation that is an everyday word names the team only in capitals, a two-letter one never", async () => {
    const db = await seed();

    expect((await teamsOf(db, "RED en LFL D2")).teams).toEqual(["RED Canids"]);
    expect((await teamsOf(db, "red en LFL D2")).teams).toEqual([]);
    expect(await resolveTeam(db, "GT")).toBeNull();
    expect((await teamsOf(db, "Qui a gagné les Worlds svp ?")).teams).toEqual([]);
    expect((await teamsOf(db, "Historique de SVP")).teams).toEqual(["Splyce Vipers"]);
    expect((await teamsOf(db, "Combien de tps dure une partie en LFL ?")).teams).toEqual([]);
    expect((await teamsOf(db, "Historique de TPS")).teams).toEqual(["Taipei Snipers"]);
    expect((await teamsOf(db, "KC ftw")).teams).toEqual(["Karmine Corp"]);
    expect((await teamsOf(db, "Champions with the most deaths per game at Worlds 2026")).teams).toEqual([]);
    expect((await teamsOf(db, "PCS 2023 winners")).teams).toEqual([]);
  });

  test("an abbreviation that is also a player's handle names the player, unless written in capitals", async () => {
    const db = await seed();

    expect(await teamsOf(db, "Historique de Wiz")).toEqual({ teams: [], players: ["Wiz"] });
    expect(await teamsOf(db, "Historique de WIZ")).toEqual({ teams: ["Wizards"], players: [] });
  });

  test("the abbreviation of a curated franchise member counts every name of the franchise", async () => {
    const db = await seed();

    expect(await resolveTeam(db, "KRX")).toMatchObject({ team: "DRX", members: ["DRX", "Kiwoom DRX"] });
    expect((await resolveTeam(db, "KRX"))?.members).toEqual((await resolveTeam(db, "DRX"))?.members);
  });

  test("the end of one team's name resolves a mention the model read as a team, never a shared or one-word end", async () => {
    const db = await seed();

    expect((await resolveTeam(db, "Blue Stars"))?.team).toBe("Karmine Corp Blue Stars");
    expect(await resolveTeam(db, "Stars")).toBeNull();
    expect((await resolveTeam(db, "Corp Blue"))?.team).toBe("Karmine Corp Blue");
  });

  test("without abbreviations (a raw cache older than schema v10), the full names still resolve", async () => {
    const db = await seed();
    await db.exec("UPDATE teams SET short = NULL");

    expect(await resolveTeam(db, "KCB")).toBeNull();
    expect((await resolveTeam(db, "Karmine Corp Blue Stars"))?.team).toBe("Karmine Corp Blue Stars");
  });
});

/**
 * Two teams with one abbreviation, NIP: Ninjas in Pyjamas (EU LCS 2017, on the red side) and Ninjas in Pyjamas.CN, with
 * more games (LPL 2026). Both played Worlds 2024, and the European team also a qualifier in 2026.
 */
async function seedShared() {
  const db = await testDb();
  const league = (name: string) => LEAGUES.findIndex((l) => l.name === name) + 1;

  for (const [i, l] of LEAGUES.entries()) await db.run("INSERT INTO leagues VALUES(?,?,?,?,?)", i + 1, l.name, l.short, l.region, +l.international);
  await db.exec(`
    INSERT INTO tournaments(id,page,event_page,name,stage,league_id,year) VALUES
      (1,'EU LCS 2017 Summer','EU LCS 2017 Summer','EU LCS 2017 Summer','season',${league("Europe League Championship Series")},2017),
      (2,'LPL 2026 Split 1','LPL 2026 Split 1','LPL 2026 Split 1','season',${league("Tencent LoL Pro League")},2026),
      (3,'Worlds 2024','Worlds 2024','Worlds 2024','main_event',${league("World Championship")},2024),
      (4,'LEC 2026 Qualifier','LEC 2026 Qualifier','LEC 2026 Qualifier','qualifier',${league("LoL EMEA Championship")},2026);
    INSERT INTO teams(id,name,short) VALUES (1,'Ninjas in Pyjamas','NIP'),(2,'Ninjas in Pyjamas.CN','NIP'),(3,'Other',NULL);
  `);
  let id = 0;

  for (const [tournament, blue, red, games] of [[1, 3, 1, 3], [2, 2, 3, 6], [3, 1, 2, 1], [4, 1, 3, 2]])
    for (let i = 0; i < games; i++) {
      id++;
      await db.run("INSERT INTO games(id,tournament_id,blue_team_id,red_team_id,winner_side,played_at) VALUES (?,?,?,?,1,?)", id, tournament, blue, red, id);
    }

  return db;
}

describe("an abbreviation two teams share", () => {
  test.each([
    ["NIP en EU LCS 2017", "Ninjas in Pyjamas"],
    ["Roster de NIP en LEC 2017", "Ninjas in Pyjamas"],
    ["NIP roster 2017", "Ninjas in Pyjamas"],
    ["NIP en LPL 2026", "Ninjas in Pyjamas.CN"],
  ])("%s names the one team that played in the scope (%s)", async (q, team) => {
    const db = await seedShared();

    expect((await teamsOf(db, q)).teams).toEqual([team]);
  });

  test.each([
    ["NIP aux Worlds 2024", "both played"],
    ["NIP en LCK 2020", "neither played"],
    ["NIP en LEC 2026", "a qualifier only"],
    ["Historique de NIP", "no scope"],
  ])("%s keeps the team with more games (%s)", async (q) => {
    const db = await seedShared();

    expect((await teamsOf(db, q)).teams).toEqual(["Ninjas in Pyjamas.CN"]);
  });

  test("beside the full name of the team with more games, the abbreviation still names the other team", async () => {
    const db = await seedShared();

    expect((await teamsOf(db, "NIP vs Ninjas in Pyjamas.CN en EU LCS 2017")).teams).toEqual(["Ninjas in Pyjamas", "Ninjas in Pyjamas.CN"]);
    expect((await teamsOf(db, "Ninjas in Pyjamas.CN vs NIP en EU LCS 2017")).teams).toEqual(["Ninjas in Pyjamas.CN", "Ninjas in Pyjamas"]);
  });

  test("without a question, the abbreviation names the team with more games", async () => {
    const db = await seedShared();

    expect(await resolveTeam(db, "NIP")).toMatchObject({ team: "Ninjas in Pyjamas.CN", members: ["Ninjas in Pyjamas.CN"] });
    expect((await resolveTeam(db, "Ninjas in Pyjamas"))?.team).toBe("Ninjas in Pyjamas");
  });
});
