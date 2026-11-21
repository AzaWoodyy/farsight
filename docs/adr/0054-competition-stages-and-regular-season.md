# Which stages count as the competition, and what a regular season is

Leaguepedia files several kinds of pages under one league label, and a `season` page does not always crown a champion. The typed tools therefore fix which stages they read and tell a regular season from a title, so that a first place in league play is never counted as a trophy.

## Rules

- `COMPETITION_STAGES` in `src/lib/agent/tools.ts` is `main_event`, `play_in`, `season`, `playoffs`. Regional qualifiers are left out because Leaguepedia gives them the same league label as the event they qualify for (`World Championship`, `Mid-Season Invitational`); `event` pages are left out of the games because they only hold standings. `STANDINGS_STAGES` adds `event` back for the standings tool only.
- `regularSeason(t)` decides that a `season` page of `v_tournaments` crowns nobody: it has no tab whose name contains "final", and either the same league, year and split has a `playoffs` page, or it is week-by-week play (`Week %` tabs) in a year where another page of the league holds the final (a `playoffs` page, or a `season` page with a final tab). "Rounds 1-2" of the LCK is a regular season; the LCK Cup, also stored as a `season`, is not, because it has its own final.
- A regular-season rank is not a final placement: `playerEventHistory.format` sets `placeNumber` to null for such a row, so it never becomes the player's best result or a title, and `teamHistory` does not count it among the titles.
- The roll of honour (`tournamentStandings` with `full: false`) excludes regular-season pages: when a regular season has its own playoffs, the title is the playoffs one.
- `playerEventHistory.format` calls the pages "editions" when there is exactly one page per year (Worlds, MSI) and "tournaments" otherwise, because a league's year holds several pages (seasons, playoffs, cups).
