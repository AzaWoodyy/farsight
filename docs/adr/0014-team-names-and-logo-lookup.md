# Team name spelling and logo file lookup at ingestion

Leaguepedia writes a team's name at different cases depending on the table, and its logo files are looked up by name. `teamIdentity` (`scripts/data/identity.ts`) gives each team one spelling, and `scripts/data/team-logos.ts` asks the wiki for the logo files under both the written and the stored spelling.

## Rules

- `teamIdentity`: one spelling per team whatever the case Leaguepedia wrote it in ("Dplus KIA" on a game, "Dplus Kia" on its player lines). The page of `Teams` wins; without a page, the first spelling seen. Two pages that differ only in case stay apart, and so do the names at their case.
- A wiki title always starts with a capital, so a name that differs from its page by the first letter alone ("paiN Gaming" for the page "PaiN Gaming") is that page as the wiki displays it: the name is kept, not replaced by the page title.
- `teamPageOf`: a name that matches two pages at another case is ambiguous and has no page; it does not fall through to a redirect, so it gets no logo rather than another team's.
- `fetchTeamLogoFiles` asks for every candidate of every name both as written in the fetched rows and as the derivation will store it (the case of its page, through `teamIdentity`), because the derivation looks the logo up under the stored name.
- A file name the MediaWiki API left unanswered in a batch (an API size limit) is asked once more on a request of its own; a name never answered gets no logo.
