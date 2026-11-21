import { beforeAll, describe, expect, test } from "bun:test";
import { teamBadges, teamLeagues, teamNames } from "../src/lib/agent/team-badges";
import { wikiImageUrl } from "../src/lib/domain/wiki-images";
import { LEAGUES } from "../src/lib/domain/leagues";
import { testDb } from "./fixtures/test-db";

const db = await testDb();

const league = (short: string) => LEAGUES.findIndex((l) => l.short === short) + 1;

beforeAll(async () => {
  for (const [i, l] of LEAGUES.entries()) await db.run("INSERT INTO leagues VALUES(?,?,?,?,?)", i + 1, l.name, l.short, l.region, +l.international);

  const tournaments: [string, number][] = [
    ["LFL D2", 2023], ["LFL", 2024], ["EMEA Masters", 2024], ["LEC", 2024], ["Worlds", 2024], ["LCK", 2015], ["LCK", 2025], ["OGN Champions", 2014], ["LFL D2", 2024],
  ];

  for (const [i, [short, year]] of tournaments.entries())
    await db.run("INSERT INTO tournaments(id,page,event_page,name,stage,league_id,year) VALUES (?,?,?,?,?,?,?)", i + 1, `T${i}`, `T${i}`, `${short} ${year}`, "season", league(short), year);
  await db.exec(`INSERT INTO teams(id,name) VALUES (1,'Climbers'),(2,'Other'),(3,'Griffin (Korean Team)'),(4,'SK Telecom T1'),(5,'T1'),(6,'Renamed'),(7,'Prime'),(8,'Back'),(9,'Promoted'),
    (10,'Nova Esports (Thai Team)'),(11,'Nova Esports (Taiwanese Team)'),(12,'DRX'),(13,'Awesome'),(14,'Awesome (Awesome Spear Academy)')`);
  // Logo files as the wiki stores them; two teams answer to "Nova Esports", each with its own logo.
  await db.exec(`UPDATE teams SET logo = CASE id WHEN 1 THEN 'Climberslogo square.png' WHEN 3 THEN 'Griffin (Korean Team)logo square.png'
    WHEN 5 THEN 'T1logo square.png' WHEN 10 THEN 'Nova Esports (Thai Team)logo square.png' WHEN 11 THEN 'Nova Esportslogo square.png' WHEN 12 THEN 'DRXlogo square.png'
    WHEN 13 THEN 'Awesomelogo square.png' WHEN 14 THEN 'Awesome Spearlogo square.png' END`);

  let id = 0;

  const games = async (team: number, tournament: number, count: number, at = tournament * 1000) => {
    for (let i = 0; i < count; i++) {
      id++;
      await db.run("INSERT INTO games(id,tournament_id,blue_team_id,red_team_id,played_at) VALUES (?,?,?,?,?)", id, tournament, team, 2, at + i);
    }
  };

  // Climbers: LFL D2 in 2023, up to the LFL in 2024, with the EMEA Masters, Worlds and one stand-in game in the LEC.
  await games(1, 1, 20);
  await games(1, 2, 30);
  await games(1, 3, 25);
  await games(1, 4, 1);
  await games(1, 5, 10);
  await games(3, 6, 10);
  // The same team under its old name (2014) and its current one (2015).
  await games(4, 8, 10);
  await games(5, 6, 10);
  // A name only taken in 2025.
  await games(6, 7, 10);
  // A team of a league out of the scope: a few LFL games beside its EMEA Masters run.
  await games(7, 2, 2);
  await games(7, 3, 25);
  // Relegated within its latest season: the LFL, then the LFL D2 the same year.
  await games(8, 2, 10);
  await games(8, 9, 10, 30_000);
  // Years in the LFL D2, then promoted: its latest season is all LFL, though the LFL is under a tenth of its career.
  await games(9, 1, 50);
  await games(9, 2, 4);
});

const all = { yearFrom: null, yearTo: null };

describe("the league a team played in", () => {
  test("a team that moved up shows both leagues, oldest first, without cups, internationals or a stand-in game", async () => {
    expect(await teamLeagues(db, ["Climbers"], all, {})).toEqual({ Climbers: ["LFL D2", "LFL"] });
  });

  test("the period decides", async () => {
    expect(await teamLeagues(db, ["Climbers"], { yearFrom: 2024, yearTo: 2024 }, {})).toEqual({ Climbers: ["LFL"] });
  });

  test("a name is matched without Leaguepedia's disambiguation", async () => {
    expect(await teamLeagues(db, ["Griffin"], all, {})).toEqual({ Griffin: ["LCK"] });
  });

  test("a roster's team counts the names it played under", async () => {
    expect(await teamLeagues(db, ["T1"], { yearFrom: 2014, yearTo: 2014 }, { T1: ["SK Telecom T1"] })).toEqual({ T1: ["OGN Champions"] });
  });

  test("a name without a game in the period gets its last league", async () => {
    expect(await teamLeagues(db, ["Renamed"], { yearFrom: 2023, yearTo: 2023 }, {})).toEqual({ Renamed: ["LCK"] });
  });

  test("a team out of the scope has none", async () => {
    expect(await teamLeagues(db, ["PSG Talon"], all, {})).toEqual({});
  });

  test("the share counts every game of the team, cups and internationals included", async () => {
    expect(await teamLeagues(db, ["Prime"], all, {})).toEqual({});
  });

  test("the fallback reads the latest season: a recent promotion after a long stint below", async () => {
    expect(await teamLeagues(db, ["Promoted"], { yearFrom: 2015, yearTo: 2015 }, {})).toEqual({ Promoted: ["LFL"] });
  });

  test("the fallback is the league the team played in last", async () => {
    expect(await teamLeagues(db, ["Back"], { yearFrom: 2015, yearTo: 2015 }, {})).toEqual({ Back: ["LFL D2"] });
  });
});

describe("the logo beside a team", () => {
  const logo = (file: string) => wikiImageUrl(file, 64);

  test("the file of the team of that name, the one team a name stands for without its disambiguation, else none", async () => {
    const { icons } = await teamBadges(db, ["Climbers", "Griffin", "Griff_n", "Other", "Unknown"], all);

    expect(icons).toEqual({ Climbers: logo("Climberslogo square.png"), Griffin: logo("Griffin (Korean Team)logo square.png") });
  });

  test("a name two teams answer to gets no logo, rather than the other team's", async () => {
    const { icons } = await teamBadges(db, ["Nova Esports", "Nova Esports (Thai Team)", "Awesome"], all);

    expect(icons).toEqual({ "Nova Esports (Thai Team)": logo("Nova Esports (Thai Team)logo square.png") });
  });

  test("the tone comes from the hand-kept list, by file", async () => {
    const { tones } = await teamBadges(db, ["DRX", "T1"], all);

    expect(tones).toEqual({ DRX: "dark" });
  });

  test("a database before migration 3 (no logo column) answers without logos", async () => {
    const old = await testDb();

    try {
      await old.exec("ALTER TABLE teams DROP COLUMN logo");
      await old.exec("INSERT INTO teams(id,name) VALUES (1,'T1')");
      expect(await teamBadges(old, ["T1"], all)).toEqual({ icons: {}, tones: {}, leagues: {} });
    } finally {
      await old.close();
    }
  });
});

describe("the team names an answer shows", () => {
  test("the teams asked and the team columns of a table, a generated query's included", () => {
    const table = { columns: ["team", "role", "games"], rows: [["Climbers", "Jungle", 3], ["Other", "Jungle", 1]] };

    expect(teamNames({ table }, ["T1"])).toEqual(["T1", "Climbers", "Other"]);
  });

  test("English headers", () => {
    const table = { columns: ["Year", "Tournament", "Winner", "Runner-up"], rows: [[2024, "Worlds 2024", "T1", "Bilibili Gaming"]] };

    expect(teamNames({ table }, [])).toEqual(["T1", "Bilibili Gaming"]);
  });
});
