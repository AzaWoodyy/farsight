import { describe, expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import { withoutLlm } from "../src/lib/agent/llm";
import { resolveTeam, understandQuestion } from "../src/lib/agent/understand";
import { createQuerySchema, createSchema } from "../src/lib/db/schema";
import { LEAGUES } from "../src/lib/domain/leagues";

/**
 * Karmine Corp, its academy Karmine Corp Blue and their second academy Karmine Corp Blue Stars, with their Leaguepedia
 * abbreviations; a player called Blue; RED Canids, whose abbreviation is an everyday word; Gamers Two ("GT"), too short.
 */
function seed() {
  const db = new DatabaseSync(":memory:");
  createSchema(db);
  createQuerySchema(db);
  LEAGUES.forEach((l, i) => db.prepare("INSERT INTO leagues VALUES(?,?,?,?,?)").run(i + 1, l.name, l.short, l.region, +l.international));
  db.exec(`
    INSERT INTO tournaments(id,page,event_page,name,stage,league_id,year) VALUES (1,'LFL D2 2025','LFL D2 2025','LFL D2 2025','season',1,2025);
    INSERT INTO teams(id,name,short) VALUES (1,'Karmine Corp','KC'),(2,'Karmine Corp Blue','KCB'),(3,'Karmine Corp Blue Stars','KCBS'),
      (4,'RED Canids','RED'),(5,'Gamers Two','GT'),(6,'Other',NULL);
    INSERT INTO players(id,page,ign) VALUES (1,'Blue (Player)','Blue');
    INSERT INTO player_aliases VALUES ('blue','Blue',1);
  `);
  const game = db.prepare("INSERT INTO games(id,tournament_id,blue_team_id,red_team_id,winner_side,played_at) VALUES (?,1,?,6,1,?)");
  let id = 0;

  for (const [team, games] of [[1, 5], [2, 4], [3, 3], [4, 2], [5, 2]]) for (let i = 0; i < games; i++) game.run(++id, team, id);
  const line = db.prepare("INSERT INTO game_players(game_id,player_id,team_id,role,side,win) VALUES (?,1,6,'Mid',2,0)");

  for (let g = 1; g <= id; g++) line.run(g);

  return db;
}

const teamsOf = async (db: DatabaseSync, q: string) => {
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
  ])("%s names %s", (mention, team) => {
    const db = seed();

    expect(resolveTeam(db, mention)?.team).toBe(team);
  });

  test("the abbreviation's longer form wins over a shorter team and a player on the same words", async () => {
    const db = seed();

    expect(await teamsOf(db, "KC Blue en LFL D2")).toEqual({ teams: ["Karmine Corp Blue"], players: [] });
    expect(await teamsOf(db, "résultats de KC Blue Stars")).toEqual({ teams: ["Karmine Corp Blue Stars"], players: [] });
    expect(await teamsOf(db, "KCB vs KCBS")).toEqual({ teams: ["Karmine Corp Blue", "Karmine Corp Blue Stars"], players: [] });
  });

  test("an abbreviation that is an everyday word names the team only in capitals, a two-letter one never", async () => {
    const db = seed();

    expect((await teamsOf(db, "RED en LFL D2")).teams).toEqual(["RED Canids"]);
    expect((await teamsOf(db, "red en LFL D2")).teams).toEqual([]);
    expect(resolveTeam(db, "GT")).toBeNull();
  });

  test("the end of one team's name resolves a mention the model read as a team, never a shared or one-word end", () => {
    const db = seed();

    expect(resolveTeam(db, "Blue Stars")?.team).toBe("Karmine Corp Blue Stars");
    expect(resolveTeam(db, "Stars")).toBeNull();
    expect(resolveTeam(db, "Corp Blue")?.team).toBe("Karmine Corp Blue");
  });

  test("without abbreviations (a raw cache older than schema v10), the full names still resolve", () => {
    const db = seed();
    db.exec("UPDATE teams SET short = NULL");

    expect(resolveTeam(db, "KCB")).toBeNull();
    expect(resolveTeam(db, "Karmine Corp Blue Stars")?.team).toBe("Karmine Corp Blue Stars");
  });
});
