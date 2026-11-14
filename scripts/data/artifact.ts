/**
 * The published database: release asset names, the manifest that describes
 * it, and the checks shared by `data:package` (before publishing) and
 * `data:pull` (after downloading).
 */
import { createHash } from "node:crypto";
import { closeSync, createReadStream, existsSync, openSync, readSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { selectAll, selectOne } from "../../src/lib/db";

/** Release tags are `data-YYYYMMDD`, with `-2`, `-3`… for a second run the same day. */
export const TAG_PREFIX = "data-";
export const MANIFEST_ASSET = "manifest.json";
export const DB_ASSET = "lol.sqlite.zst";

/**
 * In-game summaries (data/raw/ingame.jsonl, zstd): published with the
 * database so the weekly workflow only downloads the games it does not have.
 */
export const INGAME_ASSET = "ingame.jsonl.zst";

/** Database size above which `data:build` and `data:package` warn, and the hard limit. */
export const DB_WARN_BYTES = 170e6;
export const DB_MAX_BYTES = 190e6;

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);

export const Manifest = z.object({
  /** Version of this manifest's own shape. */
  format: z.literal(1),
  tag: z.string().regex(/^data-\d{8}(?:-\d+)?$/),
  schema_version: z.number().int().positive(),
  derive_version: z.number().int().positive().optional(),
  created_at: z.string(),
  /** Commit whose ingestion code built the file. */
  commit: z.string(),
  /** The uncompressed SQLite file, as the app opens it. */
  database: z.object({ file: z.string(), size: z.number().int().positive(), sha256: Sha256 }),
  /** The release asset (zstd-compressed database). */
  asset: z.object({
    file: z.literal(DB_ASSET),
    compression: z.literal("zstd"),
    size: z.number().int().positive(),
    sha256: Sha256,
  }),
  counts: z.object({
    games: z.number().int(),
    leagues: z.number().int(),
    tournaments: z.number().int(),
    players: z.number().int(),
    teams: z.number().int(),
    /** Games with in-game (Riot) stats; absent before schema v4. */
    ingame_games: z.number().int().optional(),
  }),
  /** The in-game summaries asset; absent before schema v4. */
  ingame: z
    .object({ file: z.literal(INGAME_ASSET), compression: z.literal("zstd"), size: z.number().int().positive(), sha256: Sha256, lines: z.number().int() })
    .optional(),
  ddragon_version: z.string().nullable(),
});

export type Manifest = z.infer<typeof Manifest>;

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");

  for await (const chunk of createReadStream(path)) hash.update(chunk);

  return hash.digest("hex");
}

/** Files SQLite leaves next to a database that is open or was not closed cleanly. */
export const SIDE_FILES = ["-journal", "-wal", "-shm"];

const N = z.object({ n: z.number() });
const count = (db: DatabaseSync, sql: string) => selectOne(db, N, sql)?.n ?? 0;

/** What the app needs to know about a database file before trusting it. */
export type DbFacts = {
  schemaVersion: number;
  journalMode: string;
  counts: Manifest["counts"];
  ddragonVersion: string | null;
  deriveVersion: number | null;
  staleDerive: number;
};

/** A release must contain summaries derived by one definition of the stats. */
export function derivationProblems(facts: Pick<DbFacts, "deriveVersion" | "staleDerive">, expected: number): string[] {
  const problems: string[] = [];

  if (facts.deriveVersion !== expected)
    problems.push(`build derive_version is ${facts.deriveVersion}, expected ${expected}: rebuild with current ingestion code`);

  if (facts.staleDerive > 0)
    problems.push(`${facts.staleDerive} summaries use an older DERIVE_VERSION: rerun data:fetch to recompute them from the raw cache`);

  return problems;
}

/** Reads the version, journal mode and headline counts of a database, read-only. */
export function readFacts(path: string): DbFacts {
  const db = new DatabaseSync(path, { readOnly: true });

  try {
    const schemaVersion = selectOne(db, z.object({ user_version: z.number() }), "PRAGMA user_version")?.user_version ?? 0;
    const journalMode = selectOne(db, z.object({ journal_mode: z.string() }), "PRAGMA journal_mode")?.journal_mode ?? "";
    const details = selectOne(db, z.object({ details: z.string().nullable() }), "SELECT details FROM ingest_runs WHERE kind = 'build' ORDER BY id DESC LIMIT 1")?.details;

    const metadata = details ? z.object({
      ddragon_version: z.string().optional(),
      derive_version: z.number().optional(),
      ingame: z.object({ stale_derive: z.number().optional() }).optional(),
    }).safeParse(JSON.parse(details)) : null;

    return {
      schemaVersion,
      journalMode,
      counts: {
        games: count(db, "SELECT COUNT(*) AS n FROM games"),
        leagues: count(db, "SELECT COUNT(DISTINCT t.league_id) AS n FROM games g JOIN tournaments t ON t.id = g.tournament_id"),
        tournaments: count(db, "SELECT COUNT(*) AS n FROM tournaments"),
        players: count(db, "SELECT COUNT(*) AS n FROM players"),
        teams: count(db, "SELECT COUNT(*) AS n FROM teams"),
        ingame_games: schemaVersion >= 4 ? count(db, "SELECT COUNT(*) AS n FROM game_riot") : undefined,
      },
      ddragonVersion: metadata?.success ? (metadata.data.ddragon_version ?? null) : null,
      deriveVersion: metadata?.success ? (metadata.data.derive_version ?? null) : null,
      staleDerive: metadata?.success ? (metadata.data.ingame?.stale_derive ?? 0) : 0,
    };
  } finally {
    db.close();
  }
}

/** `PRAGMA quick_check` (fast) or `integrity_check` (full): null when the file is sound. */
export function corruption(path: string, full: boolean): string | null {
  const db = new DatabaseSync(path, { readOnly: true });

  try {
    const rows = selectAll(db, z.record(z.string(), z.string()), full ? "PRAGMA integrity_check" : "PRAGMA quick_check");
    const messages = rows.flatMap((r) => Object.values(r));

    return messages.length === 1 && messages[0] === "ok" ? null : messages.slice(0, 5).join("; ");
  } finally {
    db.close();
  }
}

/**
 * Problems readable from the 100-byte file header, without opening SQLite: a
 * WAL database cannot be opened read-only without its -shm file, so this is
 * checked first. Byte 18 is the write version: 1 rollback journal, 2 WAL.
 */
export function headerProblems(path: string): string[] {
  const header = Buffer.alloc(100);
  const fd = openSync(path, "r");
  const read = readSync(fd, header, 0, 100, 0);
  closeSync(fd);

  if (read < 100 || header.toString("latin1", 0, 16) !== "SQLite format 3\0") return ["not a SQLite database"];

  if (header[18] === 2) return ["WAL mode (journal_mode=wal): rebuild it with journal_mode=DELETE, a WAL file can fail to open read-only"];

  return [];
}

/** Problems that make a database unusable by the app, or an empty list. */
export function usabilityProblems(path: string, expectedSchema: number): string[] {
  if (!existsSync(path)) return [`${path} does not exist`];

  const header = headerProblems(path);

  if (header.length > 0) return header;

  let facts: DbFacts;

  try {
    facts = readFacts(path);
  } catch (err) {
    return [`cannot be read (${err instanceof Error ? err.message : String(err)})`];
  }

  const problems: string[] = [];

  if (facts.schemaVersion !== expectedSchema)
    problems.push(`schema v${facts.schemaVersion}, the code expects v${expectedSchema}`);

  if (facts.journalMode !== "delete")
    problems.push(`journal_mode=${facts.journalMode}, expected delete (a WAL file can fail to open read-only)`);

  return problems;
}
