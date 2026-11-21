# One live region announces the progress and the end of a run

Screen readers hear the agent's progress and the arrival of the answer from a single `role="status"` paragraph in `Console` (`src/app/agent-console.tsx`).

## Rules

- The status paragraph is mounted as long as a question is shown, not only while the agent runs: a live region only announces changes to an element that is already in the page, so the end of the run ("answer ready", or nothing) is heard only if the element was there before. It is `sr-only`, so it never moves the page.
- The visible progress line (`Progress`) carries no live role of its own: it shows the same `progressLabel` the status region announces. Adding `role="status"` or `aria-live` to it would make every step heard twice.
