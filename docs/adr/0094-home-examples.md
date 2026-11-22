# Home examples are real typed-tool questions in a fixed order

The home page shows about twenty example questions drifting on four rows (`src/app/home-examples-data.ts`, `src/app/home-examples.tsx`). A click asks the question for real, so an example is a promise about what the agent answers well.

## Rules

- Each example must be answered by a typed tool without the LLM; check a new one with `bun run ask`.
- `EXAMPLES` holds the same examples in each language, in the same order, and the English question must take the same route as the French one.
- `exampleRows` deals the examples on the rows on purpose: they are first taken one subject after the other (players, teams, champions, games), then each round of subjects is dealt one row further than the round before (`(i + Math.floor(i / ROWS)) % ROWS`), so every row mixes the subjects and two neighbours seldom look alike.
- All the examples are in the static HTML, in the same order on each load: no shuffle and no random pick, so the page prerenders, hydrates without a mismatch and reads the same to a crawler. The motion and its pauses are CSS only (`globals.css`).
