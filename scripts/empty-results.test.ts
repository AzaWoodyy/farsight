import { afterEach, beforeEach, expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import { explainEmpty, unrecognizedNote } from "../src/lib/agent/empty";
import { type AgentEvent, execute } from "../src/lib/agent/run";
import type { Entities, QueryPlan, ResolvedPlayer, StepPart } from "../src/lib/agent/types";
import { createQuerySchema, createSchema } from "../src/lib/db/schema";
import { LEAGUES } from "../src/lib/domain/leagues";

const WORLDS = "World Championship";

const scope = (extra: Partial<Entities> = {}): Entities => ({
  players: [], teams: [], champion: null, unresolved: [], league: WORLDS, leagueShort: "Worlds", leagueMention: "Worlds", yearFrom: 2024, yearTo: 2024, split: null, outOfScope: null,
  ...extra,
});

const faker: ResolvedPlayer = { mention: "Faker", player: "Faker", matchedAlias: "Faker", realName: null, nativeName: null, otherCandidates: [], ambiguity: null };
const champion = (name: string) => ({ mention: name, champion: name });

/**
 * Worlds 2024: one qualifier game (Faker on Azir) and two main event games with
 * Riot data and no pentakill (Faker on Orianna), the second with a quadrakill.
 */
function fresh() {
  const db = new DatabaseSync(":memory:");
  const league = LEAGUES.find((l) => l.name === WORLDS)!;

  createSchema(db);
  createQuerySchema(db);
  db.prepare("INSERT INTO leagues VALUES(1,?,?,?,?)").run(league.name, league.short, league.region, +league.international);
  db.exec(`
    INSERT INTO tournaments(id,page,event_page,stage,name,league_id,year) VALUES
      (1,'LCK/2024 Season/Regional Finals','LCK/2024 Season/Regional Finals','qualifier','LCK 2024 Regional Finals',1,2024),
      (2,'2024 Season World Championship/Main Event','2024 Season World Championship','main_event','Worlds 2024',1,2024);
    INSERT INTO teams VALUES(1,'T1'),(2,'Gen.G');
    INSERT INTO players(id,page) VALUES(1,'Faker'),(2,'Chovy');
    INSERT INTO champions(id,name) VALUES(1,'Azir'),(2,'Orianna'),(3,'Ahri');
    INSERT INTO runes VALUES(1,'Conqueror');
    INSERT INTO games(id,tournament_id,blue_team_id,red_team_id,winner_side,length_s,played_at) VALUES
      (1,1,1,2,1,1800,1726293960),(2,2,1,2,1,1800,1728000000),(3,2,2,1,2,1800,1728100000);
    INSERT INTO game_players(game_id,player_id,team_id,side,role,champion_id,win,kills,deaths,assists,keystone_id) VALUES
      (1,1,1,1,'Mid',1,1,3,0,4,1),(1,2,2,2,'Mid',3,0,1,2,0,NULL),
      (2,1,1,1,'Mid',2,1,5,1,6,NULL),(2,2,2,2,'Mid',3,0,1,3,2,NULL),
      (3,1,1,2,'Mid',2,1,7,0,3,NULL),(3,2,2,1,'Mid',3,0,2,4,1,NULL);
    INSERT INTO game_riot VALUES(2,'riot-2','V5 data:2',5,0,0),(3,'riot-3','V5 data:3',5,0,0);
    INSERT INTO game_player_stats(game_id,player_id,penta_kills,quadra_kills) VALUES(2,1,0,0),(2,2,0,0),(3,1,0,1),(3,2,0,0);
  `);

  return db;
}

const PENTAS =
  "SELECT champion, SUM(penta_kills) AS pentakills FROM v_game_player_stats WHERE league = 'World Championship' AND year = 2024 " +
  "AND stage <> 'qualifier' GROUP BY champion HAVING SUM(penta_kills) > 0 ORDER BY pentakills DESC LIMIT 10";

const generated = (sql: string): QueryPlan => ({ intent: "sql", tool: null, sql, params: {}, attempt: 1, relaxed: [] });

// A network call would mean the model corrector ran: an explained empty result must not ask it.
const realFetch = globalThis.fetch;
let fetches = 0;

beforeEach(() => {
  fetches = 0;
  globalThis.fetch = Object.assign(async () => {
    fetches++;
    throw new Error("no network in empty-result tests");
  }, realFetch);
});

afterEach(() => {
  globalThis.fetch = realFetch;
  expect(fetches).toBe(0);
});

test("a count that is zero over the in-game games is an answer, not an empty result", () => {
  const db = fresh();

  try {
    const why = explainEmpty(db, scope(), PENTAS);

    expect(why?.reason).toBe("zero_count");
    expect(why?.conclusive).toBe(true);
    expect(why?.summary).toBe("Aucun pentakill sur les 2 parties avec données in-game aux Worlds en 2024 (qualifications exclues).");
  } finally {
    db.close();
  }
});

test("a count that is not zero leaves the empty result unexplained", () => {
  const db = fresh();

  try {
    const why = explainEmpty(db, scope(), PENTAS.replaceAll("penta_kills", "quadra_kills"));

    expect(why?.reason).toBe("unexplained");
    expect(why?.conclusive).toBe(false);
    expect(why?.summary).toContain("2 parties aux Worlds en 2024");
  } finally {
    db.close();
  }
});

test("games only in regional qualifiers are shown and said to be excluded", () => {
  const db = fresh();

  try {
    const why = explainEmpty(db, scope({ players: [faker], champion: champion("Azir") }), "SELECT 1 FROM v_game_players WHERE 0");

    expect(why?.reason).toBe("qualifier_only");
    expect(why?.summary).toContain("La seule partie de Faker sur Azir aux Worlds en 2024 est en qualifications régionales (LCK 2024 Regional Finals)");
    expect(why?.table?.rows).toEqual([["2024-09-14", "LCK 2024 Regional Finals", "Faker", "T1", "Azir", "victoire", "3/0/4", "Conqueror"]]);
    expect(why?.sources).toEqual(["LCK/2024 Season/Regional Finals"]);
  } finally {
    db.close();
  }
});

test("a statistic the Riot data does not give is no zero", () => {
  const db = fresh();

  try {
    // plates is NULL in every game: the data does not measure it.
    const why = explainEmpty(db, scope(), PENTAS.replaceAll("penta_kills", "plates"));

    expect(why?.reason).toBe("unexplained");
    expect(why?.conclusive).toBe(false);
  } finally {
    db.close();
  }
});

test("a split the games are not in leaves no game", () => {
  const db = fresh();

  try {
    expect(explainEmpty(db, scope({ split: "Summer" }), PENTAS)?.summary).toBe("Aucune partie au split Summer aux Worlds en 2024 dans la base.");
  } finally {
    db.close();
  }
});

test("several players are not explained: their games together, or each one's own", () => {
  const db = fresh();

  try {
    const chovy: ResolvedPlayer = { ...faker, mention: "Chovy", player: "Chovy", matchedAlias: "Chovy" };

    expect(explainEmpty(db, scope({ players: [faker, chovy] }), PENTAS)).toBeNull();
  } finally {
    db.close();
  }
});

test("a team whose games are all in qualifiers gets one row per game", () => {
  const db = fresh();

  try {
    db.exec(`
      INSERT INTO teams VALUES(3,'Dplus KIA');
      INSERT INTO players(id,page) VALUES(3,'ShowMaker'),(4,'Canyon');
      INSERT INTO games(id,tournament_id,blue_team_id,red_team_id,winner_side,length_s,played_at) VALUES(4,1,3,1,2,1800,1726380000);
      INSERT INTO game_players(game_id,player_id,team_id,side,role,champion_id,win) VALUES(4,3,3,1,'Mid',3,0),(4,4,3,1,'Jungle',2,0),(4,1,1,2,'Mid',1,1);
    `);
    const why = explainEmpty(db, scope({ teams: [{ mention: "DK", team: "Dplus KIA", members: ["Dplus KIA"] }] }), "SELECT 1");

    expect(why?.reason).toBe("qualifier_only");
    expect(why?.table?.rows).toEqual([["2024-09-15", "LCK 2024 Regional Finals", "Dplus KIA", "T1", "T1"]]);
  } finally {
    db.close();
  }
});

test("a scope without any game says so", () => {
  const db = fresh();

  try {
    const why = explainEmpty(db, scope({ players: [faker], champion: champion("Ahri") }), "SELECT 1");

    expect(why?.reason).toBe("no_games");
    expect(why?.summary).toBe("Aucune partie de Faker sur Ahri aux Worlds en 2024 dans la base.");
  } finally {
    db.close();
  }
});

test("a question without any scope gets no explanation", () => {
  const db = fresh();

  try {
    expect(explainEmpty(db, scope({ league: null, leagueShort: null, yearFrom: null, yearTo: null }), PENTAS)).toBeNull();
  } finally {
    db.close();
  }
});

test("execute stops at the first empty generated query the scope explains", async () => {
  const db = fresh();

  try {
    const events: AgentEvent[] = [];
    const out = await execute(db, "quel champion a le plus de pentakills aux Worlds 2024", scope(), generated(PENTAS), (e) => events.push(e), []);
    const last: StepPart | undefined = events.flatMap((e) => (e.type === "step" ? [e.part] : [])).at(-1);

    expect(out.rows).toEqual([]);
    expect(out.plan.attempt).toBe(1);
    expect(out.empty?.reason).toBe("zero_count");
    expect(last?.status).toBe("warn");
    expect(last?.title).toBe("Aucun pentakill");
  } finally {
    db.close();
  }
});

test("the unrecognized words of the question are named, without the connectors", () => {
  expect(unrecognizedNote(scope(), ["vs", "lock"])).toBe("Mot non reconnu comme joueur, équipe ou champion : « lock ».");
  expect(unrecognizedNote(scope({ unresolved: ["Fakr"] }), ["lock"])).toBe("Mots non reconnus comme joueur, équipe ou champion : « Fakr », « lock ».");
  expect(unrecognizedNote(scope(), [])).toBeNull();
});
