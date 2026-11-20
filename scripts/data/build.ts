/**
 * data:build: rebuild the normalized SQLite file from the raw cache.
 *
 *   bun run data:build
 *
 * The file is recreated from scratch on every run (no migrations), finished
 * with `journal_mode=DELETE` + `VACUUM` so it opens on a read-only filesystem.
 * The rows come from scripts/data/derive.ts, which Postgres loads too (scripts/db/load.ts).
 */
import { mkdirSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { DB_MAX_BYTES, DB_WARN_BYTES } from "./artifact";
import { deriveDataset } from "./derive";
import { DERIVE_VERSION } from "./ingame";
import { createSchema, createQuerySchema, SCHEMA_TABLES } from "../../src/lib/db/schema";
import { sqliteOne as selectOne } from "./sqlite";
import { DB_FILE, SCHEMA_VERSION } from "./scope";

const t0 = Date.now();
const startedAt = new Date().toISOString();

mkdirSync(dirname(DB_FILE), { recursive: true });

for (const suffix of ["", "-journal", "-wal", "-shm"]) rmSync(DB_FILE + suffix, { force: true });

const db = new DatabaseSync(DB_FILE);

db.exec("PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;");

createSchema(db);

const derived = deriveDataset();
const { skipped_games: skippedGames, skipped_lines: skippedLines, item_icons: itemIcons, item_kinds: kindCounts, rune_sources: runeCounts, odd_rune_pages: oddRunePages, ingame: ingameCounts, from_riot: fromRiot, identity } = derived.report;

db.exec("BEGIN");

for (const [name, { columns, rows }] of derived.tables) {
  const insert = db.prepare(`INSERT INTO ${name} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`);

  for (const row of rows) insert.run(...row);
}

// Indexes and views -------------------------------------------------------------
createQuerySchema(db);

// Ingest metadata ---------------------------------------------------------------
const TABLES = SCHEMA_TABLES.filter((name) => name !== "ingest_runs");

const count = (sql: string) => selectOne(db, z.object({ n: z.number() }), sql)?.n ?? 0;
const rowCounts = Object.fromEntries(TABLES.map((t) => [t, count(`SELECT COUNT(*) AS n FROM ${t}`)]));
const insRun = db.prepare("INSERT INTO ingest_runs (kind, started_at, finished_at, schema_version, row_counts, details) VALUES (?,?,?,?,?,?)");

for (const r of derived.runs)
  insRun.run(
    String(r.kind), String(r.started_at), String(r.finished_at), SCHEMA_VERSION,
    JSON.stringify(r.row_counts),
    JSON.stringify({ requests: r.requests, cached_responses: r.cached_responses }),
  );

insRun.run(
  "build", startedAt, new Date().toISOString(), SCHEMA_VERSION, JSON.stringify(rowCounts),
  JSON.stringify({ derive_version: DERIVE_VERSION, ddragon_version: derived.ddragonVersion, ...derived.report }),
);

db.exec("COMMIT");

db.exec(`PRAGMA user_version=${SCHEMA_VERSION}; PRAGMA journal_mode=DELETE; ANALYZE; VACUUM;`);

const byLeague = db
  .prepare(
    `SELECT l.short_name AS league, COUNT(DISTINCT t.id) AS tournaments, COUNT(g.id) AS games, COUNT(gr.game_id) AS ingame
     FROM leagues l LEFT JOIN tournaments t ON t.league_id = l.id LEFT JOIN games g ON g.tournament_id = t.id
     LEFT JOIN game_riot gr ON gr.game_id = g.id
     GROUP BY l.id ORDER BY l.id`,
  )
  .all();

const journal = selectOne(db, z.object({ journal_mode: z.string() }), "PRAGMA journal_mode")?.journal_mode;

db.close();

console.log(`built ${DB_FILE} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

const dbSize = statSync(DB_FILE).size;

console.log(`size: ${(dbSize / 1e6).toFixed(1)} MB, journal_mode=${journal}, schema v${SCHEMA_VERSION}`);

if (dbSize > DB_WARN_BYTES)
  console.warn(
    `warning: ${(dbSize / 1e6).toFixed(1)} MB is ${dbSize > DB_MAX_BYTES ? "over" : "close to"} the ${DB_MAX_BYTES / 1e6} MB budget (data:package refuses more): the /api/ask function must stay under 250 MB`,
  );

console.log(`skipped: ${skippedGames} games, ${skippedLines} player lines (outside scope or duplicates)`);

console.log("rows:", rowCounts);

console.log("item icons:", itemIcons);

console.log("item kinds:", kindCounts);

console.log("runes:", runeCounts);

console.log(`rune pages of an unexpected length, left out: ${oddRunePages}`);

console.log("in-game:", ingameCounts);

console.log("filled from the Riot JSON (Leaguepedia had none):", fromRiot);

console.log("player links:", identity);

console.log("series without a scoreboard:", derived.report.schedule_series);

console.table(byLeague);
