import { say } from "../agent/messages";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { z } from "zod";
import { MAX_ROWS, VIEWS } from "../agent/guard";
import { DB_PATH, type SqlParams, type SqlRow } from "./index";
import { SCHEMA_VERSION } from "./schema";

export const SQL_TIMEOUT_MS = 4_000;
const MAX_RESULT_BYTES = 2_000_000;
const Result = z.object({ rows: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.null()]))).max(MAX_ROWS) });

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

/** Children running at once per instance: each holds its own SQLite page cache
 * and sort buffers for up to SQL_TIMEOUT_MS. Revisit if the function memory changes.
 */
export const MAX_SQL_CHILDREN = 3;
let running = 0;
const waiters: (() => void)[] = [];

/** Wait for a child slot, giving up at the query deadline or on abort. */
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

    // `release` hands its slot over without decrementing `running`.
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

/** Execute already guarded generated SQL outside the request-serving process.
 * The child gets neither application credentials nor network clients. Waiting
 * for a slot and running share one SQL_TIMEOUT_MS deadline.
 */
export async function executeGeneratedQuery(
  sql: string,
  params: SqlParams,
  { signal, databasePath = DB_PATH }: { signal?: AbortSignal; databasePath?: string } = {},
): Promise<SqlRow[]> {
  signal?.throwIfAborted();

  const deadline = Date.now() + SQL_TIMEOUT_MS;
  await acquire(signal, deadline);

  let released = false;

  const releaseOnce = () => {
    if (released) return;

    released = true;
    release();
  };

  return new Promise((resolveRows, reject) => {
    const childPath = resolve(/*turbopackIgnore: true*/ process.cwd(), "src/lib/db/sql-child.mjs");
    const args = process.versions.bun ? ["--no-env-file", childPath] : [childPath];

    const child = (() => {
      try {
        return spawn(process.execPath, args, {
          env: { NODE_ENV: "production", NODE_NO_WARNINGS: "1" },
          stdio: ["pipe", "pipe", "ignore"],
        });
      } catch (err) {
        // A synchronous spawn failure rejects the promise; free the slot first.
        releaseOnce();
        throw err;
      }
    })();

    let output = "";
    let error: Error | null = null;

    const kill = (reason: Error) => {
      error ??= reason;
      child.kill("SIGKILL");
    };

    const timer = setTimeout(() => kill(new SqlTimeoutError()), Math.max(1, deadline - Date.now()));
    const abort = () => kill(new DOMException("Request aborted", "AbortError"));
    signal?.addEventListener("abort", abort, { once: true });

    if (signal?.aborted) abort();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;

      if (Buffer.byteLength(output) > MAX_RESULT_BYTES + 10_000) kill(new Error("SQL result exceeds the response size limit."));
    });
    // A failed spawn can emit `error` without `close`: free the slot and settle here.
    child.on("error", (err) => {
      error ??= err;
      releaseOnce();
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.stdin.on("error", (err) => { error ??= err; });
    child.on("close", () => {
      releaseOnce();
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);

      if (error) return reject(error);

      try {
        const result = Result.safeParse(JSON.parse(output));

        if (!result.success) {
          // Only return the bounded SQLite error, never child stderr or environment.
          const failure = z.object({ error: z.string().max(2_000) }).safeParse(JSON.parse(output));

          return reject(new Error(failure.success ? failure.data.error : "SQL subprocess failed."));
        }

        resolveRows(result.data.rows);
      } catch {
        reject(new Error("SQL subprocess returned an invalid response."));
      }
    });
    child.stdin.end(JSON.stringify({ databasePath, schemaVersion: SCHEMA_VERSION, sql, params, objects: VIEWS, maxRows: MAX_ROWS, maxBytes: MAX_RESULT_BYTES }));
  });
}
