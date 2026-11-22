# How `bun run size` measures a function

`scripts/size.ts` runs at the end of `bun run build` and fails it when a function that reads the database (`/api/ask`, `/api/chat`, `/api/card`, `/q`, `/en/q`) goes over Vercel's 250 MB uncompressed cap (warning from 225 MB) or ships a `data/*.sqlite` file. What it can measure depends on where the build ran.

## Rules

- Sources, most exact first, for each function: after `vercel build`, the function Vercel assembled (`.vercel/output/functions/<route>.func`: its own files plus the `filePathMap` of `.vc-config.json`), used only when it is newer than the route trace, so a stale output of an earlier build is not measured (`vercelOutput`); otherwise the traces `next build` writes, the route's own `.nft.json` plus the Next server's (`traces`).
- A plain `next build` traces the full server (`next-server.js.nft.json`); on Vercel and in `vercel build`, Next traces the minimal server instead (`next-minimal-server.js.nft.json`). `SERVER_TRACES` lists both.
- The Vercel cloud build writes neither server trace before the build command ends: the function is then measured from the route trace alone, which is accepted because the minimal server adds under 1 MB.
- Without the route trace there is nothing to measure: a warning, and the build goes on.
- `walk` counts regular files only and leaves symlinks out: inside a `.func` directory they point to files of the same directory, which would be counted twice.
