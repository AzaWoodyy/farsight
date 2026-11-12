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
  - Normalized schema: players, teams, champions, items, runes and spells stored as integer ids with lookup tables, plus SQL views that put names back for the agent and for text-to-SQL. Budget: about 50 MB for the full scope; the Vercel function cap is 250 MB including dependencies.
  - Finish every build with `PRAGMA journal_mode=DELETE; VACUUM;`, because a WAL database can fail to open on Vercel's read-only filesystem.
- **Queries**: typed, parameterized tools for common intents, with guarded text-to-SQL as the fallback. Guarded means read-only, a single statement, an allow-listed table and column set, a forced `LIMIT`, and `prepare()` used as the schema validator.
- **Hosting**: a separate Vercel project on the Hobby plan, sharing its quotas with the portfolio site. Rate limiting per IP is required.

## Data

- Source: Leaguepedia Cargo tables (CC BY-SA 3.0). Every answer cites and links its Leaguepedia pages. Data Dragon provides champion, item and rune names and icons, mapped from Leaguepedia display names (for example Wukong is `MonkeyKing`).
- Anonymous `action=cargoquery` is rate-limited on the first call, so ingestion uses `Special:CargoExport`: one request at a time, ≥ 2 s apart, backoff on errors, every raw response cached on disk. Query by league with `limit=5000` pagination rather than stage by stage.
- Scope is fixed. Leaguepedia `League` values:
  - International: `World Championship`, `Mid-Season Invitational`
  - Korea: `LoL The Champions` (OGN, 2012-2015), `LoL Champions Korea`, `LCK Challengers League`, `Challengers Korea`, `LCK Academy Series`
  - China: `Tencent LoL Pro League`
  - Europe: `Europe League Championship Series`, `LoL EMEA Championship`, `European Masters`, `EMEA Masters`
  - North America: `North America League Championship Series`, `League of Legends Championship Series`, `League of Legends Championship of The Americas`, `League of Legends Championship of The Americas North`
  - France and Spain: `La Ligue Française`, `La Ligue Française Division 2`, `LVP SuperLiga 2nd Division`
- Updates: a scheduled job appends new games to the latest published file. A full rebuild runs monthly to pick up retroactive wiki edits.

## Working rules

- Branches are named `<type>/<subject>`, with type `feat`, `fix`, `chore`, `hotfix` or `improve`. Open pull requests against `main`.
- Commit messages and PR descriptions are written in the author's voice, with no tool attribution or AI trailers.
- The frontend has no automated tests. Verify UI changes by running the app and looking at the changed screen.
- Secrets live in `.env` only, and `.env.example` lists every variable with an empty value.
- The repository is private until a first working version exists.
