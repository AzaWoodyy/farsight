import { type Subprocess, spawn } from "bun";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

const ROOT = resolve(import.meta.dirname, "..");
const PORT = 3107;
const CRAWLER = "Mozilla/5.0 (compatible; Google-InspectionTool/1.0)";
const ANSWER_LINKS = ["/?q=Faker%20aux%20Worlds", "/en?q=Faker%20at%20Worlds"];
const UNMATCHED = "/no-such-page";

const Routes = z.record(z.string(), z.string());

function pagePaths(): string[] {
  const routes = Routes.parse(JSON.parse(readFileSync(resolve(ROOT, ".next/app-path-routes-manifest.json"), "utf8")));

  return Object.values(routes).filter((path) => !path.startsWith("/api/") && !path.startsWith("/_"));
}

async function ready(server: Subprocess<"ignore", "pipe", "pipe">): Promise<void> {
  const deadline = Date.now() + 30_000;

  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`next start exited with ${server.exitCode}`);

    try {
      await fetch(`http://127.0.0.1:${PORT}/robots.txt`);

      return;
    } catch {
      await Bun.sleep(250);
    }
  }

  throw new Error("next start did not answer within 30 s");
}

const { DATABASE_URL: _url, DATABASE_DRIVER: _driver, ...withoutDatabase } = process.env;

const server = spawn(["bunx", "--no-install", "next", "start", "-p", String(PORT)], {
  cwd: ROOT,
  env: { ...withoutDatabase, NEXT_TELEMETRY_DISABLED: "1" },
  stdout: "pipe",
  stderr: "pipe",
});

const failures: string[] = [];

try {
  await ready(server);

  for (const path of [...pagePaths(), ...ANSWER_LINKS, UNMATCHED]) {
    for (const agent of [CRAWLER, "Mozilla/5.0"]) {
      const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { headers: { "user-agent": agent } });
      const expected = path === UNMATCHED ? 404 : 200;

      if (res.status !== expected) failures.push(`${path} (${agent === CRAWLER ? "Google-InspectionTool" : "browser"}): HTTP ${res.status}, expected ${expected}`);
    }
  }
} finally {
  server.kill();
}

if (failures.length) {
  console.error(
    `pages-without-db: ${failures.length} page(s) fail without a reachable database. A page must not open it while it renders ` +
      "(read figures in next.config.ts, as HOW_FACTS; AGENTS.md, Pages and the database):\n" +
      failures.map((f) => `  - ${f}`).join("\n"),
  );
  process.exit(1);
}

console.log(`pages-without-db: every page answers without a reachable database, for a crawler and a browser`);
