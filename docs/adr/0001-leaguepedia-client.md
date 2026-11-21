# Reading Leaguepedia: what the wiki's answers mean

`src/lib/sources/leaguepedia.ts` is the only code that reaches the wiki (Cargo through `Special:CargoExport`, pages and files through the MediaWiki API), one request at a time under one throttle (AGENTS.md, Data). The wiki's answers have several shapes that look like success or like absence and are neither; the client encodes them.

## Rules

- `USER_AGENT` says who the client is and how it behaves (project, URL, one request at a time, at least 2 s apart), as the wiki's bot policy asks. Keep it truthful when the throttle changes.
- A Cargo query error (bad field, bad table, bad syntax) comes back as an HTTP 200 with a text body (`Error: …`, `Error 1054`, `Unknown column`), not as JSON. It is not retryable: `fetchPage` throws `CargoQueryError` at once instead of spending six attempts with backoff. Any other non-JSON body is retried.
- Cargo fields are requested as `Table.Field=Alias` (`CargoQuery.fields`) so the keys of the JSON rows are stable whatever the tables joined.
- Cargo text arrives with HTML entities and is decoded once when the response is parsed (`CargoText`). The response cache stores rows already decoded, so the schema that reads the cache and the datasets (`StoredValue`, `StoredCargoRow`) must not decode again: a second pass would turn a literal `&amp;lt;` into `<`. Do not merge the two schemas.
- `wikiPages`: a title absent from the API result was not served because the answer hit the API size limit; the caller requests it again. Likewise a page returned with no revision content and without `missing` or `invalid` is a truncated answer, not a missing page: it is left out of the map so it is asked again, never recorded as missing.
- `maxlag=5` is sent on every MediaWiki API call: the wiki answers with a `maxlag` error when its replicas lag, and that answer is retried with backoff like an HTTP error, not thrown.
- `FILES_PER_REQUEST` is 50: the MediaWiki API limit on titles per request for an anonymous client.
- `parseWikiFiles` maps each file name asked to the exact name the wiki stores the file under: its title once normalized and then redirected. That name, not the one asked, is the one the CDN path is built from (see the image URL rules). A name absent from the map was not answered and is asked again; null means the wiki has no such file.
- A file page can outlive its file: a page counts as an existing file only when it carries the file's own `imageinfo`. A page without it maps to null.
