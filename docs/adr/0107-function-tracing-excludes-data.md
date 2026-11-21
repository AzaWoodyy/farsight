# Functions never ship the data/ directory

Nothing under `data/` is read at runtime: the app reads Postgres. Next's file tracer still picks up the cache files a shared module can write there, so the functions exclude the directory explicitly.

## Rules

- `outputFileTracingExcludes` in `next.config.ts` lists `./data/**` for `/api/ask` and every route of `CARD_ROUTES` (`/api/card`, `/q`, `/en/q`). Without it, a local `vercel build` on a machine with a full raw cache would ship gigabytes in each function.
- A new function that imports a module shared with the ingestion scripts must be added to that list; `scripts/size.ts` checks the result after the build.
