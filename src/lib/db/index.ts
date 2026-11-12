import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * The SQLite file is built by `bun run data:build` and shipped read-only: the
 * app never writes to it, so it opens on Vercel's read-only filesystem.
 */
export const DB_PATH = resolve(
  /*turbopackIgnore: true*/ process.cwd(),
  process.env.DATABASE_PATH || "data/lol.sqlite",
);

let cached: DatabaseSync | null = null;

export function openDb(): DatabaseSync {
  if (cached) return cached;
  try {
    cached = new DatabaseSync(DB_PATH, { readOnly: true });
  } catch (err) {
    throw new Error(`Cannot open ${DB_PATH} (${(err as Error).message}). Run \`bun run data:build\` first.`);
  }
  return cached;
}

/** Table or view -> columns, read live from SQLite. Used by the schema guard. */
export function readSchema(db: DatabaseSync): Record<string, string[]> {
  const objects = db
    .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  const schema: Record<string, string[]> = {};
  for (const { name } of objects) {
    const cols = db.prepare(`PRAGMA table_info("${name}")`).all() as { name: string }[];
    schema[name] = cols.map((c) => c.name);
  }
  return schema;
}
