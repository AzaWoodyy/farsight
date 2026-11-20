/** Synchronous reads of a local SQLite file, for the scripts that build and check the Data release file. */
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { z } from "zod";

type Params = Record<string, SQLInputValue> | SQLInputValue[];

/** Runs a query and parses every row with `schema`. */
export function sqliteAll<S extends z.ZodType>(db: DatabaseSync, schema: S, sql: string, params: Params = []): z.infer<S>[] {
  const stmt = db.prepare(sql);

  return z.array(schema).parse(Array.isArray(params) ? stmt.all(...params) : stmt.all(params));
}

/** First row parsed with `schema`, or null when the query returns nothing. */
export function sqliteOne<S extends z.ZodType>(db: DatabaseSync, schema: S, sql: string, params: Params = []): z.infer<S> | null {
  const stmt = db.prepare(sql);
  const row = Array.isArray(params) ? stmt.get(...params) : stmt.get(params);

  return row === undefined ? null : schema.parse(row);
}
