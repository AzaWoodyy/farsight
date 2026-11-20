/** A fresh, empty database for one test: every table and view of the schema, no row. */
import { DatabaseSync } from "node:sqlite";
import { type Db, type SqlInput, sqliteDb } from "../../src/lib/db";
import { createQuerySchema, createSchema } from "../../src/lib/db/schema";

export type TestDb = Db & {
  /** Statements without parameters (seeding), run in order. */
  exec(sql: string): Promise<void>;
  /** One statement with positional parameters. */
  run(sql: string, ...params: SqlInput[]): Promise<void>;
  close(): Promise<void>;
};

/** `views: false` creates the tables only. */
export async function testDb({ views = true }: { views?: boolean } = {}): Promise<TestDb> {
  const sqlite = new DatabaseSync(":memory:");
  createSchema(sqlite);

  if (views) createQuerySchema(sqlite);

  return {
    ...sqliteDb(sqlite),
    exec: async (sql) => sqlite.exec(sql),
    run: async (sql, ...params) => {
      sqlite.prepare(sql).run(...params);
    },
    close: async () => sqlite.close(),
  };
}
