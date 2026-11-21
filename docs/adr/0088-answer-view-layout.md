# Answer views keep their place when the visitor switches view

The champion ranking and the champion pool can be shown either as their own list or as the plain sortable table. Switching between the two must change the content and nothing else: the block starts at the same height and its header has the same height, size and capitals, so the page does not jump under the pointer.

## Rules

- In `ChampionRankingView` and `ChampionPoolView` (`src/app/champion-view.tsx`) the plain table is wrapped in a `div` that overrides the table's own top margin (`[&>div]:mt-0`, `[&>div]:mt-2`) so that it starts exactly where the champion list does. Removing the wrapper makes the content move on every switch.
- The header row of both lists copies the plain table's header (`px-3 py-2 text-xs tracking-wider uppercase`). Change them together.
- In the ranking, one column per metric is only drawn from the `lg` width, the first width where six metric columns still leave room for the champion's name; below it the other metrics wrap under the name.
- `SortHeader` sets `uppercase` on the button itself: a `<button>` does not inherit capitals from its row, so the class is not redundant with the row's.
- `columnWidth` gives a metric's header and its values the same width through the `--col` custom property: 6 rem, or more when the header is longer ("pentakills (total)"), so a header never breaks onto two lines. The width is counted in `ch` of the header, with a factor of 1.1 plus one because the header is set in tracked capitals.
- The `<main>` of `HomePage` (`src/app/home-page.tsx`) is deliberately not stretched to the screen (no `flex-1`): under a short answer the footer follows the answer, instead of an empty screen between the two.
