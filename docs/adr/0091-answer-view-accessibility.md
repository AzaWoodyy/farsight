# Accessibility constraints of the answer views

The answer views are lists and scrolling tables drawn in the console's style, not native data grids. A few constructs exist only for the keyboard and for screen readers, and look removable to someone who reads the markup alone.

## Rules

- The champion lists are not tables, so they cannot carry `aria-sort`. `SortHeader` (`src/app/champion-view.tsx`) therefore puts the sort state in the button's accessible name: the visible label, preceded by a screen-reader-only "sort by" and followed by a screen-reader-only "ascending" / "descending".
- A horizontally scrolling table wrapper is `relative` (`src/app/game-scoreboard.tsx`, `src/app/team-h2h.tsx`, `src/app/team-roster.tsx`): a `sr-only` caption or header is absolutely positioned, and without a positioned ancestor inside the scroller it is placed from outside it and widens the whole page.
- In `PlayerRow` (`src/app/game-scoreboard.tsx`) the K/D/A and the gold are repeated under the player's name at phone width, because their column is off screen behind the horizontal scroll. The repeat is `aria-hidden` and `sm:hidden`: the real cells stay the only ones a screen reader meets.
- In `Chips` (`src/app/home-examples.tsx`) each row of examples is rendered twice to close the loop of the drift. The copy stays clickable under the pointer, but is absent for the keyboard (`tabIndex={-1}`) and for screen readers (`aria-hidden`), so an example is announced and focused once.
- In `SeriesBlock` (`src/app/series-view.tsx`) the header and the meta line (which holds the source link) stay outside the `<summary>`: a link inside a summary, which is a button, is unreliable for assistive technology. Only the games line folds the series.
