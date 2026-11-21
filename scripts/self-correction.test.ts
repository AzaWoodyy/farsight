import { afterEach, beforeEach, expect, test } from "bun:test";
import { toolPlan } from "../src/lib/agent/query";
import { type AgentEvent, execute } from "../src/lib/agent/run";
import { bindTool } from "../src/lib/agent/tools";
import type { Entities, StepPart } from "../src/lib/agent/types";
import { LEAGUES } from "../src/lib/domain/leagues";
import { testDb, type TestDb } from "./fixtures/test-db";

// Empty results of typed tools only: the rules corrector relaxes them and the model corrector gives up before any call.
const entities: Entities = {
  players: [], teams: [], champion: null, unresolved: [], league: null, leagueShort: null, leagueMention: null, yearFrom: null, yearTo: null, split: null, outOfScope: null,
};

const WORLDS = "World Championship";

/** One Worlds 2023 game of T1 against Gen.G, with Riot data and team stats for both sides. */
async function seed(db: TestDb) {
  const league = LEAGUES.find((l) => l.name === WORLDS)!;

  await db.run("INSERT INTO leagues VALUES(1,?,?,?,?)", league.name, league.short, league.region, +league.international);
  await db.exec(`
    INSERT INTO tournaments(id,page,event_page,stage,name,league_id,year) VALUES(1,'2023 Season World Championship/Main Event','2023 Season World Championship','main_event','Worlds 2023',1,2023);
    INSERT INTO teams(id,name) VALUES(1,'T1'),(2,'Gen.G');
    INSERT INTO games(id,tournament_id,blue_team_id,red_team_id,winner_side,length_s,played_at) VALUES(1,1,1,2,1,1800,1697800000);
    INSERT INTO game_riot VALUES(1,'riot-1','V5 data:test',5,0,0);
    INSERT INTO game_team_stats(game_id,side,first_blood,first_tower,first_dragon,first_herald,first_baron,plates,gold_diff_15,kills_10)
      VALUES(1,1,1,1,0,1,1,3,1200,2),(1,2,0,0,1,0,0,1,-1200,1);
  `);
}

const plan = async (db: TestDb, input: { league: typeof WORLDS | null; yearFrom: number | null; yearTo: number | null }) =>
  toolPlan(await bindTool(db, { tool: "team_ingame_stats", input: { team: "T1", metric: null, minute: null, ...input } }), 1);

async function run(db: TestDb, first: Awaited<ReturnType<typeof plan>>) {
  const events: AgentEvent[] = [];
  const notes: string[] = [];
  const result = await execute(db, "first blood de T1", entities, first, (e) => events.push(e), notes);
  const last: StepPart | undefined = events.flatMap((e) => (e.type === "step" ? [e.part] : [])).at(-1);

  if (!last) throw new Error("execute emitted no step");

  return { ...result, notes, last };
}

// A network call would mean the model corrector ran: the test must stay hermetic.
const realFetch = globalThis.fetch;
let fetches = 0;

beforeEach(() => {
  fetches = 0;
  globalThis.fetch = Object.assign(async () => {
    fetches++;
    throw new Error("no network in self-correction tests");
  }, realFetch);
});

afterEach(() => {
  globalThis.fetch = realFetch;
  expect(fetches).toBe(0);
});

test("gives up after three attempts once every relaxation came back empty", async () => {
  const db = await testDb();

  try {
    const out = await run(db, await plan(db, { league: WORLDS, yearFrom: 2023, yearTo: 2023 }));

    expect(out.rows).toEqual([]);
    expect(out.problem?.kind).toBe("empty");
    expect(out.plan.attempt).toBe(3);
    expect(out.plan.relaxed).toEqual(["period", "league"]);
    expect(out.notes).toHaveLength(2);
    expect(out.last.state).toBe("done");
    // An empty result is no failure of the query: a warning, not an error.
    expect(out.last.status).toBe("warn");
    expect(out.last.title).toBe("Aucune ligne après 3 tentatives");
    expect(out.last.entries.filter((e) => e.title.startsWith("Auto-correction"))).toHaveLength(2);
  } finally {
    await db.close();
  }
});

test("stops at once when an empty result has no relaxation left", async () => {
  const db = await testDb();

  try {
    const out = await run(db, await plan(db, { league: null, yearFrom: null, yearTo: null }));

    expect(out.rows).toEqual([]);
    expect(out.problem?.kind).toBe("empty");
    expect(out.plan.attempt).toBe(1);
    expect(out.notes).toEqual([]);
    expect(out.last.status).toBe("warn");
    expect(out.last.title).toBe("Aucune ligne");
    expect(out.last.entries.map((e) => e.title)).toContain("Aucune correction possible");
  } finally {
    await db.close();
  }
});

test("succeeds on the second attempt after dropping the period", async () => {
  const db = await testDb();

  try {
    await seed(db);
    const out = await run(db, await plan(db, { league: WORLDS, yearFrom: 2020, yearTo: 2020 }));

    expect(out.problem).toBeNull();
    expect(out.rows.length).toBeGreaterThan(0);
    expect(out.plan.attempt).toBe(2);
    expect(out.plan.relaxed).toEqual(["period"]);
    expect(out.plan.tool?.call.input).toMatchObject({ league: WORLDS, yearFrom: null, yearTo: null });
    expect(out.notes).toEqual(["Rien entre 2020 et 2020 : affichage de toutes les saisons."]);
    expect(out.last.status).toBe("fix");
    expect(out.last.title).toBe(`${out.rows.length} ligne(s), après 1 correction(s)`);
  } finally {
    await db.close();
  }
});

test("succeeds at once when the scope has games", async () => {
  const db = await testDb();

  try {
    await seed(db);
    const out = await run(db, await plan(db, { league: WORLDS, yearFrom: 2023, yearTo: 2023 }));

    expect(out.problem).toBeNull();
    // One season row and the total row.
    expect(out.rows).toHaveLength(2);
    expect(out.plan.attempt).toBe(1);
    expect(out.plan.relaxed).toEqual([]);
    expect(out.notes).toEqual([]);
    expect(out.last.status).toBe("ok");
    expect(out.last.title).toBe("2 ligne(s)");
  } finally {
    await db.close();
  }
});

/** Faker in the seeded T1 lineup: the Worlds 2023 game is his only one. */
async function seedPlayer(db: TestDb) {
  await seed(db);
  await db.exec(`
    INSERT INTO players(id,page,ign) VALUES(1,'Faker','Faker');
    INSERT INTO game_players(game_id,player_id,team_id,side,role,win,kills,deaths,assists) VALUES(1,1,1,1,'Mid',1,3,1,7);
  `);
}

const faker: Entities = {
  ...entities,
  players: [{ mention: "Faker", player: "Faker", matchedAlias: "Faker", realName: null, nativeName: null, otherCandidates: [], ambiguity: null }],
  league: WORLDS,
  leagueShort: "Worlds",
};

async function recentGames(db: TestDb, scope: Entities) {
  const first = toolPlan(await bindTool(db, { tool: "player_recent_games", input: { player: "Faker", league: WORLDS, yearFrom: scope.yearFrom, yearTo: scope.yearTo, count: null } }), 1);
  const notes: string[] = [];
  const result = await execute(db, "dernières parties de Faker aux Worlds", scope, first, () => {}, notes);

  return { ...result, notes };
}

test("says the named scope holds no game instead of showing another period", async () => {
  const db = await testDb();

  try {
    await seedPlayer(db);
    const out = await recentGames(db, { ...faker, yearFrom: 2020, yearTo: 2020 });

    expect(out.rows).toEqual([]);
    expect(out.plan.attempt).toBe(1);
    expect(out.plan.relaxed).toEqual([]);
    expect(out.notes).toEqual([]);
    expect(out.empty?.reason).toBe("no_games");
    expect(out.empty?.summary).toBe("Aucune partie de Faker aux Worlds en 2020 dans la base.");
  } finally {
    await db.close();
  }
});

test("answers the named scope when it holds the games", async () => {
  const db = await testDb();

  try {
    await seedPlayer(db);
    const out = await recentGames(db, { ...faker, yearFrom: 2023, yearTo: 2023 });

    expect(out.rows).toHaveLength(1);
    expect(out.plan.attempt).toBe(1);
    expect(out.empty).toBeNull();
  } finally {
    await db.close();
  }
});
