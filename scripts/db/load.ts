/**
 * db:load: (re)build the Postgres database from the raw cache, the Postgres counterpart of data:build.
 *
 *   bun run db:load                       DATABASE_OWNER_URL (else DATABASE_URL), schema "farsight"
 *   bun run db:load --schema=farsight_ci  another schema (tests, a side-by-side trial)
 *
 * The rows come from scripts/data/derive.ts, as for the SQLite file. They are copied (COPY) into a fresh schema
 * `<schema>_next` built by every migration, analyzed and granted to the app roles, then swapped in by two renames in
 * one transaction: readers see the old data until the commit, then the new data, never a half-loaded schema. The old
 * schema is dropped afterwards. Connect as the owner role, without a transaction pooler (Neon: the direct host).
 *
 * The swap holds two copies of the data for the time of the load. Where the storage cannot (Neon's free plan: 1 GB for
 * a database of about 570 MB), `--in-place` drops the live schema first and loads it again under the same name: one
 * copy, but the app has no data until the load commits. DATABASE_SIZE_LIMIT_MB picks it when the swap would not fit.
 */
import pg from "pg";
import { from as copyFrom } from "pg-copy-streams";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { DERIVE_VERSION } from "../data/ingame";
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

/** A value in COPY's text format: `\N` for NULL, backslash escapes for the characters that would split a row. */
const field = (v: Cell) => (v == null ? "\\N" : String(v).replace(/\\/g, "\\\\").replace(/\t/g, "\\t").replace(/\n/g, "\\n").replace(/\r/g, "\\r"));

function* lines(rows: Cell[][], batch = 2_000) {
  for (let i = 0; i < rows.length; i += batch) yield `${rows.slice(i, i + batch).map((r) => r.map(field).join("\t")).join("\n")}\n`;
}

const seconds = (since: number) => `${((performance.now() - since) / 1000).toFixed(1)} s`;

const t0 = performance.now();
const startedAt = new Date().toISOString();
const derived = deriveDataset();
const derivedIn = seconds(t0);
const client = new pg.Client({ connectionString: url });

await client.connect();

const liveBytes = Number((await client.query<{ bytes: string | null }>(
  `SELECT SUM(pg_total_relation_size(c.oid))::bigint::text AS bytes FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1`,
  [schema],
)).rows[0]?.bytes ?? 0);

// Two copies of about the live size must fit, with a tenth to spare.
const inPlace = args.includes("--in-place") || (limitMb > 0 && 2 * liveBytes > 0.9 * limitMb * 1e6);
const next = inPlace ? schema : `${schema}_next`;
const old = `${schema}_old`;

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

  // Recorded as `build`, as data:build does: the day of this run is the data's day (src/lib/db/release.ts).
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

  // The swap: two renames in one transaction, then the old schema goes.
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
