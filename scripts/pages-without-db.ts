import { type Subprocess, spawn } from "bun";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

const ROOT = resolve(import.meta.dirname, "..");
const CRAWLER = "Mozilla/5.0 (compatible; Google-InspectionTool/1.0)";

const ANSWER_LINKS = [
  { home: "/", link: "/?q=Faker%20aux%20Worlds" },
  { home: "/en", link: "/en?q=Faker%20at%20Worlds" },
];

const UNMATCHED = "/no-such-page";
const PREVIEW_TAGS = ["og:title", "og:description", "og:image", "twitter:title", "twitter:description", "twitter:image"];

const Routes = z.record(z.string(), z.string());

function pagePaths(): string[] {
  const routes = Routes.parse(JSON.parse(readFileSync(resolve(ROOT, ".next/app-path-routes-manifest.json"), "utf8")));

  return Object.values(routes).filter((path) => !path.startsWith("/api/") && !path.startsWith("/_"));
}

function freePort(): number {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const { port } = probe;
  void probe.stop(true);

  return port;
}

async function ready(server: Subprocess<"ignore", "pipe", "pipe">): Promise<void> {
  const reader = server.stdout.getReader();
  const decoder = new TextDecoder();
  const timeout = setTimeout(() => server.kill(), 30_000);
  let printed = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();

      if (done) throw new Error(`next start stopped before it was ready:\n${printed}${await new Response(server.stderr).text()}`);
      printed += decoder.decode(value, { stream: true });

      if (/\bReady in\b/.test(printed)) return;
    }
  } finally {
    clearTimeout(timeout);
    reader.releaseLock();
  }
}

function previewTags(html: string): Record<string, string | null> {
  const content = (name: string) => html.match(new RegExp(`<meta (?:property|name)="${name}" content="([^"]*)"`))?.[1] ?? null;

  return Object.fromEntries(PREVIEW_TAGS.map((name) => [name, content(name)]));
}

const port = freePort();

const server = spawn(["bunx", "--no-install", "next", "start", "-p", String(port), "-H", "127.0.0.1"], {
  cwd: ROOT,
  env: { ...process.env, DATABASE_URL: "", DATABASE_DRIVER: "", NEXT_TELEMETRY_DISABLED: "1" },
  stdout: "pipe",
  stderr: "pipe",
});

const failures: string[] = [];
const get = (path: string, agent: string) => fetch(`http://127.0.0.1:${port}${path}`, { headers: { "user-agent": agent } });

try {
  await ready(server);

  for (const path of [...pagePaths(), ...ANSWER_LINKS.map((a) => a.link), UNMATCHED]) {
    for (const agent of [CRAWLER, "Mozilla/5.0"]) {
      const res = await get(path, agent);
      const expected = path === UNMATCHED ? 404 : 200;

      if (res.status !== expected) failures.push(`${path} (${agent === CRAWLER ? "Google-InspectionTool" : "browser"}): HTTP ${res.status}, expected ${expected}`);
    }
  }

  for (const { home, link } of ANSWER_LINKS) {
    const [own, linked] = await Promise.all([home, link].map(async (path) => previewTags(await (await get(path, CRAWLER)).text())));

    for (const name of PREVIEW_TAGS)
      if (!own![name] || own![name] !== linked![name])
        failures.push(`${link}: ${name} is ${JSON.stringify(linked![name])}, the home page's is ${JSON.stringify(own![name])}`);
  }
} finally {
  server.kill();
}

if (failures.length) {
  console.error(
    `pages-without-db: ${failures.length} problem(s) without a reachable database. A page must not open it while it renders ` +
      "(read figures in next.config.ts, as HOW_FACTS), and an answer link keeps the home page's preview (AGENTS.md, Pages and the database):\n" +
      failures.map((f) => `  - ${f}`).join("\n"),
  );
  process.exit(1);
}

console.log("pages-without-db: every page answers without a reachable database, for a crawler and a browser, and answer links keep the home preview");
