# Changing language is a full page load, animated by the page that arrives

Each language has its own root layout, so going from one to the other is a full load between two documents whatever link is used. The language switch is therefore made of plain `<a>` links, and the page that arrives plays a short animation: its letters shuffle, then settle into the translation.

## Rules

- `LocaleSwitch` (`src/app/site-header.tsx`) uses plain links, not `next/link`: the change is a full page load either way, and a crawler reads them as the alternates they are. From an answer, the link carries the question to the other home page, which asks it again and answers in its language.
- `ARRIVAL_SCRIPT` (`src/app/i18n/arrival.ts`) runs in `<head>`, before the first paint. The page that leaves notes the click in `sessionStorage`, and the one that arrives reads it. Where the browser animates between documents (the `@view-transition` rule of `globals.css`), the old page stays on screen until the new one is ready to shuffle its letters; any other navigation skips the transition and is shown at once. It must be in `<head>` because `pagereveal` fires with the first paint: a script in the body can be too late to hear it.
- `LanguageArrival` (`src/app/i18n/language-arrival.tsx`) waits for hydration, since React owns the text from there, then ends the view transition that kept the previous language on screen. With reduced motion the page is simply shown.
- `LanguageArrival` is rendered at the end of the page (in `SiteFooter`), never in the root shell: Next hydrates the shell before the page, and a text shuffled before its own hydration is put back at once by React.
- `decode` (`src/app/i18n/decode.ts`) relies on the page being set in a monospace font: a shuffled line is exactly as wide as the real one, so nothing moves. The links of the header (the site name, the language switch) are left alone: they are what the visitor is looking at.
- While it runs, `decode` leaves a text node alone as soon as its value is no longer the one `decode` wrote: React wrote something else in the meantime, and the text is React's again.
