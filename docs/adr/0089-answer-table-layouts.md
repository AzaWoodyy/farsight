# When a table answer becomes a card, and when it gets a team header

`TableAnswer` in `src/app/answer-view.tsx` picks the layout of a table from the table itself. The conditions on the card and on the team header each carry an exception that is easy to drop.

## Rules

- A table of one line is shown as a card (`RowCard`): one line is not a table to scan, its figures read better as a large figure and labelled tiles.
- Except under a champion profile (`answer.champion`): the single line is then the profile's per-tournament detail and stays a table.
- Except when the line has no figure at all (a generated aggregate that came back empty; a year column does not count as a figure): there is nothing for a card, and the table shows its n/d.
- An answer about exactly one team (`answer.meta.teams.length === 1`: its in-game stats, its history, its dragons) is headed by that team, its logo and its league, when the answer has a logo for it.
- Except when the answer has exactly one player profile (`answer.profiles.length === 1`): the answer is then about the player, in that team, and the player header already heads it.
