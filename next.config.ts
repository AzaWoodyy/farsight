import { existsSync } from "node:fs";
import { withBotId } from "botid/next/config";
import type { NextConfig } from "next";

// data/ is not committed: `bun run build` downloads it first (data:pull). A
// Vercel build that skipped that step would deploy an agent that cannot open
// its database, so fail the build instead.
if (process.env.VERCEL === "1" && !existsSync("data/lol.sqlite"))
  throw new Error("data/lol.sqlite is missing: the build command must run `bun run data:pull` first (see docs/deploy.md).");

const nextConfig: NextConfig = {
  // Static rendering needs inline bootstrap scripts. Keep this explicit policy
  // compatible with Next and BotID's same-origin challenge rewrites.
  headers() {
    const dev = process.env.NODE_ENV === "development";

    const csp = [
      "default-src 'self'",
      `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https://ddragon.leagueoflegends.com",
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
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
    ] }];
  },
  // Two root layouts (one per language) leave an unmatched URL without a layout: src/app/global-not-found.tsx
  // is its 404, rendered on the server.
  experimental: { globalNotFound: true },
  cacheComponents: true,
  partialPrefetching: true,
  // The database is opened at runtime from a computed path, so the tracer
  // cannot see it: ship it inside the /api/ask function (read-only).
  outputFileTracingIncludes: {
    "/api/ask": ["./data/lol.sqlite", "./src/lib/db/sql-child.mjs"],
  },
  // The ingestion cache (data/raw: Cargo responses, Riot game JSON) and release
  // assets are never read at runtime, but the tracer picks up the cache files a
  // shared module can write: keep them out, or a local `vercel build` with a
  // full cache would ship gigabytes.
  outputFileTracingExcludes: {
    "/api/ask": ["./data/raw/**", "./data/release/**", "./data/previous/**", "./data/*.log"],
  },
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
