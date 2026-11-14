/**
 * size: measures what the /api/ask function ships, from the traces `next build`
 * writes (the route's own .nft.json plus the Next server's), and the database
 * on its own. Runs after `next build` (see the `build` script) and fails the
 * build above the limits, so a deployment never hits Vercel's 250 MB cap.
 *
 *   bun run size
 *
 * Budget: database under 190 MB (warning from 170 MB), function under 250 MB
 * uncompressed (warning from 225 MB).
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { z } from "zod";
import { DB_MAX_BYTES, DB_WARN_BYTES } from "./data/artifact";

const ROOT = resolve(import.meta.dirname, "..");
const NEXT = resolve(ROOT, ".next");
const FUNCTION_MAX_BYTES = 250e6;
const FUNCTION_WARN_BYTES = 225e6;

const TRACES = [resolve(NEXT, "server/app/api/ask/route.js.nft.json"), resolve(NEXT, "next-server.js.nft.json")];

const Trace = z.object({ files: z.array(z.string()) });
const mb = (n: number) => `${(n / 1e6).toFixed(1)} MB`;

const missing = TRACES.filter((t) => !existsSync(t));

if (missing.length) {
  console.warn(`size: no trace at ${missing.map((m) => relative(ROOT, m)).join(", ")}; run \`next build\` first. Nothing measured.`);
  process.exit(0);
}

const files = new Set<string>();

for (const trace of TRACES) {
  files.add(trace.replace(/\.nft\.json$/, ""));

  for (const f of Trace.parse(JSON.parse(readFileSync(trace, "utf8"))).files) files.add(resolve(dirname(trace), f));
}

const groups = new Map<string, number>();
let total = 0;
let db = 0;

for (const file of files) {
  if (!existsSync(file)) continue;
  const st = statSync(file);

  if (!st.isFile()) continue;
  total += st.size;
  const rel = relative(ROOT, file);
  const group = rel.startsWith("node_modules/") ? rel.split("/").slice(0, rel.split("/")[1].startsWith("@") ? 3 : 2).join("/") : rel.split("/").slice(0, 2).join("/");
  groups.set(group, (groups.get(group) ?? 0) + st.size);

  if (rel === "data/lol.sqlite") db = st.size;
}

console.log(`size: /api/ask function ${mb(total)} uncompressed (${files.size} traced files), database ${mb(db)}`);

for (const [group, bytes] of [...groups].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`  ${mb(bytes).padStart(9)}  ${group}`);

const problems: string[] = [];

if (db === 0) problems.push("data/lol.sqlite is not in the /api/ask trace (outputFileTracingIncludes)");

if (db > DB_MAX_BYTES) problems.push(`database ${mb(db)} over the ${mb(DB_MAX_BYTES)} budget`);
else if (db > DB_WARN_BYTES) console.warn(`size: warning, database ${mb(db)} close to the ${mb(DB_MAX_BYTES)} budget`);

if (total > FUNCTION_MAX_BYTES) problems.push(`function ${mb(total)} over Vercel's ${mb(FUNCTION_MAX_BYTES)} limit`);
else if (total > FUNCTION_WARN_BYTES) console.warn(`size: warning, function ${mb(total)} close to Vercel's ${mb(FUNCTION_MAX_BYTES)} limit`);

if (problems.length) {
  console.error(`size: ${problems.join("; ")}`);
  process.exit(1);
}
