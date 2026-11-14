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
    super("La requête SQL a dépassé le délai de 4 secondes. Précise une période ou un joueur, puis réessaie.");
    this.name = "SqlTimeoutError";
  }
}

/** Execute already guarded generated SQL outside the request-serving process.
 * The child gets neither application credentials nor network clients.
 */
export function executeGeneratedQuery(
  sql: string,
  params: SqlParams,
  { signal, databasePath = DB_PATH }: { signal?: AbortSignal; databasePath?: string } = {},
): Promise<SqlRow[]> {
  signal?.throwIfAborted();

  return new Promise((resolveRows, reject) => {
    const childPath = resolve(/*turbopackIgnore: true*/ process.cwd(), "src/lib/db/sql-child.mjs");
    const args = process.versions.bun ? ["--no-env-file", childPath] : [childPath];

    const child = spawn(process.execPath, args, {
      env: { NODE_ENV: "production", NODE_NO_WARNINGS: "1" },
      stdio: ["pipe", "pipe", "ignore"],
    });

    let output = "";
    let error: Error | null = null;

    const kill = (reason: Error) => {
      error ??= reason;
      child.kill("SIGKILL");
    };

    const timer = setTimeout(() => kill(new SqlTimeoutError()), SQL_TIMEOUT_MS);
    const abort = () => kill(new DOMException("Request aborted", "AbortError"));
    signal?.addEventListener("abort", abort, { once: true });

    if (signal?.aborted) abort();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;

      if (Buffer.byteLength(output) > MAX_RESULT_BYTES + 10_000) kill(new Error("SQL result exceeds the response size limit."));
    });
    child.on("error", (err) => { error ??= err; });
    child.stdin.on("error", (err) => { error ??= err; });
    child.on("close", () => {
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
