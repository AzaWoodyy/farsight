# Structured data of the home page

`src/app/brand/json-ld.ts` writes the schema.org description of the site (`WebSite`) and of the application (`WebApplication`) as an inline JSON-LD script on each home page.

## Rules

- The structured data is static and only on the home pages: no answer has its own URL (the canonical of a link to an answer stays the home page), so there is nothing per question to describe. It is one site, described on each home page in the language of that page.
- `WebSite.name` is the name Google may show in results instead of the bare domain, and `alternateName` lists the accepted alternatives: the brand as it is searched (`"Farsight LoL"`, for the query "farsight lol") and the domain. Keep both; they are what Google's site-name feature reads.
- `jsonLdScript` escapes every `<` as `\u003c` after `JSON.stringify`: the result is an inline script body, and no string in it (a description, a catalog text) may be able to close the script tag.
