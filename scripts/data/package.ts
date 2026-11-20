/**
 * data:package: check the database built by `data:build`, then write the
 * release assets (zstd-compressed file, manifest, release notes).
 *
 *   bun run data:package --check-only  (all checks, no release assets)
 *   bun run data:package --tag=data-20261113
 *   bun run data:package --tag=data-20261113 --previous=prev/manifest.json --out=data/release
 *
 * Fails (exit 1) without writing anything when a check does not pass, so the
 * workflow never publishes a broken or truncated file. `--previous` compares
 * the counts with the last published release to catch a partial ingestion.
 *
 * Sizes: the database must stay under 190 MB (warning from 170 MB) so the
 * /api/ask function stays under Vercel's 250 MB (`bun run size` checks it
 * after `next build`).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { constants, zstdCompressSync } from "node:zlib";
import { z } from "zod";
import { sqliteAll as selectAll } from "./sqlite";
import {
  DB_ASSET,
  DB_MAX_BYTES,
  DB_WARN_BYTES,
  INGAME_ASSET,
  MANIFEST_ASSET,
  Manifest,
  SIDE_FILES,
  corruption,
  derivationProblems,
  headerProblems,
  readFacts,
  regressionProblems,
  sha256File,
} from "./artifact";
import { loadIngame } from "./riot";
import { DERIVE_VERSION } from "./ingame";
import { SCHEMA_OBJECTS } from "../../src/lib/db/schema";
import { DB_FILE, INGAME_FILE, LEAGUES, SCHEMA_VERSION } from "./scope";

const args = process.argv.slice(2);
const arg = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

const checkOnly = args.includes("--check-only");
const tag = arg("tag");
const previousFile = arg("previous");
const outDir = resolve(arg("out") ?? "data/release");

/** Tables and views the app reads (tools, schema guard, views). */
const REQUIRED = SCHEMA_OBJECTS;

/** Rows pointing at a parent that does not exist. */
const ORPHANS: [string, string][] = [
  ["tournaments without league", "SELECT COUNT(*) AS n FROM tournaments t LEFT JOIN leagues l ON l.id = t.league_id WHERE l.id IS NULL"],
  ["games without tournament", "SELECT COUNT(*) AS n FROM games g LEFT JOIN tournaments t ON t.id = g.tournament_id WHERE t.id IS NULL"],
  ["player lines without game", "SELECT COUNT(*) AS n FROM game_players gp LEFT JOIN games g ON g.id = gp.game_id WHERE g.id IS NULL"],
  ["player lines without player", "SELECT COUNT(*) AS n FROM game_players gp LEFT JOIN players p ON p.id = gp.player_id WHERE p.id IS NULL"],
  ["draft rows without champion", "SELECT COUNT(*) AS n FROM game_draft d LEFT JOIN champions c ON c.id = d.champion_id WHERE c.id IS NULL"],
  ["item rows without item", "SELECT COUNT(*) AS n FROM game_player_items gi LEFT JOIN items i ON i.id = gi.item_id WHERE i.id IS NULL"],
  ["aliases without player", "SELECT COUNT(*) AS n FROM player_aliases a LEFT JOIN players p ON p.id = a.player_id WHERE p.id IS NULL"],
  ["photos without player", "SELECT COUNT(*) AS n FROM player_images i LEFT JOIN players p ON p.id = i.player_id WHERE p.id IS NULL"],
  ["in-game games without game", "SELECT COUNT(*) AS n FROM game_riot r LEFT JOIN games g ON g.id = r.game_id WHERE g.id IS NULL"],
  ["in-game player rows without player line", "SELECT COUNT(*) AS n FROM game_player_stats s LEFT JOIN game_players gp ON gp.game_id = s.game_id AND gp.player_id = s.player_id WHERE gp.game_id IS NULL"],
  ["in-game team rows without game", "SELECT COUNT(*) AS n FROM game_team_stats s LEFT JOIN game_riot r ON r.game_id = s.game_id WHERE r.game_id IS NULL"],
];

function fail(problems: string[]): never {
  console.error(`data:package: ${problems.length} check(s) failed, nothing written:\n  - ${problems.join("\n  - ")}`);
  process.exit(1);
}

if ((!checkOnly && !tag) || (tag != null && !/^data-\d{8}(?:-\d+)?$/.test(tag))) fail(["--tag=data-YYYYMMDD (optional numeric suffix) is required"]);

if (!existsSync(DB_FILE)) fail([`${DB_FILE} is missing: run \`bun run data:build\` first`]);

// --- Checks -------------------------------------------------------------------

const problems: string[] = [];
const size = statSync(DB_FILE).size;

for (const suffix of SIDE_FILES)
  if (existsSync(DB_FILE + suffix)) problems.push(`${basename(DB_FILE)}${suffix} exists: the file is open or was not closed cleanly`);

if (size > DB_MAX_BYTES) problems.push(`${(size / 1e6).toFixed(1)} MB is over the ${DB_MAX_BYTES / 1e6} MB limit (the /api/ask function must stay under 250 MB)`);
else if (size > DB_WARN_BYTES) console.warn(`data:package: warning, the database is ${(size / 1e6).toFixed(1)} MB, close to the ${DB_MAX_BYTES / 1e6} MB limit`);

if (!existsSync(INGAME_FILE)) problems.push(`${INGAME_FILE} is missing: run \`bun run data:fetch\` first`);

const header = headerProblems(DB_FILE);

if (header.length > 0) fail([...problems, ...header]);

const broken = corruption(DB_FILE, true);

if (broken) problems.push(`integrity_check: ${broken}`);

const facts = readFacts(DB_FILE);

if (facts.schemaVersion !== SCHEMA_VERSION) problems.push(`user_version is ${facts.schemaVersion}, schema.ts says v${SCHEMA_VERSION}`);

problems.push(...derivationProblems(facts, DERIVE_VERSION, { allowOlder: checkOnly }));

if (checkOnly && facts.olderDerive > 0)
  console.warn(`package: ${facts.olderDerive} in-game summaries predate DERIVE_VERSION ${DERIVE_VERSION} (without the fields later versions added); a release refuses them`);

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

  const emptyLeagues = selectAll(
    db,
    Name,
    `SELECT l.name FROM leagues l
     WHERE NOT EXISTS (SELECT 1 FROM games g JOIN tournaments t ON t.id = g.tournament_id WHERE t.league_id = l.id)`,
  ).map((l) => l.name);

  if (emptyLeagues.length > 0) problems.push(`leagues without any game: ${emptyLeagues.join(", ")}`);

  if (facts.counts.leagues !== LEAGUES.length) problems.push(`${facts.counts.leagues} leagues with games, scope has ${LEAGUES.length}`);

  // The pinned CI snapshot predates the photos: its offline rebuild has none, a release must have them.
  if (!facts.counts.players_with_photo) {
    if (checkOnly) console.warn("package: no player photo (raw cache without player_images.json); a release refuses this");
    else problems.push("no player photo: data:fetch did not save player_images.json");
  }

  // Same for the team abbreviations (schema v10): understand reads them as aliases ("KCB").
  if (!facts.counts.teams_with_short) {
    if (checkOnly) console.warn("package: no team abbreviation (raw cache without teams.json); a release refuses this");
    else problems.push("no team abbreviation: data:fetch did not save teams.json");
  }

  // Same for the series known only from the schedule (schema v11): several hundred in the scope.
  if (!facts.counts.schedule_series) {
    if (checkOnly) console.warn("package: no series without a scoreboard (raw cache without schedule.json); a release refuses this");
    else problems.push("no series without a scoreboard: data:fetch did not save schedule.json");
  }
}

db.close();

if (previousFile) {
  const previous = Manifest.parse(JSON.parse(readFileSync(previousFile, "utf8")));
  problems.push(...regressionProblems(facts.counts, previous, { allowIngameDrop: args.includes("--allow-ingame-drop") }));
}

if (problems.length > 0) fail(problems);

if (checkOnly) {
  console.log(`data:package: checks passed, schema v${facts.schemaVersion}, ${facts.counts.games} games; no assets written`);
  process.exit(0);
}

// --- Assets -------------------------------------------------------------------

const raw = readFileSync(DB_FILE);
const compressed = zstdCompressSync(raw, { params: { [constants.ZSTD_c_compressionLevel]: 19 } });

mkdirSync(outDir, { recursive: true });

const assetPath = resolve(outDir, DB_ASSET);

writeFileSync(assetPath, compressed);

// One line per game (the file is append-only and may repeat a game).
const ingameRaw = Buffer.from([...loadIngame(INGAME_FILE).values()].map((l) => `${JSON.stringify(l)}\n`).join(""));
const ingamePath = resolve(outDir, INGAME_ASSET);

writeFileSync(ingamePath, zstdCompressSync(ingameRaw, { params: { [constants.ZSTD_c_compressionLevel]: 19 } }));

const ingameLines = ingameRaw.toString("utf8").split("\n").filter(Boolean).length;

const commit = process.env.GITHUB_SHA || execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();

const manifest = Manifest.parse({
  format: 1,
  tag,
  schema_version: facts.schemaVersion,
  derive_version: DERIVE_VERSION,
  created_at: new Date().toISOString(),
  commit,
  database: { file: basename(DB_FILE), size, sha256: await sha256File(DB_FILE) },
  asset: { file: DB_ASSET, compression: "zstd", size: compressed.length, sha256: await sha256File(assetPath) },
  counts: facts.counts,
  ingame: { file: INGAME_ASSET, compression: "zstd", size: statSync(ingamePath).size, sha256: await sha256File(ingamePath), lines: ingameLines },
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
    `- ${manifest.counts.ingame_games ?? 0} games with in-game stats (Riot data on Leaguepedia; none for the LPL)`,
    `- ${manifest.counts.players_with_photo ?? 0} players with a photo: Leaguepedia file names and dates only, the images (fair use, Riot Games and the leagues) are not included`,
    `- ${manifest.counts.teams_with_short ?? 0} teams with their Leaguepedia abbreviation`,
    `- ${manifest.counts.schedule_series ?? 0} series known only from Leaguepedia's match schedule (result, no game statistic)`,
    `- \`${INGAME_ASSET}\`: in-game summaries (${ingameLines} lines), read back by the next weekly run`,
    `- \`${DB_ASSET}\`: ${mb(manifest.asset.size)} (zstd), ${mb(size)} uncompressed`,
    `- sha256 (uncompressed): \`${manifest.database.sha256}\``,
    `- Data Dragon ${manifest.ddragon_version ?? "unknown"}`,
    "",
    "Data: [Leaguepedia](https://lol.fandom.com) (CC BY-SA 3.0), Riot game data hosted on Leaguepedia, and Riot Data Dragon.",
    "",
  ].join("\n"),
);

console.log(`data:package: ${tag}, schema v${manifest.schema_version}, ${manifest.counts.games} games, ${manifest.counts.leagues} leagues`);

console.log(`  ${assetPath}: ${mb(manifest.asset.size)} (from ${mb(size)})`);

console.log(`  sha256 ${manifest.database.sha256}`);
