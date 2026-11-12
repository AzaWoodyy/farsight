import { resolve } from "node:path";
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";
import { z } from "zod";

/**
 * The SQLite file is built by `bun run data:build` and shipped read-only: the
 * app never writes to it, so it opens on Vercel's read-only filesystem.
 */
export const DB_PATH = resolve(
  /*turbopackIgnore: true*/ process.cwd(),
  process.env.DATABASE_PATH || "data/lol.sqlite",
);

/** A value read from SQLite. */
export type SqlValue = SQLOutputValue;

/** A row as node:sqlite returns it: column name -> value. */
export type SqlRow = Record<string, SqlValue>;

/** Named parameters (`:name`) or positional ones (`?`). */
export type SqlParams = Record<string, SQLInputValue> | SQLInputValue[];

let cached: DatabaseSync | null = null;

export function openDb(): DatabaseSync {
  if (cached) return cached;

  try {
    cached = new DatabaseSync(DB_PATH, { readOnly: true });
  } catch (err) {
    throw new Error(`Cannot open ${DB_PATH} (${err instanceof Error ? err.message : String(err)}). Run \`bun run data:build\` first.`);
  }

  return cached;
}

/** Runs a query and parses every row with `schema`, so callers get typed rows. */
export function selectAll<S extends z.ZodType>(db: DatabaseSync, schema: S, sql: string, params: SqlParams = []): z.infer<S>[] {
  const stmt = db.prepare(sql);

  return z.array(schema).parse(Array.isArray(params) ? stmt.all(...params) : stmt.all(params));
}

/** First row parsed with `schema`, or null when the query returns nothing. */
export function selectOne<S extends z.ZodType>(db: DatabaseSync, schema: S, sql: string, params: SqlParams = []): z.infer<S> | null {
  const stmt = db.prepare(sql);
  const row = Array.isArray(params) ? stmt.get(...params) : stmt.get(params);

  return row === undefined ? null : schema.parse(row);
}

const NameRow = z.object({ name: z.string() });

/** Table or view -> columns, read live from SQLite. Used by the schema guard. */
export function readSchema(db: DatabaseSync): Record<string, string[]> {
  const objects = selectAll(
    db,
    NameRow,
    "SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'",
  );

  return Object.fromEntries(
    objects.map(({ name }) => [name, selectAll(db, NameRow, `PRAGMA table_info("${name}")`).map((c) => c.name)]),
  );
}
