# Display lab: stable variant ids and a made-up trace

The display lab (`/lab`, preview and local only) draws every tool and variation with the production views, from fixtures built by `bun run lab:build`. The catalogue (`src/app/lab/catalog.ts`) is shared by the build script and the page.

## Rules

- A variant's `id` is stable: it is the fixture's file name under `public/lab-fixtures` and the `?v=` of the lab's URL. Renaming one breaks shared links and the notes kept under that id.
- The `feedback` state draws the real `Feedback` buttons with a made-up trace (`traceId="lab"`, `token="lab"`): the rating is refused by `/api/feedback`, so the lab never writes a score to Langfuse.
