# Every page is requested without a database after the build

A page that opened the database while it rendered answered 500 to Google's inspection tool and to link previews (#126): Next streams nothing to those crawlers and renders a prerendered page again at request time, in a function that never reaches the database. A browser got the prerendered page, so nothing showed it; AGENTS.md asked for the check by hand.

## Rules

- `scripts/pages-without-db.ts` (`bun run pages:check`) starts `next start` on the build, on a free port and waiting for its own "Ready", with `DATABASE_URL` and `DATABASE_DRIVER` set empty (an unset variable would be filled again from `.env` by Next), then requests every page of `.next/app-path-routes-manifest.json` (API routes aside), the two answer links (`/?q=`, `/en?q=`) and an unmatched URL, once as `Google-InspectionTool` and once as a browser. Every page must answer 200, the unmatched URL 404, and each answer link must give the crawler the home page's Open Graph and Twitter tags (a link whose answer cannot be read keeps the site's card).
- It runs after the build in `bun run verify` and in CI's build chain (`scripts/ci/run.py`), never in the Vercel build.
- The figures a page shows are read when the build starts (`HOW_FACTS`, `next.config.ts`): `next start` itself then needs no database, which is what lets the check remove it.
- A read under `"use cache"` passes the build (it ran then, with the database) and still fails here: a fresh instance renders the crawler's request with an empty cache.
