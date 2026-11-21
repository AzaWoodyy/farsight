# Metadata, hreflang, sitemap dates and robots

What search engines and link previews read is decided in `src/app/i18n/metadata.ts`, `src/app/i18n/shell.ts`, `src/app/sitemap.ts` and `src/app/robots.ts`. These rules come from how Google and the chat services treat a page.

## Rules

- Tagline and description (`SHELL`, `src/app/i18n/shell.ts`) both carry "LoL": people search "farsight lol" more than "farsight league of legends", and Google ranks a brand query on the words a page actually contains. The description is the search snippet, the Open Graph and Twitter text and the JSON-LD: one sentence that stands alone, under 150 characters so Google shows it whole.
- `languages` (hreflang) returns nothing while only one language is public, and nothing on a page of a language that is not public: an alternate must be indexable and point back.
- `pageMetadata` sets the canonical and the other languages page by page, so a page added later does not inherit another page's address from a layout.
- Sitemap dates are the day a page really changed, never the build's clock. The home pages and the "how it works" pages change with the data, so their `lastmod` is the day the database was built, inlined at build with the page's figures (`HOW_FACTS`); the legal pages keep `LEGAL_UPDATED` (`src/app/legal/content.tsx`), a date written by hand that must be changed together with the legal text. A page without a known day gets no `lastmod`.
- `robots` disallows `/api/` but allows `/api/card`: it is the image of a link's preview, and a chat service that obeys robots.txt (X) must be able to fetch it.
