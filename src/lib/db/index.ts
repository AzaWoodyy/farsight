import { z } from "zod";
import { attachToFunction, createPool, type PgPool, postgresDb } from "./postgres";
import { PG_MIGRATION_READ } from "./schema";

export type SqlValue = string | number | bigint | boolean | null | Uint8Array | SqlValue[] | { [key: string]: SqlValue };

export type SqlRow = Record<string, SqlValue>;

export type SqlInput = string | number | null;

export type SqlParams = Record<string, SqlInput> | SqlInput[];

export interface Db {
  readonly pool: PgPool;
  query(sql: string, params?: SqlParams): Promise<SqlRow[]>;
}

let cached: Db | null = null;

const Version = z.object({ version: z.number().nullable() });

export function openDb(): Db {
  if (cached) return cached;
  const url = process.env.DATABASE_URL;

  if (!url) throw new Error("DATABASE_URL is not set: the app reads Postgres (see docs/postgres.md).");
  const pool = createPool(url);

  attachToFunction(pool);
  cached = postgresDb(pool, () => checkMigration(pool));

  return cached;
}

export async function checkMigration(pool: PgPool): Promise<void> {
  const { rows } = await pool.query("SELECT MAX(version) AS version FROM schema_migrations");
  const version = Version.parse(rows[0] ?? { version: null }).version;

  if (version === null || version < PG_MIGRATION_READ) {
    throw new Error(`Database schema migration ${version}; expected ${PG_MIGRATION_READ} or later. Run \`bun run db:load\` (or db:migrate).`);
  }
}

export async function selectAll<S extends z.ZodType>(db: Db, schema: S, sql: string, params: SqlParams = []): Promise<z.infer<S>[]> {
  return z.array(schema).parse(await db.query(sql, params));
}

export async function selectOne<S extends z.ZodType>(db: Db, schema: S, sql: string, params: SqlParams = []): Promise<z.infer<S> | null> {
  const [row] = await db.query(sql, params);

  return row === undefined ? null : schema.parse(row);
}

const ColumnRow = z.object({ name: z.string(), column: z.string() });

export const CACHE_MS = 5 * 60_000;

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

export const readSchema = cachedRead(introspect);

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
