# The fallback of Geist Mono is a monospaced font of the same width

Geist Mono is served by the site itself and preloaded (`next/font`), with `font-display: swap`: a visitor whose font arrives after the first paint sees the fallback first. The fallback `next/font` generates is Arial enlarged to the same average width. Arial is proportional, so each line had another width than in Geist Mono, the title wrapped differently and the question field moved when the font arrived: PageSpeed measured a layout shift of 0.1 on the home page.

## Rules

- `adjustFontFallback` is off (`src/app/root-shell.tsx`) and the fallbacks are named in `fallback`, so `--font-geist-mono` carries them wherever it is used.
- A character of Geist Mono is 0.6 em wide. `Geist Mono Fallback` (`src/app/globals.css`) is Menlo or DejaVu Sans Mono (0.602 em) with `size-adjust: 99.66%`; `Geist Mono Fallback Consolas` is Consolas (0.55 em) with `size-adjust: 109.13%`. Liberation Mono, Courier New and Android's monospace are 0.6 em and need no adjustment.
- Each has a second face for weights 600 to 900, so a bold title is not a synthesized bold of another width.
- `ui-monospace` is not in the list: the font behind it changes with the system, and so does its width.
- Line heights are set in CSS everywhere, so the vertical metrics of the fallback move nothing.
- After changing the font or the list, compare the page's layout with the font and with the fallback alone: the positions must be the same.
