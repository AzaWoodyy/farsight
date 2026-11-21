# Ranking the in-game summaries of one game against its scoreboard

A game and its remake, or two Riot games filed under one scoreboard, share a `gameId`. `summaryRank` (`scripts/data/derive.ts`) orders them: the number of the scoreboard's champions the summary has, whether it lasted as long as the scoreboard says, then its length. The length comparison has to survive a unit bug in the source files.

## Rules

- `bestFirst` only reorders the summaries of one game among the places those summaries already hold in the file; every other line keeps its position. A global sort would pick the same summary but move the other games, and the derivation must give the same rows whatever the order of the file.
- A few short games of the first V5 files kept their length in milliseconds: `summarizeGame` only converts a duration above 20 000, so a 5-second remake can be stored as 5 000 and would rank as longer than the real game. `summaryRank` therefore compares both readings (the value, and the value divided by 1000) with the scoreboard's length and keeps the one that agrees.
- Without a scoreboard length, a value no game reaches (more than 10 800, three hours) is read as milliseconds.
- A real long game is not mistaken for a remake: 5 700 seconds that match the scoreboard stay 5 700 seconds, and a scoreboard game of 15 seconds whose summary says 15 000 is still the scoreboard's game.
- A summary without a length never agrees with the scoreboard, even when the scoreboard's game lasted a few seconds.
- `SAME_LENGTH_S` is 5: a summary and its scoreboard may differ by that many seconds and still be the same game. In practice they agree to the second; the margin only absorbs rounding, and widening it would let a remake pass for the game.
