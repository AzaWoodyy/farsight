import { Pool as NeonPool } from "@neondatabase/serverless";
import { attachDatabasePool } from "@vercel/functions";
import pg from "pg";
import type { Db, SqlInput, SqlParams, SqlRow } from "./index";

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

const types = {
  getTypeParser: (oid: number, format?: "text" | "binary") => (oid === INT8 || oid === NUMERIC ? Number : pg.types.getTypeParser(oid, format)),
};

export const usesNeonDriver = () => process.env.DATABASE_DRIVER === "neon";

export function createPool(url: string, { schema, max = 5 }: { schema?: string; max?: number } = {}): PgPool {
  const config: pg.PoolConfig = { connectionString: url, max, idleTimeoutMillis: 10_000, types };

  if (schema) config.options = `-c search_path=${schema}`;

  const pool: PgPool = usesNeonDriver() ? new NeonPool(config) : new pg.Pool(config);

  pool.on("error", (err) => console.error(`Postgres: idle connection lost (${err.message.slice(0, 200)})`));

  return pool;
}

const typed = (slot: number, value: SqlInput) => {
  if (!Number.isFinite(value)) return `$${slot}`;

  if (!Number.isInteger(value)) return `$${slot}::double precision`;

  return Math.abs(Number(value)) < 2 ** 31 ? `$${slot}::integer` : `$${slot}::bigint`;
};

export type Positional = { text: string; values: SqlInput[] };

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

export function postgresDb(pool: PgPool, ready?: () => Promise<void>): Db {
  let checked: Promise<void> | null = null;

  return {
    pool,
    query: async (sql, params) => {
      if (ready) {
        checked ??= ready();

        try {
          await checked;
        } catch (err) {
          checked = null;
          throw err;
        }
      }

      const { text, values } = numberParameters(sql, params);

      return (await pool.query(text, values)).rows;
    },
  };
}

export function attachToFunction(pool: PgPool) {
  if (process.env.VERCEL === "1") attachDatabasePool(pool);
}
