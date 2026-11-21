# What the root shell does before the first paint

`RootShell` (`src/app/root-shell.tsx`) is the document every page is drawn in. Its font subsets and the order of its inline scripts are chosen so that nothing flashes or shifts on the first paint.

## Rules

- The whole site is set in Geist Mono only: Geist Sans would only add a preloaded font nobody reads.
- The font is loaded with the `symbols2` subset beside `latin`: `symbols2` holds the box-drawing dashes of the headings ("── joueurs"). Without it preloaded, they are drawn in a fallback font first and the heading shifts sideways when that file arrives.
- `<html>` has `suppressHydrationWarning` because the theme script sets attributes on it before hydration (see `src/app/brand/theme`).
- `ARRIVAL_SCRIPT` is in `<head>`: the page must hear `pagereveal`, which fires with the first paint, to animate a language change.
- `QUESTION_LINK_SCRIPT` is in `<head>` too: a page opened on a link to an answer must not show the home screen first.
- `THEME_SCRIPT` is the first element of `<body>`: the stored theme is applied before anything is painted.
