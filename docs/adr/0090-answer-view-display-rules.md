# Display thresholds and domain rules of the answer views

Some numbers and orderings in the views are product decisions about what a figure is worth showing, or facts about what Leaguepedia holds. They are not derivable from the code.

## Rules

- `ITEM_WINRATE_MIN_GAMES` (`src/app/champion-view.tsx`) is 5: below that many games an item's win rate is not shown, because one game more or less swings it too much. The player runes view (`winrateOf`, `Winrate` in `src/app/player-runes-view.tsx`) uses the same threshold and shows the record instead.
- `TEAMS` (`src/app/player-header.tsx`) is 3: a player's header lists three teams before "+n", because a long career would push the line past a phone's width.
- `OPEN_UP_TO` (`src/app/series-view.tsx`) is 4: up to four series, every one opens on its games; a longer phase (Swiss rounds) lists them closed.
- A series known only from Leaguepedia's match schedule (`scheduleOnly`) lists its declared winner first, whatever the score it wrote: in `SeriesBlock`, `lead` is forced to `"a"` instead of being read from `winsA` / `winsB`. A forfeit reads "W – FF".
- Rune coverage differs by period: the scoreboards list only the keystone in 2018, 2019 and, for the LPL, until 2020; whole rune pages come later. `PlayerRunesView` (`src/app/player-runes-view.tsx`) therefore shows the keystones and the primary trees for such a scope and says the rest is absent, and shares are counted over `keystoneGames` or `pageGames`, never over all games.
