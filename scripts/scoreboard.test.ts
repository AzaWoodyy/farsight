import { expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import { answerProfiles } from "../src/lib/agent/run";
import { bindTool, playerProfiles } from "../src/lib/agent/tools";
import { createQuerySchema, createSchema } from "../src/lib/db/schema";
import { LEAGUES } from "../src/lib/domain/leagues";
import { photoUrl, playerPhoto } from "../src/lib/domain/player-photos";

const ICON = "https://ddragon.leagueoflegends.com/cdn/img/x.png";

/** One Worlds final game (T1 red, winner) and one LEC season game for the profiles. */
function seed(db: DatabaseSync) {
  createSchema(db);
  createQuerySchema(db);
  LEAGUES.forEach((l, i) => db.prepare("INSERT INTO leagues VALUES(?,?,?,?,?)").run(i + 1, l.name, l.short, l.region, +l.international));
  const league = (name: string) => Number(db.prepare("SELECT id FROM leagues WHERE name = ?").get(name)!.id);

  db.prepare("INSERT INTO tournaments(id,page,event_page,stage,league_id,year) VALUES(1,'W24','W24','main_event',?,2024)").run(league("World Championship"));
  db.prepare("INSERT INTO tournaments(id,page,event_page,stage,league_id,year) VALUES(2,'LEC24','LEC24','season',?,2024)").run(league("LoL EMEA Championship"));
  db.exec(`
    INSERT INTO teams(id,name) VALUES (1,'Bilibili Gaming'),(2,'T1'),(3,'Karmine Corp'),(4,'Team Vitality');
    INSERT INTO players(id,page) VALUES (1,'Bin'),(2,'Zeus'),(3,'SAKEN');
    INSERT INTO champions VALUES (1,'Jax','${ICON}'),(2,'Gragas','${ICON}');
    INSERT INTO items VALUES (1,'Trinity Force','${ICON}','complete'),(2,'Sundered Sky','${ICON}','complete');
    -- Phase Rush left Data Dragon: no icon. Manaflow Band is taken as a primary rune, Biscuit Delivery as a secondary one.
    INSERT INTO runes VALUES (1,'Phase Rush','Sorcery',NULL),(2,'Manaflow Band','Sorcery','${ICON}'),(3,'Biscuit Delivery','Inspiration','${ICON}'),(4,'Health',NULL,NULL);
    INSERT INTO summoner_spells VALUES (1,'Flash','${ICON}'),(2,'Teleport','${ICON}'),(3,'Clairvoyance',NULL);
    INSERT INTO games(id,tournament_id,tab,match_n,game_n,blue_team_id,red_team_id,winner_side,length_s,patch,played_at,
                      blue_dragons,red_dragons,blue_barons,red_barons,blue_towers,red_towers,blue_heralds,red_heralds,
                      blue_void_grubs,red_void_grubs,blue_inhibitors,red_inhibitors)
      VALUES (1,1,'Finals',1,5,1,2,2,1934,'14.18',1,1,3,0,1,3,7,0,1,1,5,0,1),
             (2,2,'Week 1',1,1,3,4,1,1800,'14.1',2,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL),
             (3,2,'Week 2',1,1,4,3,1,1800,'14.2',3,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL),
             (4,2,'Week 3',1,1,4,3,1,1800,'14.3',4,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL);
    INSERT INTO game_players(game_id,player_id,team_id,side,role,champion_id,win,kills,deaths,assists,gold,cs,damage,vision,keystone_id) VALUES
      (1,1,1,1,'Top',1,0,0,2,5,11637,281,10771,39,NULL),
      (1,2,2,2,'Top',2,1,0,1,8,12891,282,14559,40,1),
      (2,3,3,1,'Mid',NULL,1,1,1,1,NULL,NULL,NULL,NULL,NULL),
      (3,3,4,1,'Mid',NULL,1,1,1,1,NULL,NULL,NULL,NULL,NULL),
      (4,3,4,1,'Mid',NULL,1,1,1,1,NULL,NULL,NULL,NULL,NULL);
    INSERT INTO game_player_items VALUES (1,1,2,2),(1,1,1,1);
    UPDATE game_players SET spell1_id = 1, spell2_id = 2 WHERE game_id = 1 AND player_id = 2;
    UPDATE game_players SET spell1_id = 3 WHERE game_id = 1 AND player_id = 1;
    -- game_id, player_id, primary 1-3, secondary 1-2, shards 1-3
    INSERT INTO game_player_runes VALUES (1,2,2,NULL,NULL,3,NULL,4,4,NULL);
  `);
}

test("a game's recap reads the scoreboard tables, winner first, even without Riot timeline", async () => {
  const db = new DatabaseSync(":memory:");

  try {
    seed(db);
    const tool = bindTool(db, { tool: "game_timeline", input: { teamA: "T1", teamB: "Bilibili Gaming", league: "World Championship", year: 2024, phase: "final", game: 5 } });
    const out = await tool.format(db, db.prepare(tool.sql).all(tool.params));
    const sb = out.scoreboard!;

    expect(sb.label).toBe("Worlds 2024 · finale · game 5");
    expect([sb.winner, sb.durationS, sb.patch]).toEqual(["red", 1934, "14.18"]);
    // No Riot timeline: the dragon count of the scoreboard, without elements or soul.
    expect(sb.red).toEqual({ name: "T1", kills: 0, gold: 12891, towers: 7, inhibitors: 1, dragons: 3, barons: 1, heralds: 1, grubs: 5, dragonKinds: [], soul: null });
    expect([sb.blue.kills, sb.blue.gold]).toEqual([0, 11637]);

    const [bin, zeus] = sb.players;

    // Items in slot order; a keystone the database has no icon for (removed from the game) gets the icon of its time.
    expect(bin.items.map((i) => i.name)).toEqual(["Trinity Force", "Sundered Sky"]);
    expect([bin.side, bin.champion, bin.keystone, bin.damage]).toEqual(["blue", "Jax", null, 10771]);
    expect([zeus.side, zeus.keystone, zeus.keystoneIcon, zeus.items]).toEqual(["red", "Phase Rush", "https://ddragon.leagueoflegends.com/cdn/img/perk-images/Styles/Sorcery/PhaseRush/PhaseRush.png", []]);

    // Spells with their stored icon; the page after the keystone, in page order, a shard taken twice listed twice.
    expect(zeus.spells).toEqual([{ name: "Flash", iconUrl: ICON }, { name: "Teleport", iconUrl: ICON }]);
    expect(bin.spells).toEqual([{ name: "Clairvoyance", iconUrl: null }]);
    // A stat shard is not in Data Dragon's rune list: its icon comes from the fallback paths.
    const SHARD = "https://ddragon.leagueoflegends.com/cdn/img/perk-images/StatMods/StatModsHealthPlusIcon.png";

    expect(zeus.runes).toEqual([
      { name: "Manaflow Band", kind: "primary", iconUrl: ICON },
      { name: "Biscuit Delivery", kind: "secondary", iconUrl: ICON },
      { name: "Health", kind: "shard", iconUrl: SHARD },
      { name: "Health", kind: "shard", iconUrl: SHARD },
    ]);
    expect(bin.runes).toEqual([]);
  } finally {
    db.close();
  }
});

test("with a Riot timeline, the recap names each team's dragons in order and the soul", async () => {
  const db = new DatabaseSync(":memory:");

  try {
    seed(db);
    db.exec(`
      INSERT INTO game_riot VALUES (1,'K1','V5 data:K1',5,1,0);
      INSERT INTO game_team_stats(game_id,side,elder_dragons,dragon_soul,soul) VALUES (1,1,0,0,NULL),(1,2,1,1,'ocean');
      -- game_id, seq, team_seq, side, kind, time_s
      INSERT INTO game_dragons VALUES (1,1,1,2,'cloud',400),(1,2,1,1,'infernal',800),(1,3,2,2,'ocean',1100),(1,4,3,2,'ocean',1400),(1,5,4,2,'ocean',1700),(1,6,5,2,'elder',1900);
    `);
    const tool = bindTool(db, { tool: "game_timeline", input: { teamA: "T1", teamB: "Bilibili Gaming", league: "World Championship", year: 2024, phase: "final", game: 5 } });
    const sb = (await tool.format(db, db.prepare(tool.sql).all(tool.params))).scoreboard!;

    expect([sb.red.dragonKinds, sb.red.soul]).toEqual([["nuage", "océan", "océan", "océan", "ancestral"], "océan"]);
    expect([sb.blue.dragonKinds, sb.blue.soul]).toEqual([["infernal"], null]);
  } finally {
    db.close();
  }
});

test("compared players' profiles list teams by games and the main role, in the scope given", () => {
  const db = new DatabaseSync(":memory:");

  try {
    seed(db);

    // Zeus has no LEC game: no team, no role.
    expect(playerProfiles(db, ["SAKEN", "Zeus"], { league: "LoL EMEA Championship", yearFrom: null, yearTo: null })).toEqual([
      { player: "SAKEN", teams: ["Team Vitality", "Karmine Corp"], role: "Mid", photo: null },
      { player: "Zeus", teams: [], role: null, photo: null },
    ]);
  } finally {
    db.close();
  }
});

test("profiles follow the scope given, not a narrower one", () => {
  const db = new DatabaseSync(":memory:");

  try {
    seed(db);
    const lec = { league: "LoL EMEA Championship", yearFrom: null, yearTo: null };

    // The period the question asked, before a relaxation drops it: no game there.
    expect(playerProfiles(db, ["SAKEN"], { ...lec, yearFrom: 1999, yearTo: 1999 })).toEqual([{ player: "SAKEN", teams: [], role: null, photo: null }]);
    // The widened scope the comparison ran on.
    expect(playerProfiles(db, ["SAKEN"], lec)).toEqual([{ player: "SAKEN", teams: ["Team Vitality", "Karmine Corp"], role: "Mid", photo: null }]);
    // No competition: Zeus's Worlds game counts.
    expect(playerProfiles(db, ["Zeus"], { league: null, yearFrom: null, yearTo: null })).toEqual([{ player: "Zeus", teams: ["T1"], role: "Top", photo: null }]);
  } finally {
    db.close();
  }
});

test("an answer profiles the player its statistics are about, both compared players, and no team", () => {
  const db = new DatabaseSync(":memory:");

  try {
    seed(db);
    const call = (c: Parameters<typeof bindTool>[1]) => bindTool(db, c).call;
    const lec = { league: "LoL EMEA Championship" as const, yearFrom: null, yearTo: null };
    const saken = { player: "SAKEN", teams: ["Team Vitality", "Karmine Corp"], role: "Mid", photo: null };

    expect(answerProfiles(db, call({ tool: "player_event_history", input: { player: "SAKEN", ...lec } }))).toEqual([saken]);
    expect(answerProfiles(db, call({ tool: "player_recent_games", input: { player: "SAKEN", ...lec, count: null } }))).toEqual([saken]);
    expect(answerProfiles(db, call({ tool: "champion_pool", input: { subject: "player", name: "SAKEN", ...lec, split: null } }))).toEqual([saken]);
    expect(answerProfiles(db, call({ tool: "champion_pool", input: { subject: "team", name: "Team Vitality", ...lec, split: null } }))).toEqual([]);
    expect(answerProfiles(db, call({ tool: "team_history", input: { team: "T1", league: "World Championship", yearFrom: null, yearTo: null } }))).toEqual([]);
  } finally {
    db.close();
  }
});

test("a player's photo is the one of the period: latest taken by then, else the earliest, the latest without a date", () => {
  const db = new DatabaseSync(":memory:");
  const at = (day: string) => Date.parse(`${day}T00:00:00Z`) / 1000;

  try {
    seed(db);
    db.prepare("INSERT INTO player_images VALUES (?,?,?)").run(1, at("2023-01-11"), "BLG Bin 2023 Split 1.png");
    db.prepare("INSERT INTO player_images VALUES (?,?,?)").run(1, at("2024-01-22"), "BLG Bin 2024 Split 1.png");
    db.prepare("INSERT INTO player_images VALUES (?,?,?)").run(1, at("2025-01-13"), "BLG Bin 2025 Split 1.png");

    const file = (when: number | null) => playerPhoto(db, "Bin", when)?.source.split("File:")[1];

    expect(file(at("2024-10-02"))).toBe("BLG_Bin_2024_Split_1.png");
    expect(file(at("2024-01-22"))).toBe("BLG_Bin_2024_Split_1.png");
    expect(file(at("2020-05-01"))).toBe("BLG_Bin_2023_Split_1.png");
    expect(file(null)).toBe("BLG_Bin_2025_Split_1.png");
    expect(playerPhoto(db, "Bin", at("2024-10-02"))).toEqual({
      url: photoUrl("BLG Bin 2024 Split 1.png"),
      year: 2024,
      source: "https://lol.fandom.com/wiki/File:BLG_Bin_2024_Split_1.png",
    });
    expect(playerPhoto(db, "Zeus", null)).toBeNull();
  } finally {
    db.close();
  }
});

test("a photo URL follows MediaWiki's md5 layout on Fandom's CDN", () => {
  // md5("Faker_Summer_2016.png") starts with 19, as the wiki's own URL for that file.
  expect(photoUrl("Faker Summer 2016.png", 200)).toBe(
    "https://static.wikia.nocookie.net/lolesports_gamepedia_en/images/1/19/Faker_Summer_2016.png/revision/latest/scale-to-width-down/200",
  );
});
