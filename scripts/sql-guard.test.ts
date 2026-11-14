import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { guardQuery, MAX_ROWS, VIEWS } from "../src/lib/agent/guard";
import { executeGeneratedQuery, SqlTimeoutError } from "../src/lib/db/generated-query";
import { openReadOnlyDb, readSchema } from "../src/lib/db";
import { SCHEMA_VERSION } from "../src/lib/db/schema";

const temporary: string[] = [];

afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });

function fixture(count = 300) {
  const dir = mkdtempSync(join(tmpdir(), "sql-guard-"));
  temporary.push(dir);
  const path = join(dir, "lol.sqlite");
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA user_version=${SCHEMA_VERSION}; CREATE TABLE players (id INTEGER PRIMARY KEY, player TEXT); CREATE VIEW v_game_players AS SELECT * FROM players;`);
  const insert = db.prepare("INSERT INTO players VALUES (?, ?)");

  for (let i = 0; i < count; i++) insert.run(i, `Player${i}`);

  return { path, db, schema: readSchema(db) };
}

test("guard rejects writes, unauthorized reads, recursive CTEs and wrapper escapes", () => {
  const { db, schema } = fixture();

  try {
    const rejected = [
      "INSERT INTO players VALUES (301, 'x')", "DELETE FROM players", "PRAGMA user_version", "ATTACH ':memory:' AS other",
      "SELECT * FROM sqlite_master", "SELECT * FROM players", 'SELECT * FROM "players"',
      "SELECT count(*) FROM players", "SELECT count(*) FROM v_game_players a, players b",
      "SELECT * FROM v_game_players WHERE id IN (SELECT id FROM players)",
      "SELECT * FROM pragma_table_info('players')", "SELECT load_extension('x')", "SELECT readfile('/etc/passwd')",
      "SELECT * FROM v_game_players; SELECT 1", "SELECT player FROM v_game_players) /*",
      "SELECT player FROM v_game_players /* unfinished", "SELECT 'unterminated", "SELECT (1", "SELECT 1)",
      "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<2) SELECT * FROM c",
    ];

    for (const sql of rejected) expect(guardQuery(db, schema, sql, { objects: VIEWS }).ok, sql).toBe(false);

    const accepted = [
      "SELECT player FROM v_game_players", "SELECT REPLACE(player, 'a', 'b') AS release FROM v_game_players",
      "WITH c(x) AS (SELECT player FROM v_game_players) SELECT x FROM c", "SELECT '/*' AS value -- comment",
    ];

    for (const sql of accepted) expect(guardQuery(db, schema, sql, { objects: VIEWS }).ok, sql).toBe(true);
  } finally { db.close(); }
});

test("generated SQL caps rows and rejects huge allocations inside the child", async () => {
  const { db, path, schema } = fixture();

  try {
    const guarded = guardQuery(db, schema, "SELECT player FROM v_game_players", { objects: VIEWS });

    if (!guarded.ok) throw new Error(guarded.issues.join("; "));
    expect((await executeGeneratedQuery(guarded.sql, [], { databasePath: path })).length).toBe(MAX_ROWS);
    await expect(executeGeneratedQuery("SELECT length(zeroblob(1000000000)) AS bytes", [], { databasePath: path })).rejects.toThrow(/too big/);
    // Iteration is an independent cap even for a query without the LIMIT wrapper.
    expect((await executeGeneratedQuery("SELECT player FROM v_game_players", [], { databasePath: path })).length).toBe(MAX_ROWS);
    await expect(executeGeneratedQuery("SELECT * FROM players", [], { databasePath: path })).rejects.toThrow(/prohibited|authorized/);
  } finally { db.close(); }
});

test("an expensive generated query is killed while the serving process stays responsive", async () => {
  const { db, path } = fixture(1_000);
  db.close();
  let responsive = false;
  const timer = setTimeout(() => { responsive = true; }, 20);

  try {
    await expect(executeGeneratedQuery("SELECT count(*) AS n FROM v_game_players a, v_game_players b, v_game_players c, v_game_players d", [], { databasePath: path })).rejects.toBeInstanceOf(SqlTimeoutError);
    expect(responsive).toBe(true);
  } finally { clearTimeout(timer); }
}, 6_000);

test("aborting a generated query kills its child", async () => {
  const { db, path } = fixture(1_000);
  db.close();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 40);

  try {
    await expect(executeGeneratedQuery("SELECT count(*) AS n FROM v_game_players a, v_game_players b, v_game_players c", [], { databasePath: path, signal: controller.signal })).rejects.toThrow(/aborted/i);
  } finally { clearTimeout(timer); }
});


test("read-only opening checks the schema version and enforces SQLite length limits", () => {
  const { path, db } = fixture();
  const reader = openReadOnlyDb(path);

  try {
    expect(() => reader.prepare("SELECT zeroblob(1000000000)").get()).toThrow(/too big/);
    expect(() => reader.exec("DELETE FROM players")).toThrow(/readonly/);
  } finally { reader.close(); }

  db.exec(`PRAGMA user_version=${SCHEMA_VERSION - 1}`);
  db.close();
  expect(() => openReadOnlyDb(path)).toThrow(/schema version/);
});

test("the SQL child also runs under the Node production runtime", () => {
  const { db, path } = fixture();
  db.close();

  const result = spawnSync("node", ["src/lib/db/sql-child.mjs"], {
    input: JSON.stringify({ databasePath: path, schemaVersion: SCHEMA_VERSION, sql: "SELECT COUNT(*) AS games FROM v_game_players", params: [], objects: VIEWS, maxRows: MAX_ROWS, maxBytes: 2_000_000 }),
    encoding: "utf8",
    env: { NODE_ENV: "test", NODE_NO_WARNINGS: "1", PATH: process.env.PATH },
    timeout: 5_000,
  });

  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ rows: [{ games: 300 }] });
});
