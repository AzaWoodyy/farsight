import { existsSync } from "node:fs";
import { withBotId } from "botid/next/config";
import type { NextConfig } from "next";

// data/ is not committed: `bun run build` downloads it first (data:pull). A
// Vercel build that skipped that step would deploy an agent that cannot open
// its database, so fail the build instead.
if (process.env.VERCEL === "1" && !existsSync("data/lol.sqlite"))
  throw new Error("data/lol.sqlite is missing: the build command must run `bun run data:pull` first (see docs/deploy.md).");

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  // The database is opened at runtime from a computed path, so the tracer
  // cannot see it: ship it inside the /api/ask function (read-only).
  outputFileTracingIncludes: {
    "/api/ask": ["./data/lol.sqlite"],
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
