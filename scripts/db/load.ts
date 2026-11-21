import pg from "pg";
import { from as copyFrom } from "pg-copy-streams";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { DERIVE_VERSION } from "../data/ingame";
import { datasetProblems, photoLoss } from "../data/checks";
import { type Cell, deriveDataset } from "../data/derive";
import { SCHEMA_TABLES, SCHEMA_VERSION, SCHEMA_VIEWS } from "../../src/lib/db/schema";
import { grantReaders, migrate, quoteIdent } from "./migrations";

const args = process.argv.slice(2);
const option = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const schema = option("schema") ?? "farsight";
const limitMb = Number(process.env.DATABASE_SIZE_LIMIT_MB || 0);
const url = process.env.DATABASE_OWNER_URL || process.env.DATABASE_URL;

if (!url) throw new Error("Set DATABASE_OWNER_URL (or DATABASE_URL locally) to the owner's connection string.");

if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error(`Invalid schema name ${schema}`);

const field = (v: Cell) => (v == null ? "\\N" : String(v).replace(/\\/g, "\\\\").replace(/\t/g, "\\t").replace(/\n/g, "\\n").replace(/\r/g, "\\r"));

function* lines(rows: Cell[][], batch = 2_000) {
  for (let i = 0; i < rows.length; i += batch) yield `${rows.slice(i, i + batch).map((r) => r.map(field).join("\t")).join("\n")}\n`;
}

const seconds = (since: number) => `${((performance.now() - since) / 1000).toFixed(1)} s`;

const t0 = performance.now();
const startedAt = new Date().toISOString();
const derived = deriveDataset();
const derivedIn = seconds(t0);
const problems = datasetProblems(derived.tables, derived.report.ingame, { allowOlder: args.includes("--allow-older-summaries") });

if (problems.length && args.includes("--allow-incomplete")) console.warn(`db:load: loading despite ${problems.length} failed check(s):\n  - ${problems.join("\n  - ")}`);
else if (problems.length) throw new Error(`db:load: ${problems.length} check(s) failed, nothing written:\n  - ${problems.join("\n  - ")}`);

const client = new pg.Client({ connectionString: url });

await client.connect();

const liveBytes = Number((await client.query<{ bytes: string | null }>(
  `SELECT SUM(pg_total_relation_size(c.oid))::bigint::text AS bytes FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1`,
  [schema],
)).rows[0]?.bytes ?? 0);

const inPlace = args.includes("--in-place") || (limitMb > 0 && 2 * liveBytes > 0.9 * limitMb * 1e6);
const next = inPlace ? schema : `${schema}_next`;
const old = `${schema}_old`;

const liveExists = Boolean((await client.query("SELECT 1 FROM pg_namespace WHERE nspname = $1", [schema])).rowCount);

const METRICS = ["tournaments", "games", "player lines", "in-game games", "standings"] as const;

type LeagueCounts = Map<string, number[]>;

async function schemaCounts(name: string): Promise<LeagueCounts> {
  const s = quoteIdent(name);
  const inLeague = (table: string, alias: string, join: string) => `(SELECT COUNT(*)::integer FROM ${s}.${table} ${alias} ${join} WHERE t.league_id = l.id)`;
  const viaGame = `JOIN ${s}.games g ON g.id = x.game_id JOIN ${s}.tournaments t ON t.id = g.tournament_id`;

  const { rows } = await client.query<{ league: string; counts: number[] }>(
    `SELECT l.name AS league, ARRAY[
       ${inLeague("tournaments", "t", "")},
       ${inLeague("games", "g", `JOIN ${s}.tournaments t ON t.id = g.tournament_id`)},
       ${inLeague("game_players", "x", viaGame)},
       ${inLeague("game_riot", "x", viaGame)},
       ${inLeague("tournament_results", "x", `JOIN ${s}.tournaments t ON t.id = x.tournament_id`)}] AS counts
     FROM ${s}.leagues l`,
  );

  return new Map(rows.map((r) => [r.league, r.counts]));
}

function derivedCounts(): LeagueCounts {
  const rowsOf = (table: string) => {
    const t = derived.tables.get(table)!;

    return { col: (name: string) => t.columns.indexOf(name), rows: t.rows };
  };

  const leagues = rowsOf("leagues");
  const leagueName = new Map(leagues.rows.map((r) => [r[leagues.col("id")], String(r[leagues.col("name")])]));
  const tournaments = rowsOf("tournaments");
  const leagueOfTournament = new Map(tournaments.rows.map((r) => [r[tournaments.col("id")], leagueName.get(r[tournaments.col("league_id")])]));
  const games = rowsOf("games");
  const leagueOfGame = new Map(games.rows.map((r) => [r[games.col("id")], leagueOfTournament.get(r[games.col("tournament_id")])]));
  const counts: LeagueCounts = new Map([...leagueName.values()].map((name) => [name, METRICS.map(() => 0)]));

  const add = (league: string | undefined, metric: number) => {
    if (league != null) counts.get(league)![metric]++;
  };

  for (const r of tournaments.rows) add(leagueOfTournament.get(r[tournaments.col("id")]), 0);

  for (const r of games.rows) add(leagueOfGame.get(r[games.col("id")]), 1);

  for (const [metric, table, key] of [[2, "game_players", "game_id"], [3, "game_riot", "game_id"]] as const) {
    const t = rowsOf(table);

    for (const r of t.rows) add(leagueOfGame.get(r[t.col(key)]), metric);
  }

  const results = rowsOf("tournament_results");

  for (const r of results.rows) add(leagueOfTournament.get(r[results.col("tournament_id")]), 4);

  return counts;
}

function losses(live: LeagueCounts, fresh: LeagueCounts): string[] {
  return [...live].flatMap(([league, before]) =>
    METRICS.flatMap((metric, i) => {
      const after = fresh.get(league)?.[i] ?? 0;

      return after < before[i] ? [`${league}: ${metric} ${before[i]} → ${after}`] : [];
    }),
  );
}

const photoPlayersIn = async (name: string) =>
  (await client.query<{ n: number }>(`SELECT COUNT(DISTINCT player_id)::integer AS n FROM ${quoteIdent(name)}.player_images`)).rows[0].n;

function derivedPhotoPlayers(): number {
  const t = derived.tables.get("player_images")!;
  const at = t.columns.indexOf("player_id");

  return new Set(t.rows.map((r) => r[at])).size;
}

if (inPlace && liveExists && !args.includes("--allow-shrink")) {
  const lost = [...losses(await schemaCounts(schema), derivedCounts()), ...photoLoss(await photoPlayersIn(schema), derivedPhotoPlayers())];

  if (lost.length) {
    await client.end();
    throw new Error(`The derived data has less than the live data (${lost.join("; ")}); ${schema} is left as it was. Check the ingestion, or load with --allow-shrink.`);
  }
}

if (inPlace) console.warn(`in place: ${schema} is dropped before the load (${(liveBytes / 1e6).toFixed(0)} MB live${limitMb ? `, limit ${limitMb} MB` : ""}); the app has no data until it commits`);

try {
  await client.query(`DROP SCHEMA IF EXISTS ${quoteIdent(next)} CASCADE`);
  await client.query(`CREATE SCHEMA ${quoteIdent(next)}`);
  await client.query(`SET search_path TO ${quoteIdent(next)}`);
  await migrate(client);

  const copyStarted = performance.now();
  const rowCounts: Record<string, number> = {};

  await client.query("BEGIN");

  for (const [name, { columns, rows }] of derived.tables) {
    const stream = client.query(copyFrom(`COPY ${quoteIdent(name)} (${columns.map(quoteIdent).join(", ")}) FROM STDIN`));

    await pipeline(Readable.from(lines(rows)), stream);

    if (name !== "ingest_runs") rowCounts[name] = rows.length;
  }

  const insertRun = "INSERT INTO ingest_runs (kind, started_at, finished_at, schema_version, row_counts, details) VALUES ($1, $2, $3, $4, $5, $6)";

  for (const r of derived.runs)
    await client.query(insertRun, [r.kind, r.started_at, r.finished_at, SCHEMA_VERSION, JSON.stringify(r.row_counts), JSON.stringify({ requests: r.requests, cached_responses: r.cached_responses })]);

  await client.query(insertRun, [
    "build", startedAt, new Date().toISOString(), SCHEMA_VERSION,
    JSON.stringify(Object.fromEntries(SCHEMA_TABLES.filter((t) => t !== "ingest_runs").map((t) => [t, rowCounts[t] ?? 0]))),
    JSON.stringify({ target: "postgres", derive_version: DERIVE_VERSION, ddragon_version: derived.ddragonVersion, ...derived.report }),
  ]);
  await client.query("COMMIT");

  const copiedIn = seconds(copyStarted);
  const analyzeStarted = performance.now();

  await client.query("ANALYZE");
  await grantReaders(client, next, SCHEMA_VIEWS);
  const analyzedIn = seconds(analyzeStarted);

  if (!inPlace && !args.includes("--allow-shrink") && liveExists) {
    const lost = [...losses(await schemaCounts(schema), await schemaCounts(next)), ...photoLoss(await photoPlayersIn(schema), await photoPlayersIn(next))];

    if (lost.length) {
      await client.query(`DROP SCHEMA ${quoteIdent(next)} CASCADE`);
      throw new Error(`The staged data has less than the live data (${lost.join("; ")}); ${schema} is left as it was. Check the ingestion, or load with --allow-shrink.`);
    }
  }

  if (!inPlace) {
    await client.query("BEGIN");
    await client.query(`DROP SCHEMA IF EXISTS ${quoteIdent(old)} CASCADE`);
    const live = await client.query("SELECT 1 FROM pg_namespace WHERE nspname = $1", [schema]);

    if (live.rowCount) await client.query(`ALTER SCHEMA ${quoteIdent(schema)} RENAME TO ${quoteIdent(old)}`);
    await client.query(`ALTER SCHEMA ${quoteIdent(next)} RENAME TO ${quoteIdent(schema)}`);
    await client.query("COMMIT");
    await client.query(`DROP SCHEMA IF EXISTS ${quoteIdent(old)} CASCADE`);
  }

  const size = await client.query<{ schema: string; database: string }>(
    `SELECT SUM(pg_total_relation_size(c.oid))::bigint::text AS schema, pg_database_size(current_database())::text AS database
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind IN ('r', 'm')`,
    [schema],
  );

  const mb = (bytes: string) => `${(Number(bytes) / 1e6).toFixed(1)} MB`;

  console.log(`loaded schema ${schema} in ${seconds(t0)} (derive ${derivedIn}, copy ${copiedIn}, analyze and grants ${analyzedIn})`);
  console.log(`size: schema ${mb(size.rows[0].schema)} (tables and indexes), database ${mb(size.rows[0].database)}, schema v${SCHEMA_VERSION}${inPlace ? ", loaded in place" : ", swapped in"}; rows:`);
  console.log(rowCounts);
} catch (err) {
  await client.query("ROLLBACK").catch(() => {});
  throw err;
} finally {
  await client.end();
}
