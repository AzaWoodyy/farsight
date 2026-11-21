import pg from "pg";
import { migrate, quoteIdent } from "./migrations";

const schema = process.argv.find((a) => a.startsWith("--schema="))?.slice(9) ?? "farsight";
const url = process.env.DATABASE_OWNER_URL || process.env.DATABASE_URL;

if (!url) throw new Error("Set DATABASE_OWNER_URL (or DATABASE_URL locally) to the owner's connection string.");

const client = new pg.Client({ connectionString: url });

await client.connect();

try {
  const exists = await client.query("SELECT 1 FROM pg_namespace WHERE nspname = $1", [schema]);

  if (!exists.rowCount) throw new Error(`Schema ${schema} does not exist: run \`bun run db:load\` first.`);
  await client.query(`SET search_path TO ${quoteIdent(schema)}`);
  const done = await migrate(client);

  console.log(done.length ? `applied migrations ${done.join(", ")} to ${schema}` : `${schema} is up to date`);
} finally {
  await client.end();
}
