# Theme switch: a wipe line over a view transition, right before hydration

The theme toggle (`src/app/theme-toggle.tsx`) changes the theme behind a line that sweeps the page from top to bottom, using the View Transition API, and must show the right icon in the server HTML. Several details of the code exist only because of how browsers run view transitions and hydration.

## Rules

- `switchTheme` draws the wipe as a view transition styled in `globals.css`: above the line the new theme, below it the old one. The line (`.theme-wipe-line`) is a real DOM element, appended to `body`, so that the browser moves its snapshot from the top edge to the bottom one; a pseudo-element or a pure CSS gradient would not be snapshotted and moved that way.
- Without `document.startViewTransition`, or with `prefers-reduced-motion: reduce`, the theme changes at once, with no line.
- The module-level `wipe` holds the transition in progress so that a second click during a wipe only cleans up its own: each transition's `finished` handler removes its own line, and clears `data-theme-wipe` and `wipe` only when it is still the current one. Removing that check lets the first transition's cleanup cut the second wipe short.
- The module-level `pending` holds the theme a wipe is about to apply, because the browser runs the transition's update callback a frame after the click. `toggle` reads `pending ?? currentTheme()`: without it, a fast second click reads the old theme from the DOM and toggles to the same theme again.
- `ThemeToggle` renders both icons (`data-when="dark"` and `data-when="light"`) and `globals.css` shows the one that matches the theme on screen, so the server HTML is right from the first frame, before hydration. Choosing the icon in React state would flash the wrong one or cause a hydration mismatch. The two accessible names come from the page, in its language.
- `localStorage.setItem(THEME_KEY, …)` is wrapped in a `try` whose `catch` is empty on purpose: when storage is blocked (private mode) the choice holds for this page only, and that is the intended behaviour, not an error to report.
