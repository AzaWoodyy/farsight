import { existsSync } from "node:fs";
import { withBotId } from "botid/next/config";
import type { NextConfig } from "next";

// data/ is not committed: a Vercel build without the file would deploy an
// agent that cannot open its database. Fail the build instead.
if (process.env.VERCEL === "1" && !existsSync("data/lol.sqlite"))
  throw new Error("data/lol.sqlite is missing: run `bun run data:build` before `vercel build` (see docs/deploy.md).");

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  // The database is opened at runtime from a computed path, so the tracer
  // cannot see it: ship it inside the /api/ask function (read-only).
  outputFileTracingIncludes: {
    "/api/ask": ["./data/lol.sqlite"],
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
