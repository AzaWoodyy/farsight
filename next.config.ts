import { withBotId } from "botid/next/config";
import type { NextConfig } from "next";
import pg from "pg";

if (process.env.VERCEL === "1" && !process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set for the build (see docs/postgres.md).");

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

const CARD_ROUTES = ["/api/card", "/q", "/en/q"];

const nextConfig: NextConfig = {
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
      { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
      { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
      { key: "Referrer-Policy", value: "strict-origin" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
    ] }];
  },
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

export default withBotId(async () => ({ ...nextConfig, env: { HOW_FACTS: await howFacts() } }));
