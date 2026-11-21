# Link to an answer: how its page, metadata and image are served

AGENTS.md (Link previews) records that `/?q=…` is rewritten to `/q` and `/en/q`, rendered per request with the answer in their Open Graph metadata and an image from `/api/card`. These are the details of `src/app/(fr)/q/page.tsx`, `src/app/en/q/page.tsx`, `src/app/answer-metadata.ts` and `src/app/api/card/route.tsx` that the implementation depends on.

## Rules

- The `/q` pages render `<PerRequest />` (a component that awaits `connection()` and returns null, inside `<Suspense>`). It says the page is rendered per request on purpose: only the metadata reads the address, the body does not, and without it Next would have no dynamic read in the body. It is not dead code.
- In `answerMetadata`, `connection()` is awaited only once a question has been read from the address, and before the answer is computed: the answer reads the database over the network and the clock, so it is rendered per request and never while prerendering. A `/q` without a usable `q` returns the home page's metadata before that.
- A repeated `q` parameter (an array in `searchParams`) is nobody's question and is ignored (`Search` accepts a string only). A single `q` goes through `questionIn`, the same strict reading as in the browser, so the server and the console agree on what the question is.
- Link pages are rate limited per IP like the image (`rateLimited(…, "link")`). A limited request keeps the home page's card and metadata; it is never answered with an error page, since the visitor behind the link still has to get the page.
- The page's own `<title>` stays the home page's; only the Open Graph and Twitter titles are the answer's. The console asks other questions without leaving the page, and a tab named after the first question would lie about the next.
- `cardOrigin()`: on a preview deployment (`VERCEL_ENV === "preview"`) the image URL is absolute on the deployment's own `VERCEL_URL`, so a link preview can be checked before production. Anywhere else it is relative and resolves against `metadataBase`, the public site.
- `/api/card` accepts exactly one query string per image, `?l=<locale>&q=<question>` as the metadata writes it, and answers any other spelling (other order, extra parameters, a non-normalized question) with a 308 to that one: every distinct query string would be a new CDN entry and a new render.
- The image is cached 300 s (`max-age=300, s-maxage=300`), the same time as the app's own data caches: an answer changes when the database is reloaded, which happens without a deployment, so a longer cache would show a stale card.
