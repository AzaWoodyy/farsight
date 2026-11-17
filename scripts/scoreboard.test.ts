import { expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import { bindTool, playerProfiles } from "../src/lib/agent/tools";
import { createQuerySchema, createSchema } from "../src/lib/db/schema";
import { LEAGUES } from "../src/lib/domain/leagues";

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
    INSERT INTO teams VALUES (1,'Bilibili Gaming'),(2,'T1'),(3,'Karmine Corp'),(4,'Team Vitality');
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
    expect(sb.red).toEqual({ name: "T1", kills: 0, gold: 12891, towers: 7, inhibitors: 1, dragons: 3, barons: 1, heralds: 1, grubs: 5 });
    expect([sb.blue.kills, sb.blue.gold]).toEqual([0, 11637]);

    const [bin, zeus] = sb.players;

    // Items in slot order; a keystone without icon keeps its name.
    expect(bin.items.map((i) => i.name)).toEqual(["Trinity Force", "Sundered Sky"]);
    expect([bin.side, bin.champion, bin.keystone, bin.damage]).toEqual(["blue", "Jax", null, 10771]);
    expect([zeus.side, zeus.keystone, zeus.keystoneIcon, zeus.items]).toEqual(["red", "Phase Rush", null, []]);

    // Spells with their stored icon; the page after the keystone, in page order, a shard taken twice listed twice.
    expect(zeus.spells).toEqual([{ name: "Flash", iconUrl: ICON }, { name: "Teleport", iconUrl: ICON }]);
    expect(bin.spells).toEqual([{ name: "Clairvoyance", iconUrl: null }]);
    expect(zeus.runes).toEqual([
      { name: "Manaflow Band", kind: "primary", iconUrl: ICON },
      { name: "Biscuit Delivery", kind: "secondary", iconUrl: ICON },
      { name: "Health", kind: "shard", iconUrl: null },
      { name: "Health", kind: "shard", iconUrl: null },
    ]);
    expect(bin.runes).toEqual([]);
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
      { player: "SAKEN", teams: ["Team Vitality", "Karmine Corp"], role: "Mid" },
      { player: "Zeus", teams: [], role: null },
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
    expect(playerProfiles(db, ["SAKEN"], { ...lec, yearFrom: 1999, yearTo: 1999 })).toEqual([{ player: "SAKEN", teams: [], role: null }]);
    // The widened scope the comparison ran on.
    expect(playerProfiles(db, ["SAKEN"], lec)).toEqual([{ player: "SAKEN", teams: ["Team Vitality", "Karmine Corp"], role: "Mid" }]);
    // No competition: Zeus's Worlds game counts.
    expect(playerProfiles(db, ["Zeus"], { league: null, yearFrom: null, yearTo: null })).toEqual([{ player: "Zeus", teams: ["T1"], role: "Top" }]);
  } finally {
    db.close();
  }
});
