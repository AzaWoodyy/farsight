/**
 * data:package: check the database built by `data:build`, then write the
 * release assets (zstd-compressed file, manifest, release notes).
 *
 *   bun run data:package --tag=data-20261113
 *   bun run data:package --tag=data-20261113 --previous=prev/manifest.json --out=data/release
 *
 * Fails (exit 1) without writing anything when a check does not pass, so the
 * workflow never publishes a broken or truncated file. `--previous` compares
 * the counts with the last published release to catch a partial ingestion.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { constants, zstdCompressSync } from "node:zlib";
import { z } from "zod";
import { selectAll } from "../../src/lib/db";
import { DB_ASSET, MANIFEST_ASSET, Manifest, SIDE_FILES, TAG_PREFIX, corruption, headerProblems, readFacts, sha256File } from "./artifact";
import { DB_FILE, LEAGUES, SCHEMA_VERSION } from "./scope";

const args = process.argv.slice(2);
const arg = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

const tag = arg("tag");
const previousFile = arg("previous");
const outDir = resolve(arg("out") ?? "data/release");

/** The Vercel function cap is 250 MB with dependencies (about 35 MB today). */
const MAX_DB_BYTES = 200 * 1024 * 1024;

/** A new release may lose a few games to wiki edits, not more. */
const MIN_GAMES_RATIO = 0.98;

/** Tables and views the app reads (tools, schema guard, views). */
const REQUIRED = [
  "leagues", "tournaments", "teams", "players", "player_aliases", "champions", "items", "runes",
  "tournament_results", "games", "game_draft", "game_players", "game_player_items", "ingest_runs",
  "v_tournaments", "v_tournament_results", "v_games", "v_game_players", "v_draft", "v_player_items",
];

/** Rows pointing at a parent that does not exist. */
const ORPHANS: [string, string][] = [
  ["tournaments without league", "SELECT COUNT(*) AS n FROM tournaments t LEFT JOIN leagues l ON l.id = t.league_id WHERE l.id IS NULL"],
  ["games without tournament", "SELECT COUNT(*) AS n FROM games g LEFT JOIN tournaments t ON t.id = g.tournament_id WHERE t.id IS NULL"],
  ["player lines without game", "SELECT COUNT(*) AS n FROM game_players gp LEFT JOIN games g ON g.id = gp.game_id WHERE g.id IS NULL"],
  ["player lines without player", "SELECT COUNT(*) AS n FROM game_players gp LEFT JOIN players p ON p.id = gp.player_id WHERE p.id IS NULL"],
  ["draft rows without champion", "SELECT COUNT(*) AS n FROM game_draft d LEFT JOIN champions c ON c.id = d.champion_id WHERE c.id IS NULL"],
  ["item rows without item", "SELECT COUNT(*) AS n FROM game_player_items gi LEFT JOIN items i ON i.id = gi.item_id WHERE i.id IS NULL"],
  ["aliases without player", "SELECT COUNT(*) AS n FROM player_aliases a LEFT JOIN players p ON p.id = a.player_id WHERE p.id IS NULL"],
];

function fail(problems: string[]): never {
  console.error(`data:package: ${problems.length} check(s) failed, nothing written:\n  - ${problems.join("\n  - ")}`);
  process.exit(1);
}

if (!tag || !tag.startsWith(TAG_PREFIX)) fail([`--tag=${TAG_PREFIX}YYYYMMDD is required`]);

if (!existsSync(DB_FILE)) fail([`${DB_FILE} is missing: run \`bun run data:build\` first`]);

// --- Checks -------------------------------------------------------------------

const problems: string[] = [];
const size = statSync(DB_FILE).size;

for (const suffix of SIDE_FILES)
  if (existsSync(DB_FILE + suffix)) problems.push(`${basename(DB_FILE)}${suffix} exists: the file is open or was not closed cleanly`);

if (size > MAX_DB_BYTES) problems.push(`${(size / 1e6).toFixed(1)} MB is over the ${MAX_DB_BYTES / 1e6} MB limit`);

const header = headerProblems(DB_FILE);

if (header.length > 0) fail([...problems, ...header]);

const broken = corruption(DB_FILE, true);

if (broken) problems.push(`integrity_check: ${broken}`);

const facts = readFacts(DB_FILE);

if (facts.schemaVersion !== SCHEMA_VERSION) problems.push(`user_version is ${facts.schemaVersion}, scope.ts says v${SCHEMA_VERSION}`);

if (facts.journalMode !== "delete") problems.push(`journal_mode=${facts.journalMode}, expected delete`);

const db = new DatabaseSync(DB_FILE, { readOnly: true });
const Name = z.object({ name: z.string() });
const objects = new Set(selectAll(db, Name, "SELECT name FROM sqlite_master WHERE type IN ('table', 'view')").map((o) => o.name));

for (const name of REQUIRED) {
  if (!objects.has(name)) {
    problems.push(`missing table or view ${name}`);
    continue;
  }

  try {
    db.prepare(`SELECT * FROM "${name}" LIMIT 1`).all();
  } catch (err) {
    problems.push(`${name} cannot be read: ${err instanceof Error ? err.message : String(err)}`);
  }
}

if (problems.length === 0) {
  for (const [label, sql] of ORPHANS) {
    const n = selectAll(db, z.object({ n: z.number() }), sql)[0]?.n ?? 0;

    if (n > 0) problems.push(`${n} ${label}`);
  }

  const fk = db.prepare("PRAGMA foreign_key_check").all();

  if (fk.length > 0) problems.push(`foreign_key_check: ${fk.length} violation(s)`);

  const emptyLeagues = selectAll(
    db,
    Name,
    `SELECT l.name FROM leagues l
     WHERE NOT EXISTS (SELECT 1 FROM games g JOIN tournaments t ON t.id = g.tournament_id WHERE t.league_id = l.id)`,
  ).map((l) => l.name);

  if (emptyLeagues.length > 0) problems.push(`leagues without any game: ${emptyLeagues.join(", ")}`);

  if (facts.counts.leagues !== LEAGUES.length) problems.push(`${facts.counts.leagues} leagues with games, scope has ${LEAGUES.length}`);
}

db.close();

if (previousFile) {
  const previous = Manifest.parse(JSON.parse(readFileSync(previousFile, "utf8")));
  const min = Math.floor(previous.counts.games * MIN_GAMES_RATIO);

  if (facts.counts.games < min)
    problems.push(`${facts.counts.games} games, previous release ${previous.tag} had ${previous.counts.games} (minimum ${min})`);

  if (facts.counts.leagues < previous.counts.leagues)
    problems.push(`${facts.counts.leagues} leagues, previous release ${previous.tag} had ${previous.counts.leagues}`);
}

if (problems.length > 0) fail(problems);

// --- Assets -------------------------------------------------------------------

const raw = readFileSync(DB_FILE);
const compressed = zstdCompressSync(raw, { params: { [constants.ZSTD_c_compressionLevel]: 19 } });

mkdirSync(outDir, { recursive: true });

const assetPath = resolve(outDir, DB_ASSET);

writeFileSync(assetPath, compressed);

const commit = process.env.GITHUB_SHA || execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();

const manifest = Manifest.parse({
  format: 1,
  tag,
  schema_version: facts.schemaVersion,
  created_at: new Date().toISOString(),
  commit,
  database: { file: basename(DB_FILE), size, sha256: await sha256File(DB_FILE) },
  asset: { file: DB_ASSET, compression: "zstd", size: compressed.length, sha256: await sha256File(assetPath) },
  counts: facts.counts,
  ddragon_version: facts.ddragonVersion,
});

writeFileSync(resolve(outDir, MANIFEST_ASSET), `${JSON.stringify(manifest, null, 2)}\n`);

const mb = (n: number) => `${(n / 1e6).toFixed(1)} MB`;

writeFileSync(
  resolve(outDir, "notes.md"),
  [
    `SQLite database, schema v${manifest.schema_version}, built from commit ${commit.slice(0, 7)}.`,
    "",
    `- ${manifest.counts.games} games, ${manifest.counts.leagues} leagues, ${manifest.counts.tournaments} tournaments, ${manifest.counts.players} players`,
    `- \`${DB_ASSET}\`: ${mb(manifest.asset.size)} (zstd), ${mb(size)} uncompressed`,
    `- sha256 (uncompressed): \`${manifest.database.sha256}\``,
    `- Data Dragon ${manifest.ddragon_version ?? "unknown"}`,
    "",
    "Data: [Leaguepedia](https://lol.fandom.com) (CC BY-SA 3.0) and Riot Data Dragon.",
    "",
  ].join("\n"),
);

console.log(`data:package: ${tag}, schema v${manifest.schema_version}, ${manifest.counts.games} games, ${manifest.counts.leagues} leagues`);

console.log(`  ${assetPath}: ${mb(manifest.asset.size)} (from ${mb(size)})`);

console.log(`  sha256 ${manifest.database.sha256}`);
