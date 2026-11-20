import { describe, expect, test } from "bun:test";
import { guardQuery } from "../src/lib/agent/guard";
import { bindTool, type ToolCall } from "../src/lib/agent/tools";
import { resolveTeam } from "../src/lib/agent/understand";
import { readSchema } from "../src/lib/db";
import { LEAGUES } from "../src/lib/domain/leagues";
import { testDb, type TestDb } from "./fixtures/test-db";

const LCK_AS = "LCK Academy Series";

/**
 * LCK AS 2020: in the season, two series known only from the schedule between T1 Rookies and Gen.G Global Academy
 * (2-1 for T1 Rookies, then a Gen.G forfeit); in the playoffs, a semifinal known only from the schedule (T1 Rookies 3-1
 * DRX Academy, a team without any game) and a final with its scoreboards (T1 Rookies 2-0 Gen.G Global Academy).
 * "Red", a schedule-only team named by an everyday word, is never read in a question.
 */
async function seed(db: TestDb) {
  for (const [i, l] of LEAGUES.entries()) await db.run("INSERT INTO leagues VALUES(?,?,?,?,?)", i + 1, l.name, l.short, l.region, +l.international);
  const league = Number((await db.query("SELECT id FROM leagues WHERE name = ?", [LCK_AS]))[0]!.id);

  await db.run("INSERT INTO tournaments(id,page,event_page,stage,league_id,year) VALUES (1,'AS20','AS20','season',?,2020),(2,'AS20P','AS20P','playoffs',?,2020)", league, league);
  await db.exec(`
    INSERT INTO teams(id,name) VALUES (1,'T1 Rookies'),(2,'Gen.G Global Academy'),(3,'DRX Academy'),(4,'Red');
    INSERT INTO games(id,tournament_id,tab,match_n,game_n,blue_team_id,red_team_id,winner_side,played_at) VALUES
      (1,2,'Finals',1,1,1,2,1,2000),(2,2,'Finals',1,2,2,1,2,2100);
    INSERT INTO series_results(id,tournament_id,tab,match_n,team1_id,team2_id,winner_side,team1_score,team2_score,forfeit,played_at) VALUES
      (1,1,'Week 1',1,1,2,1,2,1,NULL,1000),
      (2,1,'Week 2',1,2,1,2,0,2,1,1500),
      (3,2,'Semifinals',1,1,3,1,3,1,NULL,1800),
      (4,1,'Week 3',1,4,2,2,0,2,NULL,1600);
  `);
}

const run = async (db: TestDb, call: ToolCall) => {
  const tool = await bindTool(db, call);

  expect(guardQuery(await readSchema(db), tool.sql).ok).toBe(true);

  return tool.format(db, await db.query(tool.sql, tool.params));
};

describe("series known only from the schedule (v_series_results)", () => {
  test("a head-to-head counts them as series, their score as games, a forfeit as a series without games", async () => {
    const db = await testDb();

    try {
      await seed(db);
      const out = await run(db, { tool: "head_to_head", input: { kind: "team", sideA: "T1 Rookies", sideB: "Gen.G Global Academy", league: LCK_AS, yearFrom: 2020, yearTo: 2020 } });

      expect(out.teams).toMatchObject({ seriesA: 3, seriesB: 0, gamesA: 4, gamesB: 1, seriesCount: 3 });
      expect(out.totals).toMatchObject({ series: 3, series_a: 3, series_b: 0, wins_a: 4, wins_b: 1, schedule_series: 2 });
      expect(out.teams!.series.map((s) => [s.label, s.winsA, s.winsB, s.winner, s.scheduleOnly, s.forfeitedBy])).toEqual([
        ["LCK AS 2020 · finale", 2, 0, "T1 Rookies", false, null],
        ["LCK AS 2020 · semaine 2", 2, 0, "T1 Rookies", true, "Gen.G Global Academy"],
        ["LCK AS 2020 · semaine 1", 2, 1, "T1 Rookies", true, null],
      ]);
      expect(out.notes?.join(" ")).toContain("2 séries n'ont que leur résultat, tiré du calendrier de Leaguepedia");
      expect(out.notes?.join(" ")).toContain("Un forfait");
      expect(out.sources.map((s) => s.url)).toContain("https://lol.fandom.com/wiki/AS20");
    } finally {
      await db.close();
    }
  });

  test("a team's history adds their score to its record, tournament by tournament", async () => {
    const db = await testDb();

    try {
      await seed(db);
      const out = await run(db, { tool: "team_history", input: { team: "T1 Rookies", league: LCK_AS, yearFrom: 2020, yearTo: 2020 } });

      expect(out.table?.rows.map((r) => [r[2], r.at(-2)])).toEqual([["AS20", "2-1"], ["AS20P", "5-1"]]);
      expect(out.totals).toMatchObject({ events: 2, wins: 7, losses: 2, schedule_series: 3 });
      expect(out.notes?.join(" ")).toContain("3 séries n'ont que leur résultat");
    } finally {
      await db.close();
    }
  });

  test("a stage known only from the schedule is a series without games, and without a game table", async () => {
    const db = await testDb();

    try {
      await seed(db);
      const semi = await run(db, { tool: "series", input: { teamA: null, teamB: null, league: LCK_AS, yearFrom: 2020, yearTo: 2020, phase: "semifinal", split: null } });

      expect(semi.series?.series.map((s) => [s.teamA, s.winsA, s.winsB, s.teamB, s.bestOf, s.scheduleOnly, s.games])).toEqual([["T1 Rookies", 3, 1, "DRX Academy", 5, true, null]]);
      expect(semi.table).toBeUndefined();
      expect(semi.totals).toMatchObject({ series: 1, games: 0, schedule_series: 1 });
      expect(semi.facts).toContain("T1 Rookies 3-1 DRX Academy");

      // Every series of the two teams: the forfeit reads as one, won by its winner.
      const all = await run(db, { tool: "series", input: { teamA: "T1 Rookies", teamB: "Gen.G Global Academy", league: LCK_AS, yearFrom: 2020, yearTo: 2020, phase: null, split: null } });

      expect(all.series?.series.map((s) => [s.label, s.teamA, s.teamB, s.forfeitedBy])).toEqual([
        ["LCK AS 2020 · semaine 1", "T1 Rookies", "Gen.G Global Academy", null],
        ["LCK AS 2020 · semaine 2", "T1 Rookies", "Gen.G Global Academy", "Gen.G Global Academy"],
        ["LCK AS 2020 · finale", "T1 Rookies", "Gen.G Global Academy", null],
      ]);
      expect(all.facts).toContain("T1 Rookies bat Gen.G Global Academy par forfait");
      expect(all.table?.rows).toHaveLength(2);
      expect(all.totals).toMatchObject({ series: 3, games: 2, schedule_series: 2 });
    } finally {
      await db.close();
    }
  });

  test("a team known only from the schedule is read by its full name, never by an everyday word", async () => {
    const db = await testDb();

    try {
      await seed(db);
      expect(await resolveTeam(db, "DRX Academy")).toMatchObject({ team: "DRX Academy", members: ["DRX Academy"] });
      expect(await resolveTeam(db, "red")).toBeNull();
    } finally {
      await db.close();
    }
  });
});
