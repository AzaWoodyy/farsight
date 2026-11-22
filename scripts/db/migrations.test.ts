import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import pg from "pg";
import { tableColumns } from "../data/derive";
import { createQuerySchema, createSchema, PG_MIGRATION, SCHEMA_OBJECTS } from "../../src/lib/db/schema";
import { testDatabaseUrl, testDb, type TestDb } from "../fixtures/test-db";
import { migrate, quoteIdent, readMigrations } from "./migrations";

describe("the Postgres schema is the SQLite one", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await testDb();
  });

  afterAll(() => db.close());

  test("same tables and views, same columns in the same order; the code reads the newest migration", async () => {
    const sqlite = new DatabaseSync(":memory:");

    createSchema(sqlite);
    createQuerySchema(sqlite);
    const lite = Object.fromEntries(SCHEMA_OBJECTS.map((name) => [name, sqlite.prepare(`SELECT * FROM ${name} LIMIT 0`).columns().map((c) => c.name)]));
    sqlite.close();

    const rows = await db.query(
      `SELECT table_name AS name, column_name AS column FROM information_schema.columns WHERE table_schema = current_schema() AND table_name <> 'schema_migrations' ORDER BY table_name, ordinal_position`,
    );

    const postgres: Record<string, string[]> = {};

    for (const r of rows) (postgres[String(r.name)] ??= []).push(String(r.column));

    expect(postgres).toEqual(lite);
    expect(readMigrations().at(-1)?.version).toBe(PG_MIGRATION);

    const tables = tableColumns();

    expect([...tables.keys()]).toEqual(SCHEMA_OBJECTS.filter((o) => !o.startsWith("v_")));

    for (const [name, { columns }] of tables) expect(columns, name).toEqual(postgres[name]);
  });

  test("flags and counts read as numbers, text sorts byte by byte as in SQLite", async () => {
    await db.exec("INSERT INTO teams(id, name) VALUES (1, 'b'), (2, 'B'), (3, 'a'), (4, 'É')");
    expect((await db.query("SELECT name FROM teams ORDER BY name")).map((r) => r.name)).toEqual(["B", "a", "b", "É"]);
    expect(await db.query("SELECT COUNT(*) AS n, AVG(id) AS mean, SUM(id) AS total FROM teams")).toEqual([{ n: 4, mean: 2.5, total: 10 }]);
  });
});

describe("migrations", () => {
  const dir = mkdtempSync(join(tmpdir(), "migrations-"));
  const schema = `test_migrate_${process.pid}`;
  let client: pg.Client;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: testDatabaseUrl() });
    await client.connect();
    await client.query(`CREATE SCHEMA ${quoteIdent(schema)}`);
    await client.query(`SET search_path TO ${quoteIdent(schema)}`);
  });

  afterAll(async () => {
    await client.query(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`);
    await client.end();
    rmSync(dir, { recursive: true, force: true });
  });

  test("apply in order once, refuse an applied file that changed, and roll a failing one back", async () => {
    writeFileSync(join(dir, "0001_first.sql"), "CREATE TABLE a (x integer);");
    writeFileSync(join(dir, "0002_second.sql"), "CREATE VIEW v AS SELECT x FROM a;");
    expect(await migrate(client, readMigrations(dir))).toEqual([1, 2]);
    expect(await migrate(client, readMigrations(dir))).toEqual([]);

    writeFileSync(join(dir, "0003_broken.sql"), "CREATE TABLE b (y integer); SELECT * FROM missing;");
    await expect(migrate(client, readMigrations(dir))).rejects.toThrow(/Migration 3 \(broken\) failed/);
    expect((await client.query("SELECT to_regclass('b') AS b")).rows[0].b).toBeNull();
    rmSync(join(dir, "0003_broken.sql"));

    writeFileSync(join(dir, "0001_first.sql"), "CREATE TABLE a (x integer, z integer);");
    await expect(migrate(client, readMigrations(dir))).rejects.toThrow(/changed after it was applied/);
  });

  test("inside the caller's transaction, the caller's rollback undoes every migration, a failed one included", async () => {
    const own = mkdtempSync(join(tmpdir(), "migrations-caller-"));
    const staged = `${schema}_caller`;
    const exists = async () => (await client.query("SELECT to_regnamespace($1) AS ns", [staged])).rows[0].ns != null;

    try {
      writeFileSync(join(own, "0001_first.sql"), "CREATE TABLE a (x integer);");
      writeFileSync(join(own, "0002_second.sql"), "CREATE VIEW v AS SELECT x FROM a;");
      await client.query("BEGIN");
      await client.query(`CREATE SCHEMA ${quoteIdent(staged)}`);
      await client.query(`SET LOCAL search_path TO ${quoteIdent(staged)}`);
      expect(await migrate(client, readMigrations(own), "caller")).toEqual([1, 2]);
      await client.query("ROLLBACK");
      expect(await exists()).toBe(false);

      writeFileSync(join(own, "0003_broken.sql"), "SELECT * FROM missing;");
      await client.query("BEGIN");
      await client.query(`CREATE SCHEMA ${quoteIdent(staged)}`);
      await client.query(`SET LOCAL search_path TO ${quoteIdent(staged)}`);
      await expect(migrate(client, readMigrations(own), "caller")).rejects.toThrow(/Migration 3 \(broken\) failed/);
      expect((await client.query("SELECT version FROM schema_migrations ORDER BY version")).rows.map((r) => r.version)).toEqual([1, 2]);
      await client.query("ROLLBACK");
      expect(await exists()).toBe(false);
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      await client.query(`SET search_path TO ${quoteIdent(schema)}`);
      rmSync(own, { recursive: true, force: true });
    }
  });

  test("file names are numbered without gaps", () => {
    const gaps = mkdtempSync(join(tmpdir(), "migrations-gap-"));

    try {
      writeFileSync(join(gaps, "0001_a.sql"), "SELECT 1;");
      writeFileSync(join(gaps, "0003_c.sql"), "SELECT 1;");
      expect(() => readMigrations(gaps)).toThrow(/without gaps/);
    } finally {
      rmSync(gaps, { recursive: true, force: true });
    }
  });
});
