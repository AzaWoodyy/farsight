import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { SCHEMA_VERSION } from "./schema";

/**
 * The SQLite file is built by `bun run data:build` and shipped read-only: the
 * app never writes to it, so it opens on Vercel's read-only filesystem.
 */
export const DB_PATH = resolve(
  /*turbopackIgnore: true*/ process.cwd(),
  process.env.DATABASE_PATH || "data/lol.sqlite",
);

/** A value read from the database; an aggregated JSON column comes back as arrays and objects. */
export type SqlValue = string | number | bigint | boolean | null | Uint8Array | SqlValue[] | { [key: string]: SqlValue };

/** A row: column name -> value. */
export type SqlRow = Record<string, SqlValue>;

/** A value a query is given. */
export type SqlInput = string | number | bigint | null;

/** Named parameters (`:name`) or positional ones (`?`). */
export type SqlParams = Record<string, SqlInput> | SqlInput[];

/** The read side of the database, the only one the app sees. Every call is asynchronous: the database may be remote. */
export interface Db {
  readonly kind: "sqlite" | "postgres";
  /** Every row of one read-only statement. */
  query(sql: string, params?: SqlParams): Promise<SqlRow[]>;
}

/** A synchronous SQLite handle behind the asynchronous interface. */
export function sqliteDb(db: DatabaseSync): Db {
  return {
    kind: "sqlite",
    query: async (sql, params = []) => {
      const stmt = db.prepare(sql);

      return Array.isArray(params) ? stmt.all(...params) : stmt.all(params);
    },
  };
}

let cached: Db | null = null;

/** Validate a file before caching it; usable by offline verification too. */
export function openReadOnlyDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path, { readOnly: true, limits: { length: 1_000_000 } });

  try {
    if (!db.limits || db.limits.length > 1_000_000)
      throw new Error("SQLite length limit unavailable; Node >=24.15 is required.");
    const version = db.prepare("PRAGMA user_version").get()?.user_version;

    if (version !== SCHEMA_VERSION)
      throw new Error(`Database schema version ${version}; expected ${SCHEMA_VERSION}. Run data:pull --force or rebuild the database.`);

    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}

export function openDb(): Db {
  if (cached) return cached;

  try {
    cached = sqliteDb(openReadOnlyDb(DB_PATH));
  } catch (err) {
    throw new Error(`Cannot open ${DB_PATH} (${err instanceof Error ? err.message : String(err)}). Run \`bun run data:build\` first.`);
  }

  return cached;
}

/** Runs a query and parses every row with `schema`, so callers get typed rows. */
export async function selectAll<S extends z.ZodType>(db: Db, schema: S, sql: string, params: SqlParams = []): Promise<z.infer<S>[]> {
  return z.array(schema).parse(await db.query(sql, params));
}

/** First row parsed with `schema`, or null when the query returns nothing. */
export async function selectOne<S extends z.ZodType>(db: Db, schema: S, sql: string, params: SqlParams = []): Promise<z.infer<S> | null> {
  const [row] = await db.query(sql, params);

  return row === undefined ? null : schema.parse(row);
}

const NameRow = z.object({ name: z.string() });

const schemas = new WeakMap<Db, Promise<Record<string, string[]>>>();

/**
 * Table or view -> columns, read from the database once per handle: the schema of a deployment does not change
 * under it (a new schema is a new deployment). Used by the schema guard and the router.
 */
export function readSchema(db: Db): Promise<Record<string, string[]>> {
  let schema = schemas.get(db);

  if (!schema) {
    schema = introspect(db);
    // A failed read is not kept: the next question tries again.
    schema.catch(() => schemas.delete(db));
    schemas.set(db, schema);
  }

  return schema;
}

async function introspect(db: Db): Promise<Record<string, string[]>> {
  const objects = await selectAll(
    db,
    NameRow,
    "SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'",
  );

  return Object.fromEntries(
    await Promise.all(objects.map(async ({ name }) => [name, (await selectAll(db, NameRow, `PRAGMA table_info("${name}")`)).map((c) => c.name)] as const)),
  );
}
