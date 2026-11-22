# Display lab: stable variant ids and a made-up trace

The display lab (`/lab`, preview and local only) draws every tool and variation with the production views, from fixtures built by `bun run lab:build`. The catalogue (`src/app/lab/catalog.ts`) is shared by the build script and the page.

## Rules

- A variant's `id` is stable: it is the fixture's file name under `public/lab-fixtures` and the `?v=` of the lab's URL. Renaming one breaks shared links and the notes kept under that id.
- The `feedback` state draws the real `Feedback` buttons with a made-up trace (`traceId="lab"`, `token="lab"`): the rating is refused by `/api/feedback`, so the lab never writes a score to Langfuse.
- Fixtures are computed inside `rulesOnly` (no model, no trace) and pass through the zod schema `LabFixture` (`src/app/lab/fixture.ts`) twice: when `lab:build` writes them, and when the page reads them. A stale or foreign file is shown as a missing fixture (with the zod error in the console), never handed to a view. The schema is checked against `Answer` and `StepPart` at compile time (`schemaMatchesTypes`): a change of those types fails `tsc` until the schema follows. `meta.route` and `meta.input` are only checked as a string and an object, so the page bundle does not pull the tool registry.
