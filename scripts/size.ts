import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { z } from "zod";

const ROOT = resolve(import.meta.dirname, "..");
const NEXT = resolve(ROOT, ".next");
const FUNCTION_MAX_BYTES = 250e6;
const FUNCTION_WARN_BYTES = 225e6;

const FUNCTIONS = [
  { route: "/api/ask", trace: "server/app/api/ask/route.js.nft.json" },
  { route: "/api/chat", trace: "server/app/api/chat/route.js.nft.json" },
  { route: "/api/card", trace: "server/app/api/card/route.js.nft.json" },
  { route: "/q", trace: "server/app/(fr)/q/page.js.nft.json" },
  { route: "/en/q", trace: "server/app/en/q/page.js.nft.json" },
].map((f) => ({ route: f.route, trace: resolve(NEXT, f.trace), func: resolve(ROOT, `.vercel/output/functions${f.route}.func`) }));

type Fn = (typeof FUNCTIONS)[number];

const SERVER_TRACES = [resolve(NEXT, "next-server.js.nft.json"), resolve(NEXT, "next-minimal-server.js.nft.json")];

const Trace = z.object({ files: z.array(z.string()) });
const VcConfig = z.object({ filePathMap: z.record(z.string(), z.string()).default({}) });

type Measure = { source: string; files: string[] };

const mb = (n: number) => `${(n / 1e6).toFixed(1)} MB`;

function traced(trace: string): string[] {
  const files = Trace.parse(JSON.parse(readFileSync(trace, "utf8"))).files.map((f) => resolve(dirname(trace), f));

  return [trace.replace(/\.nft\.json$/, ""), ...files];
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);

    if (e.isDirectory()) return walk(path);

    return e.isFile() ? [path] : [];
  });
}

function vercelOutput(fn: Fn): Measure | null {
  const config = join(fn.func, ".vc-config.json");

  if (!existsSync(config) || !existsSync(fn.trace) || statSync(config).mtimeMs < statSync(fn.trace).mtimeMs) return null;
  const { filePathMap } = VcConfig.parse(JSON.parse(readFileSync(config, "utf8")));
  const own = lstatSync(fn.func).isDirectory() ? walk(fn.func) : [];

  return { source: relative(ROOT, fn.func), files: [...own, ...Object.values(filePathMap).map((src) => resolve(ROOT, src))] };
}

function traces(fn: Fn): Measure | null {
  if (!existsSync(fn.trace)) {
    console.warn(`size: warning, no trace at ${relative(ROOT, fn.trace)} (run \`next build\` first). ${fn.route} not measured.`);

    return null;
  }

  const server = SERVER_TRACES.find((t) => existsSync(t));

  if (!server) {
    console.warn(`size: no Next server trace (${SERVER_TRACES.map((t) => relative(NEXT, t)).join(" or ")}): measuring the route trace alone`);

    return { source: `trace ${relative(NEXT, fn.trace)}`, files: traced(fn.trace) };
  }

  return { source: `traces ${relative(NEXT, fn.trace)} + ${relative(NEXT, server)}`, files: [...traced(fn.trace), ...traced(server)] };
}

const problems: string[] = [];

for (const fn of FUNCTIONS) {
  const measured = vercelOutput(fn) ?? traces(fn);

  if (!measured) continue;

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

    if (/^data\/.*\.sqlite$/.test(rel)) db += st.size;
  }

  console.log(`size: ${fn.route} function ${mb(total)} uncompressed (${files.size} files, from ${measured.source})`);

  for (const [group, bytes] of [...groups].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`  ${mb(bytes).padStart(9)}  ${group}`);

  if (db > 0) problems.push(`the ${fn.route} function ships a SQLite file (${mb(db)}): the app reads Postgres`);

  if (total > FUNCTION_MAX_BYTES) problems.push(`${fn.route} function ${mb(total)} over Vercel's ${mb(FUNCTION_MAX_BYTES)} limit`);
  else if (total > FUNCTION_WARN_BYTES) console.warn(`size: warning, ${fn.route} function ${mb(total)} close to Vercel's ${mb(FUNCTION_MAX_BYTES)} limit`);
}

if (problems.length) {
  console.error(`size: ${problems.join("; ")}`);
  process.exit(1);
}
