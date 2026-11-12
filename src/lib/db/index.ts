import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SCHEMA_SQL } from "./schema";

export const DB_PATH = resolve(
  /*turbopackIgnore: true*/ process.cwd(),
  process.env.DATABASE_PATH ?? "data/lol.sqlite",
);

let cached: DatabaseSync | null = null;

export function openDb(): DatabaseSync {
  if (cached) return cached;
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA_SQL);
  cached = db;
  return db;
}

/** Table -> columns, read live from SQLite. Used by the schema guard. */
export function readSchema(db: DatabaseSync): Record<string, string[]> {
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )
    .all() as { name: string }[];
  const schema: Record<string, string[]> = {};
  for (const { name } of tables) {
    const cols = db.prepare(`PRAGMA table_info(${name})`).all() as {
      name: string;
    }[];
    schema[name] = cols.map((c) => c.name);
  }
  return schema;
}
