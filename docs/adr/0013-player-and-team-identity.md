# Identity edge cases in the derivation: same-game links, given names, team spellings and abbreviations

The derivation merges every scoreboard link of a player onto one row and gives each team the abbreviation of its Leaguepedia page (both recorded in `AGENTS.md`). These are the exceptions `scripts/data/derive.ts` makes to those rules, each forced by real data.

## Rules

- Two links that resolve to the same player page inside one game cannot both be that player: one of them is another person on that scoreboard. In that game a link that was renamed (it differs from the page it resolves to) keeps its own identity instead of being merged (`pagesInGame`, counted as `identity.same_game`). Merging them would put two lines of one game on one player and drop one through the primary key.
- A real name with a space also gives an alias made of everything after the first word: Korean and Chinese romanizations put the family name first, so "Jeong Ji-hoon" is also found as "Ji-hoon".
- Team spellings that differ only by case are folded into the team's page name (`teamIdentity`: "Dplus KIA" -> "Dplus Kia"). Only the team ids move: no row is rewritten, and the count is reported as `team_case_merged`.
- An abbreviation a team holds on its own page is not lent to an older name through a redirect (`heldDirectly`): "DNS.C" is DN SOOPers Challengers, not Kwangdong Freecs Challengers, which redirects to that page and has more games. Without this rule the older team would share the abbreviation and, having more games, win it in `understand`.
