/**
 * size: measures what the /api/ask function ships and fails the build above
 * the limits, so a deployment never hits Vercel's 250 MB cap. Runs after
 * `next build` (see the `build` script).
 *
 *   bun run size
 *
 * Sources, most exact first:
 * - after `vercel build`: the function Vercel assembled
 *   (.vercel/output/functions/api/ask.func: its own files plus the
 *   `filePathMap` of .vc-config.json), when it is newer than the route trace;
 * - otherwise the traces `next build` writes: the route's own .nft.json plus
 *   the Next server's. A plain `next build` traces the full server
 *   (next-server.js.nft.json); on Vercel (and in `vercel build`) Next traces
 *   the minimal server instead (next-minimal-server.js.nft.json).
 *
 * The Vercel cloud build writes neither server trace before the build command
 * ends: the function is then measured from the route trace alone, which holds
 * the database and nearly all of the size (the minimal server adds under
 * 1 MB). Without the route trace there is nothing to measure: a warning, and
 * the build goes on.
 *
 * Budget: database under 190 MB (warning from 170 MB), function under 250 MB
 * uncompressed (warning from 225 MB).
 */
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { z } from "zod";
import { DB_MAX_BYTES, DB_WARN_BYTES } from "./data/artifact";

const ROOT = resolve(import.meta.dirname, "..");
const NEXT = resolve(ROOT, ".next");
const FUNCTION_MAX_BYTES = 250e6;
const FUNCTION_WARN_BYTES = 225e6;

const ROUTE_TRACE = resolve(NEXT, "server/app/api/ask/route.js.nft.json");
const SERVER_TRACES = [resolve(NEXT, "next-server.js.nft.json"), resolve(NEXT, "next-minimal-server.js.nft.json")];
const VERCEL_FUNC = resolve(ROOT, ".vercel/output/functions/api/ask.func");

const Trace = z.object({ files: z.array(z.string()) });
const VcConfig = z.object({ filePathMap: z.record(z.string(), z.string()).default({}) });

/** Where the measured files come from, and the files themselves. */
type Measure = { source: string; files: string[] };

const mb = (n: number) => `${(n / 1e6).toFixed(1)} MB`;

/** Files a .nft.json trace lists, plus the traced file itself. */
function traced(trace: string): string[] {
  const files = Trace.parse(JSON.parse(readFileSync(trace, "utf8"))).files.map((f) => resolve(dirname(trace), f));

  return [trace.replace(/\.nft\.json$/, ""), ...files];
}

/** Regular files under a directory, symlinks left out (they point inside it). */
function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);

    if (e.isDirectory()) return walk(path);

    return e.isFile() ? [path] : [];
  });
}

/** The function `vercel build` assembled, when it comes from the current `next build`. */
function vercelOutput(): Measure | null {
  const config = join(VERCEL_FUNC, ".vc-config.json");

  if (!existsSync(config) || !existsSync(ROUTE_TRACE) || statSync(config).mtimeMs < statSync(ROUTE_TRACE).mtimeMs) return null;
  const { filePathMap } = VcConfig.parse(JSON.parse(readFileSync(config, "utf8")));
  const own = lstatSync(VERCEL_FUNC).isDirectory() ? walk(VERCEL_FUNC) : [];

  return { source: relative(ROOT, VERCEL_FUNC), files: [...own, ...Object.values(filePathMap).map((src) => resolve(ROOT, src))] };
}

function traces(): Measure | null {
  if (!existsSync(ROUTE_TRACE)) {
    console.warn(`size: warning, no trace at ${relative(ROOT, ROUTE_TRACE)} (run \`next build\` first). Nothing measured.`);

    return null;
  }

  const server = SERVER_TRACES.find((t) => existsSync(t));

  if (!server) {
    console.warn(`size: no Next server trace (${SERVER_TRACES.map((t) => relative(NEXT, t)).join(" or ")}): measuring the route trace alone`);

    return { source: `trace ${relative(NEXT, ROUTE_TRACE)}`, files: traced(ROUTE_TRACE) };
  }

  return { source: `traces ${relative(NEXT, ROUTE_TRACE)} + ${relative(NEXT, server)}`, files: [...traced(ROUTE_TRACE), ...traced(server)] };
}

const measured = vercelOutput() ?? traces();

if (!measured) process.exit(0);

const files = new Set(measured.files);

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

console.log(`size: /api/ask function ${mb(total)} uncompressed (${files.size} files, from ${measured.source}), database ${mb(db)}`);

for (const [group, bytes] of [...groups].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`  ${mb(bytes).padStart(9)}  ${group}`);

const problems: string[] = [];

if (db === 0) problems.push("data/lol.sqlite is not in the /api/ask function (outputFileTracingIncludes)");

if (db > DB_MAX_BYTES) problems.push(`database ${mb(db)} over the ${mb(DB_MAX_BYTES)} budget`);
else if (db > DB_WARN_BYTES) console.warn(`size: warning, database ${mb(db)} close to the ${mb(DB_MAX_BYTES)} budget`);

if (total > FUNCTION_MAX_BYTES) problems.push(`function ${mb(total)} over Vercel's ${mb(FUNCTION_MAX_BYTES)} limit`);
else if (total > FUNCTION_WARN_BYTES) console.warn(`size: warning, function ${mb(total)} close to Vercel's ${mb(FUNCTION_MAX_BYTES)} limit`);

if (problems.length) {
  console.error(`size: ${problems.join("; ")}`);
  process.exit(1);
}
