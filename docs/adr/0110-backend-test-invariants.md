# Invariants the backend tests rely on

The backend tests run against a real Postgres schema per test and fake only the outside world. A few constraints of that setup are not visible from a single test and are easy to break when one is edited.

## Rules

- Typed queries go through the same guard as generated ones: every test helper that binds a typed tool (`run` in `scripts/rankings.test.ts`, `scripts/player-runes.test.ts`, `history` in `scripts/player-history.test.ts`, and the others) asserts `guardQuery(await readSchema(db), tool.sql).ok` before running the SQL. A typed tool whose SQL the guard would refuse (a table or column outside the allow-list, a server function) is a bug even though it never passes through text-to-SQL.
- The Leaguepedia client is never tested against the wiki: `scripts/leaguepedia.test.ts` replaces `transport.fetch` with a scripted queue that never forwards, so an unscripted request fails the test instead of reaching the wiki, and `afterEach` fails when scripted answers are left over.
- Every request of the Leaguepedia client must carry a timeout (`init.signal` is an `AbortSignal`), so a stalled connection cannot hang an ingestion run; the fake transport asserts it on every call, together with the explicit `User-Agent`.
- `scripts/self-correction.test.ts` covers empty results of typed tools only: the rules corrector relaxes them (period, then league) and the model corrector gives up before any call. `globalThis.fetch` is replaced by a counter that throws, and `afterEach` expects zero calls: a network call would mean the model corrector ran, and the test must stay hermetic.
- The team index of `understand` is cached per database handle (`getIndexes = cachedRead(readIndexes)` in `src/lib/agent/understand.ts`). A test that adds a team ("Anyone's Legend" in `scripts/team-h2h.test.ts`) must insert it before the first `resolveTeam` / `understandQuestion` on that handle, or the new team is not read.
- `cardOf` (`src/lib/agent/share.ts`) reads `answer.meta.input` only for its presence (a typed tool answered) and, for a champion ranking, for its `sort` (`championSortKey`). The answer fixture of `scripts/share-card.test.ts` therefore carries a `ChampionRankingInput` whatever route it claims; it does not need to match the route.
