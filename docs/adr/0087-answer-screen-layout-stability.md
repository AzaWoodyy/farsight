# Nothing moves on the answer screen while an answer comes

The answer screen streams its content, and an earlier version shifted badly while doing so (CLS measured at 0.6). The layout of `src/app/agent-console.tsx`, `src/app/answer-view.tsx` and the display lab is built so that what is on screen stays where it is; the frontend has no automated tests, so these are easy to undo by accident.

## Rules

- While the agent works, the block of the question is at least a screen tall (`min-h-svh` on `[data-running]`): the footer stays below the fold instead of sliding under the growing answer. Once the answer is in, the block is as tall as the answer, so a short answer is not followed by an empty screen.
- While the agent works, the progress line (`Progress`) stays on top and the steps stream in under it. Once the run is over and the answer is shown, the trace (`HowIFoundIt`) is rendered folded under the answer (`traceBelow`): the visitor reads the result first, how it was found after.
- A run that failed without an answer shows its error alone: the half-run trace is not rendered under it (`!(error && !answer)`), since it explains nothing to the visitor.
- `HowIFoundIt` opens its `<details>` when a run starts and folds it when the run ends by setting `open` on the element in a layout effect, and leaves it uncontrolled otherwise. Mirroring the `toggle` event into React state raced with the fold: the browser's toggle event for the opening could land after the fold and reopen the trace.
- `CopyLink` renders its three labels (copy, copied, failed) in one grid cell, the inactive ones `invisible`: the button keeps the width of the widest label and nothing next to it moves when the label changes. Do not replace them with one conditional label.
- In `ResultsTable`, the dashed separator is a top border on each result row (`border-t … first:border-0`), not a bottom border with `last:border-0`: the phone-only champions row that follows a result stays the tbody's last child at every width (it is only hidden), so the last result would keep a border against the frame.
- The display lab page (`src/app/(fr)/lab/page.tsx`) uses the same frame as the home page (`max-w-6xl`, same paddings, header and footer), so every layout is judged at the width and beside the neighbours it ships with. It leaves no extra room for its floating menu (the H key hides the menu): the page ends where production ends. Its `<main>` is not stretched to the screen, so the footer follows a short answer as in production.
