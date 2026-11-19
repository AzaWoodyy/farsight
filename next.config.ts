import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { withBotId } from "botid/next/config";
import type { NextConfig } from "next";

// data/ is not committed: `bun run build` downloads it first (data:pull). A
// Vercel build that skipped that step would deploy an agent that cannot open
// its database, so fail the build instead.
if (process.env.VERCEL === "1" && !existsSync("data/lol.sqlite"))
  throw new Error("data/lol.sqlite is missing: the build command must run `bun run data:pull` first (see docs/deploy.md).");

/**
 * The figures of the "how it works" pages (src/app/how/facts.ts), read once when Next starts and inlined in
 * the bundle. Those pages are prerendered, but Next renders them again at request time for some crawlers, in a
 * function that does not ship the database: they must not open it. Empty without a database (a fresh clone).
 */
function howFacts(): string {
  if (!existsSync("data/lol.sqlite")) return "";
  const db = new DatabaseSync("data/lol.sqlite", { readOnly: true });

  try {
    const built = db.prepare("SELECT finished_at FROM ingest_runs WHERE kind = 'build' ORDER BY id DESC LIMIT 1").get()?.finished_at ?? null;

    const leagues = db
      .prepare("SELECT league, SUM(games) AS games, SUM(ingame_games) AS ingame, MIN(CASE WHEN ingame_games > 0 THEN year END) AS first_ingame FROM v_ingame_coverage GROUP BY league")
      .all();

    return JSON.stringify({ built, leagues });
  } finally {
    db.close();
  }
}

const DATABASE = "./data/lol.sqlite";

// The functions that answer a link's preview without the model: the image, and the two pages a link opens.
const CARD_ROUTES = ["/api/card", "/q", "/en/q"];

const nextConfig: NextConfig = {
  env: { HOW_FACTS: howFacts() },
  // Static rendering needs inline bootstrap scripts. Keep this explicit policy
  // compatible with Next and BotID's same-origin challenge rewrites.
  headers() {
    const dev = process.env.NODE_ENV === "development";

    const csp = [
      "default-src 'self'",
      `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https://ddragon.leagueoflegends.com https://static.wikia.nocookie.net",
      "font-src 'self'",
      `connect-src 'self'${dev ? " ws: wss:" : ""}`,
      "worker-src 'self' blob:",
      "frame-src 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; ");

    return [{ source: "/:path*", headers: [
      { key: "Content-Security-Policy", value: csp },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-Frame-Options", value: "DENY" },
      // Vercel sends HSTS without includeSubDomains. Every subdomain is served by Vercel over HTTPS, so cover
      // them too. No `preload`: the browser lists are a commitment that takes months to undo.
      { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
      // The site opens no window it talks to: outgoing links must not keep a handle on this one either.
      { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
      // The origin alone, even to this site: the address of an answer holds its question (`?q=`), and the
      // analytics scripts and their beacons are same-origin requests that would carry it as their referrer.
      { key: "Referrer-Policy", value: "strict-origin" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
    ] }];
  },
  // Two root layouts (one per language) leave an unmatched URL without a layout: src/app/global-not-found.tsx
  // is its 404, rendered on the server.
  // A link to an answer (`/?q=…`) is served by a page rendered per request, which writes the answer's metadata
  // for link previews (src/app/answer-metadata.ts). The home pages without a question stay static.
  rewrites: async () => ({
    beforeFiles: [
      { source: "/", has: [{ type: "query", key: "q" }], destination: "/q" },
      { source: "/en", has: [{ type: "query", key: "q" }], destination: "/en/q" },
    ],
    afterFiles: [],
    fallback: [],
  }),
  experimental: { globalNotFound: true },
  cacheComponents: true,
  partialPrefetching: true,
  // The database is opened at runtime from a computed path, so the tracer
  // cannot see it: ship it inside every function that reads it (read-only).
  // scripts/size.ts measures each of them.
  outputFileTracingIncludes: {
    "/api/ask": [DATABASE, "./src/lib/db/sql-child.mjs"],
    ...Object.fromEntries(CARD_ROUTES.map((route) => [route, [DATABASE]])),
  },
  // The ingestion cache (data/raw: Cargo responses, Riot game JSON) and release
  // assets are never read at runtime, but the tracer picks up the cache files a
  // shared module can write: keep them out, or a local `vercel build` with a
  // full cache would ship gigabytes.
  outputFileTracingExcludes: Object.fromEntries(["/api/ask", ...CARD_ROUTES].map((route) => [route, ["./data/raw/**", "./data/release/**", "./data/previous/**", "./data/*.log"]])),
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

// BotID proxies its challenge script through rewrites added here.
export default withBotId(nextConfig);
