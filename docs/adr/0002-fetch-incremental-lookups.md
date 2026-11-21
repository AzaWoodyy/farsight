# Player lookups in data:fetch keep their batches and catch up on older links

`data:fetch` resolves scoreboard links to player pages through `PlayerRedirects` and `Players` in batches of 150, and every Cargo response is cached on disk under a key derived from its query (`scripts/data/fetch.ts`). The order of the lookups and the choice of what to refetch follow from that cache and from the wiki's rate limit.

## Rules

- In `fetchPlayers`, the links come first in the list of pages to fetch and the pages found by name are appended after them: the batches of the links, and so their cached responses, stay the same when a newly resolved page is added. Sorting or deduplicating the merged list differently would invalidate the whole cache.
- An incremental fetch looks up two kinds of links: spellings never seen before, and older links that no player page or redirect name covers. The second kind exists because earlier caches were fetched before links were resolved by name; they are retried so that a cache never has to be rebuilt to gain a redirect.
- The tournament list is a single request, so an incremental fetch always refreshes it (`fresh`) instead of reusing the cache: that is what makes a new tournament appear.
