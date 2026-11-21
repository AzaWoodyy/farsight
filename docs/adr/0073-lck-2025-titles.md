# Which season pages carry a title (the LCK 2025 format)

Since 2025 the LCK year is one season made of a Cup, regular-season rounds and one playoffs, and Leaguepedia's pages no longer map a `season` page to "no title" and a `playoffs` page to "title". The roll of honour and the histories decide page by page (`scripts/standings-titles.test.ts`).

## Rules

- The LCK Cup is stored with stage `season` but ends in a final (a "Finals" tab): winning it is a title, in `tournament_standings`, `team_history` and `player_event_history`.
- Leading a regular-season page is not a title. That holds when its playoffs carry another split: "Rounds 1-2" has its own split, while the "Season Playoffs" page carries the split "Rounds 3-5", so no playoffs page shares the split of Rounds 1-2, and leading it is still not a title.
- A page without any game that has a winner in `tournament_results` (a monthly academy page such as "X Academy/2025 Season/March") is listed in the roll of honour.
- The roll of honour of such a year lists the Cup, the playoffs and the page without games, not the regular seasons.
