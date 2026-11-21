import { say } from "../agent/messages";
import { z } from "zod";
import { MAX_ROWS } from "../agent/guard";
import { openDb, type SqlParams, type SqlRow } from "./index";
import { numberParameters, type PgClient, type PgPool } from "./postgres";

export const SQL_TIMEOUT_MS = 4_000;
export const MAX_RESULT_BYTES = 2_000_000;

export const SQL_ROLE = "farsight_sql";

export class SqlTimeoutError extends Error {
  constructor() {
    super(
      say(
        "La requête SQL a dépassé le délai de 4 secondes. Précise une période ou un joueur, puis réessaie.",
        "The SQL query ran past its 4-second limit. Name a period or a player, then try again.",
      ),
    );
    this.name = "SqlTimeoutError";
  }
}

export const MAX_SQL_CHILDREN = 3;
let running = 0;
const waiters: (() => void)[] = [];

function acquire(signal: AbortSignal | undefined, deadline: number): Promise<void> {
  if (running < MAX_SQL_CHILDREN) {
    running++;

    return Promise.resolve();
  }

  return new Promise((resolveSlot, reject) => {
    const leave = (reason: Error) => {
      const index = waiters.indexOf(granted);

      if (index !== -1) waiters.splice(index, 1);
      cleanup();
      reject(reason);
    };

    const timer = setTimeout(() => leave(new SqlTimeoutError()), Math.max(1, deadline - Date.now()));
    const abort = () => leave(new DOMException("Request aborted", "AbortError"));

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };

    const granted = () => {
      cleanup();
      resolveSlot();
    };

    waiters.push(granted);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function release() {
  const next = waiters.shift();

  if (next) next();
  else running--;
}

const Line = z.object({ j: z.string().nullable(), total: z.number() });
const Row = z.record(z.string(), z.json());

const bounded = (sql: string, maxRows: number) => `WITH r AS (SELECT row_to_json(q)::text AS j FROM (\n${sql}\n) AS q LIMIT ${maxRows}),
s AS (SELECT j, octet_length(j) AS n, SUM(octet_length(j)) OVER (ROWS UNBOUNDED PRECEDING) AS total FROM r)
SELECT CASE WHEN total <= ${MAX_RESULT_BYTES} THEN j END AS j, total::bigint AS total FROM s WHERE total - n <= ${MAX_RESULT_BYTES}`;

function connectBy(pool: PgPool, deadline: number, signal: AbortSignal | undefined): Promise<PgClient> {
  return new Promise((resolveClient, reject) => {
    let settled = false;

    const finish = (fail?: Error) => {
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);

      if (fail) reject(fail);
    };

    const abort = () => finish(new DOMException("Request aborted", "AbortError"));
    const timer = setTimeout(() => finish(new SqlTimeoutError()), Math.max(1, deadline - Date.now()));

    signal?.addEventListener("abort", abort, { once: true });
    pool.connect().then(
      (client) => {
        if (settled) return client.release();
        finish();
        resolveClient(client);
      },
      (err: Error) => {
        if (!settled) finish(err);
      },
    );
  });
}

const MIN_RUN_MS = 100;

const QUERY_CANCELED = "57014";
const INSUFFICIENT_PRIVILEGE = "42501";

export async function executeGeneratedQuery(
  sql: string,
  params: SqlParams,
  { signal, pool = openDb().pool }: { signal?: AbortSignal; pool?: PgPool } = {},
): Promise<SqlRow[]> {
  signal?.throwIfAborted();

  const deadline = Date.now() + SQL_TIMEOUT_MS;
  await acquire(signal, deadline);
  let client: PgClient | null = null;
  let broken = false;

  const abort = () => {
    broken = true;
    client?.release(true);
    client = null;
  };

  try {
    if (deadline - Date.now() < MIN_RUN_MS) throw new SqlTimeoutError();
    signal?.throwIfAborted();
    client = await connectBy(pool, deadline, signal);
    signal?.addEventListener("abort", abort, { once: true });
    signal?.throwIfAborted();
    const remaining = Math.max(1, deadline - Date.now());
    const { text, values } = numberParameters(bounded(sql, MAX_ROWS), params);

    await client.query(`BEGIN READ ONLY; SET LOCAL statement_timeout = ${remaining}; SET LOCAL ROLE ${SQL_ROLE}`);
    const { rows } = await client.query(text, values);
    await client.query("ROLLBACK");
    const lines = z.array(Line).parse(rows);

    if (lines.some((l) => l.j == null)) throw new Error("SQL result exceeds the response size limit.");

    return lines.map((l) => Row.parse(JSON.parse(l.j!)));
  } catch (err) {
    if (signal?.aborted) throw new DOMException("Request aborted", "AbortError");

    if (err instanceof SqlTimeoutError) throw err;
    broken = true;
    const code = z.object({ code: z.string() }).safeParse(err).data?.code;

    if (code === QUERY_CANCELED) throw new SqlTimeoutError();

    const message = err instanceof Error ? err.message.slice(0, 2_000) : "SQL execution failed.";

    throw new Error(code === INSUFFICIENT_PRIVILEGE ? `Not allowed (generated queries read the v_* views only): ${message}` : message);
  } finally {
    signal?.removeEventListener("abort", abort);
    client?.release(broken);
    release();
  }
}
