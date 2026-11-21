# Theme: one function, inlined before the first paint

The visitor's theme choice is stored in `localStorage` (`THEME_KEY`) and applied by `applyTheme` in `src/app/brand/theme.ts`, both from the toggle and from a script inlined in the static HTML.

## Rules

- `THEME_SCRIPT` runs in the static HTML before the first paint: a stored choice is applied before anything is drawn, so a visitor who picked light on a dark system never sees a dark flash. Without a stored choice the script sets nothing and the CSS media query follows the system setting.
- `applyTheme` must stay one self-contained function: `THEME_SCRIPT` inlines its source with `applyTheme.toString()`, so it cannot reference anything from the module (an import, `COLORS`, a helper). That is why the colors are passed as an argument. A reference to module scope still works from the toggle and silently breaks the inline script.
