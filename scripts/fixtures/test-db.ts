import { randomBytes } from "node:crypto";
import pg from "pg";
import { type Db, type SqlInput } from "../../src/lib/db";
import { createPool, postgresDb } from "../../src/lib/db/postgres";
import { SCHEMA_VIEWS } from "../../src/lib/db/schema";
import { grantReaders, migrate, quoteIdent, readMigrations } from "../db/migrations";

export type TestDb = Db & {
  readonly schema: string;
  exec(sql: string): Promise<void>;
  run(sql: string, ...params: SqlInput[]): Promise<void>;
  close(): Promise<void>;
};

const migrations = readMigrations();

export const testDatabaseUrl = () => {
  const url = process.env.TEST_DATABASE_URL;

  if (!url) throw new Error("TEST_DATABASE_URL is not set: the tests need a Postgres server (docs/postgres.md).");

  return url;
};

export async function testDb({ empty = false }: { empty?: boolean } = {}): Promise<TestDb> {
  const url = testDatabaseUrl();
  const schema = `test_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: url });

  await admin.connect();

  try {
    await admin.query(`CREATE SCHEMA ${quoteIdent(schema)}`);
    await admin.query(`SET search_path TO ${quoteIdent(schema)}`);

    if (!empty) {
      await migrate(admin, migrations);
      await grantReaders(admin, schema, SCHEMA_VIEWS);
    }
  } finally {
    await admin.end();
  }

  const pool = createPool(url, { schema, max: 2 });
  const db = postgresDb(pool);

  return {
    ...db,
    schema,
    exec: async (sql) => {
      await pool.query(sql);
    },
    run: async (sql, ...params) => {
      await db.query(sql, params);
    },
    close: async () => {
      await pool.end();
      const drop = new pg.Client({ connectionString: url });

      await drop.connect();
      await drop.query(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`).finally(() => drop.end());
    },
  };
}
