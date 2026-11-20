/**
 * Postgres behind the Db interface. Two drivers, one Pool API:
 * - node-postgres over TCP, the default everywhere: on Vercel's Fluid compute an instance serves many requests and
 *   keeps its pool (attachDatabasePool closes idle connections before it is suspended), which is what Neon advises
 *   there, through the pooled (`-pooler`) host;
 * - Neon's serverless driver (a pool of WebSocket connections), for a runtime without TCP: `DATABASE_DRIVER=neon`.
 */
import { Pool as NeonPool } from "@neondatabase/serverless";
import { attachDatabasePool } from "@vercel/functions";
import pg from "pg";
import type { Db, SqlInput, SqlParams, SqlRow } from "./index";

/** The pool methods both drivers share and the app uses. */
export type PgPool = {
  query(text: string, values?: unknown[]): Promise<{ rows: SqlRow[] }>;
  connect(): Promise<PgClient>;
  end(): Promise<void>;
  on(event: "error", listener: (err: Error) => void): void;
  on(event: "release", listener: (err: Error | undefined, client?: PgClient) => void): void;
};

export type PgClient = { query(text: string, values?: unknown[]): Promise<{ rows: SqlRow[] }>; release(destroy?: boolean | Error): void };

const INT8 = 20;
const NUMERIC = 1700;

/**
 * COUNT and SUM come back as bigint and AVG as numeric, which node-postgres reads as strings; the app reads numbers,
 * as SQLite gave them. Every value of this database fits a double (counts, gold, seconds since 1970).
 */
const types = {
  getTypeParser: (oid: number, format?: "text" | "binary") => (oid === INT8 || oid === NUMERIC ? Number : pg.types.getTypeParser(oid, format)),
};

/** Neon's WebSocket driver only when DATABASE_DRIVER asks for it. */
export const usesNeonDriver = () => process.env.DATABASE_DRIVER === "neon";

/**
 * A pool for `url`. `schema` sets the search path of every connection (tests and the loader); without it the role's
 * own setting applies (db/roles.sql), which also holds behind a transaction-mode pooler.
 */
export function createPool(url: string, { schema, max = 5 }: { schema?: string; max?: number } = {}): PgPool {
  const config: pg.PoolConfig = { connectionString: url, max, idleTimeoutMillis: 10_000, types };

  if (schema) config.options = `-c search_path=${schema}`;

  const pool: PgPool = usesNeonDriver() ? new NeonPool(config) : new pg.Pool(config);

  // An idle connection the server or the network drops is an `error` event of the pool, which removes the client:
  // unheard, Node would end the instance and every request it serves.
  pool.on("error", (err) => console.error(`Postgres: idle connection lost (${err.message.slice(0, 200)})`));

  return pool;
}

/**
 * A number parameter carries its type: Postgres would infer it from its first use, and a parameter read in the select
 * list (`:minPicks AS min_picks`) would then be text everywhere else. Text and NULL keep the type of their context.
 */
const typed = (slot: number, value: SqlInput) => {
  if (!Number.isFinite(value)) return `$${slot}`;

  if (!Number.isInteger(value)) return `$${slot}::double precision`;

  return Math.abs(Number(value)) < 2 ** 31 ? `$${slot}::integer` : `$${slot}::bigint`;
};

/** A statement as Postgres takes it: `$n` placeholders and their values in order. */
export type Positional = { text: string; values: SqlInput[] };

/**
 * The SQL of the app writes its parameters `:name` (an object) or `?` (an array): Postgres numbers them `$1`, `$2`.
 * Literals, quoted identifiers, comments and `::` casts are left as they are.
 */
export function numberParameters(sql: string, params: SqlParams = []): Positional {
  const named = !Array.isArray(params);
  const values: SqlInput[] = [];
  const slots = new Map<string, number>();
  let text = "";
  let positional = 0;

  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];

    if (c === "'" || c === '"') {
      const end = closing(sql, i, c);
      text += sql.slice(i, end + 1);
      i = end;
    } else if (c === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      const stop = end < 0 ? sql.length : end;
      text += sql.slice(i, stop);
      i = stop - 1;
    } else if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      const stop = end < 0 ? sql.length : end + 2;
      text += sql.slice(i, stop);
      i = stop - 1;
    } else if (c === ":" && sql[i + 1] === ":") {
      text += "::";
      i++;
    } else if (named && c === ":" && /[A-Za-z_]/.test(sql[i + 1] ?? "")) {
      const name = /^[A-Za-z_]\w*/.exec(sql.slice(i + 1))![0];

      if (!(name in params)) throw new Error(`Missing SQL parameter :${name}`);
      let slot = slots.get(name);

      if (slot == null) {
        values.push(params[name]);
        slot = values.length;
        slots.set(name, slot);
      }

      text += typed(slot, params[name]);
      i += name.length;
    } else if (!named && c === "?") {
      if (positional >= params.length) throw new Error("Missing SQL parameter ?");
      values.push(params[positional++]);
      text += typed(values.length, values[values.length - 1]);
    } else text += c;
  }

  return { text, values };
}

/** Index of the quote that closes the literal or identifier opened at `start` (a doubled quote is part of it). */
function closing(sql: string, start: number, quote: string): number {
  for (let i = start + 1; i < sql.length; i++) {
    if (sql[i] !== quote) continue;

    if (sql[i + 1] === quote) {
      i++;
      continue;
    }

    return i;
  }

  return sql.length - 1;
}

/** A Db over a pool. `ready` runs once before the first query (the schema version check). */
export function postgresDb(pool: PgPool, ready?: () => Promise<void>): Db {
  let checked: Promise<void> | null = null;

  return {
    kind: "postgres",
    pool,
    query: async (sql, params) => {
      if (ready) {
        checked ??= ready();

        try {
          await checked;
        } catch (err) {
          // A failed check is not kept: the next query checks again.
          checked = null;
          throw err;
        }
      }

      const { text, values } = numberParameters(sql, params);

      return (await pool.query(text, values)).rows;
    },
  };
}

/** On Vercel, idle connections are closed before the instance is suspended (Fluid compute). */
export function attachToFunction(pool: PgPool) {
  if (process.env.VERCEL === "1") attachDatabasePool(pool);
}
