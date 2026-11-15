import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { selectOne } from "./index";

/** What the running site says about its database: enough to tell releases apart, nothing more. */
export type DatabaseHealth = { schemaVersion: number; games: number; builtAt: string | null };

/** Schema version, game count and end of the build of an open database (read-only). */
export function databaseHealth(db: DatabaseSync): DatabaseHealth {
  const version = selectOne(db, z.object({ user_version: z.number().int() }), "PRAGMA user_version");
  const games = selectOne(db, z.object({ n: z.number().int() }), "SELECT COUNT(*) AS n FROM games");

  const build = selectOne(
    db,
    z.object({ finished_at: z.string() }),
    "SELECT finished_at FROM ingest_runs WHERE kind = 'build' ORDER BY id DESC LIMIT 1",
  );

  return { schemaVersion: version?.user_version ?? 0, games: games?.n ?? 0, builtAt: build?.finished_at ?? null };
}
