<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# lol-esports-agent

Natural-language research agent over League of Legends esports data, a portfolio project deployed at `lolesport.enzoneault.dev`. A question ("Chovy's results at every Worlds") goes through four visible steps: understand (entities and aliases such as Chovy / 정지훈 / Jihun), build the query behind a schema guard, execute and self-correct on empty or error, format (sortable table, summary sentence, sources, follow-ups).

## Decisions

These are settled; build toward them. The POC on `main` predates some of them (it still runs LangGraph with Anthropic/OpenAI providers).

- **Orchestration**: AI SDK 7 alone, with the four steps hand-coded and streamed to the UI as typed data parts. LLM calls go through OpenRouter (`@openrouter/ai-sdk-provider`) on a capped key.
- **Runtime**: Vercel Functions on Node 24, without `bunVersion`. Bun is the package manager and runs local scripts.
- **Database**: one SQLite file, built by ingestion and shipped read-only inside the deployment. Every environment uses the same versioned file, with no per-environment seeding. Schema changes rebuild the file from the raw cache, so there are no migrations.
  - Normalized schema (v4): players, teams, champions, items and keystone runes stored as integer ids with lookup tables, plus SQL views that put names back for the agent and for text-to-SQL. Keep only the columns, tables and indexes that the `v_*` views and the tools read; the raw cache keeps the rest, so a rebuild can bring a column back.
  - In-game stats are computed at ingestion and stored in SQL (`game_player_stats`, `game_team_stats`, views `v_game_player_stats`, `v_game_team_stats`, `v_ingame_coverage`); definitions live in `scripts/data/ingame.ts`. The minute-by-minute detail never goes to SQL: the raw Riot JSON of each game is one object in Cloudflare R2, read one game at a time through `src/lib/storage` (local filesystem store for tests and the ingestion cache).
  - Budget: database under 190 MB, `/api/ask` function under 250 MB uncompressed (Vercel's cap). `data:build` and `data:package` warn from 170 MB and `data:package` refuses more than 190 MB; `bun run size` (end of `bun run build`) measures the function from the Next traces and fails the build above 250 MB.
  - Finish every build with `PRAGMA journal_mode=DELETE; VACUUM;`, because a WAL database can fail to open on Vercel's read-only filesystem.
- **Queries**: typed, parameterized tools for common intents, with guarded text-to-SQL as the fallback. Guarded means read-only, a single statement, an allow-listed table and column set, a forced `LIMIT`, and `prepare()` used as the schema validator.
- **Hosting**: a separate Vercel project on the Hobby plan, sharing its quotas with the portfolio site. Rate limiting per IP is required.

## Data

- Source: Leaguepedia Cargo tables (CC BY-SA 3.0). Every answer cites and links its Leaguepedia pages. Data Dragon provides champion, item and rune names and icons, mapped from Leaguepedia display names (for example Wukong is `MonkeyKing`).
- In-game source: the Riot game JSON Leaguepedia hosts (`PostgameJsonMetadata` lists them; pages `V4 data:…` / `V5 data:…` and `…/Timeline`), about 28 000 games of the scope. The LPL has none, and Oracle's Elixir and the lolesports live stats are deliberately not used: an in-game question about the LPL (or any scope where `v_ingame_coverage.ingame_games` is 0) answers that the data is absent for that scope.
- Anonymous `action=cargoquery` is rate-limited on the first call, so ingestion uses `Special:CargoExport`: one request at a time, ≥ 2 s apart, backoff on errors, every raw response cached on disk. Query by league with `limit=5000` pagination rather than stage by stage.
- Riot JSON goes through the MediaWiki API under the same throttle (shared with Cargo, `maxlag=5`, Retry-After honoured, explicit User-Agent), two games per request. Ingestion is resumable: one gzip object per game in `data/raw/riot` (and R2 when `R2_*` is set), one summary line per game appended to `data/raw/ingame.jsonl`; a rerun skips what is done. Bump `DERIVE_VERSION` when a definition changes: the next fetch recomputes the summaries from the cached JSON without the network.
- Scope is fixed. Leaguepedia `League` values:
  - International: `World Championship`, `Mid-Season Invitational`
  - Korea: `LoL The Champions` (OGN, 2012-2015), `LoL Champions Korea`, `LCK Challengers League`, `Challengers Korea`, `LCK Academy Series`
  - China: `Tencent LoL Pro League`
  - Europe: `Europe League Championship Series`, `LoL EMEA Championship`, `European Masters`, `EMEA Masters`
  - North America: `North America League Championship Series`, `League of Legends Championship Series`, `League of Legends Championship of The Americas`, `League of Legends Championship of The Americas North`
  - France and Spain: `La Ligue Française`, `La Ligue Française Division 2`, `LVP SuperLiga 2nd Division`
- Updates: the weekly `Data release` workflow refetches the Cargo tables, restores the previous release's `ingame.jsonl.zst`, downloads only new games' Riot JSON (time-boxed), publishes a `data-YYYYMMDD` release, and keeps the 4 newest. The first full Riot catch-up (8-9 h) runs locally, then `bun run data:sync` uploads it to R2.

## Working rules

- Branches are named `<type>/<subject>`, with type `feat`, `fix`, `chore`, `hotfix` or `improve`. Open pull requests against `main`.
- Commit messages and PR descriptions are written in the author's voice, with no tool attribution or AI trailers.
- The frontend has no automated tests. Verify UI changes by running the app and looking at the changed screen.
- Secrets live in `.env` only, and `.env.example` lists every variable with an empty value.
- The repository is private until a first working version exists.
