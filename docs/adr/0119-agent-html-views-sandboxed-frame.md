# A view composed by the agent is drawn in a frame that runs no script

`render_html` lets the model write a view of its own (a side-by-side comparison, bars, a small chart) as an HTML fragment. That HTML is model output built from figures a visitor asked for, so the page never puts it in its own document: `HtmlFrame` (`src/app/chat/html-frame.tsx`) draws it in an `iframe` with `sandbox="allow-same-origin"` and no `allow-scripts`.

## Rules

- The sandbox has `allow-same-origin` and nothing else. No script, form or navigation runs in the frame; `allow-same-origin` is there because the page reads the frame's document to size it and to hand it the theme. Adding `allow-scripts` beside it would let the fragment act as the page: never add it.
- The server also strips the tags a view has no use for before the fragment is streamed (`BLOCKED_HTML`: `script`, `iframe`, `object`, `embed`, `link`, `meta`, `base`, `form`, `style`), and a fragment is at most `HTML_MAX_LENGTH` (20 000) characters. The sandbox is the barrier; the strip keeps the stored conversation clean.
- The frame's document is written by the page (`documentAround`): the page's own stylesheet links and inline styles, the classes and `lang` of `<html>`, and the fragment inside `<div class="kit">`. The view therefore uses the site's font and colours without the model writing a style.
- The model is given a kit of classes (`kit-title`, `kit-label`, `kit-note`, `kit-table`, `kit-stats` / `kit-stat`, `kit-bars` / `kit-bar`, `kit-cols`, and text helpers), defined under `.kit` in `src/app/chat/chat.css`, and the site's colour variables only (`--background`, `--foreground`, `--muted`, `--line`, `--accent`, `--ok`, `--warn`, `--error`, `--blue`, `--red`). A literal colour would not follow the light and dark themes. The description the model reads is `KIT` in `src/lib/agent/chat.ts`: change both together.
- A bar chart is `kit-bars`; an inline `svg` is kept for a line or a curve over time. Images are not available in a view.
- The theme of the page is written on the frame's `<html>` with its document and copied again each time it changes (a `MutationObserver` on `data-theme`): a frame is a separate document and would otherwise keep the theme it was drawn with.
- The frame takes the height of its content (a `ResizeObserver` on the kit, at most `MAX_HEIGHT`), and its document never scrolls vertically; a table wider than the screen scrolls sideways inside the view instead of being cut.
- `srcDoc` is built in the browser, after mount: it reads the page's stylesheets, which do not exist during server rendering.
