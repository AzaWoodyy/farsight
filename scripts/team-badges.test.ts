import { beforeAll, describe, expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import { teamLeagues, teamNames } from "../src/lib/agent/team-badges";
import { createSchema } from "../src/lib/db/schema";
import { LEAGUES } from "../src/lib/domain/leagues";

const db = new DatabaseSync(":memory:");

const league = (short: string) => LEAGUES.findIndex((l) => l.short === short) + 1;

beforeAll(() => {
  createSchema(db);
  LEAGUES.forEach((l, i) => db.prepare("INSERT INTO leagues VALUES(?,?,?,?,?)").run(i + 1, l.name, l.short, l.region, +l.international));

  const tournaments: [string, number][] = [
    ["LFL D2", 2023], ["LFL", 2024], ["EMEA Masters", 2024], ["LEC", 2024], ["Worlds", 2024], ["LCK", 2015], ["LCK", 2025], ["OGN Champions", 2014], ["LFL D2", 2024],
  ];

  tournaments.forEach(([short, year], i) =>
    db.prepare("INSERT INTO tournaments(id,page,event_page,name,stage,league_id,year) VALUES (?,?,?,?,?,?,?)").run(i + 1, `T${i}`, `T${i}`, `${short} ${year}`, "season", league(short), year),
  );
  db.exec(`INSERT INTO teams(id,name) VALUES (1,'Climbers'),(2,'Other'),(3,'Griffin (Korean Team)'),(4,'SK Telecom T1'),(5,'T1'),(6,'Renamed'),(7,'Prime'),(8,'Back'),(9,'Promoted')`);

  let id = 0;

  const games = (team: number, tournament: number, count: number, at = tournament * 1000) => {
    for (let i = 0; i < count; i++) {
      id++;
      db.prepare("INSERT INTO games(id,tournament_id,blue_team_id,red_team_id,played_at) VALUES (?,?,?,?,?)").run(id, tournament, team, 2, at + i);
    }
  };

  // Climbers: LFL D2 in 2023, up to the LFL in 2024, with the EMEA Masters, Worlds and one stand-in game in the LEC.
  games(1, 1, 20);
  games(1, 2, 30);
  games(1, 3, 25);
  games(1, 4, 1);
  games(1, 5, 10);
  games(3, 6, 10);
  // The same team under its old name (2014) and its current one (2015).
  games(4, 8, 10);
  games(5, 6, 10);
  // A name only taken in 2025.
  games(6, 7, 10);
  // A team of a league out of the scope: a few LFL games beside its EMEA Masters run.
  games(7, 2, 2);
  games(7, 3, 25);
  // Relegated within its latest season: the LFL, then the LFL D2 the same year.
  games(8, 2, 10);
  games(8, 9, 10, 30_000);
  // Years in the LFL D2, then promoted: its latest season is all LFL, though the LFL is under a tenth of its career.
  games(9, 1, 50);
  games(9, 2, 4);
});

const all = { yearFrom: null, yearTo: null };

describe("the league a team played in", () => {
  test("a team that moved up shows both leagues, oldest first, without cups, internationals or a stand-in game", () => {
    expect(teamLeagues(db, ["Climbers"], all, {})).toEqual({ Climbers: ["LFL D2", "LFL"] });
  });

  test("the period decides", () => {
    expect(teamLeagues(db, ["Climbers"], { yearFrom: 2024, yearTo: 2024 }, {})).toEqual({ Climbers: ["LFL"] });
  });

  test("a name is matched without Leaguepedia's disambiguation", () => {
    expect(teamLeagues(db, ["Griffin"], all, {})).toEqual({ Griffin: ["LCK"] });
  });

  test("a roster's team counts the names it played under", () => {
    expect(teamLeagues(db, ["T1"], { yearFrom: 2014, yearTo: 2014 }, { T1: ["SK Telecom T1"] })).toEqual({ T1: ["OGN Champions"] });
  });

  test("a name without a game in the period gets its last league", () => {
    expect(teamLeagues(db, ["Renamed"], { yearFrom: 2023, yearTo: 2023 }, {})).toEqual({ Renamed: ["LCK"] });
  });

  test("a team out of the scope has none", () => {
    expect(teamLeagues(db, ["PSG Talon"], all, {})).toEqual({});
  });

  test("the share counts every game of the team, cups and internationals included", () => {
    expect(teamLeagues(db, ["Prime"], all, {})).toEqual({});
  });

  test("the fallback reads the latest season: a recent promotion after a long stint below", () => {
    expect(teamLeagues(db, ["Promoted"], { yearFrom: 2015, yearTo: 2015 }, {})).toEqual({ Promoted: ["LFL"] });
  });

  test("the fallback is the league the team played in last", () => {
    expect(teamLeagues(db, ["Back"], { yearFrom: 2015, yearTo: 2015 }, {})).toEqual({ Back: ["LFL D2"] });
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
