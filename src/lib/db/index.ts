import { z } from "zod";
import { attachToFunction, createPool, type PgPool, postgresDb } from "./postgres";
import { PG_MIGRATION } from "./schema";

/** A value read from the database; an aggregated JSON column comes back as arrays and objects. */
export type SqlValue = string | number | bigint | boolean | null | Uint8Array | SqlValue[] | { [key: string]: SqlValue };

/** A row: column name -> value. */
export type SqlRow = Record<string, SqlValue>;

/** A value a query is given. */
export type SqlInput = string | number | null;

/** Named parameters (`:name`) or positional ones (`?`). */
export type SqlParams = Record<string, SqlInput> | SqlInput[];

/** The read side of the database, the only one the app sees. Every call is asynchronous: the database is remote. */
export interface Db {
  /** The connections behind it: generated queries borrow one for their own read-only transaction. */
  readonly pool: PgPool;
  /** Every row of one read-only statement. */
  query(sql: string, params?: SqlParams): Promise<SqlRow[]>;
}

let cached: Db | null = null;

const Version = z.object({ version: z.number().nullable() });

/**
 * The database of the deployment: Postgres at DATABASE_URL, as the read-only app role (db/roles.sql). The schema it
 * holds must be the one this code was written for: the newest migration applied is PG_MIGRATION.
 */
export function openDb(): Db {
  if (cached) return cached;
  const url = process.env.DATABASE_URL;

  if (!url) throw new Error("DATABASE_URL is not set: the app reads Postgres (see docs/postgres.md).");
  const pool = createPool(url);

  attachToFunction(pool);
  cached = postgresDb(pool, () => checkMigration(pool));

  return cached;
}

/** The newest migration applied to the schema on the search path must be PG_MIGRATION. */
export async function checkMigration(pool: PgPool): Promise<void> {
  const { rows } = await pool.query("SELECT MAX(version) AS version FROM schema_migrations");
  const version = Version.parse(rows[0] ?? { version: null }).version;

  if (version !== PG_MIGRATION) throw new Error(`Database schema migration ${version}; expected ${PG_MIGRATION}. Run \`bun run db:load\` (or db:migrate).`);
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

const ColumnRow = z.object({ name: z.string(), column: z.string() });

/** How long a value read once per handle is kept: db:load replaces the data without a redeployment. */
export const CACHE_MS = 5 * 60_000;

/**
 * `read(db)`, kept per handle for CACHE_MS, so a warm instance reads a reloaded database within minutes. A failed read
 * is not kept: the next question tries again.
 */
export function cachedRead<T>(read: (db: Db) => Promise<T>): (db: Db) => Promise<T> {
  const cache = new WeakMap<Db, { value: Promise<T>; at: number }>();

  return (db) => {
    const hit = cache.get(db);

    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
    const value = read(db);

    value.catch(() => cache.delete(db));
    cache.set(db, { value, at: Date.now() });

    return value;
  };
}

/** Table or view -> columns, read once per handle and kept for CACHE_MS. Used by the guard and the router. */
export const readSchema = cachedRead(introspect);

/** One query for every table and view of the schema on the search path, columns in their order. */
async function introspect(db: Db): Promise<Record<string, string[]>> {
  const rows = await selectAll(
    db,
    ColumnRow,
    `SELECT c.table_name AS name, c.column_name AS column FROM information_schema.columns c
     WHERE c.table_schema = current_schema() AND c.table_name <> 'schema_migrations'
     ORDER BY c.table_name, c.ordinal_position`,
  );

  return Object.fromEntries([...Map.groupBy(rows, (r) => r.name)].map(([name, cols]) => [name, cols.map((c) => c.column)]));
}
