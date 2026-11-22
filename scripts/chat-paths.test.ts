import { afterEach, describe, expect, test } from "bun:test";
import { leaguePaths } from "../src/lib/agent/chat-paths";
import { LEAGUES, type LeagueName } from "../src/lib/domain/leagues";
import { testDb, type TestDb } from "./fixtures/test-db";

const open: TestDb[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((db) => db.close()));
});

const SEASONS: [league: LeagueName, year: number, games: [blue: string, red: string][]][] = [
  ["LVP SuperLiga 2nd Division", 2014, [["Splyce", "Filler"]]],
  ["Europe League Championship Series", 2015, [["Fnatic", "Origen"]]],
  ["Europe League Championship Series", 2016, [["Splyce", "Fnatic"]]],
  ["La Ligue Française", 2020, [["Kameto Corp", "Filler"], ["Filler", "Kameto Corp"]]],
  ["La Ligue Française", 2021, [["Filler", "Karmine Corp"]]],
  ["European Masters", 2021, [["Karmine Corp", "Filler"]]],
  ["La Ligue Française Division 2", 2022, [["Div Two", "Filler"]]],
  ["La Ligue Française", 2023, [["Div Two", "Filler"]]],
  ["La Ligue Française", 2024, [["Same Year", "Filler"]]],
  ["LoL EMEA Championship", 2024, [["Karmine Corp", "Fnatic"], ["Fnatic", "Karmine Corp"], ["Karmine Corp", "Same Year"]]],
  ["LoL EMEA Championship", 2025, [["Div Two", "Fnatic"]]],
  ["La Ligue Française", 2025, [["Fnatic", "Filler"]]],
  ["Challengers Korea", 2017, [["Griffin", "Korean Filler"]]],
  ["LoL Champions Korea", 2018, [["Griffin", "T1"]]],
  ["LCK Academy Series", 2022, [["Academy Only", "Korean Filler"]]],
  ["LoL Champions Korea", 2024, [["T1", "Academy Only"]]],
];

async function seed() {
  const db = await testDb();

  open.push(db);

  const leagueId = new Map<string, number>();

  for (const [i, l] of LEAGUES.entries()) {
    leagueId.set(l.name, i + 1);
    await db.run("INSERT INTO leagues VALUES(?,?,?,?,?)", i + 1, l.name, l.short, l.region, +l.international);
  }

  const teamId = new Map<string, number>();

  for (const name of new Set(SEASONS.flatMap(([, , games]) => games.flat()))) {
    teamId.set(name, teamId.size + 1);
    await db.run("INSERT INTO teams(id,name) VALUES (?,?)", teamId.size, name);
  }

  let game = 0;

  for (const [i, [league, year, games]] of SEASONS.entries()) {
    const page = `${league} ${year}`;

    await db.run("INSERT INTO tournaments(id,page,event_page,name,stage,league_id,year) VALUES (?,?,?,?,'season',?,?)", i + 1, page, page, page, leagueId.get(league) ?? 0, year);

    for (const [blue, red] of games) {
      game++;
      await db.run("INSERT INTO games(id,tournament_id,blue_team_id,red_team_id,winner_side,played_at) VALUES (?,?,?,?,1,?)", game, i + 1, teamId.get(blue) ?? 0, teamId.get(red) ?? 0, game);
    }
  }

  return db;
}

describe("leaguePaths", () => {
  test("teams that played a lower league before the LEC, by year of arrival, under their current name", async () => {
    expect(await leaguePaths(await seed(), "LEC", "lower")).toEqual([
      { team: "Splyce", before: [{ league: "LVP SuperLiga 2nd Division", year: 2014 }], arrived: 2016, topGames: 1 },
      {
        team: "Karmine Corp",
        before: [
          { league: "La Ligue Française", year: 2020 },
          { league: "European Masters", year: 2021 },
        ],
        arrived: 2024,
        topGames: 3,
      },
      {
        team: "Div Two",
        before: [
          { league: "La Ligue Française Division 2", year: 2022 },
          { league: "La Ligue Française", year: 2023 },
        ],
        arrived: 2025,
        topGames: 1,
      },
    ]);
  });

  test("a team that never played lower, played lower only afterwards or the same year, or never reached the top league is left out", async () => {
    const teams = (await leaguePaths(await seed(), "LEC", "lower")).map((p) => p.team);

    for (const team of ["Origen", "Fnatic", "Same Year", "Filler", "Kameto Corp", "Griffin"]) expect(teams).not.toContain(team);
  });

  test("the second scope keeps the teams that came through a second division, with their whole path", async () => {
    expect(await leaguePaths(await seed(), "LEC", "second")).toEqual([
      { team: "Splyce", before: [{ league: "LVP SuperLiga 2nd Division", year: 2014 }], arrived: 2016, topGames: 1 },
      {
        team: "Div Two",
        before: [
          { league: "La Ligue Française Division 2", year: 2022 },
          { league: "La Ligue Française", year: 2023 },
        ],
        arrived: 2025,
        topGames: 1,
      },
    ]);
  });

  test("the LCK has its own leagues: challengers count as a second division, the academy series does not", async () => {
    const db = await seed();

    expect(await leaguePaths(db, "LCK", "lower")).toEqual([
      { team: "Griffin", before: [{ league: "Challengers Korea", year: 2017 }], arrived: 2018, topGames: 1 },
      { team: "Academy Only", before: [{ league: "LCK Academy Series", year: 2022 }], arrived: 2024, topGames: 1 },
    ]);
    expect((await leaguePaths(db, "LCK", "second")).map((p) => p.team)).toEqual(["Griffin"]);
  });

  test("an empty database lists no team", async () => {
    const db = await testDb();

    open.push(db);

    expect(await leaguePaths(db, "LEC", "lower")).toEqual([]);
  });
});
