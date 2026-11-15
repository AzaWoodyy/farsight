import { expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import { bindTool, playerProfiles } from "../src/lib/agent/tools";
import type { Entities } from "../src/lib/agent/types";
import { createQuerySchema, createSchema } from "../src/lib/db/schema";
import { LEAGUES } from "../src/lib/domain/leagues";

// Icons without a Data Dragon version: the scoreboard then skips the keystone lookup (no network in tests).
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
    INSERT INTO runes VALUES (1,'Phase Rush');
    INSERT INTO games(id,tournament_id,tab,match_n,game_n,blue_team_id,red_team_id,winner_side,length_s,patch,played_at,
                      blue_dragons,red_dragons,blue_barons,red_barons,blue_towers,red_towers,blue_heralds,red_heralds,
                      blue_void_grubs,red_void_grubs,blue_inhibitors,red_inhibitors)
      VALUES (1,1,'Finals',1,5,1,2,2,1934,'14.18',1,1,3,0,1,3,7,0,1,1,5,0,1),
             (2,2,'Week 1',1,1,3,4,1,1800,'14.1',2,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL),
             (3,2,'Week 2',1,1,4,3,1,1800,'14.2',3,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL),
             (4,2,'Week 3',1,1,4,3,1,1800,'14.3',4,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL);
    INSERT INTO game_players VALUES
      (1,1,1,1,'Top',1,0,0,2,5,11637,281,10771,39,NULL),
      (1,2,2,2,'Top',2,1,0,1,8,12891,282,14559,40,1),
      (2,3,3,1,'Mid',NULL,1,1,1,1,NULL,NULL,NULL,NULL,NULL),
      (3,3,4,1,'Mid',NULL,1,1,1,1,NULL,NULL,NULL,NULL,NULL),
      (4,3,4,1,'Mid',NULL,1,1,1,1,NULL,NULL,NULL,NULL,NULL);
    INSERT INTO game_player_items VALUES (1,1,2,2),(1,1,1,1);
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
  } finally {
    db.close();
  }
});

test("compared players' profiles list teams by games and the main role, in the question's scope", () => {
  const db = new DatabaseSync(":memory:");

  try {
    seed(db);
    const player = { mention: "Saken", player: "SAKEN", matchedAlias: "saken", realName: null, nativeName: null, otherCandidates: [], ambiguity: null };

    const entities: Entities = {
      players: [player, { ...player, mention: "Zeus", player: "Zeus" }],
      teams: [], champion: null, unresolved: [], league: "LoL EMEA Championship", leagueShort: "LEC", leagueMention: "LEC",
      yearFrom: null, yearTo: null, split: null, outOfScope: null,
    };

    // Zeus has no LEC game: no team, no role.
    expect(playerProfiles(db, entities)).toEqual([
      { player: "SAKEN", teams: ["Team Vitality", "Karmine Corp"], role: "Mid" },
      { player: "Zeus", teams: [], role: null },
    ]);
  } finally {
    db.close();
  }
});
