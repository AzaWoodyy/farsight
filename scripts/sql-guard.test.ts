import { afterAll, beforeAll, expect, test } from "bun:test";
import pg from "pg";
import { guardQuery, MAX_ROWS, VIEWS } from "../src/lib/agent/guard";
import { checkMigration, readSchema } from "../src/lib/db";
import { executeGeneratedQuery, MAX_SQL_CHILDREN, SqlTimeoutError, SQL_TIMEOUT_MS } from "../src/lib/db/generated-query";
import { createPool, numberParameters, type PgPool } from "../src/lib/db/postgres";
import { grantReaders } from "./db/migrations";
import { testDatabaseUrl, testDb, type TestDb } from "./fixtures/test-db";

/** A view over a table it hides, as v_game_players hides the base tables; 300 rows. */
let db: TestDb;
let pool: PgPool;
let schema: Record<string, string[]>;

beforeAll(async () => {
  db = await testDb({ empty: true });
  await db.exec(`CREATE TABLE players (id integer PRIMARY KEY, player text);
    CREATE VIEW v_game_players AS SELECT * FROM players;
    INSERT INTO players SELECT i, 'Player' || i FROM generate_series(0, 299) AS i;`);
  const admin = new pg.Client({ connectionString: testDatabaseUrl() });

  await admin.connect();
  await grantReaders(admin, db.schema, ["v_game_players"]).finally(() => admin.end());
  // Enough connections for every generated query at once, plus the one that waits for a slot.
  pool = createPool(testDatabaseUrl(), { schema: db.schema, max: MAX_SQL_CHILDREN + 2 });
  schema = await readSchema(db);
});

afterAll(async () => {
  await pool.end();
  await db.close();
});

test("guard rejects writes, unauthorized reads, server functions, recursive CTEs and wrapper escapes", () => {
  const rejected = [
    "INSERT INTO players VALUES (301, 'x')", "DELETE FROM players", "UPDATE players SET player = 'x'", "DROP VIEW v_game_players",
    "SELECT * FROM players", 'SELECT * FROM "players"', "SELECT count(*) FROM players", "SELECT count(*) FROM v_game_players a, players b",
    "SELECT * FROM v_game_players WHERE id IN (SELECT id FROM players)", "SELECT * FROM pg_catalog.pg_tables", "SELECT * FROM information_schema.tables",
    "SELECT pg_sleep(10)", 'SELECT "pg_sleep"(10)', "SELECT pg_read_file('/etc/passwd')", "SELECT set_config('statement_timeout', '0', false)",
    "SELECT current_setting('server_version')", "SELECT query_to_xml('SELECT * FROM players', true, true, '')", "SELECT version()",
    "SELECT player INTO copy_of_players FROM v_game_players", "SELECT player FROM v_game_players FOR UPDATE",
    "SELECT * FROM v_game_players; SELECT 1", "SELECT player FROM v_game_players) /*",
    "SELECT player FROM v_game_players /* unfinished", "SELECT 'unterminated", "SELECT (1", "SELECT 1)",
    "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<2) SELECT * FROM c",
    "SELECT * FROM generate_series(1, 1000000000)",
  ];

  for (const sql of rejected) expect(guardQuery(schema, sql, { objects: VIEWS }).ok, sql).toBe(false);

  const accepted = [
    "SELECT player FROM v_game_players", "SELECT REPLACE(player, 'a', 'b') AS release FROM v_game_players",
    "WITH c(x) AS (SELECT player FROM v_game_players) SELECT x FROM c", "SELECT '/*' AS value -- comment", "SELECT 'pg_sleep(1)' AS value",
    "SELECT player FROM v_game_players WHERE player IS DISTINCT FROM 'Player1'", "SELECT EXTRACT(YEAR FROM TIMESTAMP '2024-01-01') AS y FROM v_game_players",
    "SELECT player FROM v_game_players WHERE player ILIKE 'player1%' ORDER BY player NULLS FIRST",
  ];

  for (const sql of accepted) expect(guardQuery(schema, sql, { objects: VIEWS }).ok, sql).toBe(true);
});

test("the database refuses what the guard cannot see: base tables, writes and server functions, as the views-only role", async () => {
  await expect(executeGeneratedQuery("SELECT * FROM players", [], { pool })).rejects.toThrow(/not allowed|permission denied/i);
  await expect(executeGeneratedQuery("SELECT p.* FROM v_game_players v, players p", [], { pool })).rejects.toThrow(/not allowed|permission denied/i);
  await expect(executeGeneratedQuery("SELECT pg_read_file('/etc/passwd') AS f", [], { pool })).rejects.toThrow(/permission denied/i);
  // The wrapper makes any statement a SELECT of a subquery: a write cannot even be parsed there.
  await expect(executeGeneratedQuery("DELETE FROM v_game_players RETURNING *", [], { pool })).rejects.toThrow(/syntax error/i);
  expect(await executeGeneratedQuery("SELECT COUNT(*) AS games FROM v_game_players", [], { pool })).toEqual([{ games: 300 }]);
});

test("generated SQL caps rows and bytes on the server", async () => {
  const guarded = guardQuery(schema, "SELECT player FROM v_game_players", { objects: VIEWS });

  if (!guarded.ok) throw new Error(guarded.issues.join("; "));
  expect((await executeGeneratedQuery(guarded.sql, [], { pool })).length).toBe(MAX_ROWS);
  // An independent cap even for a query without the LIMIT wrapper.
  expect((await executeGeneratedQuery("SELECT player FROM v_game_players", [], { pool })).length).toBe(MAX_ROWS);
  await expect(executeGeneratedQuery("SELECT repeat('x', 3000000) AS big FROM v_game_players LIMIT 1", [], { pool })).rejects.toThrow(/size limit/);
});

test("an expensive generated query is cut by the statement timeout while the serving process stays responsive", async () => {
  let responsive = false;
  const timer = setTimeout(() => { responsive = true; }, 20);

  try {
    await expect(executeGeneratedQuery("SELECT count(*) AS n FROM v_game_players a, v_game_players b, v_game_players c, v_game_players d", [], { pool })).rejects.toBeInstanceOf(SqlTimeoutError);
    expect(responsive).toBe(true);
  } finally { clearTimeout(timer); }
}, SQL_TIMEOUT_MS + 6_000);

test("aborting a generated query rejects at once", async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 40);
  const started = performance.now();

  try {
    await expect(executeGeneratedQuery("SELECT count(*) AS n FROM v_game_players a, v_game_players b, v_game_players c, v_game_players d", [], { pool, signal: controller.signal })).rejects.toThrow(/aborted/i);
    expect(performance.now() - started).toBeLessThan(2_000);
  } finally { clearTimeout(timer); }
}, SQL_TIMEOUT_MS + 6_000);

const SLOW_SQL = "SELECT count(*) AS n FROM v_game_players a, v_game_players b, v_game_players c, v_game_players d";

test("generated queries beyond the cap wait and share the deadline", async () => {
  const slow = Array.from({ length: MAX_SQL_CHILDREN }, () => executeGeneratedQuery(SLOW_SQL, [], { pool }));
  // Trivial, but it waits for a slot until the shared deadline.
  const queued = executeGeneratedQuery("SELECT 1 AS n", [], { pool });
  const settled = await Promise.allSettled([...slow, queued]);

  for (const result of settled) {
    expect(result.status).toBe("rejected");

    if (result.status === "rejected") expect(result.reason).toBeInstanceOf(SqlTimeoutError);
  }

  // Every slot was released.
  expect(await executeGeneratedQuery("SELECT 1 AS n", [], { pool })).toEqual([{ n: 1 }]);
}, SQL_TIMEOUT_MS + 6_000);

test("aborting a queued generated query rejects without waiting", async () => {
  const slow = Array.from({ length: MAX_SQL_CHILDREN }, () => executeGeneratedQuery(SLOW_SQL, [], { pool }));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 40);
  const started = performance.now();

  try {
    await expect(executeGeneratedQuery("SELECT 1 AS n", [], { pool, signal: controller.signal })).rejects.toThrow(/aborted/i);
    expect(performance.now() - started).toBeLessThan(2_000);
  } finally {
    clearTimeout(timer);
    await Promise.allSettled(slow);
  }
}, SQL_TIMEOUT_MS + 6_000);

test("the app refuses a schema at another migration than the code's", async () => {
  await expect(checkMigration(pool)).rejects.toThrow(/schema_migrations|migration/);
  const other = await testDb();

  try {
    await expect(checkMigration(other.pool)).resolves.toBeUndefined();
    await other.exec("DELETE FROM schema_migrations");
    await expect(checkMigration(other.pool)).rejects.toThrow(/migration null; expected/);
  } finally {
    await other.close();
  }
});

test("parameters become $n, typed when they are numbers; literals, comments and casts are left alone", () => {
  expect(numberParameters("SELECT ':x', a::int, -- :y\n b FROM t WHERE c = :x AND d = :x AND e = :z", { x: 1, z: "s" })).toEqual({
    text: "SELECT ':x', a::int, -- :y\n b FROM t WHERE c = $1::integer AND d = $1::integer AND e = $2",
    values: [1, "s"],
  });
  expect(numberParameters("SELECT ? AS a, '?' AS b, ? AS c", [2.5, null])).toEqual({ text: "SELECT $1::double precision AS a, '?' AS b, $2 AS c", values: [2.5, null] });
  expect(() => numberParameters("SELECT :missing", {})).toThrow(/Missing SQL parameter/);
});
