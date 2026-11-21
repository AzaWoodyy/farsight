import { withBotId } from "botid/next/config";
import type { NextConfig } from "next";
import pg from "pg";

// The app reads Postgres at DATABASE_URL (docs/postgres.md). A Vercel build without it would deploy an agent with no
// database, and the "how it works" pages without their figures: fail the build instead.
if (process.env.VERCEL === "1" && !process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set for the build (see docs/postgres.md).");

/**
 * The figures of the "how it works" pages (src/app/how/facts.ts), read once when Next starts and inlined in the bundle.
 * Those pages are prerendered, but Next renders them again at request time for some crawlers: they must not open the
 * database. Empty without a database (a fresh clone).
 */
async function howFacts(): Promise<string> {
  if (!process.env.DATABASE_URL) return "";
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });

  await client.connect();

  try {
    const built = (await client.query("SELECT finished_at FROM ingest_runs WHERE kind = 'build' ORDER BY id DESC LIMIT 1")).rows[0]?.finished_at ?? null;

    const leagues = (await client.query(
      `SELECT league, SUM(games)::integer AS games, SUM(ingame_games)::integer AS ingame, MIN(CASE WHEN ingame_games > 0 THEN year END) AS first_ingame
       FROM v_ingame_coverage GROUP BY league`,
    )).rows;

    return JSON.stringify({ built, leagues });
  } finally {
    await client.end();
  }
}

// The functions that answer a link's preview without the model: the image, and the two pages a link opens.
const CARD_ROUTES = ["/api/card", "/q", "/en/q"];

const nextConfig: NextConfig = {
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
  // Nothing under data/ is read at runtime (the app reads Postgres), but the tracer picks up the cache files a shared
  // module can write: keep them out, or a local `vercel build` with a full cache would ship gigabytes.
  // scripts/size.ts checks it.
  outputFileTracingExcludes: Object.fromEntries(["/api/ask", ...CARD_ROUTES].map((route) => [route, ["./data/**"]])),
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
export default withBotId(async () => ({ ...nextConfig, env: { HOW_FACTS: await howFacts() } }));
